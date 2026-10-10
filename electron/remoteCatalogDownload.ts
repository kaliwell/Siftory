import crypto from 'crypto'
import type { RemoteTerminalProfile } from '../shared/ipc-contract'
import type { CatalogFileActionRecord } from './discoveryCatalogDatabase'
import {
  isRemotePathWithinRoot,
  parseSftpEntryLocator,
  parseSftpSourceLocator,
} from './sftpSourceLocator'

export interface RemoteCatalogDownloadClaim {
  fileEntryId: string
  sourceId: string
  profileId: string
  hostFingerprint: string
  remotePath: string
  totalBytes: number
}

interface StoredClaim {
  claim: RemoteCatalogDownloadClaim
  senderId: number
  expiresAt: number
}

export class RemoteCatalogDownloadTokens {
  private readonly tokens = new Map<string, StoredClaim>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 5 * 60 * 1000,
  ) {}

  issue(senderId: number, claim: RemoteCatalogDownloadClaim): string {
    const issuedAt = this.now()
    for (const [candidate, stored] of this.tokens) {
      if (stored.expiresAt < issuedAt) this.tokens.delete(candidate)
    }
    if (this.tokens.size >= 1024) {
      const oldest = this.tokens.keys().next().value
      if (oldest) this.tokens.delete(oldest)
    }
    const token = crypto.randomUUID()
    this.tokens.set(token, { claim, senderId, expiresAt: issuedAt + this.ttlMs })
    return token
  }

  consume(rawToken: unknown, senderId: number): RemoteCatalogDownloadClaim | null {
    if (typeof rawToken !== 'string') return null
    const stored = this.tokens.get(rawToken)
    this.tokens.delete(rawToken)
    if (!stored || stored.senderId !== senderId || stored.expiresAt < this.now()) return null
    return stored.claim
  }
}

export function resolveRemoteCatalogDownloadClaim(
  record: CatalogFileActionRecord | null,
  profiles: readonly RemoteTerminalProfile[],
): { ok: true; claim: RemoteCatalogDownloadClaim } | { ok: false; error: string } {
  if (!record) return { ok: false, error: 'Catalog file not found' }
  if (record.source.type !== 'sftp') {
    return { ok: false, error: 'Only SFTP catalog results can use the transfer queue' }
  }
  const sourceLocator = parseSftpSourceLocator(record.source.rootLocator)
  const entryLocator = parseSftpEntryLocator(record.displayPath)
  if (
    !sourceLocator ||
    !entryLocator ||
    entryLocator.profileId !== sourceLocator.profileId ||
    !isRemotePathWithinRoot(entryLocator.remotePath, sourceLocator.remoteRoot)
  ) {
    return { ok: false, error: 'Catalog file is outside its registered SFTP source' }
  }
  const profile = profiles.find((candidate) => candidate.id === sourceLocator.profileId)
  if (!profile) return { ok: false, error: 'SFTP profile not found' }
  if (!profile.hostFingerprint || profile.hostFingerprint !== sourceLocator.hostFingerprint) {
    return { ok: false, error: 'SSH host fingerprint changed. Download blocked.' }
  }
  if (!Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 0) {
    return { ok: false, error: 'Catalog file size is invalid' }
  }
  return {
    ok: true,
    claim: {
      fileEntryId: record.fileEntryId,
      sourceId: record.source.id,
      profileId: sourceLocator.profileId,
      hostFingerprint: sourceLocator.hostFingerprint,
      remotePath: entryLocator.remotePath,
      totalBytes: record.sizeBytes,
    },
  }
}

export function sameRemoteCatalogDownloadClaim(
  left: RemoteCatalogDownloadClaim,
  right: RemoteCatalogDownloadClaim,
): boolean {
  return (
    left.fileEntryId === right.fileEntryId &&
    left.sourceId === right.sourceId &&
    left.profileId === right.profileId &&
    left.hostFingerprint === right.hostFingerprint &&
    left.remotePath === right.remotePath &&
    left.totalBytes === right.totalBytes
  )
}

export const remoteCatalogDownloadTokens = new RemoteCatalogDownloadTokens()
