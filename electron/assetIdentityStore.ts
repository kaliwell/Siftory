// ── Asset identity mapping store (Phase 2) ───────────────
// Persists the stable AssetId ↔ identity-key ↔ path mapping plus
// AssetMember rows in `asset-identities.jsonl` next to the asset library.
// Authority note (Phase 0 freeze + design 7.3): assets.jsonl remains the
// authority for asset identity records (id/path/kind/hash); this file is
// the Phase 2 migration-path artifact for the *stable ID mapping* and is
// fully rebuildable by re-resolving identities from the filesystem. It is
// covered by the asset-library backup/restore mechanism.

import fs from 'fs'
import path from 'path'
import type { AssetIdentity, AssetMember, AssetMemberRole } from '../shared/ipc/asset-identity'

export const ASSET_IDENTITIES_FILENAME = 'asset-identities.jsonl'

const MEMBER_ROLES = new Set<AssetMemberRole>([
  'original',
  'preview-proxy',
  'raw-companion',
  'sidecar',
])

interface PersistedIdentity {
  assetId: string
  strategy: 'filesystem' | 'path'
  identityKey: string
  path: string
  members?: AssetMember[]
  updatedAt: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isValidMember(member: AssetMember): boolean {
  return (
    !!member &&
    typeof member.assetId === 'string' &&
    MEMBER_ROLES.has(member.role) &&
    typeof member.path === 'string' &&
    member.path.trim().length > 0 &&
    !member.path.includes('\0')
  )
}

export class AssetIdentityStore {
  readonly filePath: string
  private readonly identitiesById = new Map<string, AssetIdentity>()
  private readonly assetIdByIdentityKey = new Map<string, string>()
  private readonly assetIdByPathKey = new Map<string, string>()
  private corruptRows = 0
  private loadPromise: Promise<void> | null = null
  private writeMutex: Promise<void> = Promise.resolve()

  constructor(baseDir: string) {
    this.filePath = path.join(baseDir, ASSET_IDENTITIES_FILENAME)
  }

  private async load(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true })
    this.identitiesById.clear()
    this.assetIdByIdentityKey.clear()
    this.assetIdByPathKey.clear()
    this.corruptRows = 0
    let raw: string
    try {
      raw = await fs.promises.readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return
      throw new Error(`Could not read asset-identities.jsonl: ${errorMessage(error)}`, {
        cause: error,
      })
    }
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        const record = JSON.parse(line) as PersistedIdentity
        if (typeof record.assetId !== 'string' || !record.assetId) {
          throw new Error('assetId must be a non-empty string')
        }
        if (typeof record.identityKey !== 'string' || !record.identityKey) {
          throw new Error('identityKey must be a non-empty string')
        }
        if (typeof record.path !== 'string' || !record.path || record.path.includes('\0')) {
          throw new Error('path must be a non-empty string without null bytes')
        }
        if (this.identitiesById.has(record.assetId)) {
          throw new Error(`duplicate assetId ${record.assetId}`)
        }
        const identity: AssetIdentity = {
          assetId: record.assetId,
          strategy: record.strategy === 'filesystem' ? 'filesystem' : 'path',
          identityKey: record.identityKey,
          path: record.path,
          members: (record.members ?? []).filter(isValidMember),
          updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
        }
        this.index(identity)
      } catch {
        this.corruptRows += 1
      }
    }
  }

  private index(identity: AssetIdentity): void {
    this.identitiesById.set(identity.assetId, identity)
    this.assetIdByIdentityKey.set(identity.identityKey, identity.assetId)
    this.assetIdByPathKey.set(this.pathKey(identity.path), identity.assetId)
  }

  private pathKey(filePath: string): string {
    const resolved = path.resolve(filePath)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }

  async ensureLoaded(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.load()
    await this.loadPromise
  }

  getCorruptRowCount(): number {
    return this.corruptRows
  }

  getByAssetId(assetId: string): AssetIdentity | undefined {
    return this.identitiesById.get(assetId)
  }

  getByIdentityKey(identityKey: string): AssetIdentity | undefined {
    const assetId = this.assetIdByIdentityKey.get(identityKey)
    return assetId ? this.identitiesById.get(assetId) : undefined
  }

  getByPath(filePath: string): AssetIdentity | undefined {
    const assetId = this.assetIdByPathKey.get(this.pathKey(filePath))
    return assetId ? this.identitiesById.get(assetId) : undefined
  }

  all(): AssetIdentity[] {
    return [...this.identitiesById.values()]
  }

  size(): number {
    return this.identitiesById.size
  }

  /**
   * Insert or refresh one identity. A same identity-key under a different
   * path keeps the existing AssetId and moves the recorded path (same-volume
   * move repair); a path-strategy identity that gains a filesystem identity
   * is migrated to the stronger key while keeping its AssetId.
   */
  async upsert(input: {
    assetId: string
    strategy: 'filesystem' | 'path'
    identityKey: string
    path: string
    members?: AssetMember[]
    now: number
  }): Promise<AssetIdentity> {
    await this.ensureLoaded()
    const identity = this.applyUpsert(input)
    await this.persist()
    return identity
  }

  /** Batch form used by Media Search so a scan persists one atomic snapshot, not one per video. */
  async upsertMany(
    inputs: readonly {
      assetId: string
      strategy: 'filesystem' | 'path'
      identityKey: string
      path: string
      members?: AssetMember[]
      now: number
    }[],
  ): Promise<AssetIdentity[]> {
    await this.ensureLoaded()
    if (inputs.length === 0) return []
    const identities = inputs.map((input) => this.applyUpsert(input))
    await this.persist()
    return identities
  }

  private applyUpsert(input: {
    assetId: string
    strategy: 'filesystem' | 'path'
    identityKey: string
    path: string
    members?: AssetMember[]
    now: number
  }): AssetIdentity {
    const existing =
      this.identitiesById.get(input.assetId) ?? this.getByIdentityKey(input.identityKey)
    const previousKey = existing?.identityKey
    const previousPath = existing?.path
    const members = input.members ?? existing?.members ?? []
    const identity: AssetIdentity = {
      assetId: existing?.assetId ?? input.assetId,
      strategy: input.strategy,
      identityKey: input.identityKey,
      path: input.path,
      members,
      updatedAt: input.now,
    }
    if (previousKey && previousKey !== identity.identityKey) {
      this.assetIdByIdentityKey.delete(previousKey)
    }
    if (previousPath && this.pathKey(previousPath) !== this.pathKey(identity.path)) {
      this.assetIdByPathKey.delete(this.pathKey(previousPath))
    }
    this.index(identity)
    return identity
  }

  async addMember(member: AssetMember, now: number): Promise<void> {
    await this.ensureLoaded()
    const identity = this.identitiesById.get(member.assetId)
    if (!identity || !isValidMember(member)) return
    const key = `${member.role}:${member.path.toLowerCase()}`
    const already = identity.members.some(
      (entry) => `${entry.role}:${entry.path.toLowerCase()}` === key,
    )
    if (already) return
    identity.members.push({ ...member, addedAt: member.addedAt || now })
    identity.updatedAt = now
    await this.persist()
  }

  /** Re-point an identity to a new path after a same-volume move. */
  async recordMove(
    identityKey: string,
    newPath: string,
    now: number,
  ): Promise<AssetIdentity | null> {
    await this.ensureLoaded()
    const identity = this.getByIdentityKey(identityKey)
    if (!identity) return null
    this.assetIdByPathKey.delete(this.pathKey(identity.path))
    identity.path = newPath
    identity.updatedAt = now
    for (const member of identity.members) {
      if (member.role === 'original') member.path = newPath
    }
    this.assetIdByPathKey.set(this.pathKey(identity.path), identity.assetId)
    await this.persist()
    return identity
  }

  private async persist(): Promise<void> {
    const run = async () => {
      const lines = this.all()
        .map((identity) => JSON.stringify(identity))
        .join('\n')
      const contents = lines ? `${lines}\n` : ''
      const temporaryPath = `${this.filePath}.tmp`
      await fs.promises.writeFile(temporaryPath, contents, 'utf8')
      await fs.promises.rename(temporaryPath, this.filePath)
    }
    const pending = this.writeMutex.catch(() => {}).then(run)
    this.writeMutex = pending
    await pending
  }
}
