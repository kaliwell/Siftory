import React, { useState, useCallback, useEffect, useMemo } from 'react'
import { useStore } from '../stores/useStore'
import DraggablePanel from './DraggablePanel'
import { DEFAULT_APPSTORAGE_W, DEFAULT_APPSTORAGE_H } from '../types'
import { useLinkedMove } from '../hooks/useLinkedMove'
import type {
  AppStorageScanStatus,
  AppStorageEntry,
  AppStoragePathEntry,
} from '../../shared/ipc-contract'
import { useTranslation } from '../i18n/useTranslation'

// ── Helpers ─────────────────────────────────────────────────

function fmtBytes(n: number): string {
  if (!n || n === 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`
  return `${(n / 1073741824).toFixed(2)} GB`
}

const KIND_LABELS: Record<string, string> = {
  app: 'App',
  data: 'Data',
  cache: 'Cache',
  unknown: 'Other',
}

const KIND_COLORS: Record<string, string> = {
  app: 'rgba(100,200,255,0.7)',
  data: 'rgba(100,255,150,0.7)',
  cache: 'rgba(255,200,100,0.7)',
  unknown: 'rgba(180,180,180,0.5)',
}

const STATUS_COLORS: Record<string, string> = {
  idle: 'rgba(var(--date), 0.5)',
  scanning: 'rgb(100, 200, 255)',
  stopping: 'rgb(255, 200, 100)',
  done: 'rgb(100, 255, 150)',
  error: 'rgb(255, 100, 100)',
}

const TAG_COLORS: Record<string, string> = {
  Huge: 'rgba(255,80,80,0.25)',
  Large: 'rgba(255,150,50,0.2)',
  'Cache heavy': 'rgba(255,200,50,0.2)',
  Partial: 'rgba(180,180,50,0.2)',
  'Portable-like': 'rgba(100,180,255,0.2)',
  'Registry only': 'rgba(150,150,150,0.2)',
  'Missing paths': 'rgba(255,100,100,0.15)',
  'Registry estimate': 'rgba(200,200,50,0.2)',
}

type SortMode = 'size' | 'name' | 'publisher'

function getPrimaryOpenPath(app: AppStorageEntry): string | null {
  const installPath = app.paths.find(
    (p) => p.exists && p.accessible && p.kind === 'app' && p.source === 'InstallLocation',
  )
  if (installPath) return installPath.path
  const appPath = app.paths.find((p) => p.exists && p.accessible && p.kind === 'app')
  if (appPath) return appPath.path
  const anyPath = app.paths.find((p) => p.exists && p.accessible)
  return anyPath?.path || null
}

function fmtTime(ts?: number, locale?: string): string {
  if (!ts) return ''
  return new Date(ts).toLocaleString(locale)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── Component ───────────────────────────────────────────────

const AppStoragePanel: React.FC = () => {
  const { language, t } = useTranslation()
  const appStoragePos = useStore((s) => s.appStoragePos)
  const setAppStoragePos = useStore((s) => s.setAppStoragePos)
  const appStorageSize = useStore((s) => s.appStorageSize)
  const setAppStorageSize = useStore((s) => s.setAppStorageSize)
  const linkedMove = useStore((s) => s.linkedMove)
  const locked = useStore((s) => s.lockedPanels['appStorage'] ?? false)
  const visibilityLocked = useStore((s) => s.lockedVisibility['appStorage'] ?? false)
  const togglePanelLocked = useStore((s) => s.togglePanelLocked)
  const toggleVisibilityLock = useStore((s) => s.toggleVisibilityLock)
  const handleMove = useLinkedMove('appStorage', appStoragePos, setAppStoragePos, linkedMove)

  const [status, setStatus] = useState<AppStorageScanStatus>({
    state: 'idle',
    appCount: 0,
    scannedCount: 0,
    totalBytes: 0,
    warnings: 0,
    errors: 0,
    message: 'Ready',
  })
  const [apps, setApps] = useState<AppStorageEntry[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('size')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [savedAt, setSavedAt] = useState<number | undefined>(undefined)
  const [cachePath, setCachePath] = useState<string | undefined>(undefined)
  const [openError, setOpenError] = useState<string>('')

  // ── Status listener ──────────────────────────────────────
  useEffect(() => {
    const unsub = window.electronAPI.appStorage.onStatusChanged((s) => {
      setStatus(s)
    })
    return unsub
  }, [])

  // ── Get initial status ───────────────────────────────────
  useEffect(() => {
    window.electronAPI.appStorage.getStatus().then(setStatus)
  }, [])

  // ── Auto-load last saved scan result ─────────────────────
  useEffect(() => {
    let disposed = false
    window.electronAPI.appStorage
      .loadCached()
      .then((result) => {
        if (disposed || !result) return
        setApps(result.apps)
        setStatus(result.status)
        setSavedAt(result.savedAt)
        setCachePath(result.cachePath)
      })
      .catch(() => {
        /* cache is optional */
      })
    return () => {
      disposed = true
    }
  }, [])

  // ── Scan ─────────────────────────────────────────────────
  const handleScan = useCallback(async () => {
    try {
      const result = await window.electronAPI.appStorage.scan()
      setApps(result.apps)
      setStatus(result.status)
      setSavedAt(result.savedAt)
      setCachePath(result.cachePath)
    } catch (e: unknown) {
      setStatus((prev) => ({
        ...prev,
        state: 'error',
        message: errorMessage(e),
      }))
    }
  }, [])

  // ── Stop ─────────────────────────────────────────────────
  const handleStop = useCallback(async () => {
    await window.electronAPI.appStorage.stop()
  }, [])

  const handleClearCached = useCallback(async () => {
    const result = await window.electronAPI.appStorage.clearCached()
    if (!result.ok) {
      setOpenError(result.error || 'Clear cache failed')
      return
    }
    setApps([])
    setSavedAt(undefined)
    setCachePath(undefined)
    setStatus({
      state: 'idle',
      appCount: 0,
      scannedCount: 0,
      totalBytes: 0,
      warnings: 0,
      errors: 0,
      message: 'Cache cleared',
    })
  }, [])

  // ── Toggle expand ────────────────────────────────────────
  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // ── Open path ────────────────────────────────────────────
  const handleOpenPath = useCallback(async (p: string) => {
    setOpenError('')
    const result = await window.electronAPI.appStorage.openPath(p)
    if (!result?.ok) setOpenError(result?.error || 'Open path failed')
  }, [])

  // ── Filtered & sorted apps ───────────────────────────────
  const filteredApps = useMemo(() => {
    let list = apps
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      list = list.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          (a.publisher && a.publisher.toLowerCase().includes(q)),
      )
    }
    const sorted = [...list]
    switch (sortMode) {
      case 'name':
        sorted.sort((a, b) => a.name.localeCompare(b.name))
        break
      case 'publisher':
        sorted.sort((a, b) => (a.publisher || '').localeCompare(b.publisher || ''))
        break
      case 'size':
      default:
        sorted.sort((a, b) => b.totalBytes - a.totalBytes)
        break
    }
    return sorted
  }, [apps, searchQuery, sortMode])

  const isScanning = status.state === 'scanning'
  const maxApp =
    apps.length > 0 ? apps.reduce((a, b) => (a.totalBytes > b.totalBytes ? a : b)) : null

  // ── Render ────────────────────────────────────────────────
  return (
    <DraggablePanel
      panelId="appStorage"
      title="App Storage"
      x={appStoragePos.x}
      y={appStoragePos.y}
      defaultX={150}
      defaultY={150}
      w={appStorageSize.w}
      h={appStorageSize.h}
      defaultW={DEFAULT_APPSTORAGE_W}
      defaultH={DEFAULT_APPSTORAGE_H}
      onMove={handleMove}
      onResize={(w, h) => setAppStorageSize(w, h)}
      locked={locked}
      onToggleLock={() => togglePanelLocked('appStorage')}
      visibilityLocked={visibilityLocked}
      onToggleVisibilityLock={() => toggleVisibilityLock('appStorage')}
    >
      <div
        style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 3, fontSize: 11 }}
      >
        {/* ── Toolbar ── */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <input
            type="text"
            placeholder={t('Search apps...')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              flex: 1,
              fontSize: 11,
              padding: '2px 6px',
              background: 'rgba(var(--bg), 0.8)',
              border: '1px solid rgba(var(--date), 0.3)',
              color: 'rgb(var(--date))',
              borderRadius: 3,
              outline: 'none',
              minWidth: 0,
            }}
          />
          <button
            onClick={handleScan}
            disabled={isScanning}
            style={{
              fontSize: 11,
              padding: '2px 10px',
              whiteSpace: 'nowrap',
              opacity: isScanning ? 0.5 : 1,
            }}
          >
            {t(apps.length > 0 ? 'Update' : 'Scan')}
          </button>
          <button
            onClick={handleStop}
            disabled={!isScanning}
            style={{
              fontSize: 11,
              padding: '2px 10px',
              whiteSpace: 'nowrap',
              opacity: isScanning ? 1 : 0.5,
            }}
          >
            {t('Stop')}
          </button>
          <button
            onClick={handleClearCached}
            disabled={isScanning || apps.length === 0}
            style={{
              fontSize: 11,
              padding: '2px 8px',
              whiteSpace: 'nowrap',
              opacity: isScanning || apps.length === 0 ? 0.5 : 1,
            }}
            title={cachePath ? `${t('Clear saved scan')}: ${cachePath}` : t('Clear saved scan')}
          >
            {t('Clear')}
          </button>
          <select
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
            style={{
              fontSize: 11,
              padding: '1px 4px',
              background: 'rgba(var(--bg), 0.8)',
              border: '1px solid rgba(var(--date), 0.3)',
              color: 'rgb(var(--date))',
              borderRadius: 3,
            }}
          >
            <option value="size">{t('Size')}</option>
            <option value="name">{t('Name')}</option>
            <option value="publisher">{t('Publisher')}</option>
          </select>
        </div>

        {/* ── Status bar ── */}
        <div
          style={{
            display: 'flex',
            gap: 8,
            fontSize: 10,
            opacity: 0.7,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <span style={{ color: STATUS_COLORS[status.state] || 'inherit' }}>
            ● {t(status.state)}
          </span>
          {status.message && <span>{t(status.message)}</span>}
          {status.appCount > 0 && (
            <>
              <span>
                {status.scannedCount}/{status.appCount} {t('apps')}
              </span>
              <span>{fmtBytes(status.totalBytes)}</span>
              {status.warnings > 0 && (
                <span style={{ color: 'rgb(255,200,100)' }}>⚠{status.warnings}</span>
              )}
              {status.errors > 0 && (
                <span style={{ color: 'rgb(255,100,100)' }}>✕{status.errors}</span>
              )}
            </>
          )}
          {status.currentApp && (
            <span
              style={{
                opacity: 0.5,
                maxWidth: 160,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {status.currentApp}
            </span>
          )}
          {savedAt && (
            <span title={cachePath}>
              {t('Saved')}: {fmtTime(savedAt, language)}
            </span>
          )}
          {openError && <span style={{ color: 'rgb(255,100,100)' }}>{openError}</span>}
        </div>

        {/* ── Summary ── */}
        {apps.length > 0 && (
          <div
            style={{
              display: 'flex',
              gap: 10,
              fontSize: 10,
              opacity: 0.6,
              flexWrap: 'wrap',
              borderTop: '1px solid rgba(var(--date), 0.12)',
              paddingTop: 2,
            }}
          >
            <span>
              {apps.length} {t('apps')}
            </span>
            {maxApp && (
              <span>
                {t('Max')}: {maxApp.name.slice(0, 30)} ({fmtBytes(maxApp.totalBytes)})
              </span>
            )}
          </div>
        )}

        {/* ── App list ── */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            overflowX: 'hidden',
            minHeight: 0,
          }}
        >
          {filteredApps.length === 0 && status.state === 'done' && (
            <div style={{ padding: 20, textAlign: 'center', opacity: 0.4, fontSize: 11 }}>
              {t('No apps found')}
            </div>
          )}
          {apps.length === 0 && status.state === 'idle' && (
            <div style={{ padding: 20, textAlign: 'center', opacity: 0.4, fontSize: 11 }}>
              {t('Click Scan to analyze installed apps')}
            </div>
          )}
          {filteredApps.map((app) => {
            const isExpanded = expandedIds.has(app.id)
            const primaryOpenPath = getPrimaryOpenPath(app)
            return (
              <div
                key={app.id}
                style={{
                  borderBottom: '1px solid rgba(var(--date), 0.08)',
                }}
              >
                {/* ── Row ── */}
                <div
                  onClick={() => toggleExpand(app.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '3px 4px',
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                  onMouseEnter={(e) => {
                    ;(e.currentTarget as HTMLElement).style.background = 'rgba(var(--date), 0.04)'
                  }}
                  onMouseLeave={(e) => {
                    ;(e.currentTarget as HTMLElement).style.background = 'transparent'
                  }}
                >
                  <span style={{ fontSize: 10, minWidth: 12 }}>{isExpanded ? '▼' : '▶'}</span>
                  <span
                    style={{
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontSize: 11,
                    }}
                  >
                    {app.name}
                  </span>
                  {app.tags.map((tag) => (
                    <span
                      key={tag}
                      style={{
                        fontSize: 9,
                        padding: '0px 4px',
                        borderRadius: 3,
                        background: TAG_COLORS[tag] || 'rgba(150,150,150,0.2)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {t(tag)}
                    </span>
                  ))}
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 500,
                      minWidth: 60,
                      textAlign: 'right',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {fmtBytes(app.totalBytes)}
                  </span>
                  {primaryOpenPath && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleOpenPath(primaryOpenPath)
                      }}
                      title={`${t('Open')} ${primaryOpenPath}`}
                      style={{
                        fontSize: 9,
                        padding: '1px 5px',
                        marginLeft: 4,
                        whiteSpace: 'nowrap',
                        opacity: 0.7,
                      }}
                    >
                      {t('Open')}
                    </button>
                  )}
                </div>

                {/* ── Expanded details ── */}
                {isExpanded && (
                  <div style={{ padding: '2px 4px 6px 20px', fontSize: 10 }}>
                    {/* Publisher & version */}
                    <div style={{ opacity: 0.5, marginBottom: 3 }}>
                      {app.publisher && <span>{app.publisher}</span>}
                      {app.publisher && app.version && <span> · </span>}
                      {app.version && <span>v{app.version}</span>}
                    </div>

                    {/* Size breakdown */}
                    <div style={{ display: 'flex', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
                      <span>
                        {t('Scanned')}: {fmtBytes(app.scannedBytes)}
                      </span>
                      {app.dataBytes > 0 && (
                        <span style={{ color: KIND_COLORS['data'] }}>
                          {t('Data')}: {fmtBytes(app.dataBytes)}
                        </span>
                      )}
                      {app.cacheBytes > 0 && (
                        <span style={{ color: KIND_COLORS['cache'] }}>
                          {t('Cache')}: {fmtBytes(app.cacheBytes)}
                        </span>
                      )}
                      {app.estimatedRegistryBytes &&
                        app.estimatedRegistryBytes > app.scannedBytes && (
                          <span style={{ opacity: 0.5 }}>
                            {t('Estimated')}: {fmtBytes(app.estimatedRegistryBytes)}
                          </span>
                        )}
                      {app.inaccessibleCount > 0 && (
                        <span style={{ color: 'rgb(255,200,100)' }}>
                          {app.inaccessibleCount} {t('inaccessible')}
                        </span>
                      )}
                    </div>

                    {/* Install location */}
                    {app.installLocation && (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                          marginBottom: 1,
                        }}
                      >
                        <span style={{ opacity: 0.4 }}>{t('Install')}:</span>
                        <span
                          style={{
                            flex: 1,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            cursor: 'pointer',
                            textDecoration: 'underline',
                            textDecorationColor: 'rgba(var(--date), 0.2)',
                          }}
                          onClick={(e) => {
                            e.stopPropagation()
                            handleOpenPath(app.installLocation!)
                          }}
                        >
                          {app.installLocation}
                        </span>
                      </div>
                    )}

                    {/* Path entries */}
                    {app.paths.length > 0 && (
                      <div style={{ marginTop: 3 }}>
                        <div style={{ opacity: 0.4, marginBottom: 2 }}>{t('Paths')}:</div>
                        {app.paths
                          .filter((pe) => pe.bytes > 0 || pe.exists)
                          .map((pe, i) => (
                            <PathRow key={i} entry={pe} onOpen={() => handleOpenPath(pe.path)} />
                          ))}
                        {app.paths.filter((pe) => !pe.exists).length > 0 && (
                          <div style={{ opacity: 0.3, fontSize: 9, marginTop: 2 }}>
                            +{app.paths.filter((pe) => !pe.exists).length} {t('unavailable paths')}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Uninstall string */}
                    {app.uninstallString && (
                      <div style={{ opacity: 0.4, marginTop: 3, fontSize: 9 }}>
                        {t('Uninstall')}: {app.uninstallString.slice(0, 120)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </DraggablePanel>
  )
}

// ── Path row sub-component ──────────────────────────────────

const PathRow: React.FC<{
  entry: AppStoragePathEntry
  onOpen: () => void
}> = React.memo(({ entry, onOpen }) => {
  const { t } = useTranslation()
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        paddingLeft: 4,
        fontSize: 9,
      }}
    >
      <span
        style={{
          display: 'inline-block',
          width: 6,
          height: 6,
          borderRadius: 3,
          background: KIND_COLORS[entry.kind] || KIND_COLORS['unknown'],
          flexShrink: 0,
        }}
      />
      <span style={{ opacity: 0.5, minWidth: 28 }}>{t(KIND_LABELS[entry.kind] || entry.kind)}</span>
      <span style={{ minWidth: 50, textAlign: 'right' }}>
        {entry.accessible ? fmtBytes(entry.bytes) : entry.exists ? 'perm' : '—'}
      </span>
      <span
        style={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          opacity: entry.accessible ? 0.7 : 0.35,
        }}
      >
        {entry.path}
      </span>
      <button
        disabled={!entry.accessible}
        onClick={(e) => {
          e.stopPropagation()
          if (entry.accessible) onOpen()
        }}
        title={entry.accessible ? `${t('Open')} ${entry.path}` : t('Path not accessible')}
        style={{
          fontSize: 8,
          padding: '0px 4px',
          whiteSpace: 'nowrap',
          opacity: entry.accessible ? 0.8 : 0.25,
          flexShrink: 0,
        }}
      >
        {entry.accessible ? t('Open') : '—'}
      </button>
    </div>
  )
})

export default AppStoragePanel
