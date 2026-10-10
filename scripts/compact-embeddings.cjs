const fs = require('fs')
const path = require('path')
const readline = require('readline')

function sanitize(value) {
  return String(value || 'unknown')
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .slice(0, 96) || 'unknown'
}

function getVectorDbDir() {
  const appData = process.env.APPDATA
  if (!appData) throw new Error('APPDATA is not set')
  return path.join(appData, 'floating-clock-electron', 'vector-db')
}

function makeKey(row) {
  return `${row.modelName}\u0000${row.embeddingType || 'global'}\u0000${row.imageId}`
}

async function scanLastRows(sourcePath) {
  const lastSeq = new Map()
  const stats = {
    lines: 0,
    valid: 0,
    malformed: 0,
    missingKey: 0,
    models: new Map(),
  }
  const rl = readline.createInterface({
    input: fs.createReadStream(sourcePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  let seq = 0
  let lastReport = Date.now()
  for await (const line of rl) {
    stats.lines++
    if (!line) continue
    seq++
    let row
    try {
      row = JSON.parse(line)
    } catch {
      stats.malformed++
      continue
    }
    if (
      typeof row.modelName !== 'string' ||
      typeof row.imageId !== 'string' ||
      !Array.isArray(row.vector)
    ) {
      stats.missingKey++
      continue
    }
    row.embeddingType = row.embeddingType || 'global'
    stats.valid++
    const key = makeKey(row)
    lastSeq.set(key, seq)
    const modelKey = `${row.modelName}__${row.embeddingType}`
    stats.models.set(modelKey, (stats.models.get(modelKey) || 0) + 1)
    const now = Date.now()
    if (now - lastReport > 5000) {
      lastReport = now
      console.log(
        `[pass1] lines=${stats.lines.toLocaleString()} valid=${stats.valid.toLocaleString()} unique=${lastSeq.size.toLocaleString()}`,
      )
    }
  }
  return { lastSeq, stats }
}

async function writeCompacted(sourcePath, lastSeq, outDir) {
  fs.mkdirSync(outDir, { recursive: true })
  const streams = new Map()
  const written = new Map()
  const getStream = (row) => {
    const name = `${sanitize(row.modelName)}__${sanitize(row.embeddingType || 'global')}.jsonl`
    const filePath = path.join(outDir, name)
    let stream = streams.get(filePath)
    if (!stream) {
      stream = fs.createWriteStream(filePath, { encoding: 'utf8' })
      streams.set(filePath, stream)
    }
    return { stream, filePath }
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(sourcePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  let seq = 0
  let kept = 0
  let skippedDuplicates = 0
  let lastReport = Date.now()
  for await (const line of rl) {
    if (!line) continue
    seq++
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (
      typeof row.modelName !== 'string' ||
      typeof row.imageId !== 'string' ||
      !Array.isArray(row.vector)
    ) {
      continue
    }
    row.embeddingType = row.embeddingType || 'global'
    const key = makeKey(row)
    if (lastSeq.get(key) !== seq) {
      skippedDuplicates++
      continue
    }
    const { stream, filePath } = getStream(row)
    stream.write(`${JSON.stringify(row)}\n`)
    const fileName = path.basename(filePath)
    written.set(fileName, (written.get(fileName) || 0) + 1)
    kept++
    const now = Date.now()
    if (now - lastReport > 5000) {
      lastReport = now
      console.log(
        `[pass2] seq=${seq.toLocaleString()} kept=${kept.toLocaleString()} skippedDup=${skippedDuplicates.toLocaleString()}`,
      )
    }
  }
  await Promise.all(
    [...streams.values()].map(
      (stream) =>
        new Promise((resolve, reject) => {
          stream.end((err) => (err ? reject(err) : resolve()))
        }),
    ),
  )
  return { kept, skippedDuplicates, written }
}

function replaceShardFiles(compactDir, finalDir) {
  fs.mkdirSync(finalDir, { recursive: true })
  const files = fs.readdirSync(compactDir).filter((name) => name.endsWith('.jsonl'))
  for (const file of files) {
    const src = path.join(compactDir, file)
    const dest = path.join(finalDir, file)
    const backup = `${dest}.precompact.${Date.now()}.bak`
    if (fs.existsSync(dest)) fs.renameSync(dest, backup)
    fs.renameSync(src, dest)
  }
  return files
}

async function main() {
  const vectorDbDir = getVectorDbDir()
  const sourcePath = path.join(vectorDbDir, 'image_embeddings.jsonl')
  if (!fs.existsSync(sourcePath)) {
    console.log(`source-missing:${sourcePath}`)
    return
  }
  const sourceStat = fs.statSync(sourcePath)
  const compactDir = path.join(vectorDbDir, 'embeddings', `.compact-${Date.now()}`)
  const finalDir = path.join(vectorDbDir, 'embeddings')
  console.log(`source=${sourcePath}`)
  console.log(`sourceMB=${(sourceStat.size / 1024 / 1024).toFixed(2)}`)
  console.log(`compactDir=${compactDir}`)

  const { lastSeq, stats } = await scanLastRows(sourcePath)
  const result = await writeCompacted(sourcePath, lastSeq, compactDir)
  const installed = replaceShardFiles(compactDir, finalDir)
  try {
    fs.rmdirSync(compactDir)
  } catch {
    // ignore
  }

  const backupPath = `${sourcePath}.pre-shard-${Date.now()}.bak`
  fs.renameSync(sourcePath, backupPath)

  const finalFiles = installed.map((file) => {
    const filePath = path.join(finalDir, file)
    const stat = fs.statSync(filePath)
    return {
      file,
      records: result.written.get(file) || 0,
      sizeMB: Number((stat.size / 1024 / 1024).toFixed(2)),
    }
  })
  const summary = {
    sourcePath,
    backupPath,
    sourceMB: Number((sourceStat.size / 1024 / 1024).toFixed(2)),
    scannedLines: stats.lines,
    validRows: stats.valid,
    malformedRows: stats.malformed,
    missingKeyRows: stats.missingKey,
    uniqueRows: lastSeq.size,
    keptRows: result.kept,
    skippedDuplicates: result.skippedDuplicates,
    finalFiles,
    completedAt: new Date().toISOString(),
  }
  const summaryPath = path.join(vectorDbDir, `embedding_compaction_${Date.now()}.json`)
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8')
  console.log(JSON.stringify(summary, null, 2))
  console.log(`summary=${summaryPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
