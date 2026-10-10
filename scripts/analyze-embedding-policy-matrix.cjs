#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const artifactRoot = path.join(projectRoot, 'artifacts', 'benchmark', 'image-preparation-pipeline')

function option(argv, name) {
  return argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || ''
}

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function round(value, digits = 3) {
  const factor = 10 ** digits
  return Math.round(finite(value) * factor) / factor
}

function nearestRank(values, ratio) {
  const sorted = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right)
  if (sorted.length === 0) return 0
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]
}

function resolveDirectory(argv) {
  const requested = option(argv, 'dir')
  if (!requested) throw new Error('Pass --dir=<PREP-012 artifact directory>')
  const directory = path.resolve(requested)
  const relative = path.relative(artifactRoot, directory)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Matrix directory must be below the image preparation artifact root')
  }
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error('Matrix directory does not exist')
  }
  return directory
}

function groupCompletedRuns(reports) {
  const groups = new Map()
  for (const report of reports) {
    for (const run of report.runs || []) {
      if (run.status !== 'completed') continue
      const key = `${run.model}|${run.jobs}|${run.batchSize}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(run)
    }
  }
  return [...groups.entries()]
    .map(([key, runs]) => {
      const [model, jobs, batchSize] = key.split('|')
      const elapsed = runs.map((run) => finite(run.elapsedMs))
      const qualityRows = runs.map((run) => run.qualityVsBaseline).filter(Boolean)
      const minSystemFree = runs
        .map((run) => finite(run.resources?.memory?.systemMinFreeMiB))
        .filter((value) => value > 0)
      return {
        key,
        model,
        jobs: Number(jobs),
        batchSize: Number(batchSize),
        runs: runs.length,
        elapsedMs: {
          p50: round(nearestRank(elapsed, 0.5)),
          p95: round(nearestRank(elapsed, 0.95)),
          min: round(Math.min(...elapsed)),
          max: round(Math.max(...elapsed)),
        },
        imagesPerSecondP50: round(
          nearestRank(
            runs.map((run) => finite(run.imagesPerSecond)),
            0.5,
          ),
        ),
        preInferenceSharePercentP50: round(
          nearestRank(
            runs.map((run) => finite(run.stageMetrics?.preInferenceSharePercent)),
            0.5,
          ),
        ),
        quality: {
          comparedRuns: qualityRows.length,
          minCosine: round(
            Math.min(1, ...qualityRows.map((quality) => finite(quality.minCosine))),
            8,
          ),
          maxAbsDiff: round(
            Math.max(0, ...qualityRows.map((quality) => finite(quality.maxAbsDiff))),
            8,
          ),
          uniqueDigests: new Set(runs.map((run) => String(run.digest || ''))).size,
        },
        resources: {
          samples: runs.reduce((total, run) => total + finite(run.resources?.sampling?.samples), 0),
          errors: runs.reduce((total, run) => total + finite(run.resources?.sampling?.errors), 0),
          minimumSystemFreeMiB: minSystemFree.length ? round(Math.min(...minSystemFree)) : null,
          peakChildAggregateRssMiB: round(
            Math.max(
              0,
              ...runs.map((run) => finite(run.resources?.memory?.childPeakAggregateRssMiBApprox)),
            ),
          ),
          peakGpuUsedMiB: round(
            Math.max(0, ...runs.map((run) => finite(run.resources?.gpu?.peakUsedMiB))),
          ),
          peakGpuDeltaMiB: round(
            Math.max(0, ...runs.map((run) => finite(run.resources?.gpu?.peakDeltaUsedMiB))),
          ),
        },
      }
    })
    .sort(
      (left, right) =>
        left.model.localeCompare(right.model) ||
        left.jobs - right.jobs ||
        left.batchSize - right.batchSize,
    )
}

function skippedCandidates(reports) {
  const groups = new Map()
  for (const report of reports) {
    for (const run of report.runs || []) {
      if (run.status !== 'skipped') continue
      const key = `${run.model}|${run.jobs}|${run.batchSize}|${run.preflight?.reason || 'unknown'}`
      if (!groups.has(key)) {
        groups.set(key, {
          model: run.model,
          jobs: run.jobs,
          batchSize: run.batchSize,
          reason: run.preflight?.reason || 'unknown',
          occurrences: 0,
        })
      }
      groups.get(key).occurrences += 1
    }
  }
  return [...groups.values()].sort(
    (left, right) =>
      left.model.localeCompare(right.model) ||
      left.jobs - right.jobs ||
      left.batchSize - right.batchSize,
  )
}

function addDecisions(groups) {
  return groups.map((group) => {
    const baseline = groups.find(
      (candidate) =>
        candidate.model === group.model && candidate.jobs === 2 && candidate.batchSize === 4,
    )
    const improvementPercent = baseline
      ? round((1 - group.elapsedMs.p50 / baseline.elapsedMs.p50) * 100)
      : null
    let decision
    if (group.jobs === 2 && group.batchSize === 4) decision = 'retain-current-baseline'
    else if (group.runs < 3) decision = 'reject-insufficient-rounds'
    else if (group.resources.errors > 0) decision = 'reject-resource-sampling-error'
    else if (group.quality.minCosine < 0.99999 || group.quality.maxAbsDiff > 0.0001) {
      decision = 'reject-quality-regression'
    } else if (improvementPercent !== null && improvementPercent >= 5) {
      decision = 'candidate-for-1000-image-final'
    } else decision = 'reject-speedup-below-5-percent'
    return { ...group, improvementPercent, decision }
  })
}

function analyzeReports(reportFiles) {
  const reports = reportFiles.map((filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8')))
  const groups = addDecisions(groupCompletedRuns(reports))
  const recommendations = ['dino', 'clip'].map((model) => {
    const accepted = groups
      .filter(
        (group) => group.model === model && group.decision === 'candidate-for-1000-image-final',
      )
      .sort((left, right) => left.elapsedMs.p50 - right.elapsedMs.p50)
    return accepted[0]
      ? {
          model,
          action: 'advance-candidate',
          jobs: accepted[0].jobs,
          batchSize: accepted[0].batchSize,
          improvementPercent: accepted[0].improvementPercent,
        }
      : { model, action: 'retain-jobs-2-batch-4' }
  })
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    reports: reportFiles.map((filePath) => path.basename(filePath)),
    sourceSnapshotConsistent:
      new Set(reports.map((report) => JSON.stringify(report.safety?.sourceSnapshot || null)))
        .size === 1,
    failedRuns: reports.reduce(
      (total, report) =>
        total + (report.runs || []).filter((run) => run.status === 'failed').length,
      0,
    ),
    groups,
    skipped: skippedCandidates(reports),
    recommendations,
  }
}

function renderMarkdown(analysis) {
  const groupRows = analysis.groups
    .map(
      (group) =>
        `| ${group.model.toUpperCase()} | ${group.jobs} | ${group.batchSize} | ${group.runs} | ${round(group.elapsedMs.p50 / 1000, 3)} | ${round(group.elapsedMs.p95 / 1000, 3)} | ${group.improvementPercent ?? '-'}% | ${group.preInferenceSharePercentP50}% | ${group.quality.minCosine} | ${group.quality.maxAbsDiff} | ${group.resources.minimumSystemFreeMiB ?? '-'} | ${group.resources.peakChildAggregateRssMiB} | ${group.resources.peakGpuUsedMiB} | ${group.resources.errors} | ${group.decision} |`,
    )
    .join('\n')
  const skippedRows = analysis.skipped
    .map(
      (run) =>
        `| ${run.model.toUpperCase()} | ${run.jobs} | ${run.batchSize} | ${run.occurrences} | ${run.reason} |`,
    )
    .join('\n')
  const recommendationRows = analysis.recommendations
    .map((item) =>
      item.action === 'advance-candidate'
        ? `| ${item.model.toUpperCase()} | advance jobs=${item.jobs}, batch=${item.batchSize} | ${item.improvementPercent}% |`
        : `| ${item.model.toUpperCase()} | retain jobs=2, batch=4 | no candidate reached the 5% gate |`,
    )
    .join('\n')
  return `# PREP-012 embedding policy matrix analysis

- Generated: ${analysis.generatedAt}
- Reports: ${analysis.reports.join(', ')}
- Failed runs: ${analysis.failedRuns}
- Source snapshot consistent: ${analysis.sourceSnapshotConsistent}

## Completed candidates

P50/P95 use nearest-rank values. Improvement is relative to the same model's current jobs=2, batch=4 baseline; positive is faster. Child RSS and GPU values are per-candidate observed peaks.

| Model | Jobs | Batch | Rounds | P50 s | P95 s | Improvement | Pre-inference P50 | Min cosine | Max abs diff | Min free MiB | Child RSS MiB | GPU peak MiB | Sampling errors | Decision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${groupRows || '| - | - | - | - | - | - | - | - | - | - | - | - | - | - | no completed candidates |'}

## Resource-policy skips

| Model | Jobs | Batch | Occurrences | Reason |
| --- | ---: | ---: | ---: | --- |
${skippedRows || '| - | - | - | - | none |'}

## Recommendation

| Model | Action | Evidence |
| --- | --- | --- |
${recommendationRows}
`
}

function main() {
  const directory = resolveDirectory(process.argv.slice(2))
  const reportFiles = fs
    .readdirSync(directory)
    .filter((name) => /^matrix-256-r\d+\.json$/.test(name))
    .sort()
    .map((name) => path.join(directory, name))
  if (reportFiles.length === 0) throw new Error('No matrix-256-r*.json reports found')
  const analysis = analyzeReports(reportFiles)
  fs.writeFileSync(
    path.join(directory, 'matrix-analysis.json'),
    `${JSON.stringify(analysis, null, 2)}\n`,
    'utf8',
  )
  fs.writeFileSync(path.join(directory, 'matrix-analysis.md'), renderMarkdown(analysis), 'utf8')
  process.stdout.write(
    `${JSON.stringify({
      ok: analysis.failedRuns === 0,
      reports: analysis.reports.length,
      groups: analysis.groups.length,
      recommendations: analysis.recommendations,
    })}\n`,
  )
}

if (require.main === module) main()

module.exports = { analyzeReports, nearestRank, renderMarkdown }
