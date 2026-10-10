// ── Asset identity service (Phase 2, main process) ───────
// Resolves stable AssetIds for physical files (design 7.2), maintains the
// identity/member mapping (AssetIdentityStore) and produces the shadow
// comparison report against the existing asset-catalog projection (design
// Phase 2 task 2). Search, the asset library and duplicate groups all call
// this resolver with the same path, so the same file always yields the same
// stable AssetId.

import fs from 'fs'
import path from 'path'
import type {
  AssetIdentity,
  AssetMember,
  AssetShadowReport,
  AssetShadowReportEntry,
} from '../shared/ipc/asset-identity'
import {
  classifyMemberRole,
  isOriginalImageExtension,
  resolveAssetIdentity,
} from './assetIdentityResolver'
import { AssetIdentityStore } from './assetIdentityStore'
import { discoveryPathKey } from './discoveryCatalogDatabase'

export interface AssetIdentityServiceOptions {
  /** Directories whose contents are generated preview proxies. */
  previewDirs?: readonly string[]
  /** Injectable stat for tests; defaults to fs.statSync. */
  statFile?: (filePath: string) => { dev: number; ino: number } | null
  /** Injectable sibling listing for member detection. */
  listSiblings?: (dirPath: string) => string[]
  now?: () => number
}

export interface MovedAssetRepair {
  assetId: string
  oldPath: string
  newPath: string
  strategy: AssetIdentity['strategy']
}

function defaultStat(filePath: string): { dev: number; ino: number } | null {
  try {
    const stat = fs.statSync(filePath)
    return { dev: stat.dev, ino: stat.ino }
  } catch {
    return null
  }
}

function defaultListSiblings(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath)
  } catch {
    return []
  }
}

export class AssetIdentityService {
  readonly store: AssetIdentityStore
  private readonly previewDirs: readonly string[]
  private readonly statFile: (filePath: string) => { dev: number; ino: number } | null
  private readonly listSiblings: (dirPath: string) => string[]
  private readonly now: () => number

  constructor(baseDir: string, options: AssetIdentityServiceOptions = {}) {
    this.store = new AssetIdentityStore(baseDir)
    this.previewDirs = options.previewDirs ?? []
    this.statFile = options.statFile ?? defaultStat
    this.listSiblings = options.listSiblings ?? defaultListSiblings
    this.now = options.now ?? Date.now
  }

  previewDirectoryList(): readonly string[] {
    return this.previewDirs
  }

  private detectMembers(assetId: string, originalPath: string, now: number): AssetMember[] {
    const members: AssetMember[] = [{ assetId, role: 'original', path: originalPath, addedAt: now }]
    const dir = path.dirname(originalPath)
    const stem = path.basename(originalPath, path.extname(originalPath)).toLowerCase()
    for (const sibling of this.listSiblings(dir)) {
      const siblingPath = path.join(dir, sibling)
      if (discoveryPathKey(siblingPath) === discoveryPathKey(originalPath)) continue
      const siblingStem = path.basename(sibling, path.extname(sibling)).toLowerCase()
      if (siblingStem !== stem) continue
      const role = classifyMemberRole(siblingPath, {
        previewDirs: this.previewDirs,
        // The original itself is the developed sibling for RAW companions.
        hasOriginalSibling: true,
      })
      if (role === 'original') continue
      members.push({ assetId, role, path: siblingPath, addedAt: now })
    }
    return members
  }

  /**
   * Resolve (and remember) the stable identity of one file. Search results,
   * asset library records and duplicate groups all funnel through here, so
   * the same physical file returns the same AssetId everywhere.
   */
  async resolveForPath(absolutePath: string): Promise<AssetIdentity> {
    await this.store.ensureLoaded()
    const resolved = path.resolve(absolutePath)
    const stat = this.statFile(resolved)
    const { assetId, strategy, identityKey } = resolveAssetIdentity(
      { absolutePath: resolved },
      stat,
    )
    const existing = this.store.getByIdentityKey(identityKey) ?? this.store.getByAssetId(assetId)
    if (existing) {
      if (existing.path !== resolved) {
        const moved = await this.store.recordMove(identityKey, resolved, this.now())
        if (moved) return moved
      }
      return existing
    }
    const hasOriginalSibling = this.listSiblings(path.dirname(resolved)).some((sibling) =>
      isOriginalImageExtension(path.extname(sibling)),
    )
    const role = classifyMemberRole(resolved, {
      previewDirs: this.previewDirs,
      hasOriginalSibling,
    })
    if (role !== 'original') {
      // A proxy/sidecar/companion is never registered as its own asset; the
      // caller resolves the original instead.
      return {
        assetId,
        strategy,
        identityKey,
        path: resolved,
        members: [{ assetId, role, path: resolved, addedAt: this.now() }],
        updatedAt: this.now(),
      }
    }
    return this.store.upsert({
      assetId,
      strategy,
      identityKey,
      path: resolved,
      members: this.detectMembers(assetId, resolved, this.now()),
      now: this.now(),
    })
  }

  /** Resolve many originals with one mapping-store write (Media Search scan integration). */
  async resolveManyForPaths(absolutePaths: readonly string[]): Promise<AssetIdentity[]> {
    await this.store.ensureLoaded()
    const resolvedIdentities: AssetIdentity[] = []
    const pending: Parameters<AssetIdentityStore['upsertMany']>[0][number][] = []
    const seen = new Set<string>()
    for (const absolutePath of absolutePaths) {
      const resolved = path.resolve(absolutePath)
      const pathKey = discoveryPathKey(resolved)
      if (seen.has(pathKey)) continue
      seen.add(pathKey)
      const stat = this.statFile(resolved)
      const identity = resolveAssetIdentity({ absolutePath: resolved }, stat)
      const existing =
        this.store.getByIdentityKey(identity.identityKey) ??
        this.store.getByAssetId(identity.assetId)
      if (existing?.path === resolved) {
        resolvedIdentities.push(existing)
        continue
      }
      const role = classifyMemberRole(resolved, {
        previewDirs: this.previewDirs,
        hasOriginalSibling: this.listSiblings(path.dirname(resolved)).some((sibling) =>
          isOriginalImageExtension(path.extname(sibling)),
        ),
      })
      if (role !== 'original') {
        resolvedIdentities.push({
          ...identity,
          path: resolved,
          members: [{ assetId: identity.assetId, role, path: resolved, addedAt: this.now() }],
          updatedAt: this.now(),
        })
        continue
      }
      const now = this.now()
      pending.push({
        ...identity,
        assetId: existing?.assetId ?? identity.assetId,
        path: resolved,
        members: existing
          ? existing.members.map((member) =>
              member.role === 'original' ? { ...member, path: resolved } : member,
            )
          : this.detectMembers(identity.assetId, resolved, now),
        now,
      })
    }
    resolvedIdentities.push(...(await this.store.upsertMany(pending)))
    return resolvedIdentities
  }

  async getByAssetId(assetId: string): Promise<AssetIdentity | undefined> {
    await this.store.ensureLoaded()
    return this.store.getByAssetId(assetId)
  }

  /** Read-only lookup used by unified search; never creates a mapping on query. */
  async findByPath(filePath: string): Promise<AssetIdentity | undefined> {
    await this.store.ensureLoaded()
    return this.store.getByPath(filePath)
  }

  /**
   * Same-volume move repair (Phase 2 acceptance): the file at `newPath`
   * keeps its filesystem identity, so the stable AssetId, tags, categories
   * and index rows re-point to the new location. Returns the repair
   * descriptor, or null when the identity was never registered.
   */
  async repairMovedFile(
    newPath: string,
    beforeCommit?: (repair: MovedAssetRepair) => Promise<void>,
  ): Promise<MovedAssetRepair | null> {
    await this.store.ensureLoaded()
    const resolved = path.resolve(newPath)
    const stat = this.statFile(resolved)
    const { identityKey } = resolveAssetIdentity({ absolutePath: resolved }, stat)
    const existing = this.store.getByIdentityKey(identityKey)
    if (!existing || existing.path === resolved) return null
    // Capture the old path before recordMove mutates the live record.
    const oldPath = existing.path
    const preparedRepair: MovedAssetRepair = {
      assetId: existing.assetId,
      oldPath,
      newPath: resolved,
      strategy: existing.strategy,
    }
    // Recovery intent must be durable before the authoritative identity
    // mapping changes. If publishing the intent fails, leave identity intact.
    await beforeCommit?.(preparedRepair)
    const repaired = await this.store.recordMove(identityKey, resolved, this.now())
    if (!repaired) return null
    return {
      assetId: repaired.assetId,
      oldPath,
      newPath: resolved,
      strategy: repaired.strategy,
    }
  }

  /**
   * Shadow projection report (design Phase 2 task 2): compares the unified
   * identity mapping against the existing asset library listing without
   * replacing any existing read path. Entries present on only one side are
   * reported with a reason.
   */
  async buildShadowReport(
    libraryRecords: readonly { id: number; path: string }[],
  ): Promise<AssetShadowReport> {
    await this.store.ensureLoaded()
    const onlyInLibrary: AssetShadowReportEntry[] = []
    const onlyInUnified: AssetShadowReportEntry[] = []
    const identityByPathKey = new Map<string, AssetIdentity>()
    for (const identity of this.store.all()) {
      identityByPathKey.set(discoveryPathKey(identity.path), identity)
    }
    const libraryPathKeys = new Set<string>()
    let matched = 0
    for (const record of libraryRecords) {
      const key = discoveryPathKey(record.path)
      libraryPathKeys.add(key)
      const identity = identityByPathKey.get(key)
      if (identity) {
        matched += 1
      } else {
        onlyInLibrary.push({
          path: record.path,
          reason: 'library asset has no unified identity mapping yet',
        })
      }
    }
    for (const identity of this.store.all()) {
      if (!libraryPathKeys.has(discoveryPathKey(identity.path))) {
        onlyInUnified.push({
          path: identity.path,
          assetId: identity.assetId,
          reason: 'unified identity has no matching asset library record',
        })
      }
    }
    return {
      generatedAt: this.now(),
      comparedCount: libraryRecords.length,
      matchedCount: matched,
      onlyInLibrary,
      onlyInUnified,
    }
  }
}

const services = new Map<string, AssetIdentityService>()

/**
 * Process-wide identity service, keyed by the asset-library base directory
 * (mirrors getProjectPreviewService). Initialized by main.ts; IPC handlers
 * tolerate an uninitialized service.
 */
export function getAssetIdentityService(baseDir?: string): AssetIdentityService | null {
  if (baseDir) {
    const resolved = path.resolve(baseDir)
    let service = services.get(resolved)
    if (!service) {
      service = new AssetIdentityService(resolved)
      services.set(resolved, service)
    }
    return service
  }
  const first = services.values().next()
  return first.done ? null : first.value
}
