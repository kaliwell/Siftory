'use strict'
// Watches an already-started isolated soak and records its actual terminal result.
// Never launches applications, changes the tested package, commits, or shuts down Windows.
const fs = require('node:fs')
const path = require('node:path')
const repo = path.resolve(__dirname, '..')
const parent = path.join(repo, 'artifacts', 'benchmark', 'runtime-memory')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const directory = path.resolve(process.argv[2] || '')
  if (
    path.dirname(directory) !== parent ||
    !path.basename(directory).startsWith('packaged-soak-')
  ) {
    throw new Error('Expected an owned performance soak output directory')
  }
  const file = path.join(directory, 'report.json')
  const deadline = Date.now() + 3 * 60 * 60 * 1000
  let report
  while (Date.now() < deadline) {
    report = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (report.schema !== 'siftory-workspace-performance-soak/v1') {
      throw new Error('Unexpected soak report schema')
    }
    if (report.finishedAt && report.status !== 'running') break
    try {
      process.kill(report.runnerPid, 0)
    } catch (error) {
      if (error.code === 'ESRCH')
        throw new Error('Soak runner stopped without a terminal report', { cause: error })
      throw error
    }
    await sleep(30000)
  }
  if (!report.finishedAt || report.status === 'running') throw new Error('Soak watcher timeout')
  const passed = Boolean(
    report.status === 'completed' &&
    report.fullTwoHourScenario &&
    report.application?.packaged &&
    report.mainProcessExited &&
    report.sourceFilesUnchanged &&
    report.verifiedSourceFiles === 10000 &&
    report.sampleCoverage?.valid &&
    report.memory?.samples > 0 &&
    !report.memoryTrendReviewRequired &&
    report.errors?.length === 0 &&
    [30, 120].every((minutes) => report.checkpoints.some((c) => c.minutes === minutes)),
  )
  const result = {
    passed,
    status: report.status,
    evidence: path.relative(repo, file).replaceAll('\\', '/'),
    activeMinutes: report.activeElapsedMs / 60000,
    actions: report.actions,
    memory: report.memory,
    sampleCoverage: report.sampleCoverage,
    samplerError: report.samplerError,
    artifactSha256: report.artifact?.sha256,
    candidateLabel: report.validatedCandidate?.label,
    lateWorkingSetSlopeMiBPerMinute: report.lateWorkingSetSlopeMiBPerMinute,
    memoryTrendReviewRequired: Boolean(report.memoryTrendReviewRequired),
    mainProcessExited: report.mainProcessExited,
    errors: report.errors,
    error: report.error,
    shutdownRequested: false,
  }
  fs.writeFileSync(path.join(directory, 'acceptance.json'), JSON.stringify(result, null, 2) + '\n')
  const marker = `<!-- soak-result:${path.basename(directory)} -->`
  const note = `\n\n${marker}\n## Actual packaged continuous-use result\n\n${JSON.stringify(result, null, 2)}\n\n${passed ? 'Thirty-minute and two-hour generated-catalog navigation/thumbnail acceptance passed. This does not cover real-user media or model accuracy.' : 'Continuous-use acceptance did not pass; inspect the evidence. Do not mark the pending longevity items complete.'}\n`
  for (const name of ['PERFORMANCE_REPORT.md', 'PERFORMANCE_REGRESSION.md']) {
    const target = path.join(repo, name)
    if (!fs.readFileSync(target, 'utf8').includes(marker)) fs.appendFileSync(target, note)
  }
  if (passed) {
    const target = path.join(repo, 'PERFORMANCE_TODO.md')
    const original = fs.readFileSync(target, 'utf8')
    let updated = original.replace(
      '- [ ] Phase 7: actual 30-minute and two-hour packaged continuous-use acceptance pending. Short harness smoke passed and does not satisfy these durations.',
      '- [x] Phase 7: actual 30-minute and two-hour packaged generated-catalog continuous-use acceptance passed; see appended report and acceptance.json. Real-user/model workloads remain uncovered.',
    )
    if (
      report.validatedCandidate?.label === 'combined-four-variable-candidate' &&
      report.validatedCandidate.artifactSha256 === report.artifact.sha256 &&
      report.maintenanceSectionExercised
    ) {
      updated = updated.replace(
        '- [ ] Combined four-variable package: complete its own 30-minute/two-hour packaged coverage and exit verification.',
        '- [x] Combined four-variable package: its own 30-minute/two-hour packaged coverage and exit verification passed; see latest acceptance.json and artifact hash.',
      )
    }
    fs.writeFileSync(target, updated)
  }
  console.log(JSON.stringify(result))
  if (!passed) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
