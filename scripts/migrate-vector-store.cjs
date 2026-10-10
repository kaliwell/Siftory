const path = require('node:path')
const { loadTsModule } = require('../tests/guard-utils.cjs')

// Authoritative vector store migration driver. Defaults to a read-only
// preview; pass --execute to run the migration (staging -> full SHA
// verification -> atomic CURRENT switch) via the existing service.
//
// Usage: node scripts/migrate-vector-store.cjs [userDataPath] [--execute]

async function main() {
  const execute = process.argv.includes('--execute')
  const args = process.argv.slice(2).filter((arg) => arg !== '--execute')
  const userDataPath = args[0] || path.join(process.env.APPDATA || '', 'floating-clock-electron')
  const vectorDb = path.join(userDataPath, 'vector-db')

  const svc = loadTsModule('electron/vectorStoreMigrationService.ts')
  const { getEmbeddingStorePaths, initVectorDatabase } = loadTsModule(
    'electron/vectorDatabaseService.ts',
  )
  initVectorDatabase(userDataPath)
  const cacheDir = path.join(vectorDb, 'embedding-cache')
  const sources = [
    {
      cacheDir,
      modelName: 'clip_vit_base_patch32',
      embeddingType: 'global',
      dim: 512,
      sourcePaths: getEmbeddingStorePaths('clip_vit_base_patch32', 'global'),
    },
    {
      cacheDir,
      modelName: 'dinov2_vitb14',
      embeddingType: 'global',
      dim: 768,
      sourcePaths: getEmbeddingStorePaths('dinov2_vitb14', 'global'),
    },
  ]
  const preview = svc.createVectorStoreMigrationPreview(userDataPath, sources)
  process.stdout.write(
    `${JSON.stringify(
      {
        token: preview.token,
        expiresAt: new Date(preview.expiresAt).toISOString(),
        models: preview.models,
        sourceBytes: preview.sourceBytes,
        estimatedBinaryBytes: preview.estimatedBinaryBytes,
      },
      null,
      2,
    )}\n`,
  )
  if (!execute) return

  const started = svc.startVectorStoreMigration(userDataPath, preview.token)
  if (!started.ok) throw new Error(started.error)
  process.stderr.write(`migration task: ${started.taskId}\n`)
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const progress = svc.getVectorStoreMigrationProgress()
    process.stderr.write(
      `progress: ${progress.state} ${progress.completedModels ?? ''}/${progress.totalModels ?? ''} ${progress.currentModel ?? ''}\n`,
    )
    if (progress.state !== 'running') {
      process.stdout.write(`${JSON.stringify(progress, null, 2)}\n`)
      if (progress.state !== 'completed') process.exitCode = 1
      break
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
