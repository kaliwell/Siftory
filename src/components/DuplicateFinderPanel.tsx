import React, { useCallback, useEffect, useMemo, useState } from 'react'
import DraggablePanel from './DraggablePanel'
import { useStore } from '../stores/useStore'
import { useLinkedMove } from '../hooks/useLinkedMove'
import { DEFAULT_DUPLICATE_FINDER_W, DEFAULT_DUPLICATE_FINDER_H } from '../types'
import type { DupGroup, DupScanProgress, LargestFile } from '../types/electron'
import { useTranslation } from '../i18n/useTranslation'
import SearchEmptyState from './SearchEmptyState'

type Tab = 'duplicates' | 'largest' | 'similar'

const STATUS_COLORS: Record<DupScanProgress['state'], string> = {
  scanning: 'rgba(60,140,255,0.55)',
  hashing: 'rgba(150,90,255,0.55)',
  done: 'rgba(0,180,100,0.45)',
  stopped: 'rgba(255,150,50,0.5)',
  error: 'rgba(220,60,60,0.55)',
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

const DuplicateFinderPanel: React.FC = () => {
  const { t } = useTranslation()
  const api = window.electronAPI?.duplicateFinder
  const dupPos = useStore((state) => state.dupFinderPos)
  const setDupPos = useStore((state) => state.setDupFinderPos)
  const dupSize = useStore((state) => state.dupFinderSize)
  const setDupSize = useStore((state) => state.setDupFinderSize)
  const linkedMove = useStore((state) => state.linkedMove)
  const locked = useStore((state) => state.lockedPanels.duplicateFinder ?? false)
  const visibilityLocked = useStore((state) => state.lockedVisibility.duplicateFinder ?? false)
  const togglePanelLocked = useStore((state) => state.togglePanelLocked)
  const toggleVisibilityLock = useStore((state) => state.toggleVisibilityLock)
  const setShowImageSearch = useStore((state) => state.setShowImageSearch)
  const handleMove = useLinkedMove('duplicateFinder', dupPos, setDupPos, linkedMove)

  const [tab, setTab] = useState<Tab>('duplicates')
  const [dirPath, setDirPath] = useState('')
  const [progress, setProgress] = useState<DupScanProgress>({
    state: 'done',
    scanned: 0,
    totalBytes: 0,
    duplicates: 0,
  })
  const [groups, setGroups] = useState<DupGroup[]>([])
  const [largestFiles, setLargestFiles] = useState<LargestFile[]>([])
  const [error, setError] = useState('')
  const [expandedGroup, setExpandedGroup] = useState<number | null>(null)

  const scanning = progress.state === 'scanning' || progress.state === 'hashing'

  useEffect(() => {
    if (!api) return
    return api.onProgress((nextProgress) => {
      setProgress(nextProgress)
      if (nextProgress.state === 'error') setError(nextProgress.error || 'Scan failed')
      if (nextProgress.state === 'done' && tab === 'duplicates') {
        void api.getResults().then((result) => setGroups(result.groups || []))
      }
    })
  }, [api, tab])

  useEffect(() => {
    if (!api) return
    let disposed = false
    void api
      .getProgress()
      .then((current) => {
        if (disposed) return
        setProgress(current)
        if (current.state === 'done') {
          void api.getResults().then((result) => {
            if (!disposed) setGroups(result.groups || [])
          })
        }
      })
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [api])

  const chooseDirectory = useCallback(async () => {
    const selected = await window.electronAPI.browseFolder().catch(() => null)
    if (selected) setDirPath(selected)
  }, [])

  const startScan = useCallback(async () => {
    if (!api || !dirPath.trim()) return
    setError('')
    setExpandedGroup(null)
    setProgress({ state: 'scanning', scanned: 0, totalBytes: 0, duplicates: 0 })
    if (tab === 'duplicates') {
      setGroups([])
      const result = await api.scanDuplicates({ dirPath: dirPath.trim(), minSize: 1024 })
      if (!result.ok) {
        setError(result.error || 'Failed to start scan')
        setProgress((current) => ({ ...current, state: 'error', error: result.error }))
      }
      return
    }
    if (tab === 'largest') {
      setLargestFiles([])
      const result = await api.findLargest({ dirPath: dirPath.trim(), topN: 100 })
      if (result.ok) setLargestFiles(result.files)
      else if (result.error !== 'Scan stopped') setError(result.error || 'Scan failed')
    }
  }, [api, dirPath, tab])

  const stopScan = useCallback(async () => {
    if (api) await api.stopScan()
  }, [api])

  const openPath = useCallback(
    async (filePath: string) => {
      if (!api) return
      const result = await api.openPath(filePath)
      if (!result.ok) setError(result.error || 'Unable to open path')
    },
    [api],
  )

  const wastedBytes = useMemo(
    () => groups.reduce((sum, group) => sum + group.size * (group.files.length - 1), 0),
    [groups],
  )

  return (
    <DraggablePanel
      panelId="duplicateFinder"
      title="Duplicate Finder"
      x={dupPos.x}
      y={dupPos.y}
      defaultX={120}
      defaultY={120}
      w={dupSize.w}
      h={dupSize.h}
      defaultW={DEFAULT_DUPLICATE_FINDER_W}
      defaultH={DEFAULT_DUPLICATE_FINDER_H}
      onMove={handleMove}
      onResize={(w, h) => setDupSize(w, h)}
      locked={locked}
      onToggleLock={() => togglePanelLocked('duplicateFinder')}
      visibilityLocked={visibilityLocked}
      onToggleVisibilityLock={() => toggleVisibilityLock('duplicateFinder')}
    >
      <div
        className="split-tool-shell duplicate-finder-shell"
        style={{
          fontSize: 12,
        }}
      >
        <div className="split-tool-workspace duplicate-finder-workspace">
          <aside className="split-tool-control-pane duplicate-finder-control-pane">
            <ol className="workspace-scan-steps" aria-label={t('File review workflow')}>
              <li>{t('Choose a folder')}</li>
              <li>{t('Review matches')}</li>
              <li>{t('Open files to inspect')}</li>
            </ol>
            {error && (
              <div
                title={error}
                style={{
                  padding: '3px 8px',
                  fontSize: 12,
                  textAlign: 'center',
                  background: 'rgba(255,80,80,0.3)',
                  color: 'rgb(255,150,150)',
                  borderBottom: '1px solid rgba(var(--date),0.12)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {error}
              </div>
            )}

            <div
              className="duplicate-finder-tabs"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '4px 6px',
                borderBottom: '1px solid rgba(var(--date),0.18)',
                flexShrink: 0,
                flexWrap: 'wrap',
              }}
            >
              {(['duplicates', 'largest', 'similar'] as const).map((item) => (
                <button
                  key={item}
                  aria-pressed={tab === item}
                  onClick={() => setTab(item)}
                  disabled={scanning}
                  style={{
                    fontSize: 12,
                    padding: '3px 9px',
                    background: tab === item ? 'rgba(var(--date),0.28)' : 'transparent',
                    borderColor: tab === item ? 'rgba(var(--date),0.55)' : 'rgba(var(--date),0.2)',
                  }}
                >
                  {t(
                    item === 'duplicates'
                      ? 'Duplicates'
                      : item === 'largest'
                        ? 'Largest'
                        : 'Similar',
                  )}
                </button>
              ))}
              <span style={{ flex: 1 }} />
              <span
                style={{
                  fontSize: 12,
                  padding: '2px 8px',
                  borderRadius: 3,
                  color: '#fff',
                  background: STATUS_COLORS[progress.state],
                }}
              >
                {t(progress.state)}
              </span>
            </div>

            <div
              className="duplicate-finder-directory-row"
              style={{
                display: 'flex',
                gap: 4,
                padding: '4px 6px',
                borderBottom: '1px solid rgba(var(--date),0.12)',
                flexShrink: 0,
              }}
            >
              <input
                value={dirPath}
                onChange={(event) => setDirPath(event.target.value)}
                disabled={scanning}
                placeholder={t('Choose a directory to scan')}
                title={dirPath}
                style={{
                  flex: 1,
                  minWidth: 80,
                  fontSize: 12,
                  padding: '3px 6px',
                  background: 'rgba(var(--bg),0.6)',
                  color: 'rgb(var(--fg))',
                  border: '0.5px solid rgba(var(--date),0.4)',
                  borderRadius: 2,
                }}
              />
              <button
                onClick={chooseDirectory}
                disabled={scanning}
                style={{ fontSize: 13, padding: '3px 8px' }}
              >
                {t('Browse')}
              </button>
              {tab !== 'similar' && (
                <button
                  onClick={startScan}
                  disabled={scanning || !dirPath.trim()}
                  style={{ fontSize: 13, padding: '3px 10px' }}
                >
                  {t(tab === 'duplicates' ? 'Scan' : 'Analyze')}
                </button>
              )}
              <button
                onClick={stopScan}
                disabled={!scanning}
                style={{ fontSize: 13, padding: '3px 10px' }}
              >
                {t('Stop')}
              </button>
            </div>

            <div
              style={{
                padding: '4px 6px',
                borderBottom: '1px solid rgba(var(--date),0.12)',
                flexShrink: 0,
                fontSize: 12,
                opacity: 0.78,
              }}
            >
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <span>
                  {t('State')}: {t(progress.state)}
                </span>
                <span>
                  {t('Files')}: {progress.scanned.toLocaleString()}
                </span>
                <span>
                  {t('Size')}: {formatBytes(progress.totalBytes)}
                </span>
                {progress.candidates != null && (
                  <span>
                    {t('Candidates')}: {progress.candidates.toLocaleString()}
                  </span>
                )}
                {tab === 'duplicates' && (
                  <span>
                    {t('Groups')}: {groups.length}
                  </span>
                )}
                {progress.durationMs != null && !scanning && (
                  <span>{(progress.durationMs / 1000).toFixed(1)}s</span>
                )}
              </div>
              {scanning && progress.currentPath && (
                <div
                  title={progress.currentPath}
                  style={{
                    marginTop: 2,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    opacity: 0.7,
                  }}
                >
                  {t(progress.state === 'hashing' ? 'Hashing' : 'Scanning')} |{' '}
                  {progress.currentPath}
                </div>
              )}
            </div>
          </aside>

          <main className="split-tool-results-pane duplicate-finder-results-pane">
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 4 }}>
              {tab === 'duplicates' &&
                (groups.length === 0 ? (
                  <EmptyState
                    text={
                      scanning
                        ? t('Scanning files and grouping matching sizes…')
                        : t('Choose a directory and scan for byte-identical files.')
                    }
                  />
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <ResultSummary
                      items={`${groups.length} ${t('groups')}`}
                      detail={`${formatBytes(wastedBytes)} ${t('reclaimable')}`}
                    />
                    {groups.map((group, groupIndex) => {
                      const expanded = expandedGroup === groupIndex
                      const reclaimable = group.size * (group.files.length - 1)
                      return (
                        <div
                          key={group.hash}
                          style={{
                            border: '1px solid rgba(var(--date),0.18)',
                            borderRadius: 3,
                            overflow: 'hidden',
                          }}
                        >
                          <button
                            onClick={() => setExpandedGroup(expanded ? null : groupIndex)}
                            style={{
                              width: '100%',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              padding: '5px 7px',
                              border: 0,
                              borderRadius: 0,
                              background: 'rgba(var(--date),0.07)',
                              color: 'rgb(var(--fg))',
                              textAlign: 'left',
                            }}
                          >
                            <span style={{ opacity: 0.6 }}>{expanded ? '▾' : '▸'}</span>
                            <span style={{ fontWeight: 600 }}>
                              {group.files.length} {t('copies')}
                            </span>
                            <span style={{ opacity: 0.6 }}>
                              {formatBytes(group.size)} {t('each')}
                            </span>
                            <span style={{ flex: 1 }} />
                            <span style={{ color: 'rgb(255,190,90)' }}>
                              {formatBytes(reclaimable)} {t('reclaimable')}
                            </span>
                          </button>
                          {expanded &&
                            group.files.map((file) => (
                              <FileRow key={file.path} file={file} onOpen={openPath} />
                            ))}
                        </div>
                      )
                    })}
                  </div>
                ))}

              {tab === 'largest' &&
                (largestFiles.length === 0 ? (
                  <EmptyState
                    title={t('Largest Files')}
                    text={
                      scanning
                        ? t('Measuring files…')
                        : t('Choose a directory to list its 100 largest files.')
                    }
                  />
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <ResultSummary
                      items={`${largestFiles.length} ${t('files')}`}
                      detail={`${formatBytes(largestFiles.reduce((sum, file) => sum + file.size, 0))} ${t('shown')}`}
                    />
                    {largestFiles.map((file, index) => (
                      <FileRow key={file.path} file={file} rank={index + 1} onOpen={openPath} />
                    ))}
                  </div>
                ))}

              {tab === 'similar' && (
                <div style={{ textAlign: 'center', padding: 20, opacity: 0.65, fontSize: 13 }}>
                  <div style={{ marginBottom: 8 }}>
                    {t('Perceptual similarity is handled by the indexed Image Search engine.')}
                  </div>
                  <button
                    onClick={() => setShowImageSearch(true)}
                    style={{ fontSize: 13, padding: '4px 12px' }}
                  >
                    {t('Open Image Search')}
                  </button>
                </div>
              )}
            </div>
          </main>
        </div>
      </div>
    </DraggablePanel>
  )
}

const EmptyState: React.FC<{ text: string; title?: string }> = ({ text, title }) => {
  const { t } = useTranslation()
  return (
    <SearchEmptyState
      title={title || t('Find duplicate files')}
      description={text}
      testId="duplicate-finder-empty-state"
    />
  )
}

const ResultSummary: React.FC<{ items: string; detail: string }> = ({ items, detail }) => (
  <div style={{ display: 'flex', gap: 12, padding: '2px 6px', fontSize: 12, opacity: 0.58 }}>
    <span>{items}</span>
    <span>{detail}</span>
  </div>
)

const FileRow: React.FC<{
  file: LargestFile
  rank?: number
  onOpen: (path: string) => void
}> = ({ file, rank, onOpen }) => {
  const { language, t } = useTranslation()
  return (
    <div
      title={file.path}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minHeight: 30,
        padding: '4px 6px',
        border: '1px solid rgba(var(--date),0.14)',
        borderRadius: 3,
        fontSize: 12,
      }}
    >
      {rank != null && (
        <span style={{ width: 24, textAlign: 'right', opacity: 0.45 }}>#{rank}</span>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontWeight: 600,
          }}
        >
          {file.name}
        </div>
        <div
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            opacity: 0.45,
            fontSize: 12,
          }}
        >
          {file.path}
        </div>
      </div>
      <span style={{ whiteSpace: 'nowrap', opacity: 0.65 }}>
        {new Date(file.mtime).toLocaleDateString(language)}
      </span>
      <span
        style={{
          minWidth: 70,
          textAlign: 'right',
          whiteSpace: 'nowrap',
          color: rank != null && rank <= 3 ? 'rgb(255,190,90)' : 'inherit',
        }}
      >
        {formatBytes(file.size)}
      </span>
      <button onClick={() => onOpen(file.path)} style={{ fontSize: 12, padding: '2px 7px' }}>
        {t('Show')}
      </button>
    </div>
  )
}

export default DuplicateFinderPanel
