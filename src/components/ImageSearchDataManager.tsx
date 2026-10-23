import React, { useCallback, useEffect, useState } from 'react'
import type {
  ImageSearchDataRecord,
  ImageSearchFolderDataEditPreview,
  ImageSearchFolderDataEditProgress,
  ImageSearchFolderDataLayer,
  ThumbnailRebuildBackend,
  ThumbnailRebuildProgress,
} from '../../shared/ipc-contract'
import { useTranslation } from '../i18n/useTranslation'
import { imageSearchBridge } from '../services/imageSearchBridge'
import ImageSearchDataOverview from './ImageSearchDataOverview'
import { useStore } from '../stores/useStore'

interface ImageSearchDataManagerProps {
  scanPaths: string[]
  disabled?: boolean
  standalone?: boolean
  onChanged: () => void
  showToast: (message: string, type?: 'ok' | 'err') => void
}

const IDLE_REBUILD: ThumbnailRebuildProgress = {
  state: 'idle',
  total: 0,
  completed: 0,
  skipped: 0,
  failed: 0,
}

const IDLE_FOLDER_EDIT: ImageSearchFolderDataEditProgress = {
  state: 'idle',
  processedBytes: 0,
  totalBytes: 0,
  removedRecords: 0,
}

const THUMBNAIL_GPU_JOB_OPTIONS = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]
const THUMBNAIL_BATCH_OPTIONS = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

// Candidate prefixes for path-like stats queries: the term itself, then each
// ancestor folder, capped at 8 levels and never shorter than the drive root.
// File paths (e.g. ending in an extension like .png) work the same way — the
// chain always starts from the term, so no extension special-casing is needed.
function statsPrefixChain(term: string): string[] {
  const chain: string[] = []
  let current = term.replace(/\\+$/, '')
  for (let depth = 0; depth < 8 && current; depth += 1) {
    chain.push(current)
    const cut = current.lastIndexOf('\\')
    if (cut <= 2) break
    current = current.slice(0, cut)
  }
  return chain
}

const ImageSearchDataManager: React.FC<ImageSearchDataManagerProps> = ({
  scanPaths,
  disabled = false,
  standalone = false,
  onChanged,
  showToast,
}) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(standalone)
  const [advancedOpen, setAdvancedOpen] = useState(!standalone)
  const [query, setQuery] = useState('')
  const [records, setRecords] = useState<ImageSearchDataRecord[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [selectedFolder, setSelectedFolder] = useState('')
  const [folderDeleteArmed, setFolderDeleteArmed] = useState(false)
  const [folderEditLayers, setFolderEditLayers] = useState<
    Record<ImageSearchFolderDataLayer, boolean>
  >({ native: true, dino: true, clip: true })
  const [folderEditPreview, setFolderEditPreview] =
    useState<ImageSearchFolderDataEditPreview | null>(null)
  const [folderEditProgress, setFolderEditProgress] =
    useState<ImageSearchFolderDataEditProgress>(IDLE_FOLDER_EDIT)
  const [folderStats, setFolderStats] = useState<
    Record<string, { count: number; totalBytes: number }>
  >({})
  const [queryStats, setQueryStats] = useState<{
    term: string
    prefix: string
    count: number
    totalBytes: number
  } | null>(null)
  const [dirNameStats, setDirNameStats] = useState<{
    name: string
    count: number
    totalBytes: number
  } | null>(null)
  const [dirNameDeleteArmed, setDirNameDeleteArmed] = useState(false)
  const [selectedPath, setSelectedPath] = useState('')
  const [replacementPath, setReplacementPath] = useState('')
  const [loading, setLoading] = useState(false)
  const [deleteArmed, setDeleteArmed] = useState(false)
  const [clearCacheArmed, setClearCacheArmed] = useState(false)
  const [rebuild, setRebuild] = useState<ThumbnailRebuildProgress>(IDLE_REBUILD)
  const rebuildBackend = useStore(
    (state) => state.imageSearchUiPreferences.thumbnailRebuildBackend,
  ) as ThumbnailRebuildBackend
  const thumbnailGpuJobs = useStore((state) => state.imageSearchUiPreferences.thumbnailGpuJobs)
  const thumbnailBatchSize = useStore((state) => state.imageSearchUiPreferences.thumbnailBatchSize)
  const setImageSearchUiPreferences = useStore((state) => state.setImageSearchUiPreferences)

  const selected = records.find((record) => record.path === selectedPath)
  const loadFolderStats = useCallback(async () => {
    const entries = await Promise.all(
      scanPaths.map(
        async (folder) => [folder, await imageSearchBridge.getDataStats(folder)] as const,
      ),
    )
    const next: Record<string, { count: number; totalBytes: number }> = {}
    for (const [folder, stats] of entries) {
      // Failures stay silent: the folder row just shows no aggregate line.
      if (stats.ok) next[folder] = { count: stats.count || 0, totalBytes: stats.totalBytes || 0 }
    }
    setFolderStats(next)
  }, [scanPaths])

  const runQuery = useCallback(
    async (overrideQuery?: string) => {
      const term = (overrideQuery ?? query).trim().replace(/\/+/g, '\\')
      setLoading(true)
      try {
        const pathLike = term.includes(':\\') || term.startsWith('\\')
        const result = await imageSearchBridge.queryData(term, 0, 200)
        let nextStats: { term: string; prefix: string; count: number; totalBytes: number } | null =
          null
        if (pathLike) {
          // Walk the term and its ancestor folders; keep the first prefix that
          // actually has indexed records, else fall back to the last reply.
          let fallback: { term: string; prefix: string; count: number; totalBytes: number } | null =
            null
          for (const prefix of statsPrefixChain(term)) {
            const stats = await imageSearchBridge.getDataStats(prefix)
            if (!stats.ok) continue
            const entry = {
              term,
              prefix,
              count: stats.count || 0,
              totalBytes: stats.totalBytes || 0,
            }
            fallback = entry
            if (entry.count > 0) {
              nextStats = entry
              break
            }
          }
          if (!nextStats) nextStats = fallback
        }
        setQueryStats(nextStats)
        // Directory-name mode: a bare name (no path separator) also reports the
        // aggregate of every same-named directory, wherever it was indexed.
        let nextDirNameStats: { name: string; count: number; totalBytes: number } | null = null
        if (term && !term.includes('\\')) {
          const dirStats = await imageSearchBridge.getDirNameStats(term)
          if (dirStats.ok) {
            nextDirNameStats = {
              name: term,
              count: dirStats.count || 0,
              totalBytes: dirStats.totalBytes || 0,
            }
          }
        }
        setDirNameStats(nextDirNameStats)
        setDirNameDeleteArmed(false)
        if (!result.ok) {
          showToast(result.error || t('Unable to query indexed data'), 'err')
          return
        }
        const nextRecords = result.records || []
        setRecords(nextRecords)
        setHasMore(Boolean(result.hasMore))
        if (!nextRecords.some((record) => record.path === selectedPath)) {
          setSelectedPath(nextRecords[0]?.path || '')
        }
      } finally {
        setLoading(false)
      }
    },
    [query, selectedPath, showToast, t],
  )

  const loadMore = async () => {
    setLoading(true)
    try {
      const result = await imageSearchBridge.queryData(query.trim(), records.length, 200)
      if (!result.ok) {
        showToast(result.error || t('Unable to query indexed data'), 'err')
        return
      }
      setRecords((current) => [...current, ...(result.records || [])])
      setHasMore(Boolean(result.hasMore))
    } finally {
      setLoading(false)
    }
  }

  const toggleFolder = (folder: string) => {
    if (selectedFolder === folder) {
      setSelectedFolder('')
      setFolderDeleteArmed(false)
      setFolderEditPreview(null)
      setFolderEditProgress(IDLE_FOLDER_EDIT)
      return
    }
    setSelectedFolder(folder)
    setFolderDeleteArmed(false)
    setFolderEditPreview(null)
    setFolderEditProgress(IDLE_FOLDER_EDIT)
    setQuery(folder)
    void runQuery(folder)
  }

  const selectFolderForEdit = (folder: string) => {
    let normalized = folder.trim().replace(/\/+/g, '\\')
    if (!/^[a-zA-Z]:\\$/.test(normalized)) normalized = normalized.replace(/\\+$/, '')
    if (!normalized) return
    setAdvancedOpen(true)
    setSelectedFolder(normalized)
    setFolderDeleteArmed(false)
    setFolderEditPreview(null)
    setFolderEditProgress(IDLE_FOLDER_EDIT)
  }

  const selectedFolderLayers = (): ImageSearchFolderDataLayer[] =>
    (['native', 'dino', 'clip'] as const).filter((layer) => folderEditLayers[layer])

  const setFolderLayer = (layer: ImageSearchFolderDataLayer, checked: boolean) => {
    setFolderEditLayers((current) => ({ ...current, [layer]: checked }))
    setFolderDeleteArmed(false)
    setFolderEditPreview(null)
    setFolderEditProgress(IDLE_FOLDER_EDIT)
  }

  const runWithFolderProgress = async <T,>(operation: () => Promise<T>): Promise<T> => {
    const refresh = () => {
      void imageSearchBridge.getFolderDataEditProgress().then(setFolderEditProgress)
    }
    refresh()
    const timer = window.setInterval(refresh, 500)
    try {
      return await operation()
    } finally {
      window.clearInterval(timer)
      setFolderEditProgress(await imageSearchBridge.getFolderDataEditProgress())
    }
  }

  const deleteSelectedFolder = async () => {
    if (!selectedFolder) return
    const layers = selectedFolderLayers()
    if (layers.length === 0) {
      showToast(t('Select at least one index layer'), 'err')
      return
    }
    setLoading(true)
    try {
      if (!folderDeleteArmed || !folderEditPreview?.token) {
        const preview = await runWithFolderProgress(() =>
          imageSearchBridge.previewFolderDataEdit(selectedFolder, layers),
        )
        if (!preview.ok) {
          showToast(preview.error || t('Folder index analysis failed'), 'err')
          return
        }
        setFolderEditPreview(preview)
        setFolderDeleteArmed(true)
        return
      }
      const result = await runWithFolderProgress(() =>
        imageSearchBridge.executeFolderDataEdit(folderEditPreview.token!),
      )
      if (!result.ok) {
        showToast(result.error || t('Delete failed'), 'err')
        // Execute tokens are one-shot even when a shard changed or finalization
        // failed. Return to analysis instead of repeatedly submitting a dead token.
        setFolderDeleteArmed(false)
        setFolderEditPreview(null)
      } else {
        const summary = t('Folder index data deleted: Native {native}, DINO {dino}, CLIP {clip}', {
          native: result.removed?.native || 0,
          dino: result.removed?.dino || 0,
          clip: result.removed?.clip || 0,
        })
        const warnings = (result.warnings || []).filter(Boolean).join('; ')
        showToast(
          warnings ? t('{summary} Warnings: {warnings}', { summary, warnings }) : summary,
          warnings ? 'err' : undefined,
        )
        setSelectedFolder('')
        setFolderDeleteArmed(false)
        setFolderEditPreview(null)
        setRecords([])
        setSelectedPath('')
        setHasMore(false)
        setQueryStats(null)
        void loadFolderStats()
        onChanged()
      }
    } finally {
      setLoading(false)
    }
  }

  const cancelFolderEdit = async () => {
    await imageSearchBridge.cancelFolderDataEdit()
  }

  const deleteDirNameRecords = async () => {
    if (!dirNameStats) return
    if (!dirNameDeleteArmed) {
      setDirNameDeleteArmed(true)
      return
    }
    setLoading(true)
    try {
      const result = await imageSearchBridge.deleteDirName(dirNameStats.name)
      if (!result.ok) showToast(result.error || t('Delete failed'), 'err')
      else {
        showToast(
          t(
            "Deleted {count} index records for directory name '{name}'; rebuild DINO/CLIP embeddings manually if needed",
            { count: result.removedCount || 0, name: dirNameStats.name },
          ),
        )
        setDirNameStats(null)
        setDirNameDeleteArmed(false)
        setRecords([])
        setSelectedPath('')
        setHasMore(false)
        setQueryStats(null)
        void loadFolderStats()
        onChanged()
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open || !advancedOpen) return
    void runQuery()
    void loadFolderStats()
    void imageSearchBridge.getThumbnailRebuildProgress().then(setRebuild)
  }, [open, advancedOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (rebuild.state !== 'running' && rebuild.state !== 'stopping') return
    const timer = window.setInterval(() => {
      void imageSearchBridge.getThumbnailRebuildProgress().then(setRebuild)
    }, 500)
    return () => window.clearInterval(timer)
  }, [rebuild.state])

  useEffect(() => {
    setDeleteArmed(false)
    setReplacementPath('')
  }, [selectedPath])

  const updateSelected = async () => {
    if (!selectedPath) return
    setLoading(true)
    try {
      const result = await imageSearchBridge.updateData(selectedPath)
      if (!result.ok) showToast(result.error || t('Update failed'), 'err')
      else {
        showToast(t('Indexed data updated and saved'))
        await runQuery()
        void loadFolderStats()
        onChanged()
      }
    } finally {
      setLoading(false)
    }
  }

  const deleteSelected = async () => {
    if (!selectedPath) return
    if (!deleteArmed) {
      setDeleteArmed(true)
      return
    }
    setLoading(true)
    try {
      const result = await imageSearchBridge.deleteData(selectedPath)
      if (!result.ok) showToast(result.error || t('Delete failed'), 'err')
      else {
        showToast(t('Index record deleted; source file was not changed'))
        setSelectedPath('')
        setDeleteArmed(false)
        await runQuery()
        void loadFolderStats()
        onChanged()
      }
    } finally {
      setLoading(false)
    }
  }

  const chooseReplacement = async () => {
    const filePath = await imageSearchBridge.selectImage()
    if (filePath) setReplacementPath(filePath)
  }

  const repairSelectedPath = async () => {
    if (!selectedPath || !replacementPath.trim()) return
    setLoading(true)
    try {
      const result = await imageSearchBridge.repairDataPath(selectedPath, replacementPath.trim())
      if (!result.ok) showToast(result.error || t('Path repair failed'), 'err')
      else {
        showToast(t('Source path repaired and index saved'))
        setQuery(replacementPath.trim())
        setSelectedPath(replacementPath.trim())
        setReplacementPath('')
        await runQuery()
        void loadFolderStats()
        onChanged()
      }
    } finally {
      setLoading(false)
    }
  }

  const startRebuild = async (paths: string[]) => {
    if (paths.length === 0) {
      showToast(t('No source path selected for thumbnail rebuild'), 'err')
      return
    }
    const result = await imageSearchBridge.startThumbnailRebuild(
      paths,
      rebuildBackend,
      thumbnailGpuJobs,
      thumbnailBatchSize,
    )
    if (!result.ok) showToast(result.error || t('Thumbnail rebuild could not start'), 'err')
    else {
      setRebuild(result.progress || IDLE_REBUILD)
      showToast(
        rebuildBackend === 'native'
          ? t('Native C++ thumbnail rebuild started ({count} workers)', {
              count: thumbnailGpuJobs,
            })
          : rebuildBackend === 'cuda'
            ? t('CUDA thumbnail rebuild requested ({count} workers)', {
                count: thumbnailGpuJobs,
              })
            : rebuildBackend === 'cpu'
              ? t('CPU thumbnail rebuild started')
              : rebuildBackend === 'auto'
                ? t('Adaptive thumbnail rebuild started ({jobs} GPU jobs, batch {batch})', {
                    jobs: thumbnailGpuJobs,
                    batch: thumbnailBatchSize,
                  })
                : t('GPU thumbnail rebuild started ({jobs} jobs, batch {batch})', {
                    jobs: thumbnailGpuJobs,
                    batch: thumbnailBatchSize,
                  }),
      )
    }
  }

  const stopRebuild = async () => {
    setRebuild(await imageSearchBridge.stopThumbnailRebuild())
  }

  const clearThumbnailCache = async () => {
    if (!clearCacheArmed) {
      setClearCacheArmed(true)
      return
    }
    const result = await imageSearchBridge.clearThumbnailCache(true)
    if (!result.ok) showToast(result.error || t('Thumbnail cache cleanup failed'), 'err')
    else {
      showToast(t('Old thumbnail cache retired; background cleanup started'))
      setClearCacheArmed(false)
    }
  }

  const rebuildProcessed = rebuild.completed + rebuild.failed
  const rebuildPercent =
    rebuild.total > 0 ? Math.min(100, Math.round((rebuildProcessed / rebuild.total) * 100)) : 0
  const rebuildElapsedSeconds = rebuild.startedAt
    ? Math.max(0.001, ((rebuild.finishedAt || Date.now()) - rebuild.startedAt) / 1000)
    : 0
  const rebuildRate =
    rebuildElapsedSeconds > 0 ? (rebuildProcessed / rebuildElapsedSeconds).toFixed(1) : '0.0'
  const folderEditActive = ['previewing', 'rewriting', 'finalizing'].includes(
    folderEditProgress.state,
  )
  const folderEditPercent =
    folderEditProgress.totalBytes > 0
      ? Math.min(
          100,
          Math.round((folderEditProgress.processedBytes / folderEditProgress.totalBytes) * 100),
        )
      : 0
  const normalizedQueryPath = query.trim().replace(/\/+/g, '\\')
  const queryLooksLikePath =
    normalizedQueryPath.includes(':\\') || normalizedQueryPath.startsWith('\\')

  return (
    <div className="image-search-data-manager" data-standalone={standalone}>
      {!standalone && (
        <button
          data-testid="image-search-data-manager-toggle"
          className="image-search-data-manager__toggle"
          type="button"
          onClick={() => setOpen((value) => !value)}
          disabled={disabled}
        >
          {open ? t('Close Data Editor') : t('Data Editor Manager')}
        </button>
      )}

      {open && (
        <div
          className="image-search-data-manager__body"
          style={{
            marginTop: 6,
            padding: 8,
            border: '1px solid rgba(120,180,255,0.35)',
            borderRadius: 6,
            background: 'rgb(var(--color-surface))',
            display: 'grid',
            gap: 7,
            maxHeight: '45vh',
            overflow: 'auto',
          }}
        >
          <ImageSearchDataOverview
            disabled={disabled || loading}
            onManageFolder={selectFolderForEdit}
            showToast={showToast}
          />

          <details
            className="workspace-advanced-maintenance"
            open={advancedOpen}
            onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
          >
            <summary>{t('Advanced index tools')}</summary>
            <p>
              {t(
                'Inspect records, repair paths, or rebuild thumbnails. Review the selected scope before changing index data.',
              )}
            </p>
            <div className="workspace-advanced-maintenance__content">
              {scanPaths.length > 0 && (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, opacity: 0.62 }}>{t('Source Folders')}:</span>
                  {scanPaths.map((folder) => (
                    <button
                      type="button"
                      key={folder}
                      onClick={() => toggleFolder(folder)}
                      disabled={loading}
                      title={folder}
                      style={{
                        fontSize: 12,
                        maxWidth: 180,
                        overflow: 'hidden',
                        background: selectedFolder === folder ? 'rgba(80,150,255,0.28)' : undefined,
                      }}
                    >
                      <span
                        style={{
                          display: 'block',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {folder}
                      </span>
                      {folderStats[folder] && (
                        <span style={{ display: 'block', opacity: 0.72 }}>
                          {t('{count} records · {size}', {
                            count: folderStats[folder].count.toLocaleString(),
                            size: formatBytes(folderStats[folder].totalBytes),
                          })}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', gap: 5 }}>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void runQuery()
                  }}
                  placeholder={t('Filter indexed path (empty shows first 200)')}
                  style={{ flex: 1, minWidth: 0, fontSize: 12 }}
                />
                <button type="button" onClick={() => void runQuery()} disabled={loading}>
                  {t('Search')}
                </button>
                {queryLooksLikePath && (
                  <button
                    type="button"
                    onClick={() => selectFolderForEdit(query)}
                    disabled={disabled || loading || folderEditActive}
                    title={t('Manage every selected index layer under this exact path')}
                  >
                    {t('Manage Folder Indexes')}
                  </button>
                )}
              </div>

              {queryStats && (
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                  {queryStats.count > 0 && queryStats.prefix !== queryStats.term
                    ? t('{prefix} · Total: {count} records · {size}', {
                        prefix: queryStats.prefix,
                        count: queryStats.count.toLocaleString(),
                        size: formatBytes(queryStats.totalBytes),
                      })
                    : t('Total: {count} records · {size}', {
                        count: queryStats.count.toLocaleString(),
                        size: formatBytes(queryStats.totalBytes),
                      })}
                </div>
              )}

              {selectedFolder && (
                <div
                  data-testid="image-search-folder-index-editor"
                  style={{
                    display: 'grid',
                    gap: 6,
                    padding: 7,
                    border: '1px solid rgba(120,180,255,0.28)',
                    borderRadius: 5,
                    background: 'rgba(30,55,90,0.16)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <strong style={{ fontSize: 12 }}>{t('Folder Index Editor')}</strong>
                    <span
                      title={selectedFolder}
                      style={{
                        minWidth: 0,
                        flex: 1,
                        fontSize: 12,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        opacity: 0.82,
                      }}
                    >
                      {selectedFolder}
                    </span>
                    <button
                      type="button"
                      onClick={() => toggleFolder(selectedFolder)}
                      disabled={folderEditActive}
                      style={{ fontSize: 12 }}
                    >
                      {t('Close')}
                    </button>
                  </div>

                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                    {(['native', 'dino', 'clip'] as const).map((layer) => (
                      <label key={layer} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <input
                          type="checkbox"
                          checked={folderEditLayers[layer]}
                          onChange={(event) => setFolderLayer(layer, event.target.checked)}
                          disabled={folderEditActive}
                        />
                        <span style={{ fontSize: 12 }}>
                          {layer === 'native' ? t('Native / Hash') : layer.toUpperCase()}
                        </span>
                      </label>
                    ))}
                    <span style={{ fontSize: 12, opacity: 0.65 }}>
                      {t('Source images are never deleted')}
                    </span>
                  </div>

                  {folderEditPreview?.ok && (
                    <>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                          gap: 5,
                        }}
                      >
                        {(['native', 'dino', 'clip'] as const).map((layer) => {
                          const stats = folderEditPreview[layer]
                          return (
                            <div
                              key={layer}
                              style={{
                                padding: '5px 6px',
                                border: '1px solid rgba(255,255,255,0.1)',
                                borderRadius: 4,
                                fontSize: 12,
                              }}
                            >
                              <strong>
                                {layer === 'native' ? t('Native / Hash') : layer.toUpperCase()}
                              </strong>
                              <div style={{ marginTop: 2, opacity: 0.78 }}>
                                {t('{count} images · {records} rows · {size}', {
                                  count: (stats?.count || 0).toLocaleString(),
                                  records: (stats?.recordCount || 0).toLocaleString(),
                                  size: formatBytes(stats?.matchedBytes || 0),
                                })}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.68 }}>
                        {t(
                          'Atomic vector rewrite may need {size} temporary space. DINO/CLIP caches rebuild automatically; recovery backups are kept for 7 days.',
                          { size: formatBytes(folderEditPreview.temporaryBytes || 0) },
                        )}
                      </div>
                    </>
                  )}

                  {(folderEditActive || folderEditProgress.state === 'error') && (
                    <div style={{ display: 'grid', gap: 3 }}>
                      <div style={{ fontSize: 12, opacity: 0.78 }}>
                        {folderEditProgress.state === 'previewing'
                          ? t('Analyzing DINO/CLIP vector shards')
                          : folderEditProgress.state === 'rewriting'
                            ? t('Rewriting selected vector shards')
                            : folderEditProgress.state === 'finalizing'
                              ? t('Invalidating caches and updating Native index')
                              : folderEditProgress.error || t('Folder index operation failed')}
                        {folderEditProgress.currentFile
                          ? ` · ${folderEditProgress.currentFile}`
                          : ''}
                      </div>
                      <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                        <progress value={folderEditPercent} max={100} style={{ flex: 1 }} />
                        <span style={{ fontSize: 12 }}>{folderEditPercent}%</span>
                      </div>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={() => void deleteSelectedFolder()}
                      disabled={loading || disabled || selectedFolderLayers().length === 0}
                      style={{ color: folderDeleteArmed ? 'rgb(255,110,100)' : undefined }}
                      title={t(
                        'Deletes selected index data under this folder only. Source images are never deleted.',
                      )}
                    >
                      {folderDeleteArmed
                        ? t('Confirm Delete Selected Index Data')
                        : t('Analyze Selected Index Layers')}
                    </button>
                    {folderEditActive && folderEditProgress.state !== 'finalizing' && (
                      <button type="button" onClick={() => void cancelFolderEdit()}>
                        {t('Cancel')}
                      </button>
                    )}
                    {!folderEditPreview && (
                      <span style={{ fontSize: 12, opacity: 0.62 }}>
                        {t(
                          'DINO/CLIP analysis reads the large vector shards and can take some time.',
                        )}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {dirNameStats && (
                <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, opacity: 0.75 }}>
                    {t("Directory name '{name}': Total: {count} records · {size}", {
                      name: dirNameStats.name,
                      count: dirNameStats.count.toLocaleString(),
                      size: formatBytes(dirNameStats.totalBytes),
                    })}
                  </span>
                  {dirNameStats.count > 0 && (
                    <button
                      type="button"
                      onClick={() => void deleteDirNameRecords()}
                      disabled={loading || disabled}
                      style={{
                        fontSize: 12,
                        color: dirNameDeleteArmed ? 'rgb(255,110,100)' : undefined,
                      }}
                      title={t(
                        'Deletes index records under every folder with this name, at any location. Source images are never deleted.',
                      )}
                    >
                      {dirNameDeleteArmed
                        ? t(
                            "Removes {count} index records ({size}) from every folder named '{name}'; source files are not deleted",
                            {
                              name: dirNameStats.name,
                              count: dirNameStats.count.toLocaleString(),
                              size: formatBytes(dirNameStats.totalBytes),
                            },
                          )
                        : t('Delete By Directory Name')}
                    </button>
                  )}
                </div>
              )}

              <div
                style={{
                  maxHeight: 150,
                  overflow: 'auto',
                  border: '1px solid rgba(255,255,255,0.1)',
                }}
              >
                {records.length === 0 ? (
                  <div style={{ padding: 8, opacity: 0.6, fontSize: 12 }}>
                    {t('No matching records')}
                  </div>
                ) : (
                  records.map((record) => (
                    <button
                      type="button"
                      key={record.path}
                      onClick={() => setSelectedPath(record.path)}
                      title={record.path}
                      style={{
                        display: 'grid',
                        width: '100%',
                        gridTemplateColumns: '14px 1fr auto',
                        gap: 5,
                        padding: '4px 5px',
                        textAlign: 'left',
                        border: 0,
                        borderBottom: '1px solid rgba(255,255,255,0.06)',
                        background:
                          selectedPath === record.path ? 'rgba(80,150,255,0.22)' : 'transparent',
                        color: record.exists ? 'inherit' : 'rgb(255,130,120)',
                        fontSize: 12,
                      }}
                    >
                      <span>{record.exists ? '●' : '×'}</span>
                      <span
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {record.path}
                      </span>
                      <span>
                        {record.width}×{record.height} · {formatBytes(record.fileSize)}
                      </span>
                    </button>
                  ))
                )}
              </div>

              {hasMore && (
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={loading}
                  style={{ fontSize: 12 }}
                >
                  {t('Load More')} ({records.length}+)
                </button>
              )}

              {selected && (
                <div style={{ fontSize: 12, opacity: 0.78, wordBreak: 'break-all' }}>
                  {t('Selected')}: {selected.path}
                  {!selected.exists && ` ${t('(source missing)')}`}
                </div>
              )}

              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={() => void updateSelected()}
                  disabled={loading || !selected?.exists}
                  title={t('Re-read this source image, recalculate hashes, and save the index')}
                >
                  {t('Update Selected')}
                </button>
                <button
                  type="button"
                  onClick={() => void deleteSelected()}
                  disabled={loading || !selectedPath}
                  style={{ color: deleteArmed ? 'rgb(255,110,100)' : undefined }}
                  title={t('Deletes only the index record. The source image is never deleted.')}
                >
                  {deleteArmed ? t('Confirm Index Delete') : t('Delete From Index')}
                </button>
              </div>
              <div style={{ fontSize: 11, opacity: 0.58 }}>
                {t(
                  'Index edits are saved immediately. If image content changed, rebuild its DINO/CLIP embeddings afterward.',
                )}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 5 }}>
                <input
                  value={replacementPath}
                  onChange={(event) => setReplacementPath(event.target.value)}
                  placeholder={t('New source path for selected missing/moved image')}
                  style={{ minWidth: 0, fontSize: 12 }}
                />
                <button type="button" onClick={() => void chooseReplacement()}>
                  {t('Browse')}
                </button>
                <button
                  type="button"
                  onClick={() => void repairSelectedPath()}
                  disabled={loading || !selectedPath || !replacementPath.trim()}
                  style={{ gridColumn: '1 / -1' }}
                  title={t(
                    'Requires the new file to have the same byte size as the indexed source',
                  )}
                >
                  {t('Repair Selected Path')}
                </button>
              </div>

              <div
                style={{
                  paddingTop: 6,
                  borderTop: '1px solid rgba(255,255,255,0.1)',
                  display: 'grid',
                  gap: 5,
                }}
              >
                <strong style={{ fontSize: 12 }}>{t('Rebuild Optimized Thumbnails')}</strong>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                    {t('Acceleration')}
                    <select
                      value={rebuildBackend}
                      disabled={rebuild.state === 'running' || rebuild.state === 'stopping'}
                      onChange={(event) => {
                        const value = event.target.value as ThumbnailRebuildBackend
                        setImageSearchUiPreferences({ thumbnailRebuildBackend: value })
                      }}
                      title={t(
                        'Native C++ streams JPEG decode/resize/encode through WIC. CUDA requires a compatible Toolkit and nvJPEG runtime.',
                      )}
                    >
                      <option value="native">{t('Native C++ (JPEG fast)')}</option>
                      <option value="cuda">{t('CUDA / nvJPEG preferred')}</option>
                      <option value="auto">{t('Auto (adaptive CPU/GPU)')}</option>
                      <option value="gpu">{t('GPU preferred')}</option>
                      <option value="cpu">{t('CPU only')}</option>
                    </select>
                  </label>
                  <label
                    style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}
                    title={t(
                      'Parallel GPU pipeline jobs. Up to 8 physical GPU contexts are reused. Higher values use more RAM.',
                    )}
                  >
                    {rebuildBackend === 'native' || rebuildBackend === 'cuda'
                      ? t('Workers')
                      : t('GPU Jobs')}
                    <select
                      value={thumbnailGpuJobs}
                      disabled={
                        rebuildBackend === 'cpu' ||
                        rebuild.state === 'running' ||
                        rebuild.state === 'stopping'
                      }
                      onChange={(event) => {
                        const value = Number(event.target.value)
                        setImageSearchUiPreferences({ thumbnailGpuJobs: value })
                      }}
                    >
                      {THUMBNAIL_GPU_JOB_OPTIONS.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label
                    style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}
                    title={t(
                      'Images read ahead per GPU job. The effective value is reduced when needed so total in-flight work stays at 40 or less.',
                    )}
                  >
                    {t('Batch')}
                    <select
                      value={thumbnailBatchSize}
                      disabled={
                        rebuildBackend === 'cpu' ||
                        rebuildBackend === 'native' ||
                        rebuildBackend === 'cuda' ||
                        rebuild.state === 'running' ||
                        rebuild.state === 'stopping'
                      }
                      onChange={(event) => {
                        const value = Number(event.target.value)
                        setImageSearchUiPreferences({ thumbnailBatchSize: value })
                      }}
                    >
                      {THUMBNAIL_BATCH_OPTIONS.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={() => void startRebuild(selectedPath ? [selectedPath] : [])}
                    disabled={
                      rebuild.state === 'running' ||
                      rebuild.state === 'stopping' ||
                      !selected?.exists
                    }
                  >
                    {t('Selected Image')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void startRebuild(scanPaths)}
                    disabled={
                      rebuild.state === 'running' ||
                      rebuild.state === 'stopping' ||
                      scanPaths.length === 0
                    }
                  >
                    {t('All Scan Paths')}
                  </button>
                  {(rebuild.state === 'running' || rebuild.state === 'stopping') && (
                    <button type="button" onClick={() => void stopRebuild()}>
                      {t('Stop')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void clearThumbnailCache()}
                    disabled={rebuild.state === 'running' || rebuild.state === 'stopping'}
                    style={clearCacheArmed ? { color: 'rgb(255,150,150)' } : undefined}
                    title={t(
                      'Retires only generated thumbnail cache files; source images are never deleted',
                    )}
                  >
                    {clearCacheArmed ? t('Confirm Clear Cache') : t('Clear Legacy Cache')}
                  </button>
                </div>
                {rebuild.state !== 'idle' && (
                  <>
                    <div
                      style={{
                        height: 5,
                        borderRadius: 3,
                        overflow: 'hidden',
                        background: 'rgba(255,255,255,0.1)',
                      }}
                    >
                      <div
                        style={{
                          width: `${rebuildPercent}%`,
                          height: '100%',
                          background: 'rgb(75,185,135)',
                        }}
                      />
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.78 }}>
                      {t(rebuild.state)} · {rebuildProcessed}/{rebuild.total || '?'} · {t('failed')}{' '}
                      {rebuild.failed} · {t('skipped')} {rebuild.skipped} · {rebuildRate}{' '}
                      {t('img/s')}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.72 }}>
                      {t('Backend')}:{' '}
                      {rebuild.effectiveBackend || rebuild.requestedBackend || t('detecting')} ·
                      {t('Jobs')} {rebuild.gpuJobs || 0} · {t('GPU lanes')} {rebuild.gpuLanes || 0}{' '}
                      · {t('CPU lanes')} {rebuild.cpuLanes || 0} · {t('Batch')}{' '}
                      {rebuild.batchSize || 1} · {t('In-flight')} {rebuild.inFlight || 0}/
                      {rebuild.peakInFlight || 0} · GPU {rebuild.gpuCompleted || 0} · CPU{' '}
                      {rebuild.cpuCompleted || 0} · {t('fallback')} {rebuild.fallbackCount || 0}
                    </div>
                    <div style={{ fontSize: 11, opacity: 0.58 }}>
                      {t('Queues')}: GPU {rebuild.gpuQueueDepth || 0} · CPU{' '}
                      {rebuild.cpuQueueDepth || 0} ·{t('Cache')} {rebuild.cacheQueueDepth || 0} ·
                      Auto→CPU {rebuild.autoCpuRouted || 0} ·{t('Writes')}{' '}
                      {rebuild.cacheWrites || 0}
                      {(rebuild.cacheWriteFailures || 0) > 0
                        ? ` · ${t('write failed')} ${rebuild.cacheWriteFailures}`
                        : ''}
                    </div>
                    {rebuild.gpuDevice && (
                      <div
                        title={rebuild.gpuDevice}
                        style={{
                          fontSize: 11,
                          opacity: 0.62,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        GPU: {rebuild.gpuDevice}
                      </div>
                    )}
                    {rebuild.gpuError && (
                      <div style={{ fontSize: 11, color: 'rgb(255,185,110)' }}>
                        {t('GPU unavailable')}: {rebuild.gpuError}.{' '}
                        {t('CPU fallback remains active.')}
                      </div>
                    )}
                    <div style={{ fontSize: 11, opacity: 0.52 }}>
                      {rebuild.effectiveBackend === 'native-cpp'
                        ? t(
                            'Native C++ streams JPEG files through WIC without Node buffers or base64.',
                          )
                        : rebuild.effectiveBackend === 'cuda'
                          ? t('CUDA nvJPEG decode/resize backend is active.')
                          : t(
                              'GPU % covers resize only; decoding and WebP encoding remain CPU work. Compare img/s when tuning.',
                            )}
                    </div>
                    {rebuild.currentPath && (
                      <div
                        title={rebuild.currentPath}
                        style={{
                          fontSize: 11,
                          opacity: 0.55,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {rebuild.currentPath}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </details>
        </div>
      )}
    </div>
  )
}

export default ImageSearchDataManager
