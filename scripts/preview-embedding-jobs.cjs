const fs = require('node:fs')
const path = require('node:path')
const { loadTsModule } = require('../tests/guard-utils.cjs')

// Read-only embedding jobs classification preview. Never writes to or
// deletes the jobs file or the authoritative shards.
//
// Usage: node scripts/preview-embedding-jobs.cjs [userDataPath] [--with-embedding-check]

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--with-embedding-check')
  const withEmbeddingCheck = process.argv.includes('--with-embedding-check')
  const userDataPath = args[0] || path.join(process.env.APPDATA || '', 'floating-clock-electron')
  const vectorDb = path.join(userDataPath, 'vector-db')
  const jobsPath = path.join(vectorDb, 'embedding_jobs.jsonl')
  const shardPaths = withEmbeddingCheck
    ? fs
        .readdirSync(path.join(vectorDb, 'embeddings'), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('__global.jsonl'))
        .map((entry) => path.join(vectorDb, 'embeddings', entry.name))
    : undefined

  const { previewEmbeddingJobs } = loadTsModule('electron/embeddingJobsClassifier.ts')
  const preview = await previewEmbeddingJobs(jobsPath, { shardPaths })
  process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
