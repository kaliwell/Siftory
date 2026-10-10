import path from 'path'
import type { EmbeddingEntry } from '../shared/vectorTypes'
import { getEmbeddingStorePaths } from './vectorDatabaseService'
import { getVisionModelCapability, isVisionModelName, type VisionModelName } from './modelRegistry'
import { ensureEmbeddingF16Cache, readEmbeddingF16VectorsForPaths } from './embeddingF16Cache'
import {
  loadAssetEmbeddingsForPathsFromPaths,
  normalizedVector,
  shiftedCosine,
  streamAssetEmbeddingsFromPaths,
} from './assetEmbeddingStream'

export { normalizedVector, shiftedCosine }

interface StreamEmbeddingOptions {
  modelName: VisionModelName
  maxEntries?: number
  isCancelled?: () => boolean
  onProgress?: (scanned: number, totalBytes: number, processedBytes: number) => void
  shouldStop?: () => boolean
  onEntry: (entry: EmbeddingEntry) => void | Promise<void>
}

export async function streamAssetEmbeddings(options: StreamEmbeddingOptions): Promise<{
  scanned: number
  processedBytes: number
  totalBytes: number
}> {
  return streamAssetEmbeddingsFromPaths({
    ...options,
    expectedDim: getVisionModelCapability(options.modelName).dim,
    sourcePaths: getEmbeddingStorePaths(options.modelName, 'global'),
  })
}

export async function loadAssetEmbeddingsForPaths(
  modelName: string,
  paths: Iterable<string>,
  isCancelled?: () => boolean,
  onProgress?: (scanned: number, totalBytes: number, processedBytes: number) => void,
): Promise<Map<string, Float32Array>> {
  if (!isVisionModelName(modelName)) {
    throw new RangeError(`Unknown asset embedding model: ${modelName}`)
  }
  return loadAssetEmbeddingsForPathsFromPaths(
    modelName,
    getVisionModelCapability(modelName).dim,
    getEmbeddingStorePaths(modelName, 'global'),
    paths,
    isCancelled,
    onProgress,
  )
}

const CLIP_MODEL_NAME = 'clip_vit_base_patch32'
const CLIP_EMBEDDING_DIM = getVisionModelCapability(CLIP_MODEL_NAME).dim

function clipEmbeddingCacheDir(sourcePaths: string[]): string | null {
  if (sourcePaths.length === 0) return null
  const sourceDir = path.dirname(sourcePaths[0])
  const vectorDbDir =
    path.basename(sourceDir).toLowerCase() === 'embeddings' ? path.dirname(sourceDir) : sourceDir
  return path.join(vectorDbDir, 'embedding-cache')
}

export async function loadAssetClipEmbeddingsForPaths(
  paths: Iterable<string>,
  isCancelled?: () => boolean,
  onProgress?: (scanned: number, totalBytes: number, processedBytes: number) => void,
): Promise<Map<string, Float32Array>> {
  const filePaths = [...paths]
  if (filePaths.length === 0) return new Map()
  const sourcePaths = getEmbeddingStorePaths(CLIP_MODEL_NAME, 'global')
  const cacheDir = clipEmbeddingCacheDir(sourcePaths)
  const cache = cacheDir
    ? await ensureEmbeddingF16Cache({
        cacheDir,
        modelName: CLIP_MODEL_NAME,
        embeddingType: 'global',
        dim: CLIP_EMBEDDING_DIM,
        sourcePaths,
        isCancelled,
      })
    : null
  if (!cache || cache.meta.count <= 0) {
    return loadAssetEmbeddingsForPaths(CLIP_MODEL_NAME, filePaths, isCancelled, onProgress)
  }
  return readEmbeddingF16VectorsForPaths(cache, filePaths, {
    isCancelled,
    onProgress: (progress) => onProgress?.(progress.current, progress.total, progress.current),
  })
}
