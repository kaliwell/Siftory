const fs = require('node:fs')
const path = require('node:path')

function option(argv, name, fallback) {
  return argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function nearestRank(values, percentile) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (finite.length === 0) return null
  return finite[Math.max(0, Math.ceil(finite.length * percentile) - 1)]
}

function valueAt(object, dottedPath) {
  return dottedPath.split('.').reduce((value, key) => value?.[key], object)
}

function numericValues(reports, field) {
  return reports.map((report) => Number(valueAt(report, field))).filter(Number.isFinite)
}

function distribution(reports, field) {
  const values = numericValues(reports, field)
  return {
    min: round(Math.min(...values)),
    p50: round(nearestRank(values, 0.5)),
    p95: round(nearestRank(values, 0.95)),
    max: round(Math.max(...values)),
  }
}

function digestSignature(report) {
  return JSON.stringify({
    scan: [report.scan?.digest?.count, report.scan?.digest?.sha256],
    dino: [report.embeddingDigests?.dino?.count, report.embeddingDigests?.dino?.stableSha256],
    clip: [report.embeddingDigests?.clip?.count, report.embeddingDigests?.clip?.stableSha256],
    vector: [
      report.vectorIndex?.status?.built,
      report.vectorIndex?.status?.count,
      report.vectorIndex?.status?.dim,
    ],
  })
}

function sourceSignature(report) {
  return JSON.stringify(report.safety?.sourceSnapshot || null)
}

function groupKey(scanWorkers, embeddingJobs) {
  return `scan-${scanWorkers}-jobs-${embeddingJobs}`
}

function summarizeGroup(reports, baseline) {
  const first = reports[0]
  const scanWorkers = Number(
    first.config?.requestedScanWorkers ?? first.scan?.progress?.scanWorkerCount,
  )
  const embeddingJobs = Number(first.config?.jobs)
  const ready = distribution(reports, 'phases.libraryReadyMs')
  const effectiveScanWorkers = [
    ...new Set(reports.map((report) => Number(report.scan?.progress?.scanWorkerCount))),
  ]
  const samplingErrors = reports.reduce(
    (total, report) => total + (Number(report.resources?.sampling?.errors) || 0),
    0,
  )
  const processRaceSkips = reports.reduce(
    (total, report) => total + (Number(report.resources?.sampling?.processRaceSkips) || 0),
    0,
  )
  const fallbackBatches = reports.reduce(
    (total, report) =>
      total +
      (Number(report.dino?.progress?.stageMetrics?.fallbackBatches) || 0) +
      (Number(report.clip?.progress?.stageMetrics?.fallbackBatches) || 0),
    0,
  )
  const failedEmbeddings = reports.reduce(
    (total, report) =>
      total +
      (Number(report.dino?.progress?.failed) || 0) +
      (Number(report.clip?.progress?.failed) || 0),
    0,
  )
  const commitFeedDropped = reports.reduce(
    (total, report) => total + (Number(report.pipeline?.result?.commitFeedDropped) || 0),
    0,
  )
  const group = {
    key: groupKey(scanWorkers, embeddingJobs),
    scanWorkers,
    embeddingJobs,
    batchSize: Number(first.config?.batchSize),
    runs: reports.length,
    readyMs: ready,
    scanReadyMs: distribution(reports, 'pipeline.result.timings.scanReadyMs'),
    dinoReadyMs: distribution(reports, 'pipeline.result.timings.dinoReadyMs'),
    clipReadyMs: distribution(reports, 'pipeline.result.timings.clipReadyMs'),
    nativeDecodeAggregateMs: distribution(reports, 'scan.progress.decodeMsTotal'),
    nativeQueueWaitMs: distribution(reports, 'scan.progress.queueWaitMs'),
    resources: {
      systemMinFreeMiB: round(
        Math.min(...numericValues(reports, 'resources.memory.systemMinFreeMiB')),
      ),
      mainPeakRssMiB: round(Math.max(...numericValues(reports, 'resources.memory.mainPeakRssMiB'))),
      childPeakAggregateRssMiB: round(
        Math.max(...numericValues(reports, 'resources.memory.childPeakAggregateRssMiBApprox')),
      ),
      gpuPeakUsedMiB: round(Math.max(...numericValues(reports, 'resources.gpu.peakUsedMiB'))),
      gpuTotalMiB: round(Math.min(...numericValues(reports, 'resources.gpu.totalMiB'))),
      samplingErrors,
      processRaceSkips,
    },
    correctness: {
      effectiveScanWorkers,
      requestedWorkersHonored:
        effectiveScanWorkers.length === 1 && effectiveScanWorkers[0] === scanWorkers,
      allReportsOk: reports.every((report) => report.ok === true),
      sourceUnchanged: reports.every((report) => report.safety?.sourceUnchanged === true),
      fallbackBatches,
      failedEmbeddings,
      commitFeedDropped,
    },
    improvementPercent: null,
    decision: 'baseline',
    failures: [],
  }
  if (!baseline) return group

  group.improvementPercent = round((1 - ready.p50 / baseline.readyMs.p50) * 100)
  const failures = []
  if (reports.length < 3) failures.push('fewer-than-three-runs')
  if (!group.correctness.requestedWorkersHonored) failures.push('scan-worker-override-not-honored')
  if (!group.correctness.allReportsOk) failures.push('run-failed')
  if (!group.correctness.sourceUnchanged) failures.push('source-changed')
  if (fallbackBatches > 0) failures.push('embedding-fallback')
  if (failedEmbeddings > 0) failures.push('embedding-failure')
  if (commitFeedDropped > 0) failures.push('commit-feed-dropped')
  if (samplingErrors > 0) failures.push('resource-sampling-error')
  if (!group.correctness.requestedWorkersHonored) {
    group.improvementPercent = null
    group.failures = failures
    group.decision = 'skipped-resource-policy'
    return group
  }
  if (group.improvementPercent < 5) failures.push('p50-improvement-below-5-percent')
  if (ready.p95 > baseline.readyMs.p95 * 1.03) failures.push('p95-regressed-over-3-percent')
  if (ready.max > baseline.readyMs.max * 1.03) failures.push('max-regressed-over-3-percent')
  const mainAllowance = Math.max(64, baseline.resources.mainPeakRssMiB * 0.15)
  const childAllowance = Math.max(64, baseline.resources.childPeakAggregateRssMiB * 0.15)
  if (group.resources.mainPeakRssMiB > baseline.resources.mainPeakRssMiB + mainAllowance) {
    failures.push('main-rss-over-budget')
  }
  if (
    group.resources.childPeakAggregateRssMiB >
    baseline.resources.childPeakAggregateRssMiB + childAllowance
  ) {
    failures.push('child-rss-over-budget')
  }
  if (group.resources.systemMinFreeMiB < 64) failures.push('system-free-memory-below-64-mib')
  if (
    Number.isFinite(group.resources.gpuPeakUsedMiB) &&
    Number.isFinite(group.resources.gpuTotalMiB) &&
    group.resources.gpuPeakUsedMiB / group.resources.gpuTotalMiB > 0.75
  ) {
    failures.push('gpu-usage-over-75-percent')
  }
  group.failures = failures
  group.decision = failures.length === 0 ? 'finalist' : 'reject'
  return group
}

function analyzeReports(reports, options = {}) {
  if (reports.length === 0) throw new Error('No joint-scheduling reports provided')
  const baselineScanWorkers = Number(options.baselineScanWorkers || 3)
  const baselineEmbeddingJobs = Number(options.baselineEmbeddingJobs || 2)
  const signatures = new Set(reports.map(digestSignature))
  const sourceSignatures = new Set(reports.map(sourceSignature))
  const globalParity = signatures.size === 1
  const sourceParity = sourceSignatures.size === 1
  const grouped = new Map()
  for (const report of reports) {
    const scanWorkers = Number(
      report.config?.requestedScanWorkers ?? report.scan?.progress?.scanWorkerCount,
    )
    const embeddingJobs = Number(report.config?.jobs)
    const key = groupKey(scanWorkers, embeddingJobs)
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(report)
  }
  const baselineKey = groupKey(baselineScanWorkers, baselineEmbeddingJobs)
  const baselineReports = grouped.get(baselineKey)
  if (!baselineReports) throw new Error(`Missing baseline group ${baselineKey}`)
  const baseline = summarizeGroup(baselineReports, null)
  baseline.improvementPercent = 0
  baseline.decision = 'retain-current'
  if (baseline.runs < 3) baseline.failures.push('fewer-than-three-runs')
  if (!baseline.correctness.requestedWorkersHonored) {
    baseline.failures.push('scan-worker-override-not-honored')
  }
  const groups = [...grouped.entries()]
    .map(([key, groupReports]) =>
      key === baselineKey ? baseline : summarizeGroup(groupReports, baseline),
    )
    .sort(
      (left, right) =>
        left.scanWorkers - right.scanWorkers || left.embeddingJobs - right.embeddingJobs,
    )
  if (!globalParity || !sourceParity) {
    for (const group of groups) {
      if (!globalParity) group.failures.push('cross-group-content-parity-failed')
      if (!sourceParity) group.failures.push('cross-group-source-snapshot-mismatch')
      if (group.decision === 'finalist') group.decision = 'reject'
    }
  }
  const finalists = groups
    .filter((group) => group.decision === 'finalist')
    .sort((left, right) => left.readyMs.p50 - right.readyMs.p50)
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    config: {
      reports: reports.length,
      baselineScanWorkers,
      baselineEmbeddingJobs,
      gate: {
        p50ImprovementPercent: 5,
        p95AndMaxRegressionPercent: 3,
        gpuDeviceUsageRatio: 0.75,
        minimumSystemFreeMiB: 64,
      },
    },
    correctness: { globalParity, sourceParity },
    baselineKey,
    groups,
    recommendation:
      finalists.length > 0
        ? {
            action: 'run-1000-image-final',
            scanWorkers: finalists[0].scanWorkers,
            embeddingJobs: finalists[0].embeddingJobs,
            batchSize: finalists[0].batchSize,
          }
        : { action: 'retain-scan-3-jobs-2-batch-4' },
  }
}

function renderMarkdown(analysis) {
  const rows = analysis.groups
    .map(
      (group) =>
        `| ${group.scanWorkers} | ${group.embeddingJobs} | ${group.runs} | ${round(group.readyMs.p50 / 1000)} | ${round(group.readyMs.p95 / 1000)} | ${group.improvementPercent === null ? '-' : `${group.improvementPercent}%`} | ${round(group.scanReadyMs.p50 / 1000)} | ${round(group.dinoReadyMs.p50 / 1000)} | ${group.resources.systemMinFreeMiB} | ${group.resources.mainPeakRssMiB} | ${group.resources.childPeakAggregateRssMiB} | ${group.resources.gpuPeakUsedMiB}/${group.resources.gpuTotalMiB} | ${group.resources.samplingErrors} | ${group.decision} | ${group.failures.join(', ') || '-'} |`,
    )
    .join('\n')
  const recommendation =
    analysis.recommendation.action === 'run-1000-image-final'
      ? `Run the 1000-image final for scan=${analysis.recommendation.scanWorkers}, jobs=${analysis.recommendation.embeddingJobs}, batch=${analysis.recommendation.batchSize}.`
      : 'Retain scan=3, jobs=2, batch=4; no candidate passed every screening gate.'
  return `# PREP-014 joint scheduling matrix analysis

- Generated: ${analysis.generatedAt}
- Reports: ${analysis.config.reports}
- Cross-group content parity: ${analysis.correctness.globalParity}
- Cross-group source parity: ${analysis.correctness.sourceParity}
- Recommendation: **${recommendation}**

P50/P95 use nearest-rank values. Positive improvement is faster than the current scan=3, jobs=2, batch=4 baseline.

| Scan workers | Embedding jobs | Runs | Ready P50 s | Ready P95 s | Improvement | Scan ready P50 s | DINO ready P50 s | Min free MiB | Main RSS MiB | Child RSS MiB | GPU peak/total MiB | Sampling errors | Decision | Failures |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
${rows}
`
}

function main() {
  const directory = path.resolve(option(process.argv.slice(2), 'dir', ''))
  if (!directory || !fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error('Pass --dir=<joint scheduling matrix directory>')
  }
  const reportFiles = fs
    .readdirSync(directory)
    .filter((name) => /^matrix-r\d+-scan\d+-jobs\d+\.json$/.test(name))
    .sort()
  if (reportFiles.length === 0) throw new Error('No matrix-r*-scan*-jobs*.json reports found')
  const reports = reportFiles.map((name) =>
    JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')),
  )
  const analysis = analyzeReports(reports)
  fs.writeFileSync(
    path.join(directory, 'matrix-analysis.json'),
    `${JSON.stringify(analysis, null, 2)}\n`,
    'utf8',
  )
  fs.writeFileSync(path.join(directory, 'matrix-analysis.md'), renderMarkdown(analysis), 'utf8')
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      reports: reportFiles.length,
      groups: analysis.groups.length,
      recommendation: analysis.recommendation,
    })}\n`,
  )
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  }
}

module.exports = { analyzeReports, nearestRank, renderMarkdown }
