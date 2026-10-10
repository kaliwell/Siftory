// ── Discovery catalog IPC (Phase 1, design 12.1) ─────────
// Thin handlers: sender authorization, payload validation and capability
// declaration are enforced by secureIpcMain; handlers only clamp inputs and
// forward to SourceCatalogService.

import {
  DISCOVERY_CATALOG_IPC,
  type DiscoveryAddSourceRequest,
  type DiscoveryCatalogQueryRequest,
} from '../shared/ipc/discovery-catalog'
import { secureIpcMain } from './ipcAuthorization'
import { clampNumber } from './imageSearchGuards'
import { getSourceCatalogService } from './sourceCatalogService'
import { createSftpSourceLocator } from './sftpSourceLocator'
import { listProfiles } from './remoteTerminalService'
import {
  remoteCatalogDownloadTokens,
  resolveRemoteCatalogDownloadClaim,
  sameRemoteCatalogDownloadClaim,
} from './remoteCatalogDownload'
import { getRemotePreviewService } from './remotePreviewService'
import { resolveStoredCredential } from './remoteTerminalCredential'
import { SftpVideoRetrievalService } from './sftpVideoRetrievalService'
import path from 'path'
import { getMediaTaskProgress, startMediaFrameBuild, startMediaIndexScan } from './mediaTaskQueue'
import { assignVideoManifestSources, loadVideoManifest } from './videoScanService'
import type { UnifiedTaskSubmitter } from './unifiedTaskSubmission'
import { getMediaSearchDir } from './mediaCacheService'
import { initSftpVideoProjectionStore } from './sftpVideoProjection'
import { isSourceFileSyncRunning } from './sourceFileSyncService'
import { isSourceDerivedDataCleanupRunning } from './sourceDerivedDataCleanupService'

const SOURCE_TYPES = new Set([
  'local-ntfs',
  'local-generic',
  'removable',
  'mounted-network',
  'sftp',
  'nas-agent',
])

function normalizeAddRequest(raw: unknown): DiscoveryAddSourceRequest {
  const input = (raw ?? {}) as Partial<DiscoveryAddSourceRequest>
  const type = SOURCE_TYPES.has(input.type as string)
    ? (input.type as DiscoveryAddSourceRequest['type'])
    : 'local-ntfs'
  return {
    type,
    displayName: typeof input.displayName === 'string' ? input.displayName.slice(0, 200) : '',
    rootLocator: typeof input.rootLocator === 'string' ? input.rootLocator : '',
    readOnly: input.readOnly !== false,
    ...(typeof input.sftpProfileId === 'string'
      ? { sftpProfileId: input.sftpProfileId.slice(0, 128) }
      : {}),
    ...(typeof input.sftpRemoteRoot === 'string'
      ? { sftpRemoteRoot: input.sftpRemoteRoot.slice(0, 4096) }
      : {}),
  }
}

function resolveSftpAddRequest(request: DiscoveryAddSourceRequest): DiscoveryAddSourceRequest {
  if (request.type !== 'sftp') return request
  const profile = listProfiles().find((candidate) => candidate.id === request.sftpProfileId)
  if (!profile) return { ...request, rootLocator: '' }
  const rootLocator = createSftpSourceLocator(profile, request.sftpRemoteRoot || '')
  return { ...request, rootLocator: rootLocator || '' }
}

function normalizeQuery(raw: unknown): DiscoveryCatalogQueryRequest {
  const input = (raw ?? {}) as Partial<DiscoveryCatalogQueryRequest>
  return {
    ...(typeof input.query === 'string' ? { query: input.query.slice(0, 500) } : {}),
    ...(typeof input.sourceId === 'string' ? { sourceId: input.sourceId.slice(0, 128) } : {}),
    offset: Math.floor(clampNumber(input.offset, 0, 0, 10_000_000)),
    limit: Math.floor(clampNumber(input.limit, 100, 1, 500)),
    ...(input.sort === 'name_asc' || input.sort === 'size_desc' || input.sort === 'recent'
      ? { sort: input.sort }
      : {}),
  }
}

function normalizeSourceId(raw: unknown): string {
  return typeof raw === 'string' ? raw.slice(0, 128) : ''
}

export function registerDiscoveryCatalogIpc(
  userDataPath: string,
  profilesReady: Promise<void> = Promise.resolve(),
  taskScheduler?: UnifiedTaskSubmitter,
): void {
  const remoteVideoCacheDir = path.join(getMediaSearchDir(), 'sftp-video-cache', 'v1')
  const remoteVideoCache = new SftpVideoRetrievalService(remoteVideoCacheDir)
  const remoteVideoProjection = initSftpVideoProjectionStore(
    path.join(getMediaSearchDir(), 'manifests', 'sftp-video-projection.json'),
  )
  secureIpcMain.handle(DISCOVERY_CATALOG_IPC.LIST_SOURCES, async () => {
    return getSourceCatalogService()?.listSources() ?? []
  })

  secureIpcMain.handle(DISCOVERY_CATALOG_IPC.ADD_SOURCE, async (_event, raw: unknown) => {
    const service = getSourceCatalogService()
    if (!service) return { ok: false, error: 'Discovery catalog is not initialized' }
    return service.addSource(resolveSftpAddRequest(normalizeAddRequest(raw)))
  })

  secureIpcMain.handle(DISCOVERY_CATALOG_IPC.REMOVE_SOURCE, async (_event, raw: unknown) => {
    const service = getSourceCatalogService()
    if (!service) return { ok: false, error: 'Discovery catalog is not initialized' }
    return service.removeSource(normalizeSourceId(raw))
  })

  secureIpcMain.handle(
    DISCOVERY_CATALOG_IPC.REPAIR_SOURCE_ROOT,
    async (_event, rawId: unknown, rawRoot: unknown) => {
      const service = getSourceCatalogService()
      if (!service || typeof rawRoot !== 'string' || rawRoot.length > 4096) {
        return { ok: false, error: 'Invalid replacement source root' }
      }
      return service.repairMountedSourceRoot(normalizeSourceId(rawId), rawRoot)
    },
  )

  secureIpcMain.handle(DISCOVERY_CATALOG_IPC.PROBE_SOURCE, async (_event, raw: unknown) => {
    const service = getSourceCatalogService()
    if (!service) return { ok: false, error: 'Discovery catalog is not initialized' }
    return service.probeSource(normalizeSourceId(raw))
  })

  secureIpcMain.handle(DISCOVERY_CATALOG_IPC.SCAN_START, async (_event, raw: unknown) => {
    const service = getSourceCatalogService()
    if (!service) return { ok: false, error: 'Discovery catalog is not initialized' }
    return service.startScan(normalizeSourceId(raw))
  })

  secureIpcMain.handle(DISCOVERY_CATALOG_IPC.SCAN_CANCEL, async (_event, raw: unknown) => {
    const service = getSourceCatalogService()
    if (!service) return { ok: false, error: 'Discovery catalog is not initialized' }
    return service.cancelScan(normalizeSourceId(raw))
  })

  secureIpcMain.handle(DISCOVERY_CATALOG_IPC.SCAN_STATUS, async (_event, raw: unknown) => {
    const service = getSourceCatalogService()
    if (!service) return []
    const sourceId = normalizeSourceId(raw)
    return service.getScanStatus(sourceId || undefined)
  })

  secureIpcMain.handle(DISCOVERY_CATALOG_IPC.CATALOG_QUERY, async (_event, raw: unknown) => {
    const service = getSourceCatalogService()
    if (!service) return { items: [], total: 0 }
    return service.queryCatalog(normalizeQuery(raw))
  })

  secureIpcMain.handle(DISCOVERY_CATALOG_IPC.CATALOG_STATS, async () => {
    return (
      getSourceCatalogService()?.getStats() ?? {
        sourceCount: 0,
        fileCount: 0,
        totalBytes: 0,
        sessionCount: 0,
      }
    )
  })

  secureIpcMain.handle(DISCOVERY_CATALOG_IPC.REMOTE_DOWNLOAD_GRANT, async (event, raw: unknown) => {
    const service = getSourceCatalogService()
    if (!service || typeof raw !== 'string' || raw.length > 32) {
      return { ok: false, error: 'Invalid catalog file id' }
    }
    await profilesReady
    const resolved = resolveRemoteCatalogDownloadClaim(
      service.getFileEntryForAction(raw),
      listProfiles(),
    )
    if (!resolved.ok) return resolved
    return {
      ok: true,
      token: remoteCatalogDownloadTokens.issue(event.sender.id, resolved.claim),
      displayName: resolved.claim.remotePath.split('/').at(-1) || raw,
      totalBytes: resolved.claim.totalBytes,
    }
  })

  secureIpcMain.handle(
    DISCOVERY_CATALOG_IPC.REMOTE_VIDEO_PREPARE,
    async (event, rawToken: unknown, rawTimestampMs: unknown) => {
      const claim = remoteCatalogDownloadTokens.consume(rawToken, event.sender.id)
      if (!claim) return { ok: false, error: 'Invalid or expired remote video authorization' }
      const timestampMs = rawTimestampMs === undefined ? 0 : rawTimestampMs
      if (
        typeof timestampMs !== 'number' ||
        !Number.isSafeInteger(timestampMs) ||
        timestampMs < 0 ||
        timestampMs > 7 * 24 * 60 * 60_000
      ) {
        return { ok: false, error: 'Invalid media timestamp' }
      }
      await profilesReady
      const current = resolveRemoteCatalogDownloadClaim(
        getSourceCatalogService()?.getFileEntryForAction(claim.fileEntryId) ?? null,
        listProfiles(),
      )
      if (!current.ok) return current
      if (!sameRemoteCatalogDownloadClaim(claim, current.claim)) {
        return { ok: false, error: 'Catalog video changed. Search again before retrieval.' }
      }
      const profile = listProfiles().find((candidate) => candidate.id === claim.profileId)
      if (!profile) return { ok: false, error: 'SFTP profile not found' }
      const credential = await resolveStoredCredential(userDataPath, profile, {
        profileId: profile.id,
        password: undefined as string | undefined,
        passphrase: undefined as string | undefined,
      })
      const retrieval = await remoteVideoCache.retrieve(claim, profile, credential)
      if (!retrieval.ok || !retrieval.localPath) return retrieval
      if (isSourceFileSyncRunning() || isSourceDerivedDataCleanupRunning()) {
        return { ok: false, error: 'Source index maintenance is running' }
      }
      const scan = startMediaIndexScan({ paths: [retrieval.localPath], mode: 'metadata' })
      if (!scan.ok) return { ok: false, error: scan.error || 'Could not index retrieved video' }
      let scanFinished = false
      for (let attempt = 0; attempt < 36_000; attempt += 1) {
        const progress = getMediaTaskProgress(scan.taskId)
        if (progress?.state === 'done') {
          scanFinished = true
          break
        }
        if (progress?.state === 'error' || progress?.state === 'stopped') {
          return { ok: false, error: progress.error || 'Retrieved video indexing failed' }
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      if (!scanFinished) return { ok: false, error: 'Retrieved video indexing timed out' }
      const video = loadVideoManifest().find(
        (candidate) => path.resolve(candidate.path) === path.resolve(retrieval.localPath!),
      )
      if (!video) return { ok: false, error: 'Retrieved video is not in the media manifest' }
      assignVideoManifestSources([
        { videoId: video.videoId, sourceId: claim.sourceId, sourceType: 'sftp' },
      ])
      remoteVideoProjection.upsert({
        fileEntryId: claim.fileEntryId,
        localPath: retrieval.localPath,
        videoId: video.videoId,
        updatedAt: Date.now(),
      })
      // Deep extraction is intentionally queued after metadata is authoritative;
      // the caller can play immediately while frames are built in the GPU lane.
      if (!isSourceFileSyncRunning() && !isSourceDerivedDataCleanupRunning()) {
        startMediaFrameBuild({ paths: [retrieval.localPath] }, taskScheduler)
      }
      return {
        ...retrieval,
        ok: true,
        videoId: video.videoId,
        timestampMs,
      }
    },
  )

  secureIpcMain.handle(
    DISCOVERY_CATALOG_IPC.REMOTE_PREVIEW_GET,
    async (_event, rawId: unknown, rawMaxDim: unknown) => {
      const service = getSourceCatalogService()
      if (!service || typeof rawId !== 'string' || rawId.length > 32) {
        return {
          ok: false,
          fileEntryId: '',
          status: 'metadata-only',
          error: 'Invalid catalog file id',
        }
      }
      await profilesReady
      return getRemotePreviewService({
        userDataPath,
        getRecord: (fileEntryId) => service.getFileEntryForAction(fileEntryId),
        setPreviewState: (fileEntryId, state) => {
          service.setPreviewIndexState(fileEntryId, state)
        },
        getProfiles: listProfiles,
      }).get(rawId, clampNumber(rawMaxDim, 160, 64, 256))
    },
  )
}
