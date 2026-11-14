export type SearchWorkStage =
  | 'model_loading'
  | 'query_inference'
  | 'cache_validation'
  | 'cache_building'
  | 'cache_compacting'
  | 'ann_loading'
  | 'ann_building'
  | 'vector_search'
  | 'stream_validation'
  | 'stream_search'
  | 'memory_loading'

export type SearchProgressUnit = 'bytes' | 'records'

export const SEARCH_STAGE_LABELS: Record<SearchWorkStage, string> = {
  model_loading: 'Loading search model',
  query_inference: 'Analyzing query image',
  cache_validation: 'Checking search cache',
  cache_building: 'Building search cache',
  cache_compacting: 'Compacting search cache',
  ann_loading: 'Reading search index',
  ann_building: 'Building search index',
  vector_search: 'Searching vectors',
  stream_validation: 'Checking vector records',
  stream_search: 'Searching vector records',
  memory_loading: 'Loading vector records',
}

/** Request-local counters. Global search percent is never used to estimate stage ETA. */
export function createSearchProgressMetrics(now: () => number = Date.now) {
  let key = ''
  let startedAt = now()
  let lastCurrent = 0
  return (progress: {
    phase: string
    workStage?: SearchWorkStage
    unit?: SearchProgressUnit
    scanned: number
    total?: number
  }) => {
    const nextKey = `${progress.workStage || progress.phase}:${progress.unit || ''}`
    const at = now()
    if (nextKey !== key || progress.scanned < lastCurrent) {
      key = nextKey
      startedAt = at
    }
    lastCurrent = progress.scanned
    const phaseElapsedMs = Math.max(0, at - startedAt)
    const valid = progress.unit && Number.isFinite(progress.scanned) && progress.scanned >= 0
    const throughputPerSecond =
      valid && phaseElapsedMs > 0 ? (progress.scanned * 1000) / phaseElapsedMs : undefined
    const etaMs =
      throughputPerSecond &&
      throughputPerSecond > 0 &&
      progress.total != null &&
      Number.isFinite(progress.total) &&
      progress.total >= progress.scanned
        ? Math.round(((progress.total - progress.scanned) * 1000) / throughputPerSecond)
        : undefined
    return { phaseElapsedMs, throughputPerSecond, etaMs }
  }
}

export function formatSearchThroughput(
  value: number | undefined,
  unit?: SearchProgressUnit,
): string {
  if (value == null || !Number.isFinite(value) || value <= 0 || !unit) return ''
  return unit === 'bytes'
    ? `${(value / 1048576).toFixed(2)} MiB/s`
    : `${value.toFixed(2)} records/s`
}
