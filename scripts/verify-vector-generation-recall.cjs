const crypto = require('node:crypto')
const path = require('node:path')
const fs = require('node:fs')
const { loadTsModule } = require('../tests/guard-utils.cjs')

// Per-model score-equivalent recall / numeric-error gate: exact F32 JSONL
// scan vs the F16 composite snapshot (authoritative generation + committed
// increment, D3 stage 2), over sampled real query vectors. Strict path
// recall remains in the report as a near-tie-sensitive diagnostic. The JSONL
// shard remains the F32 reference source; the generation side is read as
// base + delta union.
// Exit code is non-zero when any model fails the gate.
//
// VAL-032: the evaluation itself runs in the low-priority recall worker
// (electron/vectorGenerationRecallWorkerHost.ts — unref'd idle recycling,
// SharedArrayBuffer cancellation), unchanged source sets reuse the derived
// validation matrix cache under vector-db/recall-matrix-cache, and the
// source matrix materialisation is capped by a memory ceiling (spill +
// chunked streaming above it).
//
// Usage: node scripts/verify-vector-generation-recall.cjs [userDataPath]
//   [--queries=N] [--top-k=K] [--snapshot-only]
//   [--matrix-cache-dir=DIR | --no-matrix-cache] [--memory-ceiling-mb=N]

const projectRoot = path.resolve(__dirname, '..')

// The worker bundle must never run gate logic older than the evidence
// contract fingerprint covers; rebuild it from source when any input is
// newer than the bundle.
const RECALL_WORKER_SOURCES = [
  'electron/vectorGenerationRecallWorker.ts',
  'electron/vectorGenerationRecall.ts',
  'electron/embeddingF16Cache.ts',
  'electron/embeddingVectorValidation.ts',
]

function ensureRecallWorkerBundle() {
  const target = path.join(projectRoot, 'dist-electron', 'vectorGenerationRecallWorker.js')
  const targetStat = fs.existsSync(target) ? fs.statSync(target) : null
  const stale =
    !targetStat ||
    RECALL_WORKER_SOURCES.some(
      (source) => fs.statSync(path.join(projectRoot, source)).mtimeMs > targetStat.mtimeMs,
    )
  if (!stale) return target
  const esbuild = require('esbuild')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  esbuild.buildSync({
    entryPoints: [path.join(projectRoot, 'electron', 'vectorGenerationRecallWorker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    outfile: target,
    logLevel: 'silent',
  })
  return target
}

function snapshotEvidence(handle) {
  const descriptor = {
    cacheVersion: handle.meta.version,
    generation: handle.meta.generation || null,
    modelName: handle.meta.modelName,
    embeddingType: handle.meta.embeddingType,
    dim: handle.meta.dim,
    count: handle.meta.count,
    sourceRecordCount: handle.meta.sourceRecordCount,
    deltaBaseCount: handle.delta?.baseCount ?? null,
  }
  return {
    ...descriptor,
    snapshotFingerprint: crypto
      .createHash('sha256')
      .update(JSON.stringify(descriptor))
      .digest('hex'),
  }
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
  const queriesArg = process.argv.find((arg) => arg.startsWith('--queries='))
  const topKArg = process.argv.find((arg) => arg.startsWith('--top-k='))
  const cacheDirArg = process.argv.find((arg) => arg.startsWith('--matrix-cache-dir='))
  const ceilingArg = process.argv.find((arg) => arg.startsWith('--memory-ceiling-mb='))
  const snapshotOnly = process.argv.includes('--snapshot-only')
  const noMatrixCache = process.argv.includes('--no-matrix-cache')
  const userDataPath = args[0] || path.join(process.env.APPDATA || '', 'floating-clock-electron')
  const vectorDb = path.join(userDataPath, 'vector-db')
  const cacheDir = path.join(vectorDb, 'embedding-cache')
  const matrixCacheDir = noMatrixCache
    ? undefined
    : cacheDirArg
      ? path.resolve(cacheDirArg.split('=')[1])
      : path.join(vectorDb, 'recall-matrix-cache')
  const memoryCeilingBytes = ceilingArg
    ? Math.max(1, Math.floor(Number(ceilingArg.split('=')[1]) * 1024 * 1024) || 0)
    : undefined

  const { readFreshEmbeddingF16Cache } = loadTsModule('electron/embeddingF16Cache.ts')
  const { evaluateGenerationRecallInWorker, disposeVectorGenerationRecallWorker } = loadTsModule(
    'electron/vectorGenerationRecallWorkerHost.ts',
  )
  let interrupted = false
  process.on('SIGINT', () => {
    interrupted = true
  })

  const models = [
    {
      modelName: 'clip_vit_base_patch32',
      embeddingType: 'global',
      dim: 512,
      shard: path.join(vectorDb, 'embeddings', 'clip_vit_base_patch32__global.jsonl'),
    },
    {
      modelName: 'dinov2_vitb14',
      embeddingType: 'global',
      dim: 768,
      shard: path.join(vectorDb, 'embeddings', 'dinov2_vitb14__global.jsonl'),
    },
  ]

  const reports = []
  let failed = false
  try {
    for (const model of models) {
      const sourcePaths = [path.join(vectorDb, 'image_embeddings.jsonl'), model.shard].filter(
        (sourcePath) => fs.existsSync(sourcePath),
      )
      if (sourcePaths.length === 0) {
        console.error(`[${model.modelName}] source embedding JSONL is missing`)
        failed = true
        continue
      }
      // Composite freshness read: the CURRENT generation alone, or the
      // generation extended by a complete committed increment after appends.
      const handle = readFreshEmbeddingF16Cache({
        cacheDir,
        modelName: model.modelName,
        embeddingType: model.embeddingType,
        dim: model.dim,
        sourcePaths,
      })
      if (!handle) {
        console.error(
          `[${model.modelName}] authoritative generation (or composite snapshot) unavailable or stale; run the migration first`,
        )
        failed = true
        continue
      }
      const snapshot = snapshotEvidence(handle)
      if (snapshotOnly) {
        reports.push({ ...snapshot, ready: true })
        continue
      }
      process.stderr.write(`[${model.modelName}] evaluating in recall worker...\n`)
      const report = await evaluateGenerationRecallInWorker(
        sourcePaths,
        handle,
        {
          queryCount: queriesArg ? Number(queriesArg.split('=')[1]) : undefined,
          topK: topKArg ? Number(topKArg.split('=')[1]) : undefined,
          memoryCeilingBytes,
          matrixCacheDir,
        },
        {
          workerPath: ensureRecallWorkerBundle(),
          isCancelled: () => interrupted,
          onProgress: (info) => {
            if (info.phase === 'queries' && info.current % 20 === 0) {
              process.stderr.write(`  queries ${info.current}/${info.total}\n`)
            }
          },
        },
      )
      reports.push({ ...report, ...snapshot })
      if (!report.gatePassed) failed = true
      // Each model owns a large path/state graph. Wait for the low-priority
      // worker to exit before starting the next model so CLIP and DINO cannot
      // overlap solely because V8 delayed collection in a reused worker.
      await disposeVectorGenerationRecallWorker()
    }
  } finally {
    await disposeVectorGenerationRecallWorker()
  }
  process.stdout.write(
    `${JSON.stringify({ generatedAt: new Date().toISOString(), snapshotOnly, reports }, null, 2)}\n`,
  )
  if (failed) process.exitCode = 1
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}

module.exports = { ensureRecallWorkerBundle, main, snapshotEvidence }
