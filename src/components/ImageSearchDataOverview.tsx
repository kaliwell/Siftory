import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ImageSearchDataCatalogProgress,
  ImageSearchDataFolderList,
  ImageSearchDataOverview as ImageSearchDataOverviewResult,
} from '../../shared/ipc-contract'
import { useTranslation } from '../i18n/useTranslation'
import { imageSearchBridge } from '../services/imageSearchBridge'

interface ImageSearchDataOverviewProps {
  disabled?: boolean
  onManageFolder: (folder: string) => void
  showToast: (message: string, type?: 'ok' | 'err') => void
}

const IDLE_PROGRESS: ImageSearchDataCatalogProgress = {
  state: 'idle',
  processedBytes: 0,
  totalBytes: 0,
  processedRecords: 0,
  nativeRecords: 0,
  dinoRecords: 0,
  clipRecords: 0,
}

const EMPTY_FOLDERS: ImageSearchDataFolderList = {
  ok: false,
  catalogState: 'no-catalog',
  records: [],
  offset: 0,
  total: 0,
  hasMore: false,
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`
}

function formatDate(value?: number): string {
  if (!value) return '—'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return '—'
  }
}

const ImageSearchDataOverview: React.FC<ImageSearchDataOverviewProps> = ({
  disabled = false,
  onManageFolder,
  showToast,
}) => {
  const { t } = useTranslation()
  const [overview, setOverview] = useState<ImageSearchDataOverviewResult | null>(null)
  const [progress, setProgress] = useState<ImageSearchDataCatalogProgress>(IDLE_PROGRESS)
  const [folders, setFolders] = useState<ImageSearchDataFolderList>(EMPTY_FOLDERS)
  const [loadingOverview, setLoadingOverview] = useState(false)
  const [loadingFolders, setLoadingFolders] = useState(false)
  const [tab, setTab] = useState<'stores' | 'folders'>('stores')
  const [expandedStores, setExpandedStores] = useState<Set<string>>(() => new Set())
  const [folderQuery, setFolderQuery] = useState('')
  const [onlyAnomalies, setOnlyAnomalies] = useState(false)
  const [folderStack, setFolderStack] = useState<string[]>([])

  const catalogActive =
    progress.state === 'collecting' ||
    progress.state === 'building' ||
    progress.state === 'cancelling'
  const currentParent = folderStack.at(-1) || null

  const loadOverview = useCallback(async () => {
    setLoadingOverview(true)
    try {
      const result = await imageSearchBridge.getDataOverview()
      setOverview(result)
      if (!result.ok && result.error) showToast(result.error, 'err')
      if (result.catalogState === 'building' || result.catalogState === 'cancelling') {
        setProgress(await imageSearchBridge.getDataCatalogProgress())
      }
    } finally {
      setLoadingOverview(false)
    }
  }, [showToast])

  const loadFolders = useCallback(
    async (options?: {
      parent?: string | null
      query?: string
      offset?: number
      append?: boolean
      anomalies?: boolean
    }) => {
      const parent = options?.parent === undefined ? currentParent : options.parent
      const query = options?.query === undefined ? folderQuery.trim() : options.query.trim()
      const offset = options?.offset || 0
      setLoadingFolders(true)
      try {
        const result = await imageSearchBridge.listDataFolders({
          parent: query ? null : parent,
          query,
          onlyAnomalies: options?.anomalies ?? onlyAnomalies,
          offset,
          limit: 100,
        })
        setFolders((current) =>
          options?.append && result.ok
            ? {
                ...result,
                records: [...current.records, ...result.records],
              }
            : result,
        )
      } finally {
        setLoadingFolders(false)
      }
    },
    [currentParent, folderQuery, onlyAnomalies],
  )

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  useEffect(() => {
    if (!overview?.generation) return
    void loadFolders({ parent: null, query: '', offset: 0 })
  }, [overview?.generation]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!catalogActive) return
    let disposed = false
    const refresh = async () => {
      const next = await imageSearchBridge.getDataCatalogProgress()
      if (disposed) return
      setProgress(next)
      if (next.state === 'completed' || next.state === 'cancelled' || next.state === 'error') {
        await loadOverview()
        if (next.state === 'completed') {
          setFolderStack([])
          setFolderQuery('')
          await loadFolders({ parent: null, query: '', offset: 0 })
        }
      }
    }
    const timer = window.setInterval(() => void refresh(), 500)
    void refresh()
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [catalogActive, loadFolders, loadOverview])

  const startCatalogBuild = async () => {
    const result = await imageSearchBridge.startDataCatalogBuild()
    if (!result.ok) {
      showToast(result.error || t('Unable to start full data analysis'), 'err')
      return
    }
    setProgress({
      ...IDLE_PROGRESS,
      taskId: result.taskId,
      state: 'collecting',
      stage: 'inventory',
      startedAt: Date.now(),
      message: t('Collecting Image Search data sources'),
    })
  }

  const cancelCatalogBuild = async () => {
    const result = await imageSearchBridge.cancelDataCatalogBuild()
    if (!result.ok) showToast(t('Unable to cancel full data analysis'), 'err')
  }

  const toggleStore = (storeId: string) => {
    setExpandedStores((current) => {
      const next = new Set(current)
      if (next.has(storeId)) next.delete(storeId)
      else next.add(storeId)
      return next
    })
  }

  const openStoreLocation = async (storeId: string) => {
    const result = await imageSearchBridge.openDataStoreLocation(storeId)
    if (!result.ok) showToast(result.error || t('Unable to open data location'), 'err')
  }

  const openFolderChildren = (folder: string) => {
    const nextStack = folderQuery.trim() ? [folder] : [...folderStack, folder]
    setFolderStack(nextStack)
    setFolderQuery('')
    void loadFolders({ parent: folder, query: '', offset: 0 })
  }

  const goBack = () => {
    const next = folderStack.slice(0, -1)
    const parent = next.at(-1) || null
    setFolderStack(next)
    setFolderQuery('')
    void loadFolders({ parent, query: '', offset: 0 })
  }

  const applyFolderFilter = () => {
    void loadFolders({ parent: currentParent, query: folderQuery, offset: 0 })
  }

  const progressPercent =
    progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.processedBytes / progress.totalBytes) * 100))
      : 0
  const anomalyCount = useMemo(
    () =>
      (overview?.missingDinoCount || 0) +
      (overview?.missingClipCount || 0) +
      (overview?.vectorOnlyCount || 0) +
      (overview?.duplicateRows || 0) +
      (overview?.malformedRows || 0),
    [overview],
  )
  const progressLabel =
    progress.state === 'cancelling'
      ? t('Cancelling data analysis')
      : progress.state === 'error'
        ? t('Data analysis failed')
        : progress.stage === 'native'
          ? t('Reading Native index')
          : progress.stage === 'dino'
            ? t('Reading DINO embeddings')
            : progress.stage === 'clip'
              ? t('Reading CLIP embeddings')
              : progress.stage === 'folders'
                ? t('Building folder coverage')
                : progress.stage === 'validate'
                  ? t('Validating catalog snapshot')
                  : progress.stage === 'switch'
                    ? t('Switching catalog snapshot')
                    : progress.stage === 'inventory'
                      ? t('Collecting Image Search data sources')
                      : t('Analyzing all index data')

  return (
    <section
      data-testid="image-search-data-overview"
      style={{
        display: 'grid',
        gap: 6,
        padding: 7,
        border: '1px solid rgba(104,177,255,0.32)',
        borderRadius: 5,
        background: 'rgba(22,44,72,0.2)',
      }}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 10 }}>{t('Image Search Data Overview')}</strong>
        <span style={{ fontSize: 9, opacity: 0.68 }}>
          {overview?.catalogState ? t(overview.catalogState) : t('loading')}
          {overview?.builtAt ? ` · ${t('Snapshot')} ${formatDate(overview.builtAt)}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => void loadOverview()}
          disabled={loadingOverview || catalogActive}
          style={{ fontSize: 9 }}
        >
          {loadingOverview ? t('Loading...') : t('Refresh Inventory')}
        </button>
        <button
          type="button"
          onClick={() => void startCatalogBuild()}
          disabled={disabled || catalogActive || loadingOverview}
          style={{ fontSize: 9 }}
          title={t('Reads Native, DINO, and CLIP once and builds a reusable read-only catalog.')}
        >
          {overview?.generation ? t('Refresh All Data') : t('Analyze All Data')}
        </button>
        {catalogActive && (
          <button type="button" onClick={() => void cancelCatalogBuild()} style={{ fontSize: 9 }}>
            {t('Cancel')}
          </button>
        )}
      </div>

      {overview && (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(6, minmax(90px, 1fr))',
              gap: 4,
              overflowX: 'auto',
            }}
          >
            {[
              [t('Physical Data'), formatBytes(overview.totalBytes)],
              [t('All Paths'), overview.unionPathCount.toLocaleString()],
              [t('Native'), overview.nativeUniqueCount.toLocaleString()],
              ['DINO', overview.dinoUniqueCount.toLocaleString()],
              ['CLIP', overview.clipUniqueCount.toLocaleString()],
              [t('Issue Signals'), anomalyCount.toLocaleString()],
            ].map(([label, value]) => (
              <div
                key={label}
                style={{
                  minWidth: 90,
                  padding: '5px 6px',
                  border: '1px solid rgba(255,255,255,0.09)',
                  borderRadius: 4,
                }}
              >
                <div style={{ fontSize: 8, opacity: 0.62 }}>{label}</div>
                <strong style={{ fontSize: 10 }}>{value}</strong>
              </div>
            ))}
          </div>
          {overview.generation && (
            <div
              data-testid="image-search-data-health-breakdown"
              style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 8, opacity: 0.72 }}
            >
              {[
                [t('Complete Paths'), overview.completeCount],
                [t('Missing DINO'), overview.missingDinoCount],
                [t('Missing CLIP'), overview.missingClipCount],
                [t('Vector-only'), overview.vectorOnlyCount],
                [t('Duplicate Rows'), overview.duplicateRows],
                [t('Malformed Rows'), overview.malformedRows],
              ].map(([label, value]) => (
                <span key={label}>
                  {label}: {Number(value).toLocaleString()}
                </span>
              ))}
            </div>
          )}
        </>
      )}

      {(overview?.catalogState === 'no-catalog' || overview?.catalogState === 'stale') && (
        <div style={{ fontSize: 9, color: 'rgb(245,190,105)' }}>
          {overview.catalogState === 'no-catalog'
            ? t(
                'Run Analyze All Data once to browse Native, DINO, and CLIP folders without rescanning the large JSONL files.',
              )
            : t(
                'The source indexes changed after this snapshot. Refresh all data before using its counts for maintenance decisions.',
              )}
        </div>
      )}
      {overview?.error && (
        <div style={{ fontSize: 9, color: 'rgb(255,130,120)' }}>{overview.error}</div>
      )}

      {(catalogActive || progress.state === 'error') && (
        <div style={{ display: 'grid', gap: 3 }}>
          <div style={{ display: 'flex', gap: 6, fontSize: 9, opacity: 0.78 }}>
            <span>{progressLabel}</span>
            <span style={{ marginLeft: 'auto' }}>
              {formatBytes(progress.processedBytes)} / {formatBytes(progress.totalBytes)} ·{' '}
              {progress.processedRecords.toLocaleString()} {t('records')}
            </span>
          </div>
          <progress value={progressPercent} max={100} style={{ width: '100%' }} />
          <div style={{ fontSize: 8, opacity: 0.58 }}>
            {t('Native')} {progress.nativeRecords.toLocaleString()} · {t('DINO')}{' '}
            {progress.dinoRecords.toLocaleString()} · {t('CLIP')}{' '}
            {progress.clipRecords.toLocaleString()}
          </div>
          {progress.error && (
            <div style={{ fontSize: 9, color: 'rgb(255,130,120)' }}>{progress.error}</div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 4 }}>
        <button
          type="button"
          onClick={() => setTab('stores')}
          style={{
            fontSize: 9,
            background: tab === 'stores' ? 'rgba(80,150,255,0.28)' : undefined,
          }}
        >
          {t('Major Data Stores')}
        </button>
        <button
          type="button"
          onClick={() => setTab('folders')}
          style={{
            fontSize: 9,
            background: tab === 'folders' ? 'rgba(80,150,255,0.28)' : undefined,
          }}
        >
          {t('Folder Coverage')}
        </button>
      </div>

      {tab === 'stores' && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 9 }}>
            <thead>
              <tr style={{ textAlign: 'left', opacity: 0.68 }}>
                <th style={{ padding: 4 }}>{t('Data Store')}</th>
                <th style={{ padding: 4 }}>{t('Role')}</th>
                <th style={{ padding: 4 }}>{t('Files')}</th>
                <th style={{ padding: 4 }}>{t('Physical Size')}</th>
                <th style={{ padding: 4 }}>{t('Images / Rows')}</th>
                <th style={{ padding: 4 }}>{t('Freshness')}</th>
                <th style={{ padding: 4 }}>{t('Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {(overview?.stores || []).map((store) => {
                const expanded = expandedStores.has(store.id)
                return (
                  <React.Fragment key={store.id}>
                    <tr style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
                      <td style={{ padding: 4 }}>
                        <button
                          type="button"
                          onClick={() => toggleStore(store.id)}
                          style={{ border: 0, background: 'transparent', padding: 0, fontSize: 9 }}
                          title={t(store.pathCategory)}
                        >
                          {store.fileCount > 0 ? (expanded ? '▾ ' : '▸ ') : '· '}
                          {t(store.label)}
                        </button>
                      </td>
                      <td style={{ padding: 4 }}>{t(store.role)}</td>
                      <td style={{ padding: 4 }}>
                        {store.fileCount.toLocaleString()}
                        {!store.inventoryComplete ? ` ${t('(partial)')}` : ''}
                      </td>
                      <td style={{ padding: 4 }}>{formatBytes(store.totalBytes)}</td>
                      <td style={{ padding: 4 }}>
                        {store.uniqueCount === undefined
                          ? '—'
                          : `${store.uniqueCount.toLocaleString()} / ${(store.recordCount || 0).toLocaleString()}`}
                      </td>
                      <td style={{ padding: 4 }}>{t(store.freshness)}</td>
                      <td style={{ padding: 4 }}>
                        <button
                          type="button"
                          onClick={() => void openStoreLocation(store.id)}
                          disabled={store.fileCount === 0}
                          style={{ fontSize: 8 }}
                        >
                          {t('Open Location')}
                        </button>
                      </td>
                    </tr>
                    {expanded && store.files.length > 0 && (
                      <tr>
                        <td colSpan={7} style={{ padding: '2px 8px 6px 18px' }}>
                          <div style={{ display: 'grid', gap: 2 }}>
                            {store.files.map((file) => (
                              <div
                                key={file.id}
                                title={file.relativePath}
                                style={{
                                  display: 'grid',
                                  gridTemplateColumns: 'minmax(180px, 1fr) auto auto',
                                  gap: 8,
                                  fontSize: 8,
                                  opacity: 0.7,
                                }}
                              >
                                <span
                                  style={{
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  {file.relativePath}
                                </span>
                                <span>{formatBytes(file.sizeBytes)}</span>
                                <span>{formatDate(file.modifiedAt)}</span>
                              </div>
                            ))}
                            {store.filesTruncated && (
                              <div style={{ fontSize: 8, opacity: 0.55 }}>
                                {t('Showing the largest {count} files', {
                                  count: store.files.length,
                                })}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'folders' && (
        <div style={{ display: 'grid', gap: 5 }}>
          <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
            {folderStack.length > 0 && (
              <button
                type="button"
                onClick={goBack}
                disabled={loadingFolders}
                style={{ fontSize: 9 }}
              >
                {t('Back')}
              </button>
            )}
            <input
              value={folderQuery}
              onChange={(event) => setFolderQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') applyFolderFilter()
              }}
              placeholder={t('Search every indexed folder in the snapshot')}
              style={{ flex: 1, minWidth: 180, fontSize: 9 }}
            />
            <label style={{ display: 'flex', gap: 3, alignItems: 'center', fontSize: 9 }}>
              <input
                type="checkbox"
                checked={onlyAnomalies}
                onChange={(event) => {
                  const checked = event.target.checked
                  setOnlyAnomalies(checked)
                  void loadFolders({ anomalies: checked, offset: 0 })
                }}
              />
              {t('Only anomalies')}
            </label>
            <button
              type="button"
              onClick={applyFolderFilter}
              disabled={loadingFolders}
              style={{ fontSize: 9 }}
            >
              {t('Search')}
            </button>
          </div>
          <div
            title={currentParent || undefined}
            style={{ fontSize: 8, opacity: 0.58, overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {folderQuery.trim()
              ? t('Searching the full snapshot')
              : `${t('Current Folder')}: ${currentParent || t('All indexed roots')}`}
          </div>

          {!overview?.generation ? (
            <div style={{ padding: 8, fontSize: 9, opacity: 0.66 }}>
              {t('Analyze all data to create the reusable folder catalog.')}
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 8 }}>
                <thead>
                  <tr style={{ textAlign: 'left', opacity: 0.68 }}>
                    <th style={{ padding: 4 }}>{t('Folder')}</th>
                    <th style={{ padding: 4 }}>{t('Native')}</th>
                    <th style={{ padding: 4 }}>{t('DINO')}</th>
                    <th style={{ padding: 4 }}>{t('CLIP')}</th>
                    <th style={{ padding: 4 }}>{t('Missing DINO')}</th>
                    <th style={{ padding: 4 }}>{t('Missing CLIP')}</th>
                    <th style={{ padding: 4 }}>{t('Vector-only')}</th>
                    <th style={{ padding: 4 }}>{t('Duplicate Rows')}</th>
                    <th style={{ padding: 4 }}>{t('Actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {folders.records.map((folder) => {
                    const anomalies =
                      folder.missingDino +
                      folder.missingClip +
                      folder.vectorOnly +
                      folder.duplicateRows +
                      folder.malformedRows
                    return (
                      <tr
                        key={folder.folder}
                        style={{
                          borderTop: '1px solid rgba(255,255,255,0.07)',
                          color: anomalies > 0 ? 'rgb(245,200,125)' : undefined,
                        }}
                      >
                        <td title={folder.folder} style={{ padding: 4, minWidth: 210 }}>
                          <div
                            style={{
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {folder.name}
                          </div>
                          <div
                            style={{ opacity: 0.48, overflow: 'hidden', textOverflow: 'ellipsis' }}
                          >
                            {folder.folder}
                          </div>
                        </td>
                        <td style={{ padding: 4 }}>{folder.nativeCount.toLocaleString()}</td>
                        <td style={{ padding: 4 }}>{folder.dinoCount.toLocaleString()}</td>
                        <td style={{ padding: 4 }}>{folder.clipCount.toLocaleString()}</td>
                        <td style={{ padding: 4 }}>{folder.missingDino.toLocaleString()}</td>
                        <td style={{ padding: 4 }}>{folder.missingClip.toLocaleString()}</td>
                        <td style={{ padding: 4 }}>{folder.vectorOnly.toLocaleString()}</td>
                        <td style={{ padding: 4 }}>{folder.duplicateRows.toLocaleString()}</td>
                        <td style={{ padding: 4, whiteSpace: 'nowrap' }}>
                          {folder.childCount > 0 && (
                            <button
                              type="button"
                              onClick={() => openFolderChildren(folder.folder)}
                              style={{ fontSize: 8, marginRight: 3 }}
                            >
                              {t('Open')} ({folder.childCount})
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => onManageFolder(folder.folder)}
                            disabled={disabled || catalogActive}
                            style={{ fontSize: 8 }}
                          >
                            {t('Manage Indexes')}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {folders.records.length === 0 && (
                <div style={{ padding: 8, fontSize: 9, opacity: 0.62 }}>
                  {loadingFolders ? t('Loading...') : t('No matching folders')}
                </div>
              )}
            </div>
          )}
          {folders.hasMore && (
            <button
              type="button"
              onClick={() =>
                void loadFolders({
                  offset: folders.records.length,
                  append: true,
                })
              }
              disabled={loadingFolders}
              style={{ fontSize: 9 }}
            >
              {t('Load More')} ({folders.records.length}/{folders.total})
            </button>
          )}
        </div>
      )}
    </section>
  )
}

export default ImageSearchDataOverview
