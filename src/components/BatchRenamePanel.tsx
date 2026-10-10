// ── Batch Rename Panel ───────────────────────────────────

import React, { useCallback, useEffect, useState } from 'react'
import DraggablePanel from './DraggablePanel'
import { useStore } from '../stores/useStore'
import type {
  BatchRenameProgress,
  BatchRenameResult,
  BatchRenameStartResponse,
} from '../../shared/ipc-contract'
import { useTranslation } from '../i18n/useTranslation'
import { useLinkedMove } from '../hooks/useLinkedMove'
import { DEFAULT_BATCH_RENAME_H, DEFAULT_BATCH_RENAME_W } from '../types'
import { batchRenameBridge } from '../services/batchRenameBridge'

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const sec = s % 60
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`
}

const BatchRenamePanel: React.FC = () => {
  const { t } = useTranslation()
  const showPanel = useStore((s) => s.showBatchRename)
  const pos = useStore((s) => s.batchRenamePos)
  const size = useStore((s) => s.batchRenameSize)
  const setPos = useStore((s) => s.setBatchRenamePos)
  const setSize = useStore((s) => s.setBatchRenameSize)
  const linkedMove = useStore((s) => s.linkedMove)
  const locked = useStore((s) => s.lockedPanels.batchRename ?? false)
  const visibilityLocked = useStore((s) => s.lockedVisibility.batchRename ?? false)
  const togglePanelLocked = useStore((s) => s.togglePanelLocked)
  const toggleVisibilityLock = useStore((s) => s.toggleVisibilityLock)
  const handleMove = useLinkedMove('batchRename', pos, setPos, linkedMove)

  const [originDir, setOriginDir] = useState('')
  const [modifiedDir, setModifiedDir] = useState('')
  const [outputDir, setOutputDir] = useState('')
  const [threshold, setThreshold] = useState(0.85)
  const [conflictPolicy, setConflictPolicy] = useState<'keep-best' | 'skip' | 'keep-both'>(
    'keep-best',
  )
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<BatchRenameProgress | null>(null)
  const [result, setResult] = useState<BatchRenameResult | null>(null)

  const reset = useCallback(() => {
    setRunning(false)
    setProgress(null)
    setResult(null)
  }, [])

  useEffect(() => {
    let disposed = false
    let receivedLiveProgress = false
    const applyProgress = (next: BatchRenameProgress) => {
      if (disposed) return
      setProgress(next)
      const terminal = next.state === 'done' || next.state === 'stopped' || next.state === 'error'
      setRunning(!terminal)
      if (terminal) {
        void batchRenameBridge
          .getResult()
          .then((nextResult) => {
            if (!disposed) setResult(nextResult)
          })
          .catch(() => undefined)
      }
    }
    const unsubscribe = batchRenameBridge.onProgress((next) => {
      receivedLiveProgress = true
      applyProgress(next)
    })
    void batchRenameBridge
      .getProgress()
      .then((current) => {
        if (current && !receivedLiveProgress) applyProgress(current)
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  const handleStart = useCallback(async () => {
    if (!originDir || !modifiedDir || !outputDir) return
    setResult(null)
    setRunning(true)

    let resp: BatchRenameStartResponse
    try {
      resp = await batchRenameBridge.start({
        originDir,
        modifiedDir,
        outputDir,
        threshold,
        conflictPolicy,
      })
    } catch (error) {
      resp = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }

    if (!resp.ok) {
      setProgress({
        taskId: '',
        state: 'error',
        originTotal: 0,
        modifiedTotal: 0,
        matched: 0,
        unmatched: 0,
        conflicts: 0,
        copied: 0,
        elapsedMs: 0,
        error: resp.error,
      })
      setRunning(false)
      return
    }
  }, [originDir, modifiedDir, outputDir, threshold, conflictPolicy])

  const handleStop = useCallback(() => {
    void batchRenameBridge.stop()
  }, [])

  const handleSelectOrigin = useCallback(async () => {
    const p = await batchRenameBridge.selectFolder()
    if (p) setOriginDir(p)
  }, [])

  const handleSelectModified = useCallback(async () => {
    const p = await batchRenameBridge.selectFolder()
    if (p) setModifiedDir(p)
  }, [])

  const handleSelectOutput = useCallback(async () => {
    const p = await batchRenameBridge.selectFolder()
    if (p) setOutputDir(p)
  }, [])

  if (!showPanel) return null

  const pct =
    progress?.percent != null
      ? progress.percent
      : progress && progress.modifiedTotal > 0
        ? Math.round(((progress.matched + progress.unmatched) / progress.modifiedTotal) * 100)
        : 0

  return (
    <DraggablePanel
      panelId="batchRename"
      title="Batch Rename"
      x={pos.x}
      y={pos.y}
      defaultX={210}
      defaultY={180}
      w={size.w}
      h={size.h}
      defaultW={DEFAULT_BATCH_RENAME_W}
      defaultH={DEFAULT_BATCH_RENAME_H}
      onMove={handleMove}
      onResize={(w, h) => setSize(w, h)}
      locked={locked}
      onToggleLock={() => togglePanelLocked('batchRename')}
      visibilityLocked={visibilityLocked}
      onToggleVisibilityLock={() => toggleVisibilityLock('batchRename')}
      dataPanel="batch-rename"
    >
      <div
        style={{
          padding: '8px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          overflow: 'auto',
          flex: 1,
        }}
      >
        {/* Origin dir */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ flexShrink: 0, width: 72, opacity: 0.7, fontSize: 12 }}>
            {t('Origin')}
          </span>
          <input
            value={originDir}
            onChange={(e) => setOriginDir(e.target.value)}
            placeholder={t('Folder with original names')}
            style={{ flex: 1, fontSize: 11, padding: '2px 6px' }}
            disabled={running}
          />
          <button
            onClick={handleSelectOrigin}
            disabled={running}
            style={{ fontSize: 11, padding: '2px 8px' }}
          >
            {t('Browse')}
          </button>
        </div>

        {/* Modified dir */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ flexShrink: 0, width: 72, opacity: 0.7, fontSize: 12 }}>
            {t('Modified')}
          </span>
          <input
            value={modifiedDir}
            onChange={(e) => setModifiedDir(e.target.value)}
            placeholder={t('Folder with renamed images')}
            style={{ flex: 1, fontSize: 11, padding: '2px 6px' }}
            disabled={running}
          />
          <button
            onClick={handleSelectModified}
            disabled={running}
            style={{ fontSize: 11, padding: '2px 8px' }}
          >
            {t('Browse')}
          </button>
        </div>

        {/* Output dir */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ flexShrink: 0, width: 72, opacity: 0.7, fontSize: 12 }}>
            {t('Output')}
          </span>
          <input
            value={outputDir}
            onChange={(e) => setOutputDir(e.target.value)}
            placeholder={t('Output folder')}
            style={{ flex: 1, fontSize: 11, padding: '2px 6px' }}
            disabled={running}
          />
          <button
            onClick={handleSelectOutput}
            disabled={running}
            style={{ fontSize: 11, padding: '2px 8px' }}
          >
            {t('Browse')}
          </button>
        </div>

        {/* Threshold */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ flexShrink: 0, width: 72, opacity: 0.7, fontSize: 12 }}>
            {t('Threshold')}
          </span>
          <input
            type="range"
            min={0.5}
            max={0.99}
            step={0.01}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            disabled={running}
            style={{ flex: 1 }}
          />
          <span style={{ width: 36, textAlign: 'right', fontSize: 12 }}>
            {threshold.toFixed(2)}
          </span>
        </div>

        {/* Conflict policy */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ flexShrink: 0, width: 72, opacity: 0.7, fontSize: 12 }}>
            {t('Conflict')}
          </span>
          <select
            value={conflictPolicy}
            onChange={(e) =>
              setConflictPolicy(e.target.value as 'keep-best' | 'skip' | 'keep-both')
            }
            disabled={running}
            style={{ fontSize: 11, padding: '2px 4px' }}
          >
            <option value="keep-best">{t('Keep best match')}</option>
            <option value="skip">{t('Skip conflict')}</option>
            <option value="keep-both">{t('Keep both')}</option>
          </select>
        </div>

        {/* Buttons */}
        <div style={{ display: 'flex', gap: 6 }}>
          {!running ? (
            <button
              onClick={handleStart}
              disabled={!originDir || !modifiedDir || !outputDir}
              style={{ fontSize: 12, padding: '3px 16px' }}
            >
              {t('Start')}
            </button>
          ) : (
            <button onClick={handleStop} style={{ fontSize: 12, padding: '3px 16px' }}>
              {t('Stop')}
            </button>
          )}
          {!running && result && (
            <button onClick={reset} style={{ fontSize: 12, padding: '3px 16px' }}>
              {t('Clear')}
            </button>
          )}
        </div>

        {/* Progress */}
        {progress && progress.state !== 'error' && (
          <div style={{ fontSize: 11, opacity: 0.85 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
              <span>{t(progress.state)}</span>
              <span>
                {pct}% ({progress.matched + progress.unmatched}/{progress.modifiedTotal})
              </span>
            </div>
            <div
              style={{
                background: 'rgba(var(--date), 0.18)',
                height: 4,
                borderRadius: 2,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  background: 'rgba(var(--date), 0.7)',
                  height: '100%',
                  width: `${pct}%`,
                  transition: 'width 0.15s',
                }}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
              <span>
                ✓ {progress.matched} {t('matched')}
              </span>
              <span>
                ✗ {progress.unmatched} {t('unmatched')}
              </span>
              <span>{fmtTime(progress.elapsedMs)}</span>
            </div>
            {progress.etaMs != null && progress.etaMs > 0 && (
              <div style={{ opacity: 0.6 }}>
                {t('ETA')}: {fmtTime(progress.etaMs)}
              </div>
            )}
          </div>
        )}

        {progress?.state === 'error' && (
          <div style={{ fontSize: 12, color: 'rgba(var(--date), 0.85)', padding: '4px 0' }}>
            {t('Error')}: {progress.error || t('Unknown error')}
          </div>
        )}

        {/* Results summary */}
        {result && (
          <div
            style={{ fontSize: 11, borderTop: '1px solid rgba(var(--date), 0.14)', paddingTop: 6 }}
          >
            <div style={{ marginBottom: 4, fontWeight: 600 }}>
              {result.state === 'done' ? t('Done in') : t(result.state)}{' '}
              {fmtTime(result.durationMs)} — {result.matched.length} {t('matched')},{' '}
              {result.unmatched.length} {t('unmatched')},{' '}
              {result.pending.length + result.pendingOriginals.length} {t('pending')},{' '}
              {result.conflicts.length} {t('Conflict')}
            </div>
            <div style={{ maxHeight: 150, overflow: 'auto' }}>
              {result.matched.slice(0, 50).map((m, i) => (
                <div
                  key={i}
                  style={{
                    padding: '2px 0',
                    borderBottom: '1px solid rgba(var(--date), 0.06)',
                    display: 'flex',
                    gap: 8,
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={m.modifiedPath}
                  >
                    {m.originalName}
                  </span>
                  <span style={{ opacity: 0.5, flexShrink: 0 }}>←</span>
                  <span
                    style={{
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      opacity: 0.7,
                    }}
                    title={m.modifiedPath}
                  >
                    {m.modifiedPath.split(/[/\\]/).pop()}
                  </span>
                  <span style={{ width: 36, textAlign: 'right', flexShrink: 0 }}>
                    {(m.score * 100).toFixed(0)}%
                  </span>
                </div>
              ))}
              {result.matched.length > 50 && (
                <div style={{ opacity: 0.5, padding: '4px 0' }}>
                  ... {t('and {count} more', { count: result.matched.length - 50 })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </DraggablePanel>
  )
}

export default BatchRenamePanel
