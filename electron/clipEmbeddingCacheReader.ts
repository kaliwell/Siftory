import fs from 'fs'
import path from 'path'
import {
  EMBEDDING_F16_CACHE_VERSION,
  embeddingCachePathKey,
  ensureEmbeddingF16Cache,
  readEmbeddingF16VectorsForPaths,
  type EmbeddingF16CacheHandle,
  type EmbeddingF16CacheIntegrity,
  type EmbeddingF16CacheMeta,
} from './embeddingF16Cache'
import {
  noteEmbeddingCacheIntegrityFailure,
  verifyEmbeddingCacheFileProof,
} from './embeddingCacheIntegrity'

const CLIP_MODEL = 'clip_vit_base_patch32'
const CLIP_TYPE = 'global'

interface ClipCacheMeta {
  version: number
  dim: number
  count: number
}

function pathKey(filePath: string): string {
  return path.resolve(filePath).toLowerCase()
}

function clipCacheFiles(vectorDbDir: string): {
  metaPath: string
  pathsPath: string
  vectorsPath: string
} {
  const cacheDir = path.join(vectorDbDir, 'embedding-cache')
  const base = `${CLIP_MODEL}__${CLIP_TYPE}`
  return {
    metaPath: path.join(cacheDir, `${base}.f16.json`),
    pathsPath: path.join(cacheDir, `${base}.paths.jsonl`),
    vectorsPath: path.join(cacheDir, `${base}.f16`),
  }
}

function clipSourcePaths(vectorDbDir: string): string[] {
  return [
    path.join(vectorDbDir, 'image_embeddings.jsonl'),
    path.join(vectorDbDir, 'embeddings', `${CLIP_MODEL}__${CLIP_TYPE}.jsonl`),
  ].filter((filePath) => fs.existsSync(filePath))
}

async function resolveClipCache(vectorDbDir: string): Promise<EmbeddingF16CacheHandle | null> {
  const files = clipCacheFiles(vectorDbDir)
  if (
    ![files.metaPath, files.pathsPath, files.vectorsPath].every((filePath) =>
      fs.existsSync(filePath),
    )
  ) {
    return null
  }
  let meta: ClipCacheMeta
  try {
    meta = JSON.parse(await fs.promises.readFile(files.metaPath, 'utf8')) as ClipCacheMeta
  } catch {
    return null
  }
  if (
    meta.version !== EMBEDDING_F16_CACHE_VERSION ||
    !Number.isSafeInteger(meta.dim) ||
    meta.dim <= 0 ||
    !Number.isSafeInteger(meta.count) ||
    meta.count <= 0
  ) {
    return null
  }
  const sourcePaths = clipSourcePaths(vectorDbDir)
  if (sourcePaths.length > 0) {
    return ensureEmbeddingF16Cache({
      cacheDir: path.dirname(files.metaPath),
      modelName: CLIP_MODEL,
      embeddingType: CLIP_TYPE,
      dim: meta.dim,
      sourcePaths,
    })
  }
  const fullMeta = meta as EmbeddingF16CacheMeta
  // The source JSONL is gone, so the derived cache can never be rebuilt:
  // serve it only while its committed content proof still verifies (VAL-038).
  if (
    !/^[a-f0-9]{64}$/.test(fullMeta.integrity?.vectorsSha256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(fullMeta.integrity?.pathsSha256 ?? '')
  ) {
    return null
  }
  const integrity: EmbeddingF16CacheIntegrity = {
    vectors: {
      size: meta.count * meta.dim * 2,
      sha256: fullMeta.integrity!.vectorsSha256,
    },
    paths: {
      size: fs.statSync(files.pathsPath).size,
      sha256: fullMeta.integrity!.pathsSha256,
    },
  }
  if (
    !verifyEmbeddingCacheFileProof(files.vectorsPath, integrity.vectors) ||
    !verifyEmbeddingCacheFileProof(files.pathsPath, integrity.paths)
  ) {
    noteEmbeddingCacheIntegrityFailure(
      'clip-reader',
      `CLIP derived cache failed its content proof (${files.vectorsPath})`,
    )
    return null
  }
  return {
    meta: {
      ...fullMeta,
      modelName: CLIP_MODEL,
      embeddingType: CLIP_TYPE,
      sourceRecordCount: fullMeta.sourceRecordCount ?? meta.count,
      sourceFiles: fullMeta.sourceFiles ?? [],
      updatedAt: fullMeta.updatedAt ?? 0,
    },
    vectorPath: files.vectorsPath,
    pathIndexPath: files.pathsPath,
    integrity,
  }
}

export async function loadClipEmbeddingsForPaths(
  vectorDbDir: string,
  filePaths: string[],
): Promise<Map<string, Float32Array>> {
  const result = new Map<string, Float32Array>()
  if (filePaths.length === 0) return result
  const cache = await resolveClipCache(vectorDbDir)
  if (!cache) return result
  const vectors = await readEmbeddingF16VectorsForPaths(cache, filePaths)
  for (const filePath of filePaths) {
    const vector = vectors.get(embeddingCachePathKey(filePath))
    if (vector) result.set(pathKey(filePath), vector)
  }
  return result
}

export async function streamClipEmbeddingsForPaths(
  vectorDbDir: string,
  pathsToAssetIds: ReadonlyMap<string, number>,
  options: {
    isCancelled?: () => boolean
    onProgress?: (current: number, total: number) => void
    onVector: (assetId: number, vector: Float32Array) => void
  },
): Promise<number> {
  if (pathsToAssetIds.size === 0) return 0
  const cache = await resolveClipCache(vectorDbDir)
  if (!cache) return 0
  const vectors = await readEmbeddingF16VectorsForPaths(cache, pathsToAssetIds.keys(), {
    isCancelled: options.isCancelled,
    onProgress: (progress) => options.onProgress?.(progress.current, progress.total),
  })
  let found = 0
  for (const [filePath, assetId] of pathsToAssetIds) {
    if (options.isCancelled?.()) throw new Error('Asset library task cancelled')
    const vector = vectors.get(embeddingCachePathKey(filePath))
    if (!vector) continue
    options.onVector(assetId, vector)
    found += 1
  }
  options.onProgress?.(found, pathsToAssetIds.size)
  return found
}
