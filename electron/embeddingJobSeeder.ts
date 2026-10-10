import fs from 'fs'
import type { EmbeddingJob, EmbeddingType } from '../shared/vectorTypes'
import { embeddingCachePathKey } from './embeddingF16Cache'
import { nextEmbeddingJobEpoch } from './embeddingJobEpochLedger'
import { getModelInfo } from './modelService'
import { validateEmbeddingVector } from './embeddingVectorValidation'
import { embeddingStore, getEmbeddingStorePath, jobStore } from './vectorDatabaseService'

type DiagnosticWriter = (event: string, data?: Record<string, unknown>) => void

export function seedEmbeddingJobsIntoStore(
  images: readonly { imageId: string; path: string }[],
  modelName: string,
  embeddingType: EmbeddingType,
  writeDiagnostic: DiagnosticWriter,
): number {
  try {
    const embeddingPath = getEmbeddingStorePath()
    if (fs.existsSync(embeddingPath) && fs.statSync(embeddingPath).size > 512 * 1024 * 1024) {
      writeDiagnostic('seed-jobs:skip-large-store', {
        modelName,
        embeddingType,
        images: images.length,
        embeddingPath,
      })
      return 0
    }
  } catch {
    return 0
  }
  const expectedDim = getModelInfo(modelName)?.dim
  const existingEmbeddingStates = new Map<string, boolean>()
  for (const entry of embeddingStore.getAll()) {
    if (
      entry.modelName !== modelName ||
      entry.embeddingType !== embeddingType ||
      typeof entry.imageId !== 'string'
    ) {
      continue
    }
    const key = embeddingCachePathKey(entry.imageId)
    existingEmbeddingStates.set(
      key,
      expectedDim !== undefined &&
        entry.dim === expectedDim &&
        validateEmbeddingVector(entry.vector, expectedDim).ok,
    )
  }
  const existingEmbeddings = new Set(
    [...existingEmbeddingStates].filter(([, valid]) => valid).map(([key]) => key),
  )
  const allJobs = jobStore.getAll()
  const epoch = nextEmbeddingJobEpoch(allJobs, Date.now())
  const existingJobs = new Set(
    allJobs
      .filter((job) => job.modelName === modelName && job.embeddingType === embeddingType)
      .map((job) => embeddingCachePathKey(job.imageId)),
  )
  const now = Date.now()
  const newJobs: Omit<EmbeddingJob, 'id'>[] = []
  for (const image of images) {
    const key = embeddingCachePathKey(image.imageId)
    if (existingEmbeddings.has(key) || existingJobs.has(key)) continue
    existingJobs.add(key)
    newJobs.push({
      imageId: image.imageId,
      path: image.path,
      status: 'pending',
      modelName,
      embeddingType,
      retries: 0,
      createdAt: now,
      updatedAt: now,
      epoch,
    })
  }
  if (newJobs.length > 0) jobStore.insertMany(newJobs)
  return newJobs.length
}
