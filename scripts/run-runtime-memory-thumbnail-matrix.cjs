#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {
  parseArgs: parseScenarioArgs,
  runScenarioMatrix,
} = require('./run-runtime-memory-benchmark.cjs')

function option(argv, name, fallback = '') {
  return argv.find((entry) => entry.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
}

function parseArgs(argv, projectRoot = path.resolve(__dirname, '..')) {
  for (const entry of argv) {
    if (!/^--(?:dataset|samples|cycles|timeout-ms|output-dir)=/.test(entry)) {
      throw new Error(`Unknown thumbnail matrix argument: ${entry}`)
    }
  }
  const datasetInput = option(argv, 'dataset')
  if (!datasetInput) throw new Error('--dataset is required')
  const dataset = path.resolve(datasetInput)
  const entry = fs.lstatSync(dataset)
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('--dataset must name a regular, non-symlink directory')
  }
  const samples = Number(option(argv, 'samples', '10000'))
  const cycles = Number(option(argv, 'cycles', '1'))
  const timeoutMs = Number(option(argv, 'timeout-ms', '1800000'))
  if (!Number.isInteger(samples) || samples < 1 || samples > 10_000) {
    throw new Error('--samples must be an integer between 1 and 10000')
  }
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > 600) {
    throw new Error('--cycles must be an integer between 1 and 600')
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 8 * 60 * 60 * 1000) {
    throw new Error('--timeout-ms must be an integer between 30000 and 28800000')
  }
  const allowedRoot = path.join(projectRoot, 'artifacts', 'benchmark', 'runtime-memory')
  const outputDir = path.resolve(
    option(argv, 'output-dir', path.join(allowedRoot, 'thumbnail-matrix')),
  )
  const relative = path.relative(allowedRoot, outputDir)
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('--output-dir must stay under artifacts/benchmark/runtime-memory')
  }
  return { cycles, dataset, outputDir, projectRoot, samples, timeoutMs }
}

function uiReports(outputDir) {
  const root = path.join(outputDir, 'ui-smoke')
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, 'report.json'))
    .filter((candidate) => fs.existsSync(candidate))
    .sort((left, right) => fs.statSync(left).mtimeMs - fs.statSync(right).mtimeMs)
}

function newestUiReport(outputDir, previousReports = new Set()) {
  const candidate = uiReports(outputDir).findLast((entry) => !previousReports.has(entry))
  if (!candidate) throw new Error('Fresh thumbnail matrix UI evidence is missing')
  return JSON.parse(fs.readFileSync(candidate, 'utf8'))
}

function summarizeVariant(requestedJobs, scenario, uiReport) {
  const thumbnail = uiReport.runtimeCheck?.thumbnailGpu || {}
  const attempt = scenario.results?.[0]?.attempts?.[0]
  return {
    requestedJobs,
    status:
      scenario.status === 'passed' &&
      uiReport.ok === true &&
      uiReport.thumbnailSourceUnchanged === true &&
      thumbnail.completed === true &&
      thumbnail.total === thumbnail.cacheWrites &&
      thumbnail.cacheWriteFailures === 0 &&
      thumbnail.gpuCompleted === thumbnail.total &&
      thumbnail.cpuCompleted === 0 &&
      thumbnail.fallbackCount === 0 &&
      thumbnail.gpuJobs === requestedJobs &&
      Number.isInteger(thumbnail.gpuLanes) &&
      thumbnail.gpuLanes >= 1 &&
      thumbnail.gpuLanes <= requestedJobs
        ? 'passed'
        : 'failed',
    requestedSamples: Number(thumbnail.total) || 0,
    gpuCompleted: Number(thumbnail.gpuCompleted) || 0,
    cpuCompleted: Number(thumbnail.cpuCompleted) || 0,
    fallbackCount: Number(thumbnail.fallbackCount) || 0,
    effectiveGpuJobs: Number(thumbnail.gpuJobs) || 0,
    effectiveGpuLanes: Number(thumbnail.gpuLanes) || 0,
    peakInFlight: Number(thumbnail.peakInFlight) || 0,
    elapsedMs: Number(thumbnail.elapsedMs) || 0,
    sourceUnchanged: uiReport.thumbnailSourceUnchanged === true,
    peakPrivateBytes: Number(attempt?.memory?.peak?.privateBytes) || 0,
    peakGpuDeltaMiB: Number(attempt?.memory?.gpu?.peakDeltaMiB) || 0,
    finalGpuUsedMiB: Number(attempt?.memory?.gpu?.finalUsedMiB) || 0,
  }
}

async function runThumbnailMatrix(options, dependencies = {}) {
  const run = dependencies.runScenarioMatrix || runScenarioMatrix
  fs.mkdirSync(options.outputDir, { recursive: true })
  const variants = []
  for (const jobs of [1, 2, 8]) {
    const variantOutput = path.join(options.outputDir, `jobs-${jobs}`)
    const previousReports = new Set(uiReports(variantOutput))
    const scenarioOptions = parseScenarioArgs(
      [
        '--scenario=gpu-lifecycle',
        `--dataset=${options.dataset}`,
        `--thumbnail-samples=${options.samples}`,
        `--thumbnail-jobs=${jobs}`,
        `--cycles=${options.cycles}`,
        '--runs=1',
        `--timeout-ms=${options.timeoutMs}`,
        `--output-dir=${variantOutput}`,
      ],
      { projectRoot: options.projectRoot },
    )
    const scenario = await run(scenarioOptions)
    const uiReport = newestUiReport(variantOutput, previousReports)
    variants.push(summarizeVariant(jobs, scenario, uiReport))
    if (variants.at(-1).status !== 'passed') break
  }
  const complete = variants.length === 3 && variants.every((variant) => variant.status === 'passed')
  const fastest = complete
    ? [...variants].sort((left, right) => left.elapsedMs - right.elapsedMs)[0]
    : null
  const report = {
    schema: 'siftory-runtime-memory-thumbnail-matrix/v1',
    generatedAt: new Date().toISOString(),
    status: complete ? 'passed' : 'failed',
    samples: options.samples,
    variants,
    fastestRequestedJobs: fastest?.requestedJobs ?? null,
    safety: {
      sourceUnchanged: variants.every((variant) => variant.sourceUnchanged),
      artifactBoundaryMaintained: true,
    },
  }
  const target = path.join(
    options.outputDir,
    `thumbnail-matrix-${report.generatedAt.replace(/[:.]/g, '-')}.json`,
  )
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  return report
}

if (require.main === module) {
  runThumbnailMatrix(parseArgs(process.argv.slice(2)))
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      if (report.status !== 'passed') process.exitCode = 1
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}

module.exports = { newestUiReport, parseArgs, runThumbnailMatrix, summarizeVariant, uiReports }
