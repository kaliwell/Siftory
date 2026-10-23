import type {
  ImageSearchUiPreferences,
  MediaSearchUiPreferences,
  SearchExperiencePreference,
} from './ipc/app-core'

export type {
  ImageSearchUiPreferences,
  MediaSearchUiPreferences,
  SearchExperiencePreference,
  ThumbnailRebuildBackendPreference,
} from './ipc/app-core'

export const DEFAULT_IMAGE_SEARCH_UI_PREFERENCES: ImageSearchUiPreferences = {
  workspaceView: 'sources',
  embeddingGpuJobs: 2,
  embeddingBatchSize: 0,
  buildScanThumbnails: true,
  experienceMode: 'simple',
  thumbnailRebuildBackend: 'native',
  thumbnailGpuJobs: 4,
  thumbnailBatchSize: 2,
}

export const DEFAULT_MEDIA_SEARCH_UI_PREFERENCES: MediaSearchUiPreferences = {
  workspaceView: 'sources',
  experienceMode: 'simple',
}

const THUMBNAIL_JOB_OPTIONS = new Set([2, 4, 6, 8, 10, 12, 14, 16, 18, 20])

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function experienceMode(value: unknown): SearchExperiencePreference {
  return value === 'advanced' ? 'advanced' : 'simple'
}

export function normalizeImageSearchUiPreferences(value: unknown): ImageSearchUiPreferences {
  const input = record(value)
  const embeddingGpuJobs = Number(input.embeddingGpuJobs)
  const embeddingBatchSize = Number(input.embeddingBatchSize)
  const thumbnailGpuJobs = Number(input.thumbnailGpuJobs)
  const thumbnailBatchSize = Number(input.thumbnailBatchSize)
  const thumbnailRebuildBackend = input.thumbnailRebuildBackend
  return {
    workspaceView: input.workspaceView === 'search' ? 'search' : 'sources',
    embeddingGpuJobs: embeddingGpuJobs === 1 || embeddingGpuJobs === 2 ? embeddingGpuJobs : 2,
    embeddingBatchSize:
      Number.isInteger(embeddingBatchSize) && embeddingBatchSize >= 0 && embeddingBatchSize <= 16
        ? embeddingBatchSize
        : 0,
    buildScanThumbnails:
      typeof input.buildScanThumbnails === 'boolean' ? input.buildScanThumbnails : true,
    experienceMode: experienceMode(input.experienceMode),
    thumbnailRebuildBackend:
      thumbnailRebuildBackend === 'auto' ||
      thumbnailRebuildBackend === 'cpu' ||
      thumbnailRebuildBackend === 'gpu' ||
      thumbnailRebuildBackend === 'native' ||
      thumbnailRebuildBackend === 'cuda'
        ? thumbnailRebuildBackend
        : 'native',
    thumbnailGpuJobs: THUMBNAIL_JOB_OPTIONS.has(thumbnailGpuJobs) ? thumbnailGpuJobs : 4,
    thumbnailBatchSize: THUMBNAIL_JOB_OPTIONS.has(thumbnailBatchSize) ? thumbnailBatchSize : 2,
  }
}

export function normalizeMediaSearchUiPreferences(value: unknown): MediaSearchUiPreferences {
  const input = record(value)
  return {
    workspaceView: input.workspaceView === 'search' ? 'search' : 'sources',
    experienceMode: experienceMode(input.experienceMode),
  }
}
