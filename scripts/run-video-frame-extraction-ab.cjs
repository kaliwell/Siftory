const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { round, writeJson } = require('../tests/search-library-preparation-benchmark-utils.cjs')

const projectRoot = path.resolve(__dirname, '..')

function option(argv, name, fallback) {
  return argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
}

function parseArgs(argv) {
  return {
    runs: Math.max(3, Math.min(9, Number(option(argv, 'runs', '3')) || 3)),
    fixtureSeconds: Math.max(
      45,
      Math.min(300, Number(option(argv, 'fixture-seconds', '120')) || 120),
    ),
    width: Math.max(128, Math.min(640, Number(option(argv, 'width', '256')) || 256)),
    jsonOut: option(argv, 'json-out', ''),
    localOnly: argv.includes('--local-only'),
    help: argv.includes('--help') || argv.includes('-h'),
  }
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/run-video-frame-extraction-ab.cjs [options]

Options:
  --runs=<3..9>                Runs per mode (default: 3)
  --fixture-seconds=<45..300> CFR duration; VFR uses 75% (default: 120)
  --width=<128..640>           Output frame width (default: 256)
  --json-out=<file>            Override the full report path
  --local-only                 Skip the mounted-network comparison
`)
}

function timestampId() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}

function percentile(values, ratio) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]
}

function metric(values) {
  return {
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
  }
}

function improvementPercent(baseline, candidate) {
  return baseline > 0 ? round(((baseline - candidate) / baseline) * 100) : 0
}

function aggregateRuns(runs) {
  return {
    extractionMs: metric(runs.map((run) => run.extractionMs)),
    extractionProcessStarts: metric(runs.map((run) => run.extractionProcessStarts)),
    mainPeakRssMiB: metric(runs.map((run) => run.resources.memory.mainPeakRssMiB)),
    childPeakAggregateRssMiBApprox: metric(
      runs.map((run) => run.resources.memory.childPeakAggregateRssMiBApprox),
    ),
    childReadBytesApprox: metric(runs.map((run) => run.resources.io.childReadBytesApprox || 0)),
    childWriteBytesApprox: metric(runs.map((run) => run.resources.io.childWriteBytesApprox || 0)),
    peakActiveChildProcesses: metric(runs.map((run) => run.resources.processes.peakActive)),
    frames: runs[0].frames,
    digests: [...new Set(runs.map((run) => run.frames.digest))],
  }
}

function runOne({ scenario, mode, fixtureSeconds, width, outputPath }) {
  const args = [
    path.join('tests', 'video-frame-extraction-benchmark.cjs'),
    `--source-type=${scenario.sourceType}`,
    `--mode=${mode}`,
    `--fixture-seconds=${fixtureSeconds}`,
    `--width=${width}`,
    `--json-out=${outputPath}`,
  ]
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10 * 60_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      `Frame benchmark ${scenario.key}/${mode} failed: ${
        result.error?.message || result.stderr || result.stdout || `exit ${result.status}`
      }`,
    )
  }
  return JSON.parse(fs.readFileSync(outputPath, 'utf8'))
}

function validateScenario(scenario, runsByMode) {
  const allRuns = [...runsByMode[scenario.baseline], ...runsByMode[scenario.candidate]]
  assert.ok(allRuns.every((run) => run.ok))
  assert.ok(allRuns.every((run) => run.correctness.sourceUnchanged))
  assert.ok(allRuns.every((run) => run.correctness.privateFilesLeft === 0))
  assert.equal(new Set(allRuns.map((run) => run.frames.digest)).size, 1)
  assert.equal(new Set(allRuns.map((run) => run.frames.total)).size, 1)
  assert.equal(new Set(allRuns.map((run) => run.frames.completed)).size, 1)
  assert.equal(new Set(allRuns.map((run) => run.frames.failed)).size, 1)
  assert.equal(new Set(allRuns.map((run) => run.correctness.manifestRows)).size, 1)
  assert.ok(allRuns.every((run) => run.correctness.decodableJpegs === run.frames.completed))
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }

  const runId = timestampId()
  const artifactRoot = path.join(
    projectRoot,
    'artifacts',
    'benchmark',
    'video-frame-extraction',
    runId,
  )
  fs.mkdirSync(artifactRoot, { recursive: true })
  const scenarios = [
    {
      key: 'local',
      sourceType: 'local',
      baseline: 'legacy',
      candidate: 'single-input',
      requiredImprovementPercent: 20,
    },
    ...(!options.localOnly
      ? [
          {
            key: 'mountedNetwork',
            sourceType: 'mounted-network',
            baseline: 'multi-input',
            candidate: 'single-input',
            requiredImprovementPercent: 20,
          },
        ]
      : []),
  ]
  const raw = {}

  for (const scenario of scenarios) {
    raw[scenario.key] = { [scenario.baseline]: [], [scenario.candidate]: [] }
    for (let roundIndex = 0; roundIndex < options.runs; roundIndex++) {
      const modes =
        roundIndex % 2 === 0
          ? [scenario.baseline, scenario.candidate]
          : [scenario.candidate, scenario.baseline]
      for (const mode of modes) {
        const outputPath = path.join(
          artifactRoot,
          `${scenario.key}-${mode}-run-${roundIndex + 1}.json`,
        )
        const run = runOne({
          scenario,
          mode,
          fixtureSeconds: options.fixtureSeconds,
          width: options.width,
          outputPath,
        })
        raw[scenario.key][mode].push(run)
        process.stderr.write(
          `[frame-ab] ${scenario.key}/${mode} run ${roundIndex + 1}: ${run.extractionMs} ms, ${run.extractionProcessStarts} FFmpeg starts\n`,
        )
      }
    }
  }

  const summary = {}
  for (const scenario of scenarios) {
    const runsByMode = raw[scenario.key]
    validateScenario(scenario, runsByMode)
    const baseline = aggregateRuns(runsByMode[scenario.baseline])
    const candidate = aggregateRuns(runsByMode[scenario.candidate])
    const improvement = improvementPercent(baseline.extractionMs.p50, candidate.extractionMs.p50)
    // The 100 ms OS sampler can miss the legacy path's many very short FFmpeg
    // processes entirely. Treat a zero baseline child RSS as unavailable, not
    // as a literal zero-memory process. Peak active-process tracking is event
    // based, so combine it with main RSS and a conservative 512 MiB child cap.
    const baselineChildRss = baseline.childPeakAggregateRssMiBApprox.p50
    const childMemoryLimit = baselineChildRss > 0 ? baselineChildRss * 1.5 + 64 : 512
    const mainMemoryLimit = baseline.mainPeakRssMiB.p50 * 1.25 + 32
    const resourceGate =
      candidate.childPeakAggregateRssMiBApprox.p50 <= childMemoryLimit &&
      candidate.mainPeakRssMiB.p50 <= mainMemoryLimit &&
      candidate.peakActiveChildProcesses.p95 <= baseline.peakActiveChildProcesses.p95
    summary[scenario.key] = {
      baselineMode: scenario.baseline,
      candidateMode: scenario.candidate,
      baseline,
      candidate,
      extractionP50ImprovementPercent: improvement,
      requiredImprovementPercent: scenario.requiredImprovementPercent,
      correctnessGate: true,
      resourceGate,
      resourceGateLimits: {
        baselineChildRssSampleObserved: baselineChildRss > 0,
        childPeakAggregateRssMiBApproxP50Max: round(childMemoryLimit),
        mainPeakRssMiBP50Max: round(mainMemoryLimit),
        peakActiveChildProcessesP95Max: baseline.peakActiveChildProcesses.p95,
      },
      accepted: improvement >= scenario.requiredImprovementPercent && resourceGate,
    }
  }

  const local = summary.local
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    config: {
      runs: options.runs,
      fixtureSeconds: options.fixtureSeconds,
      vfrFixtureSeconds: Math.max(45, Math.floor(options.fixtureSeconds * 0.75)),
      width: options.width,
      fixedCorpus: ['CFR', 'VFR', 'damaged-truncated'],
    },
    summary,
    decision: {
      localDefault: local.accepted ? 'single-input' : 'legacy',
      mountedNetworkDefault:
        summary.mountedNetwork?.accepted === true ? 'single-input' : 'multi-input',
      localGatePassed: local.accepted,
      mountedNetworkCandidateDeferred: summary.mountedNetwork
        ? !summary.mountedNetwork.accepted
        : null,
    },
    ok: local.accepted,
    raw,
  }
  const reportPath = options.jsonOut
    ? path.resolve(options.jsonOut)
    : path.join(artifactRoot, 'report.json')
  writeJson(reportPath, report)
  writeJson(
    path.join(projectRoot, 'artifacts', 'benchmark', 'video-frame-extraction', 'latest.json'),
    report,
  )
  process.stdout.write(
    `${JSON.stringify({ reportPath, ...report.decision, ok: report.ok }, null, 2)}\n`,
  )
  if (!report.ok) process.exitCode = 2
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
}
