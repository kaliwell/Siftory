const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { startRuntimeMemorySampler } = require('./runtime-memory-process-sampler.cjs')

const projectRoot = path.resolve(__dirname, '..')

function option(argv, name, fallback) {
  const prefix = `--${name}=`
  const value = argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
  return value === undefined ? fallback : value
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return parsed
}

function sampleFile(filePath) {
  const stat = fs.statSync(filePath)
  if (!stat.isFile())
    throw new Error(`Quality gate input is not a file: ${path.basename(filePath)}`)
  const windowBytes = Math.min(64 * 1024, stat.size)
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(filePath, 'r')
  try {
    const offsets = [
      0,
      Math.max(0, Math.floor((stat.size - windowBytes) / 2)),
      Math.max(0, stat.size - windowBytes),
    ]
    for (const offset of new Set(offsets)) {
      const buffer = Buffer.allocUnsafe(windowBytes)
      const bytes = fs.readSync(fd, buffer, 0, windowBytes, offset)
      hash.update(buffer.subarray(0, bytes))
    }
  } finally {
    fs.closeSync(fd)
  }
  return { bytes: stat.size, mtimeMs: stat.mtimeMs, sampledSha256: hash.digest('hex') }
}

function qualityInputPaths(userDataPath) {
  const vectorDb = path.join(userDataPath, 'vector-db')
  const cache = path.join(vectorDb, 'embedding-cache')
  return {
    legacySource: path.join(vectorDb, 'image_embeddings.jsonl'),
    clipSource: path.join(vectorDb, 'embeddings', 'clip_vit_base_patch32__global.jsonl'),
    dinoSource: path.join(vectorDb, 'embeddings', 'dinov2_vitb14__global.jsonl'),
    clipMeta: path.join(cache, 'clip_vit_base_patch32__global.f16.json'),
    clipVectors: path.join(cache, 'clip_vit_base_patch32__global.f16'),
    clipPaths: path.join(cache, 'clip_vit_base_patch32__global.paths.jsonl'),
    dinoMeta: path.join(cache, 'dinov2_vitb14__global.f16.json'),
    dinoVectors: path.join(cache, 'dinov2_vitb14__global.f16'),
    dinoPaths: path.join(cache, 'dinov2_vitb14__global.paths.jsonl'),
  }
}

function snapshotInputs(userDataPath) {
  const result = {}
  for (const [label, filePath] of Object.entries(qualityInputPaths(userDataPath))) {
    if (fs.existsSync(filePath)) result[label] = sampleFile(filePath)
  }
  return result
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.partial`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(temporary, filePath)
}

function summarizeMemory(samples, rawSamples) {
  return {
    sampleCount: samples.length,
    intervalMs: samples[0]?.intervalMs ?? null,
    rawSamples,
    peakWorkingSetBytes: Math.max(...samples.map((sample) => sample.aggregate.workingSetBytes)),
    peakPrivateBytes: Math.max(...samples.map((sample) => sample.aggregate.privateBytes)),
    peakCommitBytes: Math.max(...samples.map((sample) => sample.aggregate.commitBytes)),
    minimumFreePhysicalMemoryBytes: Math.min(
      ...samples.map((sample) => sample.system.freePhysicalMemoryBytes),
    ),
    peakProcessCount: Math.max(...samples.map((sample) => sample.aggregate.processCount)),
  }
}

function runRecallRound({ userDataPath, queries, topK, matrixCacheDir, sampleDir, round }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(projectRoot, 'scripts', 'verify-vector-generation-recall.cjs'),
        userDataPath,
        `--queries=${queries}`,
        `--top-k=${topK}`,
        `--matrix-cache-dir=${matrixCacheDir}`,
        '--memory-ceiling-mb=256',
      ],
      { cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    const samplePrefix = `round-${round}-${Date.now()}`
    const rawSamples = path.join(sampleDir, `${samplePrefix}.jsonl`)
    const stopFile = path.join(sampleDir, `${samplePrefix}.stop`)
    const readyFile = path.join(sampleDir, `${samplePrefix}.ready`)
    const samplerPromise = startRuntimeMemorySampler({
      rootPid: child.pid,
      outputFile: rawSamples,
      stopFile,
      readyFile,
      intervalMs: 500,
    })
    const append = (current, chunk, label) => {
      const next = current + chunk
      if (Buffer.byteLength(next) > 1024 * 1024) {
        child.kill()
        throw new Error(`${label} exceeded the 1 MiB quality-gate output limit`)
      }
      return next
    }
    child.stdout.on('data', (chunk) => {
      try {
        stdout = append(stdout, chunk.toString('utf8'), 'stdout')
      } catch (error) {
        reject(error)
      }
    })
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      process.stderr.write(`[quality ${round}] ${text}`)
      try {
        stderr = append(stderr, text, 'stderr')
      } catch (error) {
        reject(error)
      }
    })
    child.once('error', reject)
    child.once('exit', async (code) => {
      let memory
      try {
        const sampler = await samplerPromise
        const samples = await sampler.stop()
        memory = summarizeMemory(samples, path.relative(projectRoot, rawSamples))
      } catch (error) {
        reject(new Error(`Quality gate round ${round} memory sampling failed: ${error.message}`))
        return
      }
      if (code !== 0) {
        reject(new Error(`Quality gate round ${round} exited ${code}: ${stderr.slice(-2000)}`))
        return
      }
      try {
        resolve({ ...JSON.parse(stdout), memory })
      } catch (error) {
        reject(new Error(`Quality gate round ${round} returned invalid JSON: ${error.message}`))
      }
    })
  })
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))]
}

function evaluateQualityRounds(rounds, before, after) {
  const failures = []
  if (rounds.length < 3) failures.push('fewer than three quality rounds')
  if (
    rounds.some(
      (round) =>
        !Number.isFinite(round.memory?.peakPrivateBytes) ||
        round.memory.peakPrivateBytes > 2 * 1024 * 1024 * 1024,
    )
  ) {
    failures.push('a quality round exceeded the 2 GiB process-tree private-memory gate')
  }
  const models = ['clip_vit_base_patch32', 'dinov2_vitb14']
  const summaries = {}
  for (const modelName of models) {
    const reports = rounds.map((round) =>
      round.reports.find((item) => item.modelName === modelName),
    )
    if (reports.some((report) => !report)) {
      failures.push(`${modelName} is missing from a round`)
      continue
    }
    if (reports.some((report) => !report.gatePassed)) {
      failures.push(`${modelName} failed a quality round`)
    }
    for (const field of ['snapshotFingerprint', 'sourceFingerprint']) {
      if (new Set(reports.map((report) => report[field])).size !== 1) {
        failures.push(`${modelName} ${field} changed across rounds`)
      }
    }
    if (reports.some((report) => report.generationLoadMode !== 'f16-stream')) {
      failures.push(`${modelName} did not use bounded F16 streaming`)
    }
    summaries[modelName] = {
      rounds: reports.length,
      count: reports[0].generationCount,
      sourceRecordCount: reports[0].sourceRecordCount,
      sourceEffectiveCount: reports[0].sourceEffectiveCount,
      alignedCount: reports[0].alignedCount,
      recallAtKMeanMin: Math.min(...reports.map((report) => report.recallAtKMean)),
      rankEquivalentRecallAtKMeanMin: Math.min(
        ...reports.map((report) => report.rankEquivalentRecallAtKMean),
      ),
      selfWithinTop1ToleranceRateMin: Math.min(
        ...reports.map((report) => report.selfWithinTop1ToleranceRate),
      ),
      scoreErrorP99Max: Math.max(...reports.map((report) => report.scoreErrorP99)),
      elapsedP50Ms: percentile(
        reports.map((report) => report.elapsedMs),
        0.5,
      ),
      elapsedP95Ms: percentile(
        reports.map((report) => report.elapsedMs),
        0.95,
      ),
      sourceMatrixBytes: reports[0].sourceMatrixBytes,
      generationEncodedBytes: reports[0].generationEncodedBytes,
      generationDecodedWindowBytes: reports[0].generationDecodedWindowBytes,
    }
  }
  const sourceFilesUnchanged = JSON.stringify(before) === JSON.stringify(after)
  if (!sourceFilesUnchanged) failures.push('a quality-gate source file changed')
  return {
    passed: failures.length === 0,
    failures,
    sourceFilesUnchanged,
    models: summaries,
    memory: {
      peakPrivateBytes: Math.max(...rounds.map((round) => round.memory?.peakPrivateBytes ?? 0)),
      peakWorkingSetBytes: Math.max(
        ...rounds.map((round) => round.memory?.peakWorkingSetBytes ?? 0),
      ),
      minimumFreePhysicalMemoryBytes: Math.min(
        ...rounds.map((round) => round.memory?.minimumFreePhysicalMemoryBytes ?? Infinity),
      ),
      rounds: rounds.map((round, index) => ({ round: index + 1, ...round.memory })),
    },
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const runs = boundedInteger(option(argv, 'runs'), 3, 3, 5, 'runs')
  const queries = boundedInteger(option(argv, 'queries'), 200, 1, 10_000, 'queries')
  const topK = boundedInteger(option(argv, 'top-k'), 50, 1, 5_000, 'top-k')
  const userDataPath = path.resolve(
    option(argv, 'user-data', path.join(process.env.APPDATA || '', 'floating-clock-electron')),
  )
  const outputDir = path.resolve(
    projectRoot,
    option(argv, 'output-dir', 'artifacts/benchmark/runtime-memory/quality-gate'),
  )
  const matrixCacheDir = path.join(outputDir, 'matrix-cache')
  const sampleDir = path.join(outputDir, 'samples')
  fs.mkdirSync(matrixCacheDir, { recursive: true })
  fs.mkdirSync(sampleDir, { recursive: true })
  const before = snapshotInputs(userDataPath)
  const rounds = []
  for (let round = 1; round <= runs; round++) {
    const report = await runRecallRound({
      userDataPath,
      queries,
      topK,
      matrixCacheDir,
      sampleDir,
      round,
    })
    rounds.push(report)
    writeJsonAtomic(path.join(outputDir, `round-${round}.json`), report)
  }
  const after = snapshotInputs(userDataPath)
  const gate = evaluateQualityRounds(rounds, before, after)
  const report = {
    schema: 'siftory-runtime-memory-quality-gate/v1',
    generatedAt: new Date().toISOString(),
    runs,
    queries,
    topK,
    safety: { sourceFilesUnchanged: gate.sourceFilesUnchanged, outputIsolated: true },
    memory: gate.memory,
    models: gate.models,
    gate: { passed: gate.passed, failures: gate.failures },
  }
  writeJsonAtomic(path.join(outputDir, 'report.json'), report)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!gate.passed) process.exitCode = 1
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}

module.exports = { evaluateQualityRounds, qualityInputPaths, sampleFile, snapshotInputs }
