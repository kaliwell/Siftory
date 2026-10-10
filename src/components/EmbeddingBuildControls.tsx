import React, { useCallback } from 'react'
import type { EmbeddingProgress, ModelStatus, SearchMode } from '../../shared/vectorTypes'
import { useTranslation } from '../i18n/useTranslation'

export const GPU_JOB_OPTIONS = [1, 2]

function fmtDuration(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms) || ms < 0) return '--'
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Error'
}

const smallButtonStyle: React.CSSProperties = {
  fontSize: 8,
  padding: '1px 5px',
  background: 'rgba(var(--date),0.12)',
  color: 'rgb(var(--fg))',
  border: '0.5px solid rgba(var(--date),0.3)',
  borderRadius: 2,
}

interface EmbeddingBuildControlsProps {
  searchMode: SearchMode
  scanPaths: string[]
  dinoModelStatus: ModelStatus
  clipModelStatus: ModelStatus
  embeddingProgress: EmbeddingProgress
  gpuJobs: number
  setGpuJobs: (value: number) => void
  batchSize: number
  setBatchSize: (value: number) => void
  showToast: (msg: string, type?: 'ok' | 'err') => void
}

const EmbeddingBuildControls: React.FC<EmbeddingBuildControlsProps> = ({
  searchMode,
  scanPaths,
  dinoModelStatus,
  clipModelStatus,
  embeddingProgress,
  gpuJobs,
  setGpuJobs,
  batchSize,
  setBatchSize,
  showToast,
}) => {
  const { t } = useTranslation()
  const buildDisabled = ['queued', 'running', 'paused', 'stopping'].includes(
    embeddingProgress.state,
  )
  const dinoReady = dinoModelStatus.state === 'downloaded' || dinoModelStatus.state === 'loaded'
  const clipReady = clipModelStatus.state === 'downloaded' || clipModelStatus.state === 'loaded'
  const embeddingFinished =
    embeddingProgress.completed + embeddingProgress.failed + embeddingProgress.skipped
  const embeddingPercent =
    embeddingProgress.total > 0
      ? Math.min(100, Math.round((embeddingFinished / embeddingProgress.total) * 100))
      : embeddingProgress.state === 'done'
        ? 100
        : 0

  const downloadModel = useCallback(
    async (modelName: 'dinov2_vitb14' | 'clip_vit_base_patch32') => {
      try {
        const api = window.electronAPI?.vector
        if (!api) return
        const r = await api.downloadModel(modelName)
        const label = modelName === 'clip_vit_base_patch32' ? 'CLIP' : 'DINO'
        showToast(
          r.ok ? `${label} ${t('download started')}` : r.error || t('Download failed'),
          r.ok ? 'ok' : 'err',
        )
      } catch (e) {
        showToast(errMsg(e), 'err')
      }
    },
    [showToast, t],
  )

  const startBuild = useCallback(
    async (modelName: 'dinov2_vitb14' | 'clip_vit_base_patch32', backend?: 'gpu') => {
      try {
        const api = window.electronAPI?.vector
        if (!api) return
        const isClip = modelName === 'clip_vit_base_patch32'
        const label = isClip ? 'CLIP' : 'DINO'
        const safeBackend = backend === 'gpu' ? 'gpu' : undefined
        const r = await api.startEmbeddingBuild({
          modelName,
          embeddingType: 'global',
          scanPaths,
          ...(safeBackend === 'gpu'
            ? {
                backend: 'gpu',
                maxConcurrentEmbeddings: gpuJobs,
                batchSize,
              }
            : {}),
        })
        showToast(
          r.ok
            ? `${label} ${
                safeBackend === 'gpu'
                  ? t('GPU build started ({count} jobs)', { count: gpuJobs })
                  : t('CPU build started')
              }`
            : r.error || `${label} ${t('build failed')}`,
          r.ok ? 'ok' : 'err',
        )
      } catch (e) {
        showToast(errMsg(e), 'err')
      }
    },
    [batchSize, gpuJobs, scanPaths, showToast, t],
  )

  const buildIndex = useCallback(async () => {
    try {
      const api = window.electronAPI?.vector
      if (!api) return
      const r = await api.buildVectorIndex('dinov2_vitb14')
      showToast(
        r.ok ? r.warning || t('Vector index built') : r.error || t('Index build failed'),
        r.ok ? 'ok' : 'err',
      )
    } catch (e) {
      showToast(errMsg(e), 'err')
    }
  }, [showToast, t])

  if (searchMode === 'fast') return null

  return (
    <div
      style={{
        padding: '3px 6px',
        borderBottom: '1px solid rgba(var(--date),0.10)',
        flexShrink: 0,
        fontSize: 9,
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      <span>
        {t('DINO')}:{' '}
        <span
          style={{
            color: dinoReady
              ? 'rgb(100,255,150)'
              : dinoModelStatus.state === 'downloading'
                ? 'rgb(255,200,100)'
                : dinoModelStatus.state === 'error'
                  ? 'rgb(255,100,100)'
                  : 'rgba(var(--date),0.6)',
          }}
        >
          {t(dinoModelStatus.state)}
        </span>
      </span>
      <span>
        {t('CLIP')}:{' '}
        <span
          style={{
            color: clipReady
              ? 'rgb(100,255,150)'
              : clipModelStatus.state === 'downloading'
                ? 'rgb(255,200,100)'
                : clipModelStatus.state === 'error'
                  ? 'rgb(255,100,100)'
                  : 'rgba(var(--date),0.6)',
          }}
        >
          {t(clipModelStatus.state)}
        </span>
      </span>
      {dinoModelStatus.state === 'not-installed' && (
        <button
          onClick={() => void downloadModel('dinov2_vitb14')}
          style={{ ...smallButtonStyle, cursor: 'pointer' }}
        >
          {t('Download')} DINO
        </button>
      )}
      {clipModelStatus.state === 'not-installed' && (
        <button
          onClick={() => void downloadModel('clip_vit_base_patch32')}
          style={{ ...smallButtonStyle, cursor: 'pointer' }}
        >
          {t('Download')} CLIP
        </button>
      )}
      {dinoModelStatus.state === 'downloading' && (
        <span>DINO {dinoModelStatus.progress ?? 0}%</span>
      )}
      {clipModelStatus.state === 'downloading' && (
        <span>CLIP {clipModelStatus.progress ?? 0}%</span>
      )}
      {(dinoReady || clipReady) && (
        <>
          <span
            style={{ fontSize: 8, opacity: 0.8 }}
            title={t(
              'Build scans selected paths, skips existing embeddings, and queues only missing images.',
            )}
          >
            {t('Build Missing')}:
          </span>
          {dinoReady && (
            <button
              disabled={buildDisabled}
              onClick={() => void startBuild('dinov2_vitb14')}
              style={{
                ...smallButtonStyle,
                cursor: buildDisabled ? 'default' : 'pointer',
                opacity: buildDisabled ? 0.55 : 1,
              }}
              title={t('Build only missing DINOv2 embeddings on CPU for image-to-image rerank')}
            >
              {t('DINO CPU')}
            </button>
          )}
          {dinoReady && (
            <button
              disabled={buildDisabled}
              onClick={() => void startBuild('dinov2_vitb14', 'gpu')}
              style={{
                ...smallButtonStyle,
                background: 'rgba(80,180,255,0.14)',
                border: '0.5px solid rgba(80,180,255,0.45)',
                cursor: buildDisabled ? 'default' : 'pointer',
                opacity: buildDisabled ? 0.55 : 1,
              }}
              title={t(
                'Build only missing DINOv2 embeddings with GPU/DirectML in an isolated child process (max 2 concurrent)',
              )}
            >
              {t('DINO GPU')}
            </button>
          )}
          {clipReady && (
            <button
              disabled={buildDisabled}
              onClick={() => void startBuild('clip_vit_base_patch32')}
              style={{
                ...smallButtonStyle,
                cursor: buildDisabled ? 'default' : 'pointer',
                opacity: buildDisabled ? 0.55 : 1,
              }}
              title={t(
                'Build only missing CLIP image embeddings for full text semantic image search',
              )}
            >
              {t('CLIP CPU')}
            </button>
          )}
          {clipReady && (
            <button
              disabled={buildDisabled}
              onClick={() => void startBuild('clip_vit_base_patch32', 'gpu')}
              style={{
                ...smallButtonStyle,
                background: 'rgba(80,180,255,0.14)',
                border: '0.5px solid rgba(80,180,255,0.45)',
                cursor: buildDisabled ? 'default' : 'pointer',
                opacity: buildDisabled ? 0.55 : 1,
              }}
              title={t(
                'Build only missing CLIP image embeddings with GPU/DirectML in an isolated child process',
              )}
            >
              {t('CLIP GPU')}
            </button>
          )}
          {clipReady && (
            <>
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 8,
                  opacity: buildDisabled ? 0.55 : 0.9,
                }}
                title={t('GPU worker count for CLIP GPU and DINO GPU')}
              >
                {t('GPU Jobs')}
                <select
                  value={gpuJobs}
                  disabled={buildDisabled}
                  onChange={(e) => {
                    const next = Number(e.target.value)
                    setGpuJobs(next)
                  }}
                  style={{
                    fontSize: 8,
                    padding: '1px 2px',
                    background: 'rgba(var(--bg),0.72)',
                    color: 'rgb(var(--fg))',
                    border: '0.5px solid rgba(80,180,255,0.45)',
                    borderRadius: 2,
                  }}
                >
                  {GPU_JOB_OPTIONS.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 8,
                  opacity: buildDisabled ? 0.55 : 0.9,
                }}
                title={t(
                  'Images per batch in GPU child process (higher = more GPU utilization, more VRAM)',
                )}
              >
                {t('Batch')}
                <select
                  value={batchSize}
                  disabled={buildDisabled}
                  onChange={(e) => {
                    const next = Number(e.target.value)
                    setBatchSize(next)
                  }}
                  style={{
                    fontSize: 8,
                    padding: '1px 2px',
                    background: 'rgba(var(--bg),0.72)',
                    color: 'rgb(var(--fg))',
                    border: '0.5px solid rgba(80,180,255,0.45)',
                    borderRadius: 2,
                  }}
                >
                  <option value={0}>{t('Auto')}</option>
                  {[1, 2, 4, 6, 8, 10, 12, 14, 16].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          {dinoReady && (
            <button
              onClick={() => void buildIndex()}
              style={{ ...smallButtonStyle, cursor: 'pointer' }}
            >
              {t('Build Index')}
            </button>
          )}
        </>
      )}
      {(dinoReady || clipReady) && embeddingProgress.state !== 'idle' && (
        <div
          title={[
            `State: ${embeddingProgress.state}`,
            `Completed: ${embeddingProgress.completed}`,
            `Failed: ${embeddingProgress.failed}`,
            `Skipped: ${embeddingProgress.skipped}`,
            `Running: ${embeddingProgress.running}`,
            `Pending: ${embeddingProgress.pending}`,
            `Speed: ${(embeddingProgress.itemsPerSecond ?? 0).toFixed(2)}/s`,
            `Elapsed: ${fmtDuration(embeddingProgress.elapsedMs)}`,
            `ETA: ${fmtDuration(embeddingProgress.etaMs)}`,
          ].join('\n')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            minWidth: 180,
            fontSize: 8,
            opacity: 0.86,
          }}
        >
          <span style={{ flexShrink: 0 }}>
            {t('Emb')}:{' '}
            {embeddingProgress.total > 0
              ? `${embeddingFinished}/${embeddingProgress.total}`
              : embeddingProgress.state}
          </span>
          <div
            style={{
              width: 70,
              height: 5,
              border: '0.5px solid rgba(var(--date),0.35)',
              background: 'rgba(var(--bg),0.55)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${embeddingPercent}%`,
                height: '100%',
                background:
                  embeddingProgress.state === 'error' ? 'rgb(255,90,90)' : 'rgb(80,255,150)',
                transition: 'width 120ms linear',
              }}
            />
          </div>
          <span style={{ flexShrink: 0 }}>{embeddingPercent}%</span>
          {embeddingProgress.itemsPerSecond != null && embeddingProgress.itemsPerSecond > 0 && (
            <span style={{ flexShrink: 0 }}>{embeddingProgress.itemsPerSecond.toFixed(2)}/s</span>
          )}
          {embeddingProgress.state === 'running' && embeddingProgress.etaMs != null && (
            <span style={{ flexShrink: 0, color: 'rgb(120,200,255)' }}>
              {t('ETA')} {fmtDuration(embeddingProgress.etaMs)}
            </span>
          )}
          {embeddingProgress.failed > 0 && (
            <span style={{ color: 'rgb(255,120,120)' }}>
              {t('fail')} {embeddingProgress.failed}
            </span>
          )}
          {embeddingProgress.skipped > 0 && (
            <span style={{ color: 'rgb(255,200,90)' }}>
              {t('skip')} {embeddingProgress.skipped}
            </span>
          )}
        </div>
      )}
      {dinoModelStatus.state === 'error' && (
        <span style={{ color: 'rgb(255,100,100)' }}>{dinoModelStatus.error}</span>
      )}
      {clipModelStatus.state === 'error' && (
        <span style={{ color: 'rgb(255,100,100)' }}>{clipModelStatus.error}</span>
      )}
    </div>
  )
}

export default EmbeddingBuildControls
