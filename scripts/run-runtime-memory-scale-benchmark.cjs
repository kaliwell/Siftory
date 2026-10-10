#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { performance } = require('node:perf_hooks')
const { loadTsModule } = require('../tests/guard-utils.cjs')

const { VideoFrameManifestLookup } = loadTsModule('electron/videoFrameManifestLookup.ts')
const { scanVideoFrameVectors } = loadTsModule('electron/videoFrameVectorLookup.ts')
const { normalizedCosineScore } = loadTsModule('electron/mediaSearchVectorMath.ts')
const VECTOR_MODELS = [
  { modelName: 'clip_vit_base_patch32', dimension: 512 },
  { modelName: 'dinov2_vitb14', dimension: 768 },
]

function option(argv, name, fallback = '') {
  return argv.find((entry) => entry.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
}

function boundedInteger(raw, fallback, minimum, maximum, label) {
  const value = Number(raw || fallback)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function parseArgs(argv, projectRoot = path.resolve(__dirname, '..')) {
  for (const entry of argv) {
    if (!/^--(?:manifest-rows|vector-small-rows|vector-large-rows|output-dir)=/.test(entry)) {
      throw new Error(`Unknown scale benchmark argument: ${entry}`)
    }
  }
  const manifestRows = boundedInteger(option(argv, 'manifest-rows'), 1_000_000, 1_000, 1_000_000, '--manifest-rows')
  const vectorSmallRows = boundedInteger(option(argv, 'vector-small-rows'), 100_000, 1_000, 500_000, '--vector-small-rows')
  const vectorLargeRows = boundedInteger(option(argv, 'vector-large-rows'), 500_000, 1_000, 500_000, '--vector-large-rows')
  if (vectorSmallRows > vectorLargeRows) throw new Error('small vector scale must not exceed large scale')
  const allowedRoot = path.join(projectRoot, 'artifacts', 'benchmark', 'runtime-memory')
  const outputDir = path.resolve(option(argv, 'output-dir', path.join(allowedRoot, 'scale')))
  const relative = path.relative(allowedRoot, outputDir)
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('--output-dir must stay under artifacts/benchmark/runtime-memory')
  }
  return { manifestRows, outputDir, projectRoot, vectorLargeRows, vectorSmallRows }
}

function memorySnapshot() {
  const value = process.memoryUsage()
  return { heapUsedBytes: value.heapUsed, rssBytes: value.rss }
}

function growth(before, after) {
  return {
    heapUsedBytes: after.heapUsedBytes - before.heapUsedBytes,
    rssBytes: after.rssBytes - before.rssBytes,
  }
}

function* manifestRecords(count) {
  for (let index = 0; index < count; index += 1) {
    yield {
      frameId: index.toString(16).padStart(40, '0'),
      videoId: 'a'.repeat(40),
      videoPath: `S:/synthetic/video-${Math.floor(index / 1000)}.mp4`,
      timestampMs: index * 1000,
      imagePath: `S:/synthetic/frame-${String(index).padStart(9, '0')}.jpg`,
      width: 640,
      status: index % 5 === 0 ? 'error' : 'done',
      createdAt: index,
      updatedAt: index,
    }
  }
}

function createVectorFixture(databasePath, rows, modelName, dimension) {
  const database = new DatabaseSync(databasePath)
  try {
    database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = OFF;
      CREATE TABLE frame_vectors (
        model_name TEXT NOT NULL,
        path_key TEXT NOT NULL,
        image_path TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector BLOB NOT NULL,
        PRIMARY KEY(model_name, path_key)
      ) WITHOUT ROWID, STRICT;
      BEGIN IMMEDIATE;
    `)
    const insert = database.prepare(
      'INSERT INTO frame_vectors(model_name, path_key, image_path, dim, vector) VALUES (?, ?, ?, ?, ?)',
    )
    // Reuse the input buffer while inserting. SQLite copies bound BLOB values,
    // so fixture construction itself does not manufacture 500k temporary
    // ArrayBuffers and obscure the query-memory result.
    const vector = new Float32Array(dimension)
    const vectorBlob = Buffer.from(vector.buffer)
    for (let index = 0; index < rows; index += 1) {
      const score = (index + 1) / (rows + 1)
      vector[0] = score
      vector[1] = Math.sqrt(Math.max(0, 1 - score * score))
      const imagePath = `S:/synthetic/frame-${String(index).padStart(9, '0')}.jpg`
      insert.run(
        modelName,
        imagePath.toLowerCase(),
        imagePath,
        dimension,
        vectorBlob,
      )
    }
    database.exec('COMMIT')
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Transaction may already be closed.
    }
    throw error
  } finally {
    database.close()
  }
}

function insertTopK(top, entry, limit) {
  top.push(entry)
  top.sort((left, right) => right.score - left.score)
  if (top.length > limit) top.length = limit
}

async function benchmarkVectorScale(root, rows, modelName, dimension) {
  const databasePath = path.join(root, `vectors-${modelName}-${rows}.sqlite`)
  const buildStarted = performance.now()
  createVectorFixture(databasePath, rows, modelName, dimension)
  const buildMs = performance.now() - buildStarted
  if (global.gc) global.gc()
  const before = memorySnapshot()
  let peak = before
  const top = []
  const queryVector = new Float32Array(dimension)
  queryVector[0] = 1
  let visited = 0
  const queryStarted = performance.now()
  const scanned = await scanVideoFrameVectors(
    databasePath,
    modelName,
    (imagePath, vector) => {
      visited += 1
      insertTopK(top, { imagePath, score: normalizedCosineScore(queryVector, vector) }, 10)
      if (visited % 10_000 === 0) {
        const current = memorySnapshot()
        peak = {
          heapUsedBytes: Math.max(peak.heapUsedBytes, current.heapUsedBytes),
          rssBytes: Math.max(peak.rssBytes, current.rssBytes),
        }
      }
    },
    { yieldEvery: 2048 },
  )
  const queryMs = performance.now() - queryStarted
  const expected = Array.from({ length: 10 }, (_, offset) =>
    `S:/synthetic/frame-${String(rows - 1 - offset).padStart(9, '0')}.jpg`,
  )
  const parity = expected.every((imagePath, index) => top[index]?.imagePath === imagePath)
  const after = memorySnapshot()
  return {
    modelName,
    dimension,
    rows,
    buildMs,
    queryMs,
    scanned,
    topKParity: parity,
    queryGrowth: growth(before, after),
    queryPeakGrowth: growth(before, peak),
    databaseBytes: fs.statSync(databasePath).size,
  }
}

async function runScaleBenchmark(options) {
  fs.mkdirSync(options.outputDir, { recursive: true })
  const workingRoot = fs.mkdtempSync(path.join(options.outputDir, 'working-'))
  try {
    const manifestPath = path.join(workingRoot, 'manifest.jsonl')
    const manifestDatabase = path.join(workingRoot, 'manifest.sqlite')
    fs.writeFileSync(manifestPath, '')
    const manifest = new VideoFrameManifestLookup(manifestPath, manifestDatabase)
    const manifestBuildStarted = performance.now()
    manifest.replace(manifestRecords(options.manifestRows))
    const manifestBuildMs = performance.now() - manifestBuildStarted
    if (global.gc) global.gc()
    const manifestBefore = memorySnapshot()
    const manifestQueryStarted = performance.now()
    let countDone = 0
    let preview
    let found
    for (let index = 0; index < 20; index += 1) {
      countDone = manifest.countDone()
      preview = manifest.preview(25)
      found = manifest.findReady((options.manifestRows - 1).toString(16).padStart(40, '0'))
    }
    const manifestQueryMs = performance.now() - manifestQueryStarted
    const manifestAfter = memorySnapshot()
    const vectors = []
    for (const { modelName, dimension } of VECTOR_MODELS) {
      for (const rows of [...new Set([options.vectorSmallRows, options.vectorLargeRows])]) {
        vectors.push(await benchmarkVectorScale(workingRoot, rows, modelName, dimension))
      }
    }
    const manifestPassed =
      countDone === options.manifestRows - Math.ceil(options.manifestRows / 5) &&
      preview?.total === options.manifestRows &&
      preview?.frames.length === 25 &&
      found?.frameId === (options.manifestRows - 1).toString(16).padStart(40, '0') &&
      growth(manifestBefore, manifestAfter).heapUsedBytes <= 64 * 1024 * 1024
    const vectorsPassed = vectors.every(
      (entry) =>
        entry.scanned === entry.rows &&
        entry.topKParity &&
        entry.queryPeakGrowth.heapUsedBytes <= 64 * 1024 * 1024 &&
        entry.queryPeakGrowth.rssBytes <= 256 * 1024 * 1024,
    )
    const report = {
      schema: 'siftory-runtime-memory-scale/v2',
      generatedAt: new Date().toISOString(),
      status: manifestPassed && vectorsPassed ? 'passed' : 'failed',
      manifest: {
        rows: options.manifestRows,
        countDone,
        previewCount: preview?.frames.length || 0,
        buildMs: manifestBuildMs,
        queryMs: manifestQueryMs,
        queryGrowth: growth(manifestBefore, manifestAfter),
        databaseBytes: fs.statSync(manifestDatabase).size,
        gatePassed: manifestPassed,
      },
      vectors,
      vectorFixture: {
        models: VECTOR_MODELS,
        scorePath: 'normalizedCosineScore',
        purpose:
          'production-width fixed-record streaming, exact Top-K parity, and bounded query memory; not model quality',
      },
      safety: { syntheticOnly: true, artifactBoundaryMaintained: true },
    }
    const reportPath = path.join(options.outputDir, 'report.json')
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    return report
  } finally {
    fs.rmSync(workingRoot, { recursive: true, force: true })
  }
}

if (require.main === module) {
  runScaleBenchmark(parseArgs(process.argv.slice(2)))
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      if (report.status !== 'passed') process.exitCode = 1
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}

module.exports = { parseArgs, runScaleBenchmark }
