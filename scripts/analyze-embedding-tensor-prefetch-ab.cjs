const fs = require('node:fs')
const path = require('node:path')

function option(argv, name, fallback) {
  return argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
}

function round(value, digits = 3) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null
}

function nearestRank(values, percentile) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (sorted.length === 0) return null
  return sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)]
}

function distribution(values) {
  return {
    min: round(Math.min(...values)),
    p50: round(nearestRank(values, 0.5)),
    p95: round(nearestRank(values, 0.95)),
    max: round(Math.max(...values)),
  }
}

function unwrapReport(report, fileName = '') {
  const run = report.runs?.[0]
  if (run) return { report, run, fileName }
  if (!report.phases?.libraryReadyMs) {
    throw new Error(`Missing benchmark run in ${fileName || 'report'}`)
  }
  const imageCount = Number(report.config?.imageCount) || 0
  const fallbackBatches =
    (Number(report.dino?.progress?.stageMetrics?.fallbackBatches) || 0) +
    (Number(report.clip?.progress?.stageMetrics?.fallbackBatches) || 0)
  return {
    report,
    fileName,
    run: {
      status: report.ok === true ? 'completed' : 'failed',
      elapsedMs: Number(report.phases.libraryReadyMs),
      imagesPerSecond:
        imageCount > 0 ? imageCount / (Number(report.phases.libraryReadyMs) / 1000) : 0,
      digest: JSON.stringify({
        scan: report.scan?.digest,
        dino: report.embeddingDigests?.dino,
        clip: report.embeddingDigests?.clip,
        vectorIndex: report.vectorIndex?.status,
      }),
      stageMetrics: {
        fallbackBatches,
        tensorPrefetchBatches: report.config?.tensorPrefetch === true ? 1 : 0,
      },
      resources: report.resources,
    },
  }
}

function summarize(entries) {
  const elapsed = entries.map(({ run }) => Number(run.elapsedMs))
  const throughput = entries.map(({ run }) => Number(run.imagesPerSecond))
  const childPeak = entries.map(({ run }) =>
    Number(run.resources?.memory?.childPeakAggregateRssMiBApprox),
  )
  const minFree = entries.map(({ run }) => Number(run.resources?.memory?.systemMinFreeMiB))
  const gpuPeak = entries.map(({ run }) => Number(run.resources?.gpu?.peakUsedMiB))
  return {
    runs: entries.length,
    elapsedMs: distribution(elapsed),
    imagesPerSecond: distribution(throughput),
    childPeakAggregateRssMiB: distribution(childPeak),
    systemMinFreeMiB: distribution(minFree),
    gpuPeakUsedMiB: distribution(gpuPeak),
    fallbackBatches: entries.reduce(
      (total, { run }) => total + (Number(run.stageMetrics?.fallbackBatches) || 0),
      0,
    ),
    samplingErrors: entries.reduce(
      (total, { run }) => total + (Number(run.resources?.sampling?.errors) || 0),
      0,
    ),
    prefetchBatches: entries.reduce(
      (total, { run }) => total + (Number(run.stageMetrics?.tensorPrefetchBatches) || 0),
      0,
    ),
  }
}

function analyzeEmbeddingTensorPrefetch(baselineEntries, candidateEntries, options = {}) {
  if (baselineEntries.length === 0 || candidateEntries.length === 0) {
    throw new Error('Both baseline and candidate reports are required')
  }
  const baseline = summarize(baselineEntries)
  const candidate = summarize(candidateEntries)
  const allEntries = [...baselineEntries, ...candidateEntries]
  const digests = new Set(allEntries.map(({ run }) => run.digest))
  const sourceSnapshots = new Set(
    allEntries.map(({ report }) => JSON.stringify(report.safety?.sourceSnapshot || null)),
  )
  const failures = []
  const minimumRuns = Math.max(1, Number(options.minimumRuns) || 3)
  if (baseline.runs < minimumRuns || candidate.runs < minimumRuns) {
    failures.push('fewer-than-required-runs')
  }
  if (allEntries.some(({ report, run }) => report.ok !== true || run.status !== 'completed')) {
    failures.push('run-failed')
  }
  if (allEntries.some(({ report }) => report.safety?.sourceUnchanged !== true)) {
    failures.push('source-changed')
  }
  if (digests.size !== 1) failures.push('vector-digest-parity-failed')
  if (sourceSnapshots.size !== 1) failures.push('source-snapshot-parity-failed')
  if (candidate.fallbackBatches > 0) failures.push('candidate-fallback')
  if (candidate.samplingErrors > 0) failures.push('resource-sampling-error')
  if (candidate.prefetchBatches <= 0) failures.push('candidate-prefetch-not-observed')

  const improvementPercent = round((1 - candidate.elapsedMs.p50 / baseline.elapsedMs.p50) * 100)
  if (improvementPercent < 5) failures.push('p50-improvement-below-5-percent')
  if (candidate.elapsedMs.p95 > baseline.elapsedMs.p95 * 1.03) {
    failures.push('p95-regressed-over-3-percent')
  }
  if (candidate.elapsedMs.max > baseline.elapsedMs.max * 1.03) {
    failures.push('max-regressed-over-3-percent')
  }
  if (
    candidate.childPeakAggregateRssMiB.max >
    baseline.childPeakAggregateRssMiB.max +
      Math.max(64, baseline.childPeakAggregateRssMiB.max * 0.05)
  ) {
    failures.push('child-rss-over-budget')
  }
  if (candidate.systemMinFreeMiB.min < 64) failures.push('system-free-memory-below-64-mib')
  if (candidate.gpuPeakUsedMiB.max > baseline.gpuPeakUsedMiB.max + 64) {
    failures.push('gpu-memory-over-budget')
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    gate: {
      minimumRuns,
      p50ImprovementPercent: 5,
      p95AndMaxRegressionPercent: 3,
      minimumSystemFreeMiB: 64,
      gpuPeakAllowanceMiB: 64,
    },
    parity: {
      vectorDigest: digests.size === 1,
      sourceSnapshot: sourceSnapshots.size === 1,
      digest: digests.size === 1 ? [...digests][0] : null,
    },
    baseline,
    candidate,
    improvementPercent,
    failures,
    decision:
      failures.length === 0 ? options.successDecision || 'run-1000-final' : 'reject-and-defer',
  }
}

function loadDirectory(directory) {
  const groups = { baseline: [], candidate: [] }
  for (const fileName of fs.readdirSync(directory).sort()) {
    const match = /^(baseline|candidate)-round-\d+\.json$/.exec(fileName)
    if (!match) continue
    const report = JSON.parse(fs.readFileSync(path.join(directory, fileName), 'utf8'))
    groups[match[1]].push(unwrapReport(report, fileName))
  }
  return groups
}

function main() {
  const argv = process.argv.slice(2)
  const directory = path.resolve(option(argv, 'dir', argv[0] || ''))
  const jsonOut = option(argv, 'json-out', path.join(directory, 'analysis.json'))
  const baselineFile = option(argv, 'baseline-file', '')
  const candidateFile = option(argv, 'candidate-file', '')
  const groups =
    baselineFile && candidateFile
      ? {
          baseline: [
            unwrapReport(
              JSON.parse(fs.readFileSync(path.resolve(baselineFile), 'utf8')),
              baselineFile,
            ),
          ],
          candidate: [
            unwrapReport(
              JSON.parse(fs.readFileSync(path.resolve(candidateFile), 'utf8')),
              candidateFile,
            ),
          ],
        }
      : loadDirectory(directory)
  const minimumRuns = Math.max(1, Number(option(argv, 'minimum-runs', '3')) || 3)
  const analysis = analyzeEmbeddingTensorPrefetch(groups.baseline, groups.candidate, {
    minimumRuns,
    successDecision: option(
      argv,
      'success-decision',
      minimumRuns === 1 ? 'standalone-pass-await-e2e' : 'run-1000-final',
    ),
  })
  fs.writeFileSync(path.resolve(jsonOut), `${JSON.stringify(analysis, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(analysis, null, 2)}\n`)
  if (analysis.decision === 'reject-and-defer') process.exitCode = 2
}

if (require.main === module) main()

module.exports = { analyzeEmbeddingTensorPrefetch, unwrapReport }
