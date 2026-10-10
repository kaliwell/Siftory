const fs = require('node:fs')
const path = require('node:path')
const { loadTsModule } = require('../tests/guard-utils.cjs')

// Stale embedding jobs migration. Defaults to a read-only dry run; pass
// --execute to perform the atomic rewrite (original preserved as a
// timestamped backup, stale rows archived, never deleted).
//
// Usage: node scripts/migrate-embedding-jobs.cjs [userDataPath] [--execute]

async function main() {
  const execute = process.argv.includes('--execute')
  const args = process.argv.slice(2).filter((arg) => arg !== '--execute')
  const userDataPath = args[0] || path.join(process.env.APPDATA || '', 'floating-clock-electron')
  const vectorDb = path.join(userDataPath, 'vector-db')
  const jobsPath = path.join(vectorDb, 'embedding_jobs.jsonl')
  const shardPaths = fs
    .readdirSync(path.join(vectorDb, 'embeddings'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('__global.jsonl'))
    .map((entry) => path.join(vectorDb, 'embeddings', entry.name))

  const { migrateStaleEmbeddingJobs } = loadTsModule('electron/embeddingJobsMigration.ts')
  const result = await migrateStaleEmbeddingJobs(jobsPath, shardPaths, { dryRun: !execute })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!result.ok) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
