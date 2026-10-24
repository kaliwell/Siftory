import fs from 'fs'
import path from 'path'
import { authoritativeVectorStoreRootFromCacheDir } from './authoritativeVectorStore'
import { ensureEmbeddingF16Cache } from './embeddingF16Cache'
import { probeVectorIndexHealth, type VectorIndexHealth } from './vectorIndexHealth'

/** Legacy JSONL/F16 stores remain valid until migration; verify them through the same reader as image search. */
export async function probeUnifiedImageVectorHealth(
  cacheDir: string,
  sourcePaths: string[],
): Promise<VectorIndexHealth> {
  const root = authoritativeVectorStoreRootFromCacheDir(cacheDir)
  const health = probeVectorIndexHealth(root, {
    modelName: 'clip_vit_base_patch32',
    embeddingType: 'global',
  })
  // A committed generation is authoritative, including when corrupt or missing the required model.
  if (fs.existsSync(path.join(root, 'CURRENT'))) return health
  try {
    const cache = await ensureEmbeddingF16Cache({
      cacheDir,
      sourcePaths,
      modelName: 'clip_vit_base_patch32',
      embeddingType: 'global',
      dim: 512,
    })
    return cache && cache.meta.count > 0
      ? { status: 'ready', detail: 'Verified existing CLIP embedding cache' }
      : health
  } catch {
    return { status: 'vector-corrupt', detail: 'Existing embedding cache failed verification' }
  }
}
