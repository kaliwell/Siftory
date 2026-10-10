// ── Phase 1 unified sources view ─────────────────────────
// Source registration and scan status over the unified Discovery Catalog.
// Unified querying now lives in the first-class UnifiedSearchPanel.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DiscoveryScanStatus,
  DiscoveryProbeResult,
  DiscoverySourceListItem,
  AssetCollection,
  AssetCollectionItem,
  SourceType,
  SubjectBBox,
  UnifiedSearchResponse,
  UnifiedSearchResultItem,
} from '../../shared/ipc-contract'
import { useTranslation } from '../i18n/useTranslation'
import SubjectPickerModal, { type SubjectPickerData } from './SubjectPickerModal'
import { mediaSearchBridge } from '../services/mediaSearchBridge'
import { notifyAssetCollectionsChanged } from '../hooks/useAssetCollections'
import { buildSourceHealthItems } from '../services/sourceHealth'
import {
  videoHitEvidenceLabelKeys,
  videoHitLabelKey,
  videoHitModelLabel,
} from '../utils/unifiedVideoEvidence'
import { setBoundedDataUrlRecord } from '../utils/rendererDataUrlCache'

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

function formatDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return '-'
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`
}

const availabilityKey: Record<string, string> = {
  online: 'Online',
  offline: 'Offline',
  degraded: 'Degraded',
  unknown: 'Unknown',
}

const sessionStateKey: Record<string, string> = {
  running: 'Scanning',
  completed: 'Completed',
  cancelled: 'Cancelled',
  error: 'Failed',
}

const sourceTypeKey: Record<string, string> = {
  'local-ntfs': 'Local drive',
  'local-generic': 'Local files',
  removable: 'Removable drive',
  'mounted-network': 'Mounted network',
  sftp: 'SFTP source',
  'nas-agent': 'NAS agent',
}

const scanCapabilityKey: Record<string, string> = {
  usn: 'Native connection',
  directory: 'Directory scan',
  'remote-list': 'Remote listing',
  agent: 'NAS agent',
}

const incrementalWatchStateKey: Record<string, string> = {
  watching: 'Watching for changes',
  'paused-offline': 'Paused while source is offline',
  unsupported: 'Not available for this source',
  error: 'Watcher needs attention',
}

function formatTimestamp(value?: number): string {
  if (!value || !Number.isFinite(value)) return ''
  return new Date(value).toLocaleString()
}

const REMOTE_PREVIEW_LIMIT = 12
const DISCOVERY_PREVIEW_CACHE_ENTRIES = 100
const DISCOVERY_PREVIEW_CACHE_BYTES = 32 * 1024 * 1024
const COLLECTION_DRAG_TYPE = 'application/x-floating-clock-collection-item'

function collectionInputFromResult(item: UnifiedSearchResultItem) {
  return {
    ...(item.assetId ? { assetId: item.assetId } : {}),
    fileEntryId: item.fileEntryId,
    mediaType: item.mediaType,
    displayName: item.displayName,
    displayPath: item.displayPath,
    sizeBytes: item.sizeBytes,
    modifiedAt: item.modifiedAt,
    ...(item.videoId ? { videoId: item.videoId } : {}),
    ...(item.videoHitMs !== undefined
      ? { videoHitMs: item.videoHitMs }
      : item.videoHits?.[0]
        ? { videoHitMs: item.videoHits[0].timestampMs }
        : {}),
    source: item.source,
  }
}

function resultIndexLabel(indexState: readonly string[]): string {
  if (indexState[0] === 'full') return 'Full AI index'
  if (indexState[0] === 'partial') return 'Partial AI index'
  return indexState.includes('preview-ready:ready') ? 'Preview ready' : 'Metadata only'
}

interface DiscoverySourcesSectionProps {
  enableEmbeddedSearch?: boolean
}

const DiscoverySourcesSection: React.FC<DiscoverySourcesSectionProps> = ({
  enableEmbeddedSearch = false,
}) => {
  const { t } = useTranslation()
  const sectionRef = useRef<HTMLDivElement | null>(null)
  const [sources, setSources] = useState<DiscoverySourceListItem[]>([])
  const [statuses, setStatuses] = useState<Record<string, DiscoveryScanStatus>>({})
  const [probes, setProbes] = useState<Record<string, DiscoveryProbeResult>>({})
  const [probePending, setProbePending] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [rootPath, setRootPath] = useState('')
  const [sourceType, setSourceType] =
    useState<Extract<SourceType, 'local-ntfs' | 'mounted-network' | 'sftp'>>('local-ntfs')
  const [sftpProfileId, setSftpProfileId] = useState('')
  const [remoteProfiles, setRemoteProfiles] = useState<
    Awaited<ReturnType<typeof window.electronAPI.remoteTerminal.listProfiles>>
  >([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [downloadPending, setDownloadPending] = useState<string | null>(null)
  const [remotePreviews, setRemotePreviews] = useState<Record<string, string>>({})
  const [videoPreviews, setVideoPreviews] = useState<Record<string, string>>({})
  const videoPreviewIds = useRef(new Set<string>())
  const videoPreviewRequests = useRef(new Set<string>())
  const remotePreviewRequests = useRef(new Set<string>())
  const [query, setQuery] = useState('')
  const [referenceImagePath, setReferenceImagePath] = useState('')
  const [subject, setSubject] = useState<SubjectBBox | undefined>()
  const [subjectPicker, setSubjectPicker] = useState<SubjectPickerData | null>(null)
  const [results, setResults] = useState<UnifiedSearchResultItem[]>([])
  const [selectedResultIds, setSelectedResultIds] = useState<Set<string>>(new Set())
  const [collections, setCollections] = useState<AssetCollection[]>([])
  const [selectedCollectionId, setSelectedCollectionId] = useState(0)
  const [collectionItems, setCollectionItems] = useState<AssetCollectionItem[]>([])
  const [collectionName, setCollectionName] = useState('')
  const [collectionPending, setCollectionPending] = useState(false)
  const [resultTotal, setResultTotal] = useState(0)
  const [searchState, setSearchState] = useState<Pick<
    UnifiedSearchResponse,
    'aiEnhancement' | 'degradedReason' | 'actionableHint'
  > | null>(null)
  const catalogSearchRevision = referenceImagePath
    ? ''
    : sources.map((source) => `${source.id}:${source.fileCount}:${source.availability}`).join('|')

  const refresh = useCallback(async () => {
    try {
      const api = window.electronAPI.discoveryCatalog
      const [list, statusList, profiles] = await Promise.all([
        api.listSources(),
        api.getScanStatus(),
        window.electronAPI.remoteTerminal.listProfiles(),
      ])
      setSources(list)
      setStatuses(Object.fromEntries(statusList.map((status) => [status.sourceId, status])))
      setRemoteProfiles(profiles)
    } catch {
      /* catalog not initialized yet; next poll retries */
    }
  }, [])

  const refreshCollections = useCallback(async () => {
    const list = await window.electronAPI.assetLibrary.listCollections()
    setCollections(list)
    setSelectedCollectionId((current) =>
      current && list.some((collection) => collection.id === current)
        ? current
        : (list[0]?.id ?? 0),
    )
  }, [])

  useEffect(() => {
    void refresh()
    const unsubscribe = window.electronAPI.discoveryCatalog.onScanStatusChanged((status) => {
      setStatuses((previous) => ({ ...previous, [status.sourceId]: status }))
      if (!status.running) void refresh()
    })
    const timer = setInterval(() => void refresh(), 2000)
    return () => {
      unsubscribe()
      clearInterval(timer)
    }
  }, [refresh])

  useEffect(() => {
    void refreshCollections().catch(() => {})
  }, [refreshCollections])

  useEffect(() => {
    if (!selectedCollectionId) {
      setCollectionItems([])
      return
    }
    void window.electronAPI.assetLibrary
      .listCollectionItems(selectedCollectionId)
      .then(setCollectionItems)
      .catch(() => setCollectionItems([]))
  }, [selectedCollectionId])

  useEffect(() => {
    const visibleIds = new Set(results.map((item) => item.fileEntryId))
    setSelectedResultIds((current) => new Set([...current].filter((id) => visibleIds.has(id))))
  }, [results])

  useEffect(() => {
    const focusSources = () => {
      sectionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
    window.addEventListener('workspace-sources-focus', focusSources)
    return () => window.removeEventListener('workspace-sources-focus', focusSources)
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!enableEmbeddedSearch) {
      setResults([])
      setResultTotal(0)
      setSearchState(null)
      return
    }
    const handle = setTimeout(() => {
      window.electronAPI.unifiedSearch
        .query({
          query,
          ...(referenceImagePath ? { referenceImagePath } : {}),
          ...(referenceImagePath && subject ? { subject } : {}),
          limit: 50,
        })
        .then((response) => {
          if (cancelled) return
          setResults(response.items)
          setResultTotal(response.total)
          setSearchState({
            aiEnhancement: response.aiEnhancement,
            ...(response.degradedReason ? { degradedReason: response.degradedReason } : {}),
            ...(response.actionableHint ? { actionableHint: response.actionableHint } : {}),
          })
        })
        .catch(() => {
          if (cancelled) return
          setResults([])
          setResultTotal(0)
          setSearchState(null)
        })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [enableEmbeddedSearch, query, referenceImagePath, subject, catalogSearchRevision])

  useEffect(() => {
    void window.electronAPI.unifiedSearch.setVisiblePaths(results.map((item) => item.displayPath))
  }, [results])

  useEffect(() => {
    let cancelled = false
    const previewItems = results
      .filter((item) => item.source.type === 'sftp' && item.mediaType === 'image')
      .slice(0, REMOTE_PREVIEW_LIMIT)
    for (const item of previewItems) {
      const previewKey = `${item.fileEntryId}:${item.modifiedAt}:${item.sizeBytes}`
      if (remotePreviews[previewKey] || remotePreviewRequests.current.has(previewKey)) continue
      remotePreviewRequests.current.add(previewKey)
      void window.electronAPI.discoveryCatalog
        .getRemotePreview(item.fileEntryId, 160)
        .then((preview) => {
          if (cancelled || !preview.ok || !preview.dataUrl) return
          setRemotePreviews((previous) =>
            setBoundedDataUrlRecord(
              previous,
              previewKey,
              preview.dataUrl!,
              DISCOVERY_PREVIEW_CACHE_ENTRIES,
              DISCOVERY_PREVIEW_CACHE_BYTES,
            ),
          )
          setResults((previous) =>
            previous.map((result) =>
              result.fileEntryId === item.fileEntryId &&
              !result.indexState.includes('preview-ready:ready')
                ? {
                    ...result,
                    indexState: [...result.indexState, 'preview-ready:ready'],
                  }
                : result,
            ),
          )
        })
        .catch(() => {})
        .finally(() => remotePreviewRequests.current.delete(previewKey))
    }
    return () => {
      cancelled = true
    }
  }, [remotePreviews, results])

  useEffect(() => {
    for (const item of results.filter((result) => result.mediaType === 'video').slice(0, 12)) {
      const frameId = item.videoHits?.find((hit) => hit.kind === 'visual' && hit.frameId)?.frameId
      if (
        !frameId ||
        videoPreviewIds.current.has(frameId) ||
        videoPreviewRequests.current.has(frameId)
      )
        continue
      videoPreviewRequests.current.add(frameId)
      void mediaSearchBridge
        .getFramePreview(frameId)
        .then((preview) => {
          if (preview.ok && preview.dataUrl) {
            setVideoPreviews((previous) => {
              const next = setBoundedDataUrlRecord(
                previous,
                frameId,
                preview.dataUrl!,
                DISCOVERY_PREVIEW_CACHE_ENTRIES,
                DISCOVERY_PREVIEW_CACHE_BYTES,
              )
              videoPreviewIds.current = new Set(Object.keys(next))
              return next
            })
          }
        })
        .catch(() => {})
        .finally(() => videoPreviewRequests.current.delete(frameId))
    }
  }, [results])

  const handleAddSource = useCallback(async () => {
    setError(null)
    const response = await window.electronAPI.discoveryCatalog.addSource({
      type: sourceType,
      displayName: displayName.trim(),
      rootLocator: sourceType === 'sftp' ? '' : rootPath.trim(),
      ...(sourceType === 'sftp' ? { sftpProfileId, sftpRemoteRoot: rootPath.trim() } : {}),
    })
    if (!response.ok) {
      setError(response.error || t('The operation failed.'))
      return
    }
    setDisplayName('')
    setRootPath('')
    await refresh()
  }, [displayName, refresh, rootPath, sftpProfileId, sourceType, t])

  const handleStartScan = useCallback(
    async (sourceId: string) => {
      setError(null)
      const response = await window.electronAPI.discoveryCatalog.startScan(sourceId)
      if (!response.ok) setError(response.error || t('The operation failed.'))
      await refresh()
    },
    [refresh, t],
  )

  const handleProbeSource = useCallback(
    async (sourceId: string) => {
      setError(null)
      setProbePending(sourceId)
      try {
        const response = await window.electronAPI.discoveryCatalog.probeSource(sourceId)
        setProbes((previous) => ({ ...previous, [sourceId]: response }))
        if (!response.ok) setError(response.error || t('The operation failed.'))
        await refresh()
      } catch (probeError) {
        setError(probeError instanceof Error ? probeError.message : t('The operation failed.'))
      } finally {
        setProbePending(null)
      }
    },
    [refresh, t],
  )

  const handleRemoveSource = useCallback(
    async (sourceId: string) => {
      setError(null)
      const response = await window.electronAPI.discoveryCatalog.removeSource(sourceId)
      if (!response.ok) setError(response.error || t('The operation failed.'))
      await refresh()
    },
    [refresh, t],
  )

  const handleRepairSource = useCallback(
    async (sourceId: string) => {
      setError(null)
      const newRoot = await window.electronAPI.browseFolder()
      if (!newRoot) return
      const response = await window.electronAPI.discoveryCatalog.repairSourceRoot(sourceId, newRoot)
      if (!response.ok) setError(response.error || t('The operation failed.'))
      await refresh()
    },
    [refresh, t],
  )

  const handleRefineSubject = useCallback(async () => {
    if (!referenceImagePath) return
    setError(null)
    try {
      const detection = await window.electronAPI.subject.detect(referenceImagePath)
      if (!detection.ok) {
        setError(detection.error || t('Subject detection failed'))
        return
      }
      setSubjectPicker({
        imagePath: referenceImagePath,
        width: detection.width,
        height: detection.height,
        subjects: detection.subjects,
      })
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t('Subject detection failed'))
    }
  }, [referenceImagePath, t])

  const handleRemoteDownload = useCallback(
    async (item: Pick<UnifiedSearchResultItem, 'fileEntryId' | 'displayName'>) => {
      setError(null)
      setNotice(null)
      setDownloadPending(item.fileEntryId)
      try {
        const grant = await window.electronAPI.discoveryCatalog.createRemoteDownloadGrant(
          item.fileEntryId,
        )
        if (!grant.ok || !grant.token) {
          setError(grant.error || t('Download could not be queued'))
          return
        }
        const selection = await window.electronAPI.remoteTerminal.chooseDownloadDirectory()
        if (!selection.ok || !selection.token) return
        const queued = await window.electronAPI.remoteTerminal.enqueueCatalogDownload(
          grant.token,
          selection.token,
          'rename',
        )
        if (!queued.ok) {
          setError(queued.error || t('Download could not be queued'))
          return
        }
        setNotice(`${item.displayName}: ${t('download started')}`)
      } catch (requestError) {
        setError(
          requestError instanceof Error ? requestError.message : t('Download could not be queued'),
        )
      } finally {
        setDownloadPending(null)
      }
    },
    [t],
  )

  const handleCreateCollection = useCallback(async () => {
    const name = collectionName.trim()
    if (!name) return
    setCollectionPending(true)
    setError(null)
    try {
      const created = await window.electronAPI.assetLibrary.createCollection(name)
      setCollectionName('')
      await refreshCollections()
      notifyAssetCollectionsChanged()
      setSelectedCollectionId(created.id)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t('The operation failed.'))
    } finally {
      setCollectionPending(false)
    }
  }, [collectionName, refreshCollections, t])

  const handleDeleteCollection = useCallback(async () => {
    if (!selectedCollectionId || !window.confirm(t('Delete this collection?'))) return
    setCollectionPending(true)
    try {
      await window.electronAPI.assetLibrary.deleteCollection(selectedCollectionId)
      setCollectionItems([])
      await refreshCollections()
      notifyAssetCollectionsChanged()
    } finally {
      setCollectionPending(false)
    }
  }, [refreshCollections, selectedCollectionId, t])

  const handleRenameCollection = useCallback(async () => {
    if (!selectedCollectionId) return
    const current = collections.find((collection) => collection.id === selectedCollectionId)
    const name = collectionName.trim()
    if (!current || !name) return
    setCollectionPending(true)
    try {
      await window.electronAPI.assetLibrary.updateCollection(current.id, name)
      setCollectionName('')
      await refreshCollections()
      notifyAssetCollectionsChanged()
    } finally {
      setCollectionPending(false)
    }
  }, [collectionName, collections, refreshCollections, selectedCollectionId])

  const handleMoveCollection = useCallback(
    async (direction: -1 | 1) => {
      const index = collections.findIndex((collection) => collection.id === selectedCollectionId)
      const target = index + direction
      if (index < 0 || target < 0 || target >= collections.length) return
      const ordered = collections.map((collection) => collection.id)
      ;[ordered[index], ordered[target]] = [ordered[target], ordered[index]]
      setCollectionPending(true)
      try {
        await window.electronAPI.assetLibrary.reorderCollections(ordered)
        await refreshCollections()
        notifyAssetCollectionsChanged()
      } finally {
        setCollectionPending(false)
      }
    },
    [collections, refreshCollections, selectedCollectionId],
  )

  const handleCollect = useCallback(
    async (item: UnifiedSearchResultItem) => {
      if (!selectedCollectionId) return
      setCollectionPending(true)
      setError(null)
      try {
        await window.electronAPI.assetLibrary.addCollectionItem(
          selectedCollectionId,
          collectionInputFromResult(item),
        )
        setCollectionItems(
          await window.electronAPI.assetLibrary.listCollectionItems(selectedCollectionId),
        )
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : t('The operation failed.'))
      } finally {
        setCollectionPending(false)
      }
    },
    [selectedCollectionId, t],
  )

  const handleCollectSelected = useCallback(async () => {
    if (!selectedCollectionId || selectedResultIds.size === 0) return
    const selected = results.filter((item) => selectedResultIds.has(item.fileEntryId))
    setCollectionPending(true)
    setError(null)
    try {
      await window.electronAPI.assetLibrary.addCollectionItems(
        selectedCollectionId,
        selected.map(collectionInputFromResult),
      )
      setCollectionItems(
        await window.electronAPI.assetLibrary.listCollectionItems(selectedCollectionId),
      )
      setSelectedResultIds(new Set())
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t('The operation failed.'))
    } finally {
      setCollectionPending(false)
    }
  }, [results, selectedCollectionId, selectedResultIds, t])

  const handleRemoveCollected = useCallback(async (id: number) => {
    await window.electronAPI.assetLibrary.removeCollectionItem(id)
    setCollectionItems((items) => items.filter((item) => item.id !== id))
  }, [])

  const handleOpenCollected = useCallback(
    async (item: AssetCollectionItem) => {
      if (item.source.type === 'sftp') {
        if (item.fileEntryId) await handleRemoteDownload({ ...item, fileEntryId: item.fileEntryId })
        else setError(t('The operation failed.'))
      } else if (item.videoId) {
        await window.electronAPI.mediaSearch.openMediaAtTime({
          videoId: item.videoId,
          timestampMs: item.videoHitMs ?? 0,
        })
      } else {
        const result = await window.electronAPI.assetIdentity.openOriginal(
          item.assetId || item.displayPath,
        )
        if (!result.ok) setError(result.error || t('The operation failed.'))
      }
    },
    [handleRemoteDownload, t],
  )

  const sourceHealthItems = buildSourceHealthItems(sources, statuses, probes)

  return (
    <div ref={sectionRef} className="image-search-sources-content" data-testid="workspace-sources">
      <div className="image-search-sources-content__header">
        <span style={{ fontSize: 12, fontWeight: 600 }}>{t('Sources')}</span>
        <span style={{ fontSize: 11, opacity: 0.7 }}>
          {t('{count} sources', { count: sources.length })}
        </span>
      </div>

      <div id="image-search-sources-content-body" className="image-search-sources-content__body">
        <div
          className={`discovery-source-form ${sourceType === 'sftp' ? 'is-sftp' : ''}`}
          style={{ display: 'flex', gap: 6, alignItems: 'center' }}
        >
          <select
            className="discovery-source-type"
            value={sourceType}
            onChange={(event) =>
              setSourceType(event.target.value as 'local-ntfs' | 'mounted-network' | 'sftp')
            }
            aria-label={t('Source type')}
            style={{ fontSize: 11, padding: '2px 6px' }}
          >
            <option value="local-ntfs">{t('Local drive')}</option>
            <option value="mounted-network">{t('Mounted network')}</option>
            <option value="sftp">{t('SFTP source')}</option>
          </select>
          {sourceType === 'sftp' && (
            <select
              className="discovery-source-profile"
              value={sftpProfileId}
              onChange={(event) => setSftpProfileId(event.target.value)}
              aria-label={t('SFTP profile')}
              style={{ fontSize: 11, padding: '2px 6px', maxWidth: 140 }}
            >
              <option value="">{t('Select profile')}</option>
              {remoteProfiles.map((profile) => (
                <option key={profile.id} value={profile.id} disabled={!profile.hostFingerprint}>
                  {profile.name}
                </option>
              ))}
            </select>
          )}
          <input
            className="discovery-source-name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder={t('Name')}
            style={{ width: 110, fontSize: 11, padding: '2px 6px' }}
          />
          <input
            className="discovery-source-root"
            value={rootPath}
            onChange={(event) => setRootPath(event.target.value)}
            placeholder={sourceType === 'sftp' ? t('Remote root') : t('Root path')}
            style={{ flex: 1, fontSize: 11, padding: '2px 6px' }}
          />
          <button
            className="discovery-source-add"
            onClick={() => void handleAddSource()}
            disabled={
              !displayName.trim() || !rootPath.trim() || (sourceType === 'sftp' && !sftpProfileId)
            }
            style={{ fontSize: 11, padding: '2px 8px' }}
          >
            {t('Add source')}
          </button>
        </div>
        {error && <div style={{ fontSize: 11, color: '#e07070' }}>{error}</div>}
        {notice && <div style={{ fontSize: 11, color: '#62b47a' }}>{notice}</div>}

        <div
          data-testid="asset-collection-tray"
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes(COLLECTION_DRAG_TYPE)) event.preventDefault()
          }}
          onDrop={(event) => {
            event.preventDefault()
            const fileEntryId = event.dataTransfer.getData(COLLECTION_DRAG_TYPE)
            const item = results.find((result) => result.fileEntryId === fileEntryId)
            if (item) void handleCollect(item)
          }}
          style={{ border: '1px solid rgba(var(--date), 0.25)', borderRadius: 4, padding: 6 }}
        >
          <div
            className="asset-collection-toolbar"
            style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}
          >
            <strong style={{ fontSize: 11 }}>{t('Collection tray')}</strong>
            <select
              data-testid="asset-collection-select"
              value={selectedCollectionId}
              onChange={(event) => setSelectedCollectionId(Number(event.target.value))}
              style={{ maxWidth: 160, fontSize: 11 }}
            >
              <option value={0}>{t('Select collection')}</option>
              {collections.map((collection) => (
                <option key={collection.id} value={collection.id}>
                  {collection.name}
                </option>
              ))}
            </select>
            <input
              data-testid="asset-collection-name"
              value={collectionName}
              onChange={(event) => setCollectionName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleCreateCollection()
              }}
              placeholder={t('New collection name')}
              style={{ width: 140, fontSize: 11 }}
            />
            <button
              data-testid="asset-collection-create"
              onClick={() => void handleCreateCollection()}
              disabled={!collectionName.trim() || collectionPending}
              style={{ fontSize: 11 }}
            >
              {t('Create')}
            </button>
            <button
              data-testid="asset-collection-rename"
              onClick={() => void handleRenameCollection()}
              disabled={!selectedCollectionId || !collectionName.trim() || collectionPending}
              style={{ fontSize: 11 }}
            >
              {t('Rename')}
            </button>
            <button
              data-testid="asset-collection-move-up"
              onClick={() => void handleMoveCollection(-1)}
              disabled={
                collectionPending ||
                collections.findIndex((collection) => collection.id === selectedCollectionId) <= 0
              }
              title={t('Move up')}
              style={{ fontSize: 11 }}
            >
              ↑
            </button>
            <button
              data-testid="asset-collection-move-down"
              onClick={() => void handleMoveCollection(1)}
              disabled={
                collectionPending ||
                collections.findIndex((collection) => collection.id === selectedCollectionId) >=
                  collections.length - 1
              }
              title={t('Move down')}
              style={{ fontSize: 11 }}
            >
              ↓
            </button>
            <button
              onClick={() => void handleDeleteCollection()}
              disabled={!selectedCollectionId || collectionPending}
              style={{ fontSize: 11 }}
            >
              {t('Delete')}
            </button>
            <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.65 }}>
              {t('{count} collected items', { count: collectionItems.length })}
            </span>
          </div>
          {selectedCollectionId && collectionItems.length === 0 && (
            <div style={{ marginTop: 4, fontSize: 10, opacity: 0.6 }}>
              {t('Collect search results here without moving the originals.')}
            </div>
          )}
          {collectionItems.length > 0 && (
            <div style={{ marginTop: 4, maxHeight: 90, overflowY: 'auto' }}>
              {collectionItems.map((item) => (
                <div
                  key={item.id}
                  style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 10 }}
                >
                  <button
                    onClick={() => void handleOpenCollected(item)}
                    title={item.displayPath}
                    style={{ flex: 1, textAlign: 'left', fontSize: 10, overflow: 'hidden' }}
                  >
                    {item.displayName} ({item.source.name})
                  </button>
                  <span title={item.assetId || item.fileEntryId} style={{ opacity: 0.6 }}>
                    {t(item.assetId ? 'Stable AssetId' : 'Catalog EntryId')}
                  </span>
                  <button
                    onClick={() => void handleRemoveCollected(item.id)}
                    style={{ fontSize: 10 }}
                  >
                    {t('Remove')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div
          data-testid="source-health-center"
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}
        >
          <strong>{t('Source health')}</strong>
          <span style={{ marginLeft: 'auto', opacity: 0.66 }}>
            {t('{online} online · {attention} need attention', {
              online: sourceHealthItems.filter((source) => source.availability === 'online').length,
              attention: sourceHealthItems.filter((source) => source.availability !== 'online')
                .length,
            })}
          </span>
        </div>

        {sources.length === 0 ? (
          <div style={{ fontSize: 11, opacity: 0.6 }}>{t('No sources yet')}</div>
        ) : (
          sourceHealthItems.map((source) => {
            const status = statuses[source.id]
            const session = status?.session ?? null
            const running = status?.running === true
            return (
              <div
                key={source.id}
                style={{
                  border: '1px solid rgba(var(--date), 0.25)',
                  borderRadius: 4,
                  padding: '4px 6px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
              >
                <div
                  data-testid={`source-health-${source.id}`}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
                >
                  <span style={{ fontWeight: 600 }}>{source.displayName}</span>
                  <span style={{ opacity: 0.7 }}>
                    {t(availabilityKey[source.availability] || 'Unknown')}
                  </span>
                  <span style={{ opacity: 0.6 }}>
                    {t(sourceTypeKey[source.type] || 'Unknown')} ·{' '}
                    {t(scanCapabilityKey[source.scanCapability] || 'Unknown')}
                  </span>
                  <span style={{ opacity: 0.7 }}>
                    {t('{count} files', { count: source.fileCount })} ·{' '}
                    {formatBytes(source.totalBytes)}
                  </span>
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                    {running ? (
                      <button
                        onClick={() =>
                          void window.electronAPI.discoveryCatalog.cancelScan(source.id)
                        }
                        style={{ fontSize: 11, padding: '1px 6px' }}
                      >
                        {t('Cancel')}
                      </button>
                    ) : (
                      <button
                        onClick={() => void handleStartScan(source.id)}
                        style={{ fontSize: 11, padding: '1px 6px' }}
                      >
                        {t('Scan')}
                      </button>
                    )}
                    <button
                      onClick={() => void handleProbeSource(source.id)}
                      disabled={running || probePending === source.id}
                      style={{ fontSize: 11, padding: '1px 6px' }}
                    >
                      {t(source.primaryAction === 'reconnect' ? 'Reconnect' : 'Check connection')}
                    </button>
                    <button
                      onClick={() => void handleRemoveSource(source.id)}
                      disabled={running}
                      style={{ fontSize: 11, padding: '1px 6px' }}
                    >
                      {t('Remove')}
                    </button>
                    {source.canRepairRoot && (
                      <button
                        onClick={() => void handleRepairSource(source.id)}
                        disabled={running}
                        style={{ fontSize: 11, padding: '1px 6px' }}
                      >
                        {t('Repair path')}
                      </button>
                    )}
                  </span>
                </div>
                <div style={{ fontSize: 11, opacity: 0.7, wordBreak: 'break-all' }}>
                  {source.displayLocator}
                </div>
                <div
                  data-testid={`source-health-times-${source.id}`}
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 8,
                    fontSize: 10,
                    opacity: 0.66,
                  }}
                >
                  <span>
                    {t('Last successful scan')}:{' '}
                    {formatTimestamp(source.lastSuccessfulScanAt) || t('Never')}
                  </span>
                  <span>
                    {t('Last attempt')}: {formatTimestamp(source.lastAttemptAt) || t('Never')}
                  </span>
                  {source.incrementalWatch ? (
                    <span data-testid={`source-incremental-watch-${source.id}`}>
                      {t('Live updates')}:{' '}
                      {t(incrementalWatchStateKey[source.incrementalWatch.state])}
                      {source.incrementalWatch.pendingCount > 0
                        ? ` · ${t('{count} changes pending', {
                            count: source.incrementalWatch.pendingCount,
                          })}`
                        : ''}
                      {source.incrementalWatch.lastAppliedAt
                        ? ` · ${t('Last incremental update')}: ${formatTimestamp(source.incrementalWatch.lastAppliedAt)}`
                        : ''}
                    </span>
                  ) : null}
                </div>
                {source.detail && (
                  <div
                    data-testid={`source-health-detail-${source.id}`}
                    style={{ fontSize: 10, color: '#e0a260', wordBreak: 'break-word' }}
                  >
                    {t('Connection detail: {detail}', { detail: source.detail })}
                  </div>
                )}
                {session && (
                  <div style={{ fontSize: 11, opacity: 0.8 }}>
                    {t(sessionStateKey[session.state] || 'Unknown')} ·{' '}
                    {t('{count} files', { count: session.committedCount })}
                    {session.backend !== 'unknown' &&
                      ` · ${session.backend === 'usn' ? 'USN' : t('Directory enumeration')}`}
                    {session.fallbackReason && ` · ${t('Fallback')}: ${session.fallbackReason}`}
                  </div>
                )}
              </div>
            )
          })
        )}

        {enableEmbeddedSearch && (
          <>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('Search file names')}
              style={{ fontSize: 11, padding: '2px 6px' }}
            />
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button
                onClick={() => {
                  void window.electronAPI.imageSearch.selectImage().then((selected) => {
                    if (selected) {
                      setReferenceImagePath(selected)
                      setSubject(undefined)
                    }
                  })
                }}
                style={{ fontSize: 11, padding: '2px 8px' }}
              >
                {t('Reference image')}
              </button>
              {referenceImagePath && (
                <>
                  <button
                    onClick={() => void handleRefineSubject()}
                    style={{ fontSize: 11, padding: '2px 8px' }}
                  >
                    {t('Refine subject on the original image')}
                  </button>
                  {subject && (
                    <span style={{ fontSize: 11, opacity: 0.75 }}>
                      {t('Subject')}: {subject.label}
                    </span>
                  )}
                  <span
                    title={referenceImagePath}
                    style={{ flex: 1, fontSize: 11, opacity: 0.7, overflow: 'hidden' }}
                  >
                    {referenceImagePath}
                  </span>
                  <button
                    onClick={() => {
                      setReferenceImagePath('')
                      setSubject(undefined)
                    }}
                    style={{ fontSize: 11, padding: '2px 8px' }}
                  >
                    {t('Remove')}
                  </button>
                </>
              )}
            </div>
            {(query.trim() || referenceImagePath) && searchState?.degradedReason && (
              <div style={{ fontSize: 11, opacity: 0.75 }} title={searchState.actionableHint}>
                {searchState.aiEnhancement} · {searchState.degradedReason}
                {searchState.actionableHint && ` · ${searchState.actionableHint}`}
              </div>
            )}
            {(query.trim() || referenceImagePath) && (
              <div>
                {results.length > 0 && (
                  <button
                    data-testid="asset-collection-add-selected"
                    onClick={() => void handleCollectSelected()}
                    disabled={
                      !selectedCollectionId || selectedResultIds.size === 0 || collectionPending
                    }
                    style={{ fontSize: 11, marginBottom: 3 }}
                  >
                    {t('Collect selected')} ({selectedResultIds.size})
                  </button>
                )}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    maxHeight: 160,
                    overflowY: 'auto',
                  }}
                >
                  {results.length === 0 ? (
                    <div style={{ fontSize: 11, opacity: 0.6 }}>{t('No results')}</div>
                  ) : (
                    results.map((item) => (
                      <div
                        key={item.fileEntryId}
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = 'copy'
                          event.dataTransfer.setData(COLLECTION_DRAG_TYPE, item.fileEntryId)
                        }}
                        style={{ fontSize: 11, lineHeight: 1.4 }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <input
                            data-testid="unified-result-select"
                            type="checkbox"
                            checked={selectedResultIds.has(item.fileEntryId)}
                            onChange={(event) => {
                              setSelectedResultIds((current) => {
                                const next = new Set(current)
                                if (event.target.checked) next.add(item.fileEntryId)
                                else next.delete(item.fileEntryId)
                                return next
                              })
                            }}
                            aria-label={t('Select result')}
                          />
                          {item.mediaType === 'video' &&
                            (() => {
                              const frameId = item.videoHits?.find(
                                (hit) => hit.kind === 'visual' && hit.frameId,
                              )?.frameId
                              return frameId && videoPreviews[frameId] ? (
                                <img
                                  src={videoPreviews[frameId]}
                                  alt=""
                                  style={{
                                    width: 48,
                                    height: 32,
                                    objectFit: 'cover',
                                    borderRadius: 3,
                                  }}
                                />
                              ) : null
                            })()}
                          {remotePreviews[
                            `${item.fileEntryId}:${item.modifiedAt}:${item.sizeBytes}`
                          ] && (
                            <img
                              src={
                                remotePreviews[
                                  `${item.fileEntryId}:${item.modifiedAt}:${item.sizeBytes}`
                                ]
                              }
                              alt=""
                              style={{
                                width: 36,
                                height: 36,
                                objectFit: 'cover',
                                borderRadius: 3,
                              }}
                            />
                          )}
                          <span style={{ fontWeight: 600 }}>{item.displayName}</span>
                          <span style={{ opacity: 0.7 }}>
                            {' '}
                            · {formatBytes(item.sizeBytes)} · {item.source.name}
                            {' · '}
                            {t(resultIndexLabel(item.indexState))}
                            {item.degradedReason === 'remote-content-required' &&
                              ` · ${t('Remote original required')}`}
                          </span>
                          {item.source.type === 'sftp' && (
                            <button
                              onClick={() => void handleRemoteDownload(item)}
                              disabled={downloadPending === item.fileEntryId}
                              style={{ marginLeft: 'auto', fontSize: 11, padding: '1px 6px' }}
                            >
                              {t('Download')}
                            </button>
                          )}
                          <button
                            data-testid="asset-collection-add"
                            onClick={() => void handleCollect(item)}
                            disabled={!selectedCollectionId || collectionPending}
                            style={{ fontSize: 11, padding: '1px 6px' }}
                          >
                            {t('Collect')}
                          </button>
                        </div>
                        <div style={{ opacity: 0.6, wordBreak: 'break-all' }}>
                          {item.displayPath}
                        </div>
                        {item.mediaType === 'video' && (
                          <div
                            style={{
                              display: 'flex',
                              gap: 4,
                              alignItems: 'center',
                              flexWrap: 'wrap',
                            }}
                          >
                            {item.durationMs !== undefined && (
                              <span style={{ opacity: 0.7 }}>
                                {t('Duration')}: {formatDuration(item.durationMs)}
                              </span>
                            )}
                            {item.videoId &&
                              item.videoHits?.map((hit, index) => {
                                const evidence = videoHitEvidenceLabelKeys(hit).map((key) => t(key))
                                const model = videoHitModelLabel(hit)
                                return (
                                  <button
                                    key={`${hit.kind}:${hit.timestampMs}:${hit.frameId ?? index}`}
                                    onClick={() =>
                                      void window.electronAPI.mediaSearch.openMediaAtTime({
                                        videoId: item.videoId!,
                                        timestampMs: hit.timestampMs,
                                      })
                                    }
                                    title={[
                                      hit.text,
                                      `${t('Evidence')}: ${evidence.join(' + ')}`,
                                      model,
                                    ]
                                      .filter(Boolean)
                                      .join('\n')}
                                    style={{ fontSize: 10, padding: '1px 5px' }}
                                  >
                                    {t(videoHitLabelKey(hit))} · {formatDuration(hit.timestampMs)} ·{' '}
                                    {t('Evidence')}: {evidence.join(' + ')}
                                    {model ? ` · ${t('AI generated')}: ${model}` : ''}
                                  </button>
                                )
                              })}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                  {resultTotal > results.length && (
                    <div style={{ fontSize: 11, opacity: 0.6 }}>
                      {t('{count} results total', { count: resultTotal })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
      {subjectPicker && (
        <SubjectPickerModal
          data={subjectPicker}
          enableSegmentation={false}
          onPick={(selectedSubject) => {
            setSubject(selectedSubject)
            setSubjectPicker(null)
          }}
          onSegment={(bbox) => {
            setSubject({ ...bbox, confidence: 1, label: 'manual' })
            setSubjectPicker(null)
          }}
          onAuto={() => {
            setSubject(undefined)
            setSubjectPicker(null)
          }}
          onCancel={() => setSubjectPicker(null)}
        />
      )}
    </div>
  )
}

export default DiscoverySourcesSection
