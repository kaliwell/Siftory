import type { ImageSearchStatus } from '../../shared/ipc/image-search'
import type { EmbeddingProgress } from '../../shared/vectorTypes'
import {
  setupSnapshotFromEmbeddingProgress,
  type SetupWorkflowSnapshot,
} from './searchSetupWorkflow'

export function searchReadinessProgress(
  workflow: SetupWorkflowSnapshot,
  embedding: EmbeddingProgress | undefined,
  scanState: ImageSearchStatus['state'],
) {
  const background = embedding && setupSnapshotFromEmbeddingProgress(embedding)
  const active =
    workflow.state === 'running' ? workflow : background?.state === 'running' ? background : null
  if (active) return normalize(active)
  if (
    scanState === 'scanning' ||
    scanState === 'indexing' ||
    scanState === 'queued' ||
    scanState === 'paused'
  )
    return { state: scanState, percent: 0, indeterminate: true }
  if (scanState === 'error') return { state: 'error', percent: 0, indeterminate: false }
  return normalize(workflow.state !== 'idle' ? workflow : background || workflow)
}

function normalize(snapshot: SetupWorkflowSnapshot) {
  return {
    state: snapshot.state,
    percent:
      snapshot.state === 'done'
        ? 100
        : Number.isFinite(snapshot.percent)
          ? Math.max(0, Math.min(100, snapshot.percent))
          : 0,
    indeterminate: snapshot.state === 'running' && Boolean(snapshot.indeterminate),
  }
}
