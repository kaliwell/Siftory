import React, { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AssetLibraryTaskProgress,
  SourceDerivedDataCategoryId,
  SourceDerivedDataCleanupProgress,
  SourceDerivedDataCleanupResult,
  SourceDerivedDataPreview,
  SourceFileSyncPreview,
  SourceFileSyncProgress,
  SourceFileSyncResult,
} from '../../shared/ipc-contract'
import { useTranslation } from '../i18n/useTranslation'

const ASSET_LIBRARY_TASK_POLL_INTERVAL_MS = 500
const ASSET_LIBRARY_TASK_TIMEOUT_MS = 30 * 60 * 1000

function abortError(): Error {
  const error = new Error('Asset library synchronization wait was cancelled')
  error.name = 'AbortError'
  return error
}

function waitForAssetLibraryTask(
  taskId: string,
  signal: AbortSignal,
): Promise<AssetLibraryTaskProgress> {
  return new Promise((resolve, reject) => {
    let settled = false
    let pollTimer: number | undefined
    let timeoutTimer: number | undefined
    let unsubscribe: (() => void) | undefined

    const cleanup = () => {
      if (pollTimer !== undefined) window.clearTimeout(pollTimer)
      if (timeoutTimer !== undefined) window.clearTimeout(timeoutTimer)
      signal.removeEventListener('abort', handleAbort)
      unsubscribe?.()
    }
    const succeed = (progress: AssetLibraryTaskProgress) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(progress)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const handleProgress = (progress: AssetLibraryTaskProgress | null) => {
      if (!progress || progress.taskId !== taskId || settled) return
      if (progress.state === 'done') {
        succeed(progress)
      } else if (progress.state === 'error') {
        fail(
          new Error(progress.error || progress.message || 'Asset library synchronization failed'),
        )
      } else if (progress.state === 'stopped') {
        fail(
          new Error(
            progress.error || progress.message || 'Asset library synchronization was stopped',
          ),
        )
      }
    }
    const poll = async () => {
      if (settled) return
      try {
        handleProgress(await window.electronAPI.assetLibrary.getTaskProgress(taskId))
        if (!settled) {
          pollTimer = window.setTimeout(() => void poll(), ASSET_LIBRARY_TASK_POLL_INTERVAL_MS)
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    }
    function handleAbort() {
      fail(abortError())
    }

    if (signal.aborted) {
      fail(abortError())
      return
    }
    signal.addEventListener('abort', handleAbort, { once: true })
    timeoutTimer = window.setTimeout(
      () => fail(new Error('Timed out waiting for asset library synchronization to finish')),
      ASSET_LIBRARY_TASK_TIMEOUT_MS,
    )
    unsubscribe = window.electronAPI.assetLibrary.onTaskProgress(handleProgress)
    void poll()
  })
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

const CATEGORY_LABELS: Record<SourceDerivedDataCategoryId, string> = {
  'image-native-index': 'Image native index',
  'image-model-vectors': 'Image model vectors',
  'image-subject-vectors': 'Image subject, face and person vectors',
  'image-thumbnails-previews': 'Image thumbnails and project previews',
  'image-diagnostics': 'Image embedding diagnostics and rejection cache',
  'video-catalog': 'Video catalog records',
  'video-frames-thumbnails': 'Video frames and thumbnails',
  'video-model-vectors': 'Video frame model vectors',
  'video-transcripts-ocr': 'Video transcripts, OCR and audio staging',
  'video-semantics': 'Video semantic index',
  'managed-automation-history': 'Managed automation source path traces',
  'shared-rebuildable-caches': 'Shared rebuildable caches',
}

export default function SourceDerivedDataCleanup(): React.ReactElement {
  const { t } = useTranslation()
  const [drives, setDrives] = useState<string[]>([])
  const [sourcePath, setSourcePath] = useState('')
  const [preview, setPreview] = useState<SourceDerivedDataPreview | null>(null)
  const [result, setResult] = useState<SourceDerivedDataCleanupResult | null>(null)
  const [progress, setProgress] = useState<SourceDerivedDataCleanupProgress | null>(null)
  const [syncPreview, setSyncPreview] = useState<SourceFileSyncPreview | null>(null)
  const [syncResult, setSyncResult] = useState<SourceFileSyncResult | null>(null)
  const [syncProgress, setSyncProgress] = useState<SourceFileSyncProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const [activeAction, setActiveAction] = useState<'sync' | 'cleanup' | null>(null)
  const [removeManagedHistoryTraces, setRemoveManagedHistoryTraces] = useState(false)
  const actionInFlightRef = useRef(false)
  const mountedRef = useRef(true)
  const assetTaskWaitAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      assetTaskWaitAbortRef.current?.abort()
      assetTaskWaitAbortRef.current = null
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.electronAPI.mediaSearch.listDrives().then((items) => {
      if (!cancelled) setDrives(items)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!busy || !activeAction) return
    let cancelled = false
    let polling = false
    let timer: number | undefined
    const poll = async () => {
      if (cancelled || polling) return
      polling = true
      try {
        if (activeAction === 'sync') {
          const current = await window.electronAPI.sourceDerivedData.syncProgress()
          if (!cancelled) setSyncProgress(current)
        } else {
          const current = await window.electronAPI.sourceDerivedData.progress()
          if (!cancelled) setProgress(current)
        }
      } catch {
        /* The final operation result remains authoritative. */
      } finally {
        polling = false
        if (!cancelled) timer = window.setTimeout(() => void poll(), 500)
      }
    }
    void poll()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [activeAction, busy])

  const hasTargets = useMemo(
    () => Boolean(preview && (preview.totalRecords > 0 || preview.fileCount > 0)),
    [preview],
  )

  const chooseFolder = async () => {
    const selected = await window.electronAPI.browseFolder()
    if (!selected) return
    setSourcePath(selected)
    setPreview(null)
    setResult(null)
    setSyncPreview(null)
    setSyncResult(null)
  }

  const analyzeSync = async () => {
    if (!sourcePath || actionInFlightRef.current) return
    actionInFlightRef.current = true
    setActiveAction('sync')
    setBusy(true)
    setSyncPreview(null)
    setSyncResult(null)
    try {
      setSyncPreview(await window.electronAPI.sourceDerivedData.syncPreview({ sourcePath }))
    } catch (error) {
      setSyncPreview({
        ok: false,
        checkedImageRecords: 0,
        checkedVideoRecords: 0,
        missingImageRecords: 0,
        missingVideoRecords: 0,
        inaccessibleRecords: 0,
        staleIndexedSourceBytes: 0,
        originalFilesAffected: 0,
        warnings: [],
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      actionInFlightRef.current = false
      setActiveAction(null)
      setBusy(false)
    }
  }

  const executeSync = async () => {
    if (!syncPreview?.ok || !syncPreview.token || syncResult || actionInFlightRef.current) return
    assetTaskWaitAbortRef.current?.abort()
    const waitController = new AbortController()
    assetTaskWaitAbortRef.current = waitController
    actionInFlightRef.current = true
    setActiveAction('sync')
    setBusy(true)
    setSyncResult(null)
    let sourceSyncResult: SourceFileSyncResult | null = null
    try {
      sourceSyncResult = await window.electronAPI.sourceDerivedData.syncExecute(syncPreview.token)
      if (waitController.signal.aborted) return
      if (
        sourceSyncResult.assetLibraryTaskId &&
        sourceSyncResult.assetLibrarySyncCompleted === undefined
      ) {
        await waitForAssetLibraryTask(sourceSyncResult.assetLibraryTaskId, waitController.signal)
      } else if (
        sourceSyncResult.assetLibrarySyncStarted &&
        sourceSyncResult.assetLibrarySyncCompleted === undefined
      ) {
        throw new Error('Asset library synchronization started without a task ID')
      }
      if (mountedRef.current && !waitController.signal.aborted) {
        setSyncResult(sourceSyncResult)
      }
    } catch (error) {
      if (mountedRef.current && !waitController.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error)
        setSyncResult(
          sourceSyncResult
            ? { ...sourceSyncResult, ok: false, error: message }
            : {
                ok: false,
                sourcePath,
                imageRecordsRemoved: 0,
                imageVectorRecordsRemoved: 0,
                videoRecordsMarkedMissing: 0,
                recoveredBeforeApply: 0,
                thumbnailFilesRemoved: 0,
                freedBytes: 0,
                assetLibrarySyncStarted: false,
                originalFilesAffected: 0,
                warnings: [],
                error: message,
              },
        )
      }
    } finally {
      actionInFlightRef.current = false
      if (assetTaskWaitAbortRef.current === waitController) {
        assetTaskWaitAbortRef.current = null
      }
      if (mountedRef.current && !waitController.signal.aborted) {
        setActiveAction(null)
        setBusy(false)
      }
    }
  }

  const analyze = async () => {
    if (!sourcePath || actionInFlightRef.current) return
    actionInFlightRef.current = true
    setActiveAction('cleanup')
    setBusy(true)
    setPreview(null)
    setResult(null)
    try {
      setPreview(
        await window.electronAPI.sourceDerivedData.preview({
          sourcePath,
          historyPolicy: removeManagedHistoryTraces ? 'remove-source-traces' : 'preserve-audit',
        }),
      )
    } catch (error) {
      setPreview({
        ok: false,
        categories: [],
        imageRecords: 0,
        videoRecords: 0,
        totalRecords: 0,
        fileCount: 0,
        estimatedBytes: 0,
        originalFilesAffected: 0,
        warnings: [],
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      actionInFlightRef.current = false
      setActiveAction(null)
      setBusy(false)
    }
  }

  const execute = async () => {
    if (!preview?.ok || !preview.token || result || actionInFlightRef.current) return
    actionInFlightRef.current = true
    setActiveAction('cleanup')
    setBusy(true)
    setResult(null)
    try {
      setResult(await window.electronAPI.sourceDerivedData.execute(preview.token))
    } catch (error) {
      setResult({
        ok: false,
        sourcePath,
        imageRecordsRemoved: 0,
        videoRecordsRemoved: 0,
        totalRecordsRemoved: 0,
        deletedFiles: 0,
        freedBytes: 0,
        originalFilesAffected: 0,
        warnings: [],
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      actionInFlightRef.current = false
      setActiveAction(null)
      setBusy(false)
    }
  }

  return (
    <div
      data-testid="source-derived-data-cleanup"
      style={{
        marginTop: 7,
        padding: 8,
        display: 'grid',
        gap: 7,
        border: '1px solid rgba(var(--date), 0.24)',
        borderRadius: 5,
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 600 }}>{t('Source index maintenance')}</div>
      <div style={{ fontSize: 10, opacity: 0.72 }}>
        {t(
          'Choose a drive or folder to synchronize deleted source files or manage generated data for that scope.',
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 5 }}>
        <select
          aria-label={t('Select source drive')}
          value={drives.includes(sourcePath) ? sourcePath : ''}
          disabled={busy}
          onChange={(event) => {
            if (!event.target.value) return
            setSourcePath(event.target.value)
            setPreview(null)
            setResult(null)
            setSyncPreview(null)
            setSyncResult(null)
          }}
          style={{ minWidth: 0, fontSize: 11 }}
        >
          <option value="">{t('Select drive')}</option>
          {drives.map((drive) => (
            <option key={drive} value={drive}>
              {drive}
            </option>
          ))}
        </select>
        <button type="button" disabled={busy} onClick={() => void chooseFolder()}>
          {t('Choose folder')}
        </button>
      </div>
      <input
        readOnly
        value={sourcePath}
        title={sourcePath}
        placeholder={t('No source selected')}
        style={{ width: '100%', minWidth: 0, boxSizing: 'border-box', fontSize: 10 }}
      />
      <div
        style={{
          padding: 7,
          display: 'grid',
          gap: 6,
          border: '1px solid rgba(var(--date), 0.16)',
          borderRadius: 4,
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 600 }}>{t('Sync source file changes')}</div>
        <div style={{ fontSize: 10, opacity: 0.72 }}>
          {t(
            'Check indexed images and videos in this online source. Missing files are removed from search metadata; original files are never changed.',
          )}
        </div>
        <button type="button" disabled={busy || !sourcePath} onClick={() => void analyzeSync()}>
          {busy && syncProgress?.state === 'checking'
            ? t('Checking indexed files...')
            : t('Check deleted source files')}
        </button>
        {activeAction === 'sync' && syncProgress?.state === 'applying' && (
          <div style={{ fontSize: 10, opacity: 0.72 }}>
            {t('Source sync phase')}: {t(syncProgress.phase || 'applying-index')} ·{' '}
            {syncProgress.checkedRecords}/{syncProgress.totalRecords}
          </div>
        )}
        {syncPreview && !syncPreview.ok && (
          <div style={{ fontSize: 10, color: 'rgba(255, 110, 110, 1)' }}>
            {syncPreview.error ? t(syncPreview.error) : t('Analysis failed')}
          </div>
        )}
        {syncPreview?.ok && (
          <div style={{ display: 'grid', gap: 4, fontSize: 10 }}>
            <div>
              {t('Checked indexed files')}: {syncPreview.checkedImageRecords} {t('images')} ·{' '}
              {syncPreview.checkedVideoRecords} {t('videos')}
            </div>
            <div>
              {t('Deleted source files found')}: {syncPreview.missingImageRecords} {t('images')} ·{' '}
              {syncPreview.missingVideoRecords} {t('videos')}
            </div>
            {syncPreview.inaccessibleRecords > 0 && (
              <div style={{ color: 'rgba(255, 190, 90, 1)' }}>
                {t('Inaccessible records preserved')}: {syncPreview.inaccessibleRecords}
              </div>
            )}
            {syncPreview.warnings.map((warning) => (
              <div key={warning} style={{ color: 'rgba(255, 190, 90, 1)' }}>
                {warning}
              </div>
            ))}
            <div style={{ color: 'rgba(120, 220, 150, 1)' }}>
              {t('Offline sources are blocked and original files are never deleted.')}
            </div>
            <button
              type="button"
              data-testid="confirm-source-file-sync"
              disabled={
                busy ||
                syncResult !== null ||
                syncPreview.missingImageRecords + syncPreview.missingVideoRecords === 0
              }
              onClick={() => void executeSync()}
            >
              {syncResult
                ? syncResult.ok
                  ? t('Synchronization completed')
                  : t('Run the check again before retrying')
                : busy && activeAction === 'sync'
                  ? t('Synchronizing source changes...')
                  : t('Confirm synchronize index')}
            </button>
          </div>
        )}
        {syncResult && (
          <div
            style={{
              fontSize: 10,
              color: syncResult.ok ? 'rgba(120, 220, 150, 1)' : 'rgba(255, 110, 110, 1)',
            }}
          >
            {syncResult.ok
              ? t('Synchronized {images} image records and {videos} video records.', {
                  images: syncResult.imageRecordsRemoved,
                  videos: syncResult.videoRecordsMarkedMissing,
                })
              : syncResult.error
                ? t(syncResult.error)
                : t('Synchronization failed')}
            {syncResult.partialCommit && (
              <div style={{ color: 'rgba(255, 190, 90, 1)' }}>
                {t(
                  'Synchronization stopped after a partial commit: {images} image records and {videos} video records were already updated.',
                  {
                    images: syncResult.imageRecordsRemoved,
                    videos: syncResult.videoRecordsMarkedMissing,
                  },
                )}
              </div>
            )}
            {syncResult.warnings.map((warning) => (
              <div key={warning}>{warning}</div>
            ))}
          </div>
        )}
      </div>
      <div style={{ fontSize: 11, fontWeight: 600 }}>{t('Delete generated data by source')}</div>
      <button type="button" disabled={busy || !sourcePath} onClick={() => void analyze()}>
        {busy && progress?.state === 'previewing'
          ? t('Analyzing generated data...')
          : t('Analyze generated data')}
      </button>
      <label
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto minmax(0, 1fr)',
          alignItems: 'start',
          gap: 6,
          fontSize: 10,
          color: 'rgba(255, 190, 90, 1)',
        }}
      >
        <input
          type="checkbox"
          checked={removeManagedHistoryTraces}
          disabled={busy}
          onChange={(event) => {
            setRemoveManagedHistoryTraces(event.target.checked)
            setPreview(null)
            setResult(null)
          }}
        />
        <span>
          {t(
            'Also remove this source path from whitelisted managed automation history. Audit evidence is preserved by default; ordinary logs are never scanned or changed.',
          )}
        </span>
      </label>

      {activeAction === 'cleanup' && progress && (
        <div style={{ fontSize: 10, opacity: 0.72 }}>
          {t('Cleanup phase')}: {t(progress.phase || 'finalizing')}
        </div>
      )}

      {preview && !preview.ok && (
        <div style={{ fontSize: 10, color: 'rgba(255, 110, 110, 1)' }}>
          {preview.error || t('Analysis failed')}
        </div>
      )}

      {preview?.ok && (
        <div style={{ display: 'grid', gap: 4, fontSize: 10 }}>
          <div>
            {t('Matched generated records')}: {preview.totalRecords} ·{' '}
            {t('Estimated removable size')}: {formatBytes(preview.estimatedBytes)}
          </div>
          {preview.categories
            .filter((item) => item.recordCount > 0 || item.fileCount > 0)
            .map((item) => (
              <div key={item.id} style={{ opacity: 0.72 }}>
                {t(CATEGORY_LABELS[item.id])}: {item.recordCount} {t('records')} · {item.fileCount}{' '}
                {t('files')} · {formatBytes(item.estimatedBytes)}
                {!item.exactBytes ? ` (${t('size is approximate')})` : ''}
              </div>
            ))}
          {!hasTargets && <div style={{ opacity: 0.72 }}>{t('No generated data found')}</div>}
          {preview.warnings.map((warning) => (
            <div key={warning} style={{ color: 'rgba(255, 190, 90, 1)' }}>
              {warning}
            </div>
          ))}
          <div style={{ color: 'rgba(255, 190, 90, 1)' }}>
            {t(
              'Original images, original videos, installed models and manually curated library metadata will not be deleted.',
            )}
          </div>
          <button
            type="button"
            data-testid="confirm-source-derived-data-cleanup"
            disabled={busy || result !== null || !hasTargets}
            onClick={() => void execute()}
            style={{ color: 'rgba(255, 100, 100, 1)' }}
          >
            {busy && progress?.state === 'deleting'
              ? t('Deleting generated data...')
              : t('Confirm delete generated data')}
          </button>
        </div>
      )}

      {result && (
        <div
          style={{
            fontSize: 10,
            color: result.ok ? 'rgba(120, 220, 150, 1)' : 'rgba(255, 110, 110, 1)',
          }}
        >
          {!result.ok && <div>{result.error || t('Cleanup failed')}</div>}
          {result.partialCommit && (
            <div>
              {t('Cleanup stopped after some steps completed. Completed changes are listed below.')}
            </div>
          )}
          {(result.ok || result.partialCommit) &&
            t('Removed {records} generated records and {files} files; freed {size}.', {
              records: result.totalRecordsRemoved,
              files: result.deletedFiles,
              size: formatBytes(result.freedBytes),
            })}
          {result.warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </div>
      )}
    </div>
  )
}
