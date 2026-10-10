import React, { useCallback, useEffect, useState } from 'react'
import type {
  StorageCleanupPreview,
  StorageCleanupProgress,
  VectorGcPreview,
  VectorGcProgress,
  VectorStoreMigrationPreview,
  VectorStoreMigrationProgress,
  VectorMaintenanceStats,
} from '../../shared/ipc-contract'
import { useTranslation } from '../i18n/useTranslation'

type ToastFn = (msg: string, type?: 'ok' | 'err') => void
type VectorModelName = 'dinov2_vitb14' | 'clip_vit_base_patch32'

interface VectorMaintenanceBarProps {
  indexedCount: number
  gpuJobs: number
  buildDisabled: boolean
  showToast: ToastFn
}

function fmtBytes(n: number | undefined): string {
  if (!n || !Number.isFinite(n) || n < 0) return ''
  if (n < 1024) return `${n}B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)}MB`
  return `${(n / 1073741824).toFixed(2)}GB`
}

function fmtPct(value: number, total: number): string {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return '--'
  return `${Math.min(999, (value / total) * 100).toFixed(1)}%`
}

function fmtDate(value: number | undefined): string {
  if (!value || !Number.isFinite(value)) return '--'
  return new Date(value).toLocaleString()
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e || 'Error')
}

function smallButtonStyle(
  disabled: boolean,
  tone: 'default' | 'warn' | 'blue' = 'default',
): React.CSSProperties {
  const colors = {
    default: {
      background: 'rgba(var(--date),0.1)',
      border: '0.5px solid rgba(var(--date),0.25)',
    },
    warn: {
      background: 'rgba(255,170,80,0.12)',
      border: '0.5px solid rgba(255,170,80,0.35)',
    },
    blue: {
      background: 'rgba(80,180,255,0.14)',
      border: '0.5px solid rgba(80,180,255,0.45)',
    },
  }[tone]
  return {
    fontSize: 8,
    padding: '1px 5px',
    background: colors.background,
    color: 'rgb(var(--fg))',
    border: colors.border,
    borderRadius: 2,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.55 : 1,
  }
}

const VectorMaintenanceBar: React.FC<VectorMaintenanceBarProps> = ({
  indexedCount,
  gpuJobs,
  buildDisabled,
  showToast,
}) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [stats, setStats] = useState<VectorMaintenanceStats | null>(null)
  const [cleanupPreview, setCleanupPreview] = useState<StorageCleanupPreview | null>(null)
  const [cleanupSelection, setCleanupSelection] = useState<Set<string>>(new Set())
  const [cleanupProgress, setCleanupProgress] = useState<StorageCleanupProgress | null>(null)
  const [gcPreview, setGcPreview] = useState<VectorGcPreview | null>(null)
  const [gcProgress, setGcProgress] = useState<VectorGcProgress | null>(null)
  const [migrationPreview, setMigrationPreview] = useState<VectorStoreMigrationPreview | null>(null)
  const [migrationProgress, setMigrationProgress] = useState<VectorStoreMigrationProgress | null>(
    null,
  )
  const topRetryableFailureReason = stats?.failureByReason.find(
    (item) =>
      ![
        'File missing',
        'Permission denied',
        'Image decode failed',
        'Malformed failure row',
      ].includes(item.key),
  )?.key
  const persistenceIssues =
    stats?.persistence.filter(
      (store) => store.pendingWrites > 0 || store.lastWriteError || store.corruptedRows > 0,
    ) || []
  const logHealthIssues = stats?.logHealth.filter((item) => !item.ok) || []

  const refreshStats = useCallback(async () => {
    const api = window.electronAPI?.vector
    if (!api?.getVectorMaintenanceStats) return
    setLoading(true)
    try {
      const next = await api.getVectorMaintenanceStats()
      setStats(next)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open || stats) return
    void refreshStats()
  }, [open, refreshStats, stats])

  useEffect(() => {
    if (cleanupProgress?.state !== 'running') return
    const timer = window.setInterval(() => {
      void window.electronAPI?.vector.getStorageCleanupProgress().then((next) => {
        setCleanupProgress(next)
        if (next.state !== 'running') {
          void refreshStats()
          showToast(
            next.state === 'completed'
              ? t('Cleanup done, freed {bytes}', {
                  bytes: fmtBytes(next.freedBytes) || '0B',
                })
              : t('Cleanup {state}', { state: t(next.state) }),
            next.errors.length > 0 ? 'err' : 'ok',
          )
        }
      })
    }, 500)
    return () => window.clearInterval(timer)
  }, [cleanupProgress?.state, refreshStats, showToast, t])

  const scanCleanupPreview = useCallback(async () => {
    setBusy(true)
    try {
      const preview = await window.electronAPI?.vector.previewStorageCleanup()
      if (!preview) return
      setCleanupPreview(preview)
      setCleanupSelection(
        new Set(preview.items.filter((item) => item.cleanupRisk === 'low').map((item) => item.id)),
      )
      showToast(
        t('Cleanup preview ready: {bytes} available', {
          bytes: fmtBytes(preview.estimatedBytes) || '0B',
        }),
        'ok',
      )
    } catch (e: unknown) {
      showToast(errMsg(e) || t('Cleanup preview failed'), 'err')
    } finally {
      setBusy(false)
    }
  }, [showToast, t])

  const confirmCleanup = useCallback(async () => {
    if (!cleanupPreview || cleanupSelection.size === 0) return
    const selected = cleanupPreview.items.filter((item) => cleanupSelection.has(item.id))
    const estimated = selected.reduce((sum, item) => sum + item.estimatedBytes, 0)
    if (
      !window.confirm(
        t(
          'Delete {count} previewed storage items ({bytes})? A metadata snapshot will be created first.',
          { count: selected.length, bytes: fmtBytes(estimated) || '0B' },
        ),
      )
    ) {
      return
    }
    setBusy(true)
    try {
      const result = await window.electronAPI?.vector.startStorageCleanup({
        token: cleanupPreview.token,
        selectedIds: [...cleanupSelection],
      })
      if (!result?.ok) {
        showToast(result?.error || t('Cleanup did not start'), 'err')
        return
      }
      const next = await window.electronAPI?.vector.getStorageCleanupProgress()
      setCleanupProgress(next || null)
      setCleanupPreview(null)
      showToast(t('Storage cleanup started'), 'ok')
    } catch (e: unknown) {
      showToast(errMsg(e) || t('Cleanup did not start'), 'err')
    } finally {
      setBusy(false)
    }
  }, [cleanupPreview, cleanupSelection, showToast, t])

  useEffect(() => {
    if (gcProgress?.state !== 'running') return
    const timer = window.setInterval(() => {
      void window.electronAPI?.vector.getVectorGcProgress().then((next) => {
        setGcProgress(next)
        if (next.state !== 'running') {
          void refreshStats()
          showToast(
            next.state === 'completed'
              ? t('Vector GC done, {bytes} reclaimable after snapshots expire', {
                  bytes: fmtBytes(next.pendingReleaseBytes) || '0B',
                })
              : t('Vector GC {state}', { state: t(next.state) }),
            next.errors.length > 0 ? 'err' : 'ok',
          )
        }
      })
    }, 750)
    return () => window.clearInterval(timer)
  }, [gcProgress?.state, refreshStats, showToast, t])

  const scanVectorGc = useCallback(async () => {
    setBusy(true)
    try {
      const preview = await window.electronAPI?.vector.previewVectorGc()
      if (!preview) return
      setGcPreview(preview)
      showToast(
        t('Vector GC preview: {bytes} reclaimable', {
          bytes: fmtBytes(preview.reclaimableBytes) || '0B',
        }),
        'ok',
      )
    } catch (e: unknown) {
      showToast(errMsg(e) || t('Vector GC preview failed'), 'err')
    } finally {
      setBusy(false)
    }
  }, [showToast, t])

  const confirmVectorGc = useCallback(async () => {
    if (!gcPreview) return
    if (
      !window.confirm(
        t(
          'Compact {count} vector shards and reclaim about {bytes}? Validated recovery backups will be retained for 7 days.',
          {
            count: gcPreview.shards.length,
            bytes: fmtBytes(gcPreview.reclaimableBytes) || '0B',
          },
        ),
      )
    ) {
      return
    }
    setBusy(true)
    try {
      const result = await window.electronAPI?.vector.startVectorGc(gcPreview.token)
      if (!result?.ok) {
        showToast(result?.error || t('Vector GC did not start'), 'err')
        return
      }
      setGcPreview(null)
      setGcProgress(await window.electronAPI.vector.getVectorGcProgress())
      showToast(t('Vector GC started'), 'ok')
    } catch (e: unknown) {
      showToast(errMsg(e) || t('Vector GC did not start'), 'err')
    } finally {
      setBusy(false)
    }
  }, [gcPreview, showToast, t])

  useEffect(() => {
    if (migrationProgress?.state !== 'running') return
    const timer = window.setInterval(() => {
      void window.electronAPI?.vector.getVectorStoreMigrationProgress().then((next) => {
        setMigrationProgress(next)
        if (next.state !== 'running') {
          void refreshStats()
          showToast(
            next.state === 'completed'
              ? t('Binary vector store ready: {generation}', {
                  generation: next.generation || t('new generation'),
                })
              : t('Vector migration {state}', { state: t(next.state) }),
            next.errors.length > 0 ? 'err' : 'ok',
          )
        }
      })
    }, 750)
    return () => window.clearInterval(timer)
  }, [migrationProgress?.state, refreshStats, showToast, t])

  const scanVectorStoreMigration = useCallback(async () => {
    setBusy(true)
    try {
      const preview = await window.electronAPI?.vector.previewVectorStoreMigration()
      if (!preview) return
      setMigrationPreview(preview)
      showToast(
        t('Binary migration preview: {count} model(s), about {bytes}', {
          count: preview.models.length,
          bytes: fmtBytes(preview.estimatedBinaryBytes) || '0B',
        }),
        'ok',
      )
    } catch (e: unknown) {
      showToast(errMsg(e) || t('Vector migration preview failed'), 'err')
    } finally {
      setBusy(false)
    }
  }, [showToast, t])

  const confirmVectorStoreMigration = useCallback(async () => {
    if (!migrationPreview || migrationPreview.models.length === 0) return
    if (
      !window.confirm(
        t(
          'Build and validate a new binary generation for {count} model(s)? JSONL remains untouched until you separately confirm cleanup.',
          { count: migrationPreview.models.length },
        ),
      )
    ) {
      return
    }
    setBusy(true)
    try {
      const result = await window.electronAPI?.vector.startVectorStoreMigration(
        migrationPreview.token,
      )
      if (!result?.ok) {
        showToast(result?.error || t('Vector migration did not start'), 'err')
        return
      }
      setMigrationPreview(null)
      setMigrationProgress(await window.electronAPI.vector.getVectorStoreMigrationProgress())
      showToast(t('Binary vector migration started'), 'ok')
    } catch (e: unknown) {
      showToast(errMsg(e) || t('Vector migration did not start'), 'err')
    } finally {
      setBusy(false)
    }
  }, [migrationPreview, showToast, t])

  const runMaintenanceAction = useCallback(
    async (
      action: 'clearVectorDiagnostics' | 'clearVectorFailures' | 'compactVectorJobs',
      label: string,
    ) => {
      const api = window.electronAPI?.vector
      if (!api) return
      setBusy(true)
      try {
        const result =
          action === 'clearVectorDiagnostics'
            ? await api.clearVectorDiagnostics()
            : action === 'clearVectorFailures'
              ? await api.clearVectorFailures()
              : await api.compactVectorJobs()
        if (!result?.ok) {
          showToast(result?.error || t('{label} failed', { label }), 'err')
          return
        }
        await refreshStats()
        const freed =
          'freedBytes' in result
            ? result.freedBytes
            : Math.max(0, result.beforeBytes - result.afterBytes)
        showToast(
          t('{label} done{freed}', {
            label,
            freed: freed > 0 ? `, ${t('freed')} ${fmtBytes(freed)}` : '',
          }),
          'ok',
        )
      } catch (e: unknown) {
        showToast(errMsg(e) || t('{label} failed', { label }), 'err')
      } finally {
        setBusy(false)
      }
    },
    [refreshStats, showToast, t],
  )

  const retryFailedEmbeddings = useCallback(
    async (modelName: VectorModelName, reason?: string) => {
      const api = window.electronAPI?.vector
      if (!api?.getVectorFailureRetryCandidates || !api?.startEmbeddingBuild) return
      setBusy(true)
      try {
        const candidates = await api.getVectorFailureRetryCandidates({
          modelName,
          ...(reason ? { reason } : {}),
          limit: 1000,
        })
        if (!candidates?.ok) {
          showToast(candidates?.error || t('Load retry candidates failed'), 'err')
          return
        }
        if (!candidates.imageIds?.length) {
          showToast(
            reason
              ? t('No {reason} files to retry', { reason })
              : t('No existing failed files to retry'),
            'err',
          )
          return
        }
        const r = await api.startEmbeddingBuild({
          modelName,
          embeddingType: 'global',
          imageIds: candidates.imageIds,
          ...(modelName === 'clip_vit_base_patch32'
            ? { backend: 'gpu', maxConcurrentEmbeddings: gpuJobs }
            : {}),
        })
        const label = reason ? t('Retry {reason}', { reason }) : t('Retry')
        showToast(
          r.ok
            ? t('{label} started: {count} failed files', {
                label,
                count: candidates.imageIds.length.toLocaleString(),
              })
            : r.error || t('Retry failed'),
          r.ok ? 'ok' : 'err',
        )
      } catch (e: unknown) {
        showToast(errMsg(e) || t('Retry failed'), 'err')
      } finally {
        setBusy(false)
      }
    },
    [gpuJobs, showToast, t],
  )

  const actionDisabled = busy || buildDisabled

  return (
    <div
      style={{
        padding: '3px 6px',
        borderBottom: '1px solid rgba(var(--date),0.12)',
        flexShrink: 0,
        fontSize: 9,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <button
          data-testid="vector-storage-toggle"
          onClick={() => setOpen((v) => !v)}
          style={{
            fontSize: 8,
            padding: '1px 6px',
            background: open ? 'rgba(80,180,255,0.18)' : 'rgba(var(--date),0.1)',
            color: 'rgb(var(--fg))',
            border: '0.5px solid rgba(var(--date),0.3)',
            borderRadius: 2,
            cursor: 'pointer',
          }}
          title={t('Show vector database size and maintenance actions')}
        >
          {t('Storage')}
        </button>
        {stats ? (
          <>
            <span>
              {t('Total')} {fmtBytes(stats.totalBytes)}
            </span>
            <span>
              {t('Inventory')} {fmtBytes(stats.storageInventory.totalBytes)} / {t('reclaimable')}{' '}
              {fmtBytes(stats.storageInventory.reclaimableBytes)}
            </span>
            <span>
              {t('Emb')} {fmtBytes(stats.embeddingsDirBytes)}
            </span>
            <span
              title={t('DINO unique images / current hash index total records: {count}', {
                count: stats.dinoEmbeddingRecords.toLocaleString(),
              })}
            >
              DINO {stats.dinoUniqueImages.toLocaleString()} (
              {fmtPct(stats.dinoUniqueImages, indexedCount)})
            </span>
            <span
              title={t('CLIP unique images / current hash index total records: {count}', {
                count: stats.clipEmbeddingRecords.toLocaleString(),
              })}
            >
              CLIP {stats.clipUniqueImages.toLocaleString()} (
              {fmtPct(stats.clipUniqueImages, indexedCount)})
            </span>
            <span>
              {t('Jobs')} {fmtBytes(stats.jobs.sizeBytes)}
            </span>
            <span
              title={t('Failure rows: {count}', {
                count: stats.failureCount.toLocaleString(),
              })}
              style={{
                color: stats.failureCount > 0 ? 'rgb(255,170,120)' : 'rgb(var(--fg))',
              }}
            >
              {t('Fail')} {fmtBytes(stats.failures.sizeBytes)} /{' '}
              {stats.failureCount.toLocaleString()}
            </span>
            <span>
              {t('Diag')} {stats.diagnosticBackups.length}
            </span>
            {logHealthIssues.length > 0 && (
              <span
                style={{ color: 'rgb(255,110,110)' }}
                title={logHealthIssues
                  .map((item) => `${item.name}: ${item.lastError || 'write unavailable'}`)
                  .join('\n')}
              >
                {t('Log issues: {count}', { count: logHealthIssues.length })}
              </span>
            )}
            {persistenceIssues.length > 0 && (
              <span
                style={{ color: 'rgb(255,110,110)' }}
                title={persistenceIssues
                  .map(
                    (store) =>
                      `${store.filename}: pending=${store.pendingWrites}, corrupt=${store.corruptedRows}${store.lastWriteError ? `, error=${store.lastWriteError}` : ''}`,
                  )
                  .join('\n')}
              >
                {t('Store issues: {count}', { count: persistenceIssues.length })}
              </span>
            )}
            <button
              disabled={busy || loading}
              onClick={() => void refreshStats()}
              style={smallButtonStyle(busy || loading)}
            >
              {loading ? t('Loading') : t('Refresh')}
            </button>
          </>
        ) : (
          <span style={{ opacity: 0.55 }}>
            {loading ? t('Loading stats...') : t('Open to inspect vector storage')}
          </span>
        )}
      </div>
      {open && (
        <>
          <div
            style={{
              marginTop: 3,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flexWrap: 'wrap',
              opacity: 0.88,
            }}
          >
            {stats && (
              <>
                <span>
                  CLIP {t('Cache')} {fmtBytes(stats.clipCache.vectors.sizeBytes)} /{' '}
                  {stats.clipCacheUniquePaths.toLocaleString()} {t('images')}
                </span>
                <span>
                  {t('Shards')} {stats.embeddingShards.length}
                </span>
                <span>
                  {t('Diag backups')}{' '}
                  {fmtBytes(stats.diagnosticBackups.reduce((sum, item) => sum + item.sizeBytes, 0))}
                </span>
                {stats.failureByReason.length > 0 && (
                  <span
                    title={stats.failureByReason
                      .map((item) => `${item.key}: ${item.count.toLocaleString()}`)
                      .join('\n')}
                    style={{ color: 'rgb(255,170,120)' }}
                  >
                    {t('Top fail')} {stats.failureByReason[0].key} (
                    {stats.failureByReason[0].count.toLocaleString()})
                  </span>
                )}
                {stats.failureByModel.length > 0 && (
                  <span
                    title={stats.failureByModel
                      .map((item) => `${item.key}: ${item.count.toLocaleString()}`)
                      .join('\n')}
                  >
                    {t('Fail models')}{' '}
                    {stats.failureByModel
                      .map((item) => `${item.key}:${item.count.toLocaleString()}`)
                      .join(', ')}
                  </span>
                )}
                {stats.recentFailures.length > 0 && (
                  <span
                    title={stats.recentFailures
                      .map((item) => [item.time || '', item.modelName || '', item.error].join('\n'))
                      .join('\n\n')}
                    style={{
                      maxWidth: 260,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t('Recent fail')}: {stats.recentFailures[0].error}
                  </span>
                )}
              </>
            )}
            <button
              disabled={busy}
              onClick={() =>
                void runMaintenanceAction('clearVectorDiagnostics', t('Clear diagnostics'))
              }
              style={smallButtonStyle(busy)}
              title={t('Delete old embedding_diagnostics backup files only')}
            >
              {t('Clear Diag')}
            </button>
            <button
              disabled={busy}
              onClick={() => void runMaintenanceAction('clearVectorFailures', t('Clear failures'))}
              style={smallButtonStyle(busy)}
              title={t('Truncate embedding_failures.jsonl. Embeddings are not deleted.')}
            >
              {t('Clear Fail')}
            </button>
            <button
              disabled={busy}
              onClick={() => void runMaintenanceAction('compactVectorJobs', t('Compact jobs'))}
              style={smallButtonStyle(busy)}
              title={t(
                'Rewrite embedding_jobs.jsonl and keep active jobs plus bounded recent failures',
              )}
            >
              {t('Compact Jobs')}
            </button>
            <button
              disabled={actionDisabled}
              onClick={() => void retryFailedEmbeddings('dinov2_vitb14')}
              style={smallButtonStyle(actionDisabled, 'warn')}
              title={t(
                'Retry recent failed DINO embedding files that still exist. Existing embeddings are skipped.',
              )}
            >
              {t('Retry DINO')}
            </button>
            <button
              disabled={actionDisabled}
              onClick={() => void retryFailedEmbeddings('clip_vit_base_patch32')}
              style={smallButtonStyle(actionDisabled, 'blue')}
              title={t(
                'Retry recent failed CLIP embedding files with GPU when available. Existing embeddings are skipped.',
              )}
            >
              {t('Retry CLIP')}
            </button>
            {topRetryableFailureReason && (
              <>
                <button
                  disabled={actionDisabled}
                  onClick={() =>
                    void retryFailedEmbeddings('dinov2_vitb14', topRetryableFailureReason)
                  }
                  style={smallButtonStyle(actionDisabled, 'warn')}
                  title={t('Retry DINO failed files whose current failure reason is: {reason}', {
                    reason: topRetryableFailureReason,
                  })}
                >
                  {t('Retry Top DINO')}
                </button>
                <button
                  disabled={actionDisabled}
                  onClick={() =>
                    void retryFailedEmbeddings('clip_vit_base_patch32', topRetryableFailureReason)
                  }
                  style={smallButtonStyle(actionDisabled, 'blue')}
                  title={t('Retry CLIP failed files whose current failure reason is: {reason}', {
                    reason: topRetryableFailureReason,
                  })}
                >
                  {t('Retry Top CLIP')}
                </button>
              </>
            )}
          </div>
          {stats && (
            <div
              style={{
                marginTop: 5,
                maxHeight: 190,
                overflow: 'auto',
                border: '0.5px solid rgba(var(--date),0.16)',
              }}
            >
              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: 8,
                  textAlign: 'left',
                }}
              >
                <thead style={{ position: 'sticky', top: 0, background: 'rgb(var(--bg))' }}>
                  <tr>
                    {[
                      'Logical storage',
                      'Total',
                      'Active',
                      'Reclaimable',
                      'Modified',
                      'Rebuild',
                      'Risk',
                      'Task',
                    ].map((label) => (
                      <th
                        key={label}
                        style={{
                          padding: '2px 4px',
                          borderBottom: '0.5px solid rgba(var(--date),0.2)',
                        }}
                      >
                        {t(label)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {stats.storageInventory.items.map((item) => (
                    <tr key={item.id} title={item.detail || item.pathCategory}>
                      <td style={{ padding: '2px 4px' }}>
                        {item.pathCategory}
                        <span style={{ opacity: 0.5 }}>
                          {' '}
                          · {item.fileCount} {t('files')}
                        </span>
                      </td>
                      <td style={{ padding: '2px 4px' }}>{fmtBytes(item.totalBytes) || '0B'}</td>
                      <td style={{ padding: '2px 4px' }}>{fmtBytes(item.activeBytes) || '0B'}</td>
                      <td
                        style={{
                          padding: '2px 4px',
                          color: item.reclaimableBytes > 0 ? 'rgb(120,210,150)' : 'rgb(var(--fg))',
                        }}
                      >
                        {fmtBytes(item.reclaimableBytes) || '0B'}
                      </td>
                      <td style={{ padding: '2px 4px', whiteSpace: 'nowrap' }}>
                        {fmtDate(item.lastModifiedAt)}
                      </td>
                      <td style={{ padding: '2px 4px' }}>
                        {item.rebuildable ? t('Yes') : t('No')}
                      </td>
                      <td
                        style={{
                          padding: '2px 4px',
                          color:
                            item.cleanupRisk === 'high'
                              ? 'rgb(255,120,120)'
                              : item.cleanupRisk === 'medium'
                                ? 'rgb(255,190,110)'
                                : 'rgb(var(--fg))',
                        }}
                      >
                        {t(item.cleanupRisk)}
                      </td>
                      <td style={{ padding: '2px 4px' }}>{t(item.taskState)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div
            style={{
              marginTop: 5,
              display: 'flex',
              gap: 5,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <button
              data-testid="vector-cleanup-preview"
              disabled={busy || cleanupProgress?.state === 'running'}
              onClick={() => void scanCleanupPreview()}
              style={smallButtonStyle(busy || cleanupProgress?.state === 'running', 'blue')}
              title={t('Scan safe cleanup candidates. This preview does not delete data.')}
            >
              {t('Preview Cleanup')}
            </button>
            {cleanupPreview?.items.map((item) => (
              <label
                key={item.id}
                title={t('{category} Risk: {risk}', {
                  category: item.pathCategory,
                  risk: t(item.cleanupRisk),
                })}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}
              >
                <input
                  type="checkbox"
                  checked={cleanupSelection.has(item.id)}
                  onChange={(event) =>
                    setCleanupSelection((current) => {
                      const next = new Set(current)
                      if (event.target.checked) next.add(item.id)
                      else next.delete(item.id)
                      return next
                    })
                  }
                />
                {item.label} {fmtBytes(item.estimatedBytes)}
              </label>
            ))}
            {cleanupPreview && (
              <button
                disabled={busy || cleanupSelection.size === 0}
                onClick={() => void confirmCleanup()}
                style={smallButtonStyle(busy || cleanupSelection.size === 0, 'warn')}
              >
                {t('Confirm Cleanup')}
              </button>
            )}
            {cleanupProgress?.state === 'running' && (
              <>
                <span>
                  {t('Cleaning')} {cleanupProgress.completedFiles}/{cleanupProgress.totalFiles} ·{' '}
                  {t('freed')} {fmtBytes(cleanupProgress.freedBytes) || '0B'}
                </span>
                <button
                  onClick={() => void window.electronAPI?.vector.cancelStorageCleanup()}
                  style={smallButtonStyle(false, 'warn')}
                >
                  {t('Cancel')}
                </button>
              </>
            )}
            {cleanupProgress && cleanupProgress.state !== 'running' && (
              <span>
                {t('Last cleanup')}: {t(cleanupProgress.state)}, {t('freed')}{' '}
                {fmtBytes(cleanupProgress.freedBytes) || '0B'}, {t('skipped')}{' '}
                {cleanupProgress.skipped},{t('errors')} {cleanupProgress.errors.length}
              </span>
            )}
          </div>
          <div
            style={{
              marginTop: 4,
              display: 'flex',
              gap: 5,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <button
              disabled={busy || gcProgress?.state === 'running'}
              onClick={() => void scanVectorGc()}
              style={smallButtonStyle(busy || gcProgress?.state === 'running', 'blue')}
              title={t('Read the active Image Search index and preview stale vector removal')}
            >
              {t('Preview Vector GC')}
            </button>
            {gcPreview && (
              <>
                <span>
                  {t('Active')} {gcPreview.activeAssetCount.toLocaleString()} · {t('shards')}{' '}
                  {gcPreview.shards.length} · {t('reclaimable')}{' '}
                  {fmtBytes(gcPreview.reclaimableBytes) || '0B'}
                </span>
                {gcPreview.shards.map((shard) => (
                  <span
                    key={shard.name}
                    title={t(
                      'active={active}, stale={stale}, duplicate={duplicate}, malformed={malformed}',
                      {
                        active: shard.activeRecords,
                        stale: shard.staleRecords,
                        duplicate: shard.duplicateRecords,
                        malformed: shard.malformedRecords,
                      },
                    )}
                  >
                    {shard.modelName || shard.name}: {shard.activeRecords.toLocaleString()}{' '}
                    {t('active')} / {shard.staleRecords.toLocaleString()} {t('stale')}
                  </span>
                ))}
                <button
                  disabled={busy || gcPreview.shards.length === 0}
                  onClick={() => void confirmVectorGc()}
                  style={smallButtonStyle(busy || gcPreview.shards.length === 0, 'warn')}
                >
                  {t('Confirm Vector GC')}
                </button>
              </>
            )}
            {gcProgress?.state === 'running' && (
              <>
                <span>
                  {t('Vector GC')} {gcProgress.completedShards}/{gcProgress.totalShards}
                  {gcProgress.currentShard ? ` · ${gcProgress.currentShard}` : ''}
                </span>
                <button
                  onClick={() => void window.electronAPI?.vector.cancelVectorGc()}
                  style={smallButtonStyle(false, 'warn')}
                >
                  {t('Cancel GC')}
                </button>
              </>
            )}
            {gcProgress && gcProgress.state !== 'running' && (
              <span>
                {t('Last GC')}: {t(gcProgress.state)}, {t('reclaimed')}{' '}
                {fmtBytes(gcProgress.freedBytes) || '0B'},{t('pending')}{' '}
                {fmtBytes(gcProgress.pendingReleaseBytes) || '0B'}, {t('backups')}{' '}
                {gcProgress.backups}, {t('errors')} {gcProgress.errors.length}
              </span>
            )}
          </div>
          <div
            style={{
              marginTop: 4,
              display: 'flex',
              gap: 5,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <button
              disabled={busy || migrationProgress?.state === 'running'}
              onClick={() => void scanVectorStoreMigration()}
              style={smallButtonStyle(busy || migrationProgress?.state === 'running', 'blue')}
              title={t(
                'Preview a streaming migration to the authoritative Float16 generation store',
              )}
            >
              {t('Preview Binary Migration')}
            </button>
            {migrationPreview && (
              <>
                <span>
                  {migrationPreview.models.length} {t('models')} · {t('source')}{' '}
                  {fmtBytes(migrationPreview.sourceBytes) || '0B'} · {t('estimated binary')}{' '}
                  {fmtBytes(migrationPreview.estimatedBinaryBytes) || '0B'}
                </span>
                <button
                  disabled={busy || migrationPreview.models.length === 0}
                  onClick={() => void confirmVectorStoreMigration()}
                  style={smallButtonStyle(busy || migrationPreview.models.length === 0, 'warn')}
                >
                  {t('Confirm Migration')}
                </button>
              </>
            )}
            {migrationProgress?.state === 'running' && (
              <>
                <span>
                  {t('Migrating')} {migrationProgress.completedModels}/
                  {migrationProgress.totalModels}
                  {migrationProgress.currentModel ? ` · ${migrationProgress.currentModel}` : ''} ·
                  {t('written')} {fmtBytes(migrationProgress.writtenBytes) || '0B'}
                </span>
                <button
                  onClick={() => void window.electronAPI?.vector.cancelVectorStoreMigration()}
                  style={smallButtonStyle(false, 'warn')}
                >
                  {t('Cancel Migration')}
                </button>
              </>
            )}
            {migrationProgress && migrationProgress.state !== 'running' && (
              <span>
                {t('Last migration')}: {t(migrationProgress.state)}, {t('written')}{' '}
                {fmtBytes(migrationProgress.writtenBytes) || '0B'}, {t('generation')}{' '}
                {migrationProgress.generation || t('unchanged')}, {t('errors')}{' '}
                {migrationProgress.errors.length}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default VectorMaintenanceBar
