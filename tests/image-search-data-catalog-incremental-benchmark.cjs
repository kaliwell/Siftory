const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { loadTsModule } = require('./guard-utils.cjs')

const catalog = loadTsModule('electron/imageSearchDataCatalogWorker.ts')
const fingerprints = loadTsModule('electron/imageSearchDataCatalogFingerprint.ts')
const imageSearch = loadTsModule('electron/imageSearchService.ts')

const repoRoot = path.resolve(__dirname, '..')
const userData = path.join(process.env.APPDATA || '', 'floating-clock-electron')
const artifactRoot = path.join(repoRoot, 'artifacts', 'benchmark', 'data-catalog-prep009')
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-catalog-prep009-'))
const stopView = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))

function round(value, digits = 2) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function percentile(values, ratio) {
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)]
}

function timestamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '-').replace(/-+$/, '')
}

function sourceId(physicalKey) {
  return `vector-${crypto.createHash('sha256').update(physicalKey).digest('hex').slice(0, 16)}`
}

function descriptor(root, filePath) {
  const stat = fs.statSync(filePath)
  const physicalKey = path.relative(root, filePath).replace(/\\/g, '/')
  const name = path.basename(filePath).toLowerCase()
  return {
    sourceId: sourceId(physicalKey),
    filePath,
    physicalKey,
    logicalName: physicalKey,
    layer: name.includes('dino') ? 'dino' : name.includes('clip') ? 'clip' : 'mixed',
    sizeBytes: stat.size,
    modifiedAt: stat.mtimeMs,
    sampleSha256: fingerprints.sampleCatalogSourceFileSync(filePath, stat.size),
  }
}

function discoverRealSources() {
  const vectorRoot = path.join(userData, 'vector-db')
  const embeddingRoot = path.join(vectorRoot, 'embeddings')
  const candidates = fs.existsSync(embeddingRoot)
    ? fs
        .readdirSync(embeddingRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && /\.jsonl$/i.test(entry.name))
        .map((entry) => path.join(embeddingRoot, entry.name))
    : []
  const legacy = path.join(vectorRoot, 'image_embeddings.jsonl')
  if (fs.existsSync(legacy)) candidates.push(legacy)
  return [...new Set(candidates.map((filePath) => path.resolve(filePath)))]
    .map((filePath) => descriptor(userData, filePath))
    .sort((left, right) => left.physicalKey.localeCompare(right.physicalKey))
}

function sourceSnapshot(nativeRevision, sources) {
  return JSON.stringify({
    version: 2,
    nativeRevision,
    vectors: sources.map((source) => ({
      physicalKey: source.physicalKey,
      layer: source.layer,
      sizeBytes: source.sizeBytes,
      modifiedAt: source.modifiedAt,
      sampleSha256: source.sampleSha256,
    })),
  })
}

function comparableSummary(summary) {
  return Object.fromEntries(
    Object.entries(summary).filter(([key]) => key !== 'generation' && key !== 'builtAt'),
  )
}

function makeInput(root, generation, nativeRecords, nativeRevision, sources, previousDatabasePath) {
  const directory = path.join(root, generation)
  fs.mkdirSync(directory, { recursive: true })
  return {
    taskId: `prep009-${generation}`,
    generation,
    databasePath: path.join(directory, 'catalog.sqlite'),
    buildMetadataPath: path.join(directory, 'build.json'),
    roots: [],
    nativeRecords,
    nativeSource: {
      sourceId: 'native-index',
      physicalKey: 'image-search-index',
      logicalName: 'image-search-index',
      sizeBytes: nativeRecords.length,
      modifiedAt: 0,
    },
    vectorSources: sources,
    sourceSnapshot: sourceSnapshot(nativeRevision, sources),
    ...(previousDatabasePath ? { previousDatabasePath } : {}),
  }
}

async function measureBuild(input) {
  let peakRss = process.memoryUsage().rss
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }, 100)
  const startedAt = performance.now()
  try {
    const result = await catalog.runImageSearchDataCatalogBuild(input, stopView, (progress) => {
      if (progress.message && progress.processedRecords % 50_000 === 0) {
        process.stderr.write(`[prep009] ${progress.message}\n`)
      }
    })
    return {
      elapsedMs: round(performance.now() - startedAt),
      peakRssMiB: round(peakRss / 1024 / 1024),
      databaseMiB: round(fs.statSync(input.databasePath).size / 1024 / 1024),
      result,
    }
  } finally {
    clearInterval(sampler)
  }
}

async function waitForNativeSnapshot() {
  imageSearch.initImageSearchService(() => {}, userData)
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const snapshot = await imageSearch.snapshotImageSearchData()
    if (snapshot.ok && snapshot.records && snapshot.records.length > 0) return snapshot.records
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Native Image Search snapshot did not become ready')
}

function embeddingRow(imageId, modelName) {
  return `${JSON.stringify({
    imageId,
    modelName,
    embeddingType: 'global',
    dim: 2,
    vector: [1, 0],
    norm: 1,
  })}\n`
}

function writeSyntheticSource(filePath, modelName, count) {
  const descriptor = fs.openSync(filePath, 'wx')
  try {
    let batch = ''
    for (let index = 0; index < count; index++) {
      batch += embeddingRow(
        `D:\\prep009\\folder_${String(index % 100).padStart(3, '0')}\\image_${String(index).padStart(6, '0')}.jpg`,
        modelName,
      )
      if ((index + 1) % 1000 === 0) {
        fs.writeSync(descriptor, batch)
        batch = ''
      }
    }
    if (batch) fs.writeSync(descriptor, batch)
  } finally {
    fs.closeSync(descriptor)
  }
}

async function syntheticAppendParity() {
  const root = path.join(temporaryRoot, 'synthetic')
  const sourceRoot = path.join(root, 'sources')
  fs.mkdirSync(sourceRoot, { recursive: true })
  const count = 80_000
  const dinoPath = path.join(sourceRoot, 'dinov2_vitb14__global.jsonl')
  const clipPath = path.join(sourceRoot, 'clip_vit_base_patch32__global.jsonl')
  writeSyntheticSource(dinoPath, 'dinov2_vitb14', count)
  writeSyntheticSource(clipPath, 'clip_vit_base_patch32', count)
  const nativeRecords = Array.from({ length: count }, (_, index) => ({
    path: `D:\\prep009\\folder_${String(index % 100).padStart(3, '0')}\\image_${String(index).padStart(6, '0')}.jpg`,
    width: 100,
    height: 100,
    fileSize: 1000 + index,
    modifiedTime: index,
    exists: true,
  }))
  const sourcesBefore = [descriptor(root, dinoPath), descriptor(root, clipPath)].sort((left, right) =>
    left.physicalKey.localeCompare(right.physicalKey),
  )
  const baseInput = makeInput(root, 'synthetic-base', nativeRecords, 'synthetic', sourcesBefore)
  const base = await measureBuild(baseInput)
  const appendCount = 2_000
  const appendDescriptor = fs.openSync(dinoPath, 'a')
  try {
    let batch = ''
    for (let index = 0; index < appendCount; index++) {
      const pathIndex = index < appendCount / 2 ? index : count + index
      batch += embeddingRow(
        `D:\\prep009\\folder_${String(pathIndex % 100).padStart(3, '0')}\\image_${String(pathIndex).padStart(6, '0')}.jpg`,
        'dinov2_vitb14',
      )
    }
    fs.writeSync(appendDescriptor, batch)
  } finally {
    fs.closeSync(appendDescriptor)
  }
  const sourcesAfter = [descriptor(root, dinoPath), descriptor(root, clipPath)].sort((left, right) =>
    left.physicalKey.localeCompare(right.physicalKey),
  )
  const incrementalInput = makeInput(
    root,
    'synthetic-incremental',
    nativeRecords,
    'synthetic',
    sourcesAfter,
    baseInput.databasePath,
  )
  const incremental = await measureBuild(incrementalInput)
  const comparisonInput = makeInput(
    root,
    'synthetic-comparison',
    nativeRecords,
    'synthetic',
    sourcesAfter,
  )
  const comparison = await measureBuild(comparisonInput)
  return {
    recordsPerLayerBefore: count,
    appendedRows: appendCount,
    sourceBytesAfter: sourcesAfter.reduce((sum, source) => sum + source.sizeBytes, 0),
    baseMs: base.elapsedMs,
    incrementalMs: incremental.elapsedMs,
    comparisonFullMs: comparison.elapsedMs,
    tailBytesRead: incremental.result.tailBytesRead,
    readRatio: round(
      incremental.result.tailBytesRead /
        Math.max(1, sourcesAfter.reduce((sum, source) => sum + source.sizeBytes, 0)),
      6,
    ),
    summaryParity:
      JSON.stringify(comparableSummary(incremental.result.summary)) ===
      JSON.stringify(comparableSummary(comparison.result.summary)),
    catalogSha256Parity:
      incremental.result.catalogSha256 === comparison.result.catalogSha256,
    incrementalBuildMode: incremental.result.buildMode,
  }
}

async function main() {
  const beforeSources = discoverRealSources()
  if (beforeSources.length === 0) throw new Error('No real authoritative vector sources found')
  const nativeRecords = await waitForNativeSnapshot()
  const nativeRevision = imageSearch.getImageSearchCatalogRevision()
  const realRoot = path.join(temporaryRoot, 'real')
  fs.mkdirSync(realRoot, { recursive: true })
  const fullInput = makeInput(
    realRoot,
    'real-full',
    nativeRecords,
    nativeRevision,
    beforeSources,
  )
  process.stderr.write('[prep009] real full build\n')
  const full = await measureBuild(fullInput)
  const noOpRuns = []
  for (let index = 0; index < 3; index++) {
    process.stderr.write(`[prep009] real no-op ${index + 1}/3\n`)
    const input = makeInput(
      realRoot,
      `real-noop-${index + 1}`,
      nativeRecords,
      nativeRevision,
      beforeSources,
      fullInput.databasePath,
    )
    noOpRuns.push(await measureBuild(input))
  }
  process.stderr.write('[prep009] synthetic append parity\n')
  const synthetic = await syntheticAppendParity()
  const afterSources = discoverRealSources()
  const sourceFilesUnchanged = JSON.stringify(beforeSources) === JSON.stringify(afterSources)
  const noOpElapsed = noOpRuns.map((run) => run.elapsedMs)
  const summaryParity = noOpRuns.every(
    (run) =>
      JSON.stringify(comparableSummary(run.result.summary)) ===
      JSON.stringify(comparableSummary(full.result.summary)),
  )
  const shaParity = noOpRuns.every(
    (run) => run.result.catalogSha256 === full.result.catalogSha256,
  )
  const failures = []
  if (full.result.buildMode !== 'full') failures.push('Real calibration did not use full mode')
  if (full.elapsedMs > 150_000) failures.push('Real full build exceeded 150 seconds')
  if (full.peakRssMiB > 700) failures.push('Real full build exceeded 700 MiB RSS')
  if (full.databaseMiB > 256) failures.push('Real catalog exceeded 256 MiB')
  if (noOpRuns.some((run) => run.result.buildMode !== 'incremental')) {
    failures.push('A real no-op refresh did not use incremental mode')
  }
  if (noOpRuns.some((run) => run.result.fullBytesRead !== 0 || run.result.tailBytesRead !== 0)) {
    failures.push('A real no-op refresh re-read vector source bytes')
  }
  if (percentile(noOpElapsed, 0.95) > 45_000) {
    failures.push('Real no-op P95 exceeded 45 seconds')
  }
  if (!summaryParity || !shaParity) failures.push('Real no-op catalog differs from full build')
  if (!synthetic.summaryParity || !synthetic.catalogSha256Parity) {
    failures.push('Synthetic append catalog differs from full rebuild')
  }
  if (synthetic.incrementalBuildMode !== 'incremental') {
    failures.push('Synthetic append did not use incremental mode')
  }
  if (synthetic.readRatio >= 0.3) failures.push('Synthetic append read at least 30% of sources')
  if (!sourceFilesUnchanged) failures.push('A real source file changed')

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    real: {
      nativeRecords: nativeRecords.length,
      vectorSources: beforeSources.map((source) => ({
        physicalKeyHash: crypto.createHash('sha256').update(source.physicalKey).digest('hex').slice(0, 16),
        layer: source.layer,
        sizeBytes: source.sizeBytes,
      })),
      vectorBytes: beforeSources.reduce((sum, source) => sum + source.sizeBytes, 0),
      full: {
        elapsedMs: full.elapsedMs,
        workerDurationMs: full.result.durationMs,
        peakRssMiB: full.peakRssMiB,
        databaseMiB: full.databaseMiB,
        summary: full.result.summary,
        catalogSha256: full.result.catalogSha256,
      },
      noOp: {
        runsMs: noOpElapsed,
        p50Ms: round(percentile(noOpElapsed, 0.5)),
        p95Ms: round(percentile(noOpElapsed, 0.95)),
        peakRssMiB: round(Math.max(...noOpRuns.map((run) => run.peakRssMiB))),
        fullBytesRead: noOpRuns.map((run) => run.result.fullBytesRead),
        tailBytesRead: noOpRuns.map((run) => run.result.tailBytesRead),
        summaryParity,
        catalogSha256Parity: shaParity,
      },
    },
    syntheticAppend: synthetic,
    safety: { sourceFilesUnchanged, isolatedDerivedCatalog: true },
    gate: { passed: failures.length === 0, failures },
  }
  fs.mkdirSync(artifactRoot, { recursive: true })
  const reportDirectory = timestamp()
  const output = path.join(artifactRoot, reportDirectory)
  fs.mkdirSync(output, { recursive: false })
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
  fs.writeFileSync(
    path.join(artifactRoot, 'latest.json'),
    JSON.stringify(
      {
        generatedAt: report.generatedAt,
        reportDirectory,
        reportFile: `artifacts/benchmark/data-catalog-prep009/${reportDirectory}/report.json`,
        gate: report.gate,
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log(JSON.stringify(report, null, 2))
  if (!report.gate.passed) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    try {
      await imageSearch.shutdownImageSearchForQuit()
    } catch {
      // Benchmark cleanup is best effort; no source mutation occurred.
    }
    const resolved = path.resolve(temporaryRoot)
    const safePrefix = path.join(path.resolve(os.tmpdir()), 'floating-clock-catalog-prep009-')
    if (resolved.startsWith(safePrefix)) fs.rmSync(resolved, { recursive: true, force: true })
  })
