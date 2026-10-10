'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  DEFAULT_OUTPUT_DIR,
  MAX_STREAM_BYTES,
  MAX_STREAM_LINES,
  boundedTail,
  createPlan,
  main,
  parseArgs,
  report,
  resolveNpmInvocation,
  run,
} = require('../scripts/run-automation-health.cjs')

const projectRoot = path.resolve(__dirname, '..')

function makeStage(id, timeoutMs = 1000) {
  return {
    id,
    label: `Stage ${id}`,
    category: 'test',
    readOnly: true,
    timeoutMs,
    command: {
      executable: 'node',
      args: ['--version'],
      display: 'node --version',
    },
  }
}

function tickingClock(start = Date.UTC(2026, 7, 24), increment = 5) {
  let current = start
  return () => {
    const value = current
    current += increment
    return value
  }
}

test('parseArgs supports quick defaults and all documented flags', () => {
  assert.deepEqual(parseArgs([]), {
    plan: false,
    full: false,
    json: false,
    outputDir: null,
  })
  assert.deepEqual(parseArgs(['--plan', '--full', '--json', '--output-dir=health output']), {
    plan: true,
    full: true,
    json: true,
    outputDir: 'health output',
  })
  assert.throws(() => parseArgs(['--wat']), /Unknown option/)
  assert.throws(() => parseArgs(['--output-dir=']), /non-empty path/)
  assert.throws(() => parseArgs(['--json', '--json']), /Duplicate option/)
  assert.throws(() => parseArgs(['--output-dir=one', '--output-dir=two']), /Duplicate option/)
})

test('default reports stay inside the repository automation health root', () => {
  assert.equal(DEFAULT_OUTPUT_DIR, path.join(projectRoot, 'artifacts', 'automation', 'health'))
})

test('createPlan exposes a fixed offline and read-only quick plan plus a safe full superset', () => {
  const quick = createPlan({ platform: 'linux' })
  const full = createPlan({ full: true, platform: 'linux' })

  assert.equal(quick.mode, 'quick')
  assert.equal(full.mode, 'full')
  assert.deepEqual(
    quick.stages.map((stage) => stage.id),
    ['toolchain', 'architecture', 'privacy', 'documentation', 'licenses'],
  )
  assert.deepEqual(
    full.stages.slice(0, quick.stages.length).map((stage) => stage.id),
    quick.stages.map((stage) => stage.id),
  )
  assert.ok(full.stages.length > quick.stages.length)

  const forbiddenScripts = /(^|:)(install|fetch|build|audit|cleanup|release)(:|$)/i
  for (const stage of full.stages) {
    assert.equal(stage.readOnly, true)
    assert.equal(stage.network, false)
    assert.ok(Number.isInteger(stage.timeoutMs) && stage.timeoutMs > 0)
    assert.doesNotMatch(stage.npmScript, forbiddenScripts)
    assert.equal(stage.command.executable, 'npm')
    assert.deepEqual(stage.command.args, ['run', stage.npmScript])
  }
})

test('resolveNpmInvocation uses the Windows command processor for npm.cmd compatibility', () => {
  const invocation = resolveNpmInvocation({
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
  })

  assert.equal(invocation.executable, 'C:\\Windows\\System32\\cmd.exe')
  assert.deepEqual(invocation.argsPrefix, ['/d', '/s', '/c', 'npm.cmd'])
  assert.equal(invocation.displayExecutable, 'npm.cmd')

  const plan = createPlan({
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
  })
  assert.deepEqual(plan.stages[0].command.args.slice(0, 4), ['/d', '/s', '/c', 'npm.cmd'])
  assert.match(plan.stages[0].command.display, /^npm\.cmd run /)
})

test('boundedTail retains only the bounded UTF-8 tail and reports truncation', () => {
  const source = Array.from({ length: MAX_STREAM_LINES + 40 }, (_, index) => {
    return `${String(index).padStart(4, '0')}:${'像'.repeat(200)}`
  }).join('\r\n')
  const tail = boundedTail(source)

  assert.equal(tail.truncated, true)
  assert.ok(tail.keptBytes <= MAX_STREAM_BYTES)
  assert.ok(tail.keptLines <= MAX_STREAM_LINES)
  assert.equal(Buffer.byteLength(tail.text, 'utf8'), tail.keptBytes)
  assert.match(tail.text, /0159:/)
  assert.doesNotMatch(tail.text, /0000:/)

  assert.deepEqual(boundedTail('ok', { maxBytes: 10, maxLines: 2 }), {
    text: 'ok',
    truncated: false,
    originalBytes: 2,
    originalLines: 1,
    keptBytes: 2,
    keptLines: 1,
  })
})

test('run continues after failures and records bounded output and timings for every stage', () => {
  const plan = {
    mode: 'custom',
    scope: { readOnlyChecks: true },
    stages: [makeStage('pass'), makeStage('fail'), makeStage('timeout')],
  }
  const calls = []
  const hugeOutput = Array.from(
    { length: 300 },
    (_, index) => `line-${index}-${'x'.repeat(200)}`,
  ).join('\n')
  const results = [
    { status: 0, stdout: hugeOutput, stderr: '' },
    { status: 7, stdout: 'partial', stderr: 'assertion failed' },
    {
      status: null,
      stdout: '',
      stderr: 'timed out',
      error: Object.assign(new Error('deadline'), { code: 'ETIMEDOUT' }),
    },
  ]

  const result = run(plan, {
    cwd: process.cwd(),
    now: tickingClock(),
    runCommand(command, args, options) {
      calls.push({ command, args, options })
      return results[calls.length - 1]
    },
  })

  assert.equal(calls.length, 3)
  assert.deepEqual(
    result.stages.map((stage) => stage.status),
    ['passed', 'failed', 'timed_out'],
  )
  assert.deepEqual(
    result.stages.map((stage) => stage.exitCode),
    [0, 7, 124],
  )
  assert.equal(result.ok, false)
  assert.equal(result.status, 'failed')
  assert.equal(result.exitCode, 1)
  assert.deepEqual(result.summary, {
    total: 3,
    passed: 1,
    failed: 1,
    timedOut: 1,
    spawnErrors: 0,
  })
  for (const stage of result.stages) {
    assert.match(stage.startedAt, /^2026-08-24T/)
    assert.equal(stage.duration, 5)
    assert.equal(stage.durationMs, 5)
    assert.ok(stage.output.stdout.keptBytes <= MAX_STREAM_BYTES)
    assert.ok(stage.output.stdout.keptLines <= MAX_STREAM_LINES)
    assert.ok(stage.output.stderr.keptBytes <= MAX_STREAM_BYTES)
    assert.ok(stage.output.stderr.keptLines <= MAX_STREAM_LINES)
    assert.equal(calls[result.stages.indexOf(stage)].options.shell, false)
    assert.equal(calls[result.stages.indexOf(stage)].options.env.npm_config_offline, 'true')
  }
  assert.equal(result.stages[0].output.stdout.truncated, true)
})

test('report writes parseable JSON and a concise escaped HTML report', (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-health-report-'))
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }))
  const result = run(
    {
      mode: 'quick',
      stages: [
        {
          ...makeStage('html'),
          label: '<script>alert(1)</script>',
        },
      ],
    },
    {
      now: tickingClock(),
      runCommand: () => ({ status: 1, stdout: '<b>unsafe</b>', stderr: 'bad & worse' }),
    },
  )

  const written = report(result, { outputDir })
  const json = JSON.parse(fs.readFileSync(written.jsonPath, 'utf8'))
  const html = fs.readFileSync(written.htmlPath, 'utf8')

  assert.equal(json.status, 'failed')
  assert.equal(json.artifacts.jsonPath, written.jsonPath)
  assert.equal(json.artifacts.htmlPath, written.htmlPath)
  assert.match(html, /Automation health report/)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(html, /&lt;b&gt;unsafe&lt;\/b&gt;/)
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/)
})

test('main plan mode performs no work and normal JSON mode reports all failures', (t) => {
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-health-main-'))
  t.after(() => fs.rmSync(parentDir, { recursive: true, force: true }))
  const planOutputDir = path.join(parentDir, 'plan-must-not-exist')
  let planStdout = ''
  let runnerCalls = 0

  const planExitCode = main(['--plan', '--json', `--output-dir=${planOutputDir}`], {
    platform: 'linux',
    runCommand: () => {
      runnerCalls += 1
      return { status: 0 }
    },
    writeStdout: (value) => {
      planStdout += value
    },
  })

  assert.equal(planExitCode, 0)
  assert.equal(runnerCalls, 0)
  assert.equal(fs.existsSync(planOutputDir), false)
  assert.equal(JSON.parse(planStdout).mode, 'quick')

  const reportDir = path.join(parentDir, 'report')
  let jsonStdout = ''
  const normalExitCode = main(['--json', `--output-dir=${reportDir}`], {
    platform: 'linux',
    now: tickingClock(),
    runCommand: () => {
      runnerCalls += 1
      return runnerCalls === 1 ? { status: 2, stderr: 'failed first' } : { status: 0 }
    },
    writeStdout: (value) => {
      jsonStdout += value
    },
  })

  const parsed = JSON.parse(jsonStdout)
  assert.equal(normalExitCode, 1)
  assert.equal(runnerCalls, createPlan({ platform: 'linux' }).stages.length)
  assert.equal(parsed.status, 'failed')
  assert.equal(parsed.stages.length, 5)
  assert.equal(fs.existsSync(parsed.artifacts.jsonPath), true)
  assert.equal(fs.existsSync(parsed.artifacts.htmlPath), true)
})
