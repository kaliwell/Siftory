// Read committed snapshots without creating directories, rebuilding caches, or
// letting an empty source list hide a current generation's committed increment.
const fs = require('node:fs')
const path = require('node:path')
const { loadTsModule } = require('../tests/guard-utils.cjs')
const api = loadTsModule('electron/embeddingF16Cache.ts')
const { embeddingIncrementDir, readEmbeddingIncrementSnapshot } = loadTsModule(
  'electron/embeddingIncrementLog.ts',
)

const MODEL_DIMENSIONS = Object.freeze({ dinov2_vitb14: 768, clip_vit_base_patch32: 512 })

function readBenchmarkSnapshot(root, modelName = 'dinov2_vitb14') {
  const dim = MODEL_DIMENSIONS[modelName]
  if (!dim) throw new Error('Unsupported vector benchmark model')
  const database = path.join(root, 'vector-db')
  const storeRoot = path.join(database, 'vector-store')
  const sourcePaths = [
    path.join(database, 'image_embeddings.jsonl'),
    path.join(database, 'embeddings', `${modelName}__global.jsonl`),
  ].filter((file) => fs.existsSync(file))
  const options = {
    cacheDir: path.join(database, 'embedding-cache'),
    modelName,
    embeddingType: 'global',
    dim,
    sourcePaths,
  }
  const commitPath = path.join(embeddingIncrementDir(storeRoot, modelName, 'global'), 'delta.json')
  if (!fs.existsSync(commitPath)) return api.readExistingEmbeddingF16Cache(options)

  // Validate the increment first, even when import JSONL files were retained
  // elsewhere or removed after generation publication. An unreadable increment
  // must not become a successful benchmark of an older base-only snapshot.
  const snapshot = readEmbeddingIncrementSnapshot(storeRoot, modelName, 'global', dim, sourcePaths)
  if (!snapshot) throw new Error('Committed increment could not be verified; benchmark stopped')
  const base = api.openAuthoritativeEmbeddingF16Cache(options)
  if (!base || base.meta.generation !== snapshot.generation)
    throw new Error('Generation changed while opening the benchmark snapshot')
  const { commit } = snapshot
  return {
    ...base,
    meta: {
      ...base.meta,
      count: commit.baseCount + commit.deltaCount,
      sourceRecordCount: commit.baseSourceRecordCount + commit.deltaCount,
    },
    delta: {
      vectorPath: snapshot.vectorPath,
      pathIndexPath: snapshot.pathIndexPath,
      baseCount: commit.baseCount,
    },
    integrity: {
      ...base.integrity,
      deltaVectors: { size: commit.deltaCount * dim * 2, sha256: commit.vectorsSha256 },
      deltaPaths: { size: commit.pathsBytes, sha256: commit.pathsSha256 },
    },
  }
}

module.exports = { MODEL_DIMENSIONS, readBenchmarkSnapshot }
