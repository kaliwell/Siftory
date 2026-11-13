import React, { useCallback, useEffect, useState } from 'react'
import type { EmbeddingProgress } from '../../shared/vectorTypes'
import type { ImageHashResult, ImageSearchStatus } from '../../shared/ipc-contract'
import { imageSearchBridge } from '../services/imageSearchBridge'
import { useStore } from '../stores/useStore'
import { useTranslation } from '../i18n/useTranslation'
import VectorMaintenanceBar from './VectorMaintenanceBar'
import RecentManifestBar from './RecentManifestBar'
import ImageSearchIndexFooter from './ImageSearchIndexFooter'
import ImageHashSmokeTest from './ImageHashSmokeTest'

export default function ImageIndexMaintenanceTools({
  showToast,
}: {
  showToast: (message: string, type?: 'ok' | 'err') => void
}) {
  const { t } = useTranslation()
  const manifestPath = useStore((s) => s.manifestPath)
  const manifests = useStore((s) => s.recentManifests)
  const gpuJobs = useStore((s) => s.imageSearchUiPreferences.embeddingGpuJobs)
  const [status, setStatus] = useState<ImageSearchStatus>({
    state: 'idle',
    indexedCount: 0,
    pendingCount: 0,
  })
  const [embedding, setEmbedding] = useState<EmbeddingProgress['state']>('idle')
  const [busy, setBusy] = useState(false)
  const [testImage, setTestImage] = useState<string | null>(null)
  const [hashResult, setHashResult] = useState<ImageHashResult | null>(null)
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ok' | 'err'>('idle')
  const refresh = useCallback(async () => {
    const next = await imageSearchBridge.getStatus()
    if (next) setStatus(next)
  }, [])
  useEffect(() => {
    let alive = true
    const off = imageSearchBridge.onStatusChanged((next) => {
      if (alive) setStatus(next)
    })
    const offEmbedding = window.electronAPI.vector.onEmbeddingProgress((next) => {
      if (alive) setEmbedding(next.state)
    })
    void Promise.all([
      imageSearchBridge.getStatus(),
      window.electronAPI.vector.getEmbeddingProgress(),
    ])
      .then(([next, progress]) => {
        if (!alive) return
        if (next) {
          setStatus(next)
          setLoadState(next.segmentPath ? 'ok' : 'idle')
        }
        if (progress) setEmbedding(progress.state)
      })
      .catch((error) => {
        if (alive) showToast(String(error), 'err')
      })
    return () => {
      alive = false
      off?.()
      offEmbedding?.()
    }
  }, [showToast])
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'err')
    } finally {
      setBusy(false)
    }
  }
  const load = async (path: string) => {
    if (!path) {
      showToast(t('No manifest loaded'), 'err')
      return
    }
    setLoadState('loading')
    try {
      const result = await imageSearchBridge.loadManifest(path)
      setLoadState(result?.ok ? 'ok' : 'err')
      if (!result?.ok) {
        showToast(t('Load failed: {error}', { error: result?.error || '' }), 'err')
        return
      }
      useStore.getState().setManifestPath(path)
      useStore.getState().addRecentManifest(path)
      showToast(
        t('Loaded {records} records, {segments} segment(s)', {
          records: result.recordCount ?? 0,
          segments: result.segmentCount ?? 1,
        }),
      )
      await refresh()
    } catch (error) {
      setLoadState('err')
      throw error
    }
  }
  return (
    <div data-testid="image-index-maintenance-tools">
      <VectorMaintenanceBar
        indexedCount={status.indexedCount}
        gpuJobs={gpuJobs}
        buildDisabled={['queued', 'running', 'paused', 'stopping'].includes(embedding)}
        showToast={showToast}
      />
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <RecentManifestBar manifests={manifests} onLoad={(path) => void run(() => load(path))} />
        <ImageSearchIndexFooter
          status={status}
          manifestPath={manifestPath}
          autoloadState={loadState}
          onReload={() => void run(() => load(manifestPath))}
          onClear={() =>
            void run(async () => {
              if (['queued', 'scanning', 'indexing'].includes(status.state))
                await imageSearchBridge.stopScan()
              await imageSearchBridge.clearIndex()
              window.dispatchEvent(new Event('workspace-image-index-cleared'))
              await refresh()
            })
          }
          onOpenIndexDir={() =>
            void run(async () => {
              const path = manifestPath || status.segmentPath
              if (path) await imageSearchBridge.openFolder(path)
              else showToast(t('No index path available'), 'err')
            })
          }
        />
        <ImageHashSmokeTest
          testImagePath={testImage}
          hashing={busy}
          hashResult={hashResult}
          onSelectTestImage={() =>
            void run(async () => {
              const path = await imageSearchBridge.selectImage()
              if (!path) return
              setTestImage(path)
              setHashResult(null)
              setHashResult(await imageSearchBridge.hashImage(path))
            })
          }
        />
      </fieldset>
    </div>
  )
}
