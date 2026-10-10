'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const SCHEMA_VERSION = 1
const projectRoot = path.resolve(__dirname, '..')
const DEFAULT_OUTPUT_DIR = path.join(projectRoot, 'artifacts', 'automation', 'health')
const MAX_STREAM_BYTES = 16 * 1024
const MAX_STREAM_LINES = 120
const MAX_ERROR_BYTES = 2 * 1024
const MAX_CAPTURE_BUFFER_BYTES = 2 * 1024 * 1024

const QUICK_STAGE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'toolchain',
    label: 'Toolchain prerequisites',
    category: 'development-quality',
    npmScript: 'toolchain:check',
    timeoutMs: 60_000,
  }),
  Object.freeze({
    id: 'architecture',
    label: 'Architecture boundaries',
    category: 'architecture',
    npmScript: 'test:architecture',
    timeoutMs: 120_000,
  }),
  Object.freeze({
    id: 'privacy',
    label: 'Privacy policy checks',
    category: 'security',
    npmScript: 'privacy:check',
    timeoutMs: 60_000,
  }),
  Object.freeze({
    id: 'documentation',
    label: 'Documentation consistency',
    category: 'development-quality',
    npmScript: 'docs:check',
    timeoutMs: 90_000,
  }),
  Object.freeze({
    id: 'licenses',
    label: 'License material consistency',
    category: 'security',
    npmScript: 'licenses:check',
    timeoutMs: 120_000,
  }),
])

const FULL_STAGE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'typecheck',
    label: 'TypeScript type checking',
    category: 'development-quality',
    npmScript: 'typecheck',
    timeoutMs: 180_000,
  }),
  Object.freeze({
    id: 'lint',
    label: 'Static lint checks',
    category: 'development-quality',
    npmScript: 'lint',
    timeoutMs: 180_000,
  }),
  Object.freeze({
    id: 'format',
    label: 'Formatting checks',
    category: 'development-quality',
    npmScript: 'format:check',
    timeoutMs: 120_000,
  }),
  Object.freeze({
    id: 'guards',
    label: 'Runtime guard tests',
    category: 'security',
    npmScript: 'test:guards',
    timeoutMs: 120_000,
  }),
  Object.freeze({
    id: 'ipc-validation',
    label: 'IPC validation tests',
    category: 'security',
    npmScript: 'test:ipc-validation',
    timeoutMs: 120_000,
  }),
  Object.freeze({
    id: 'ipc-registration',
    label: 'IPC registration tests',
    category: 'architecture',
    npmScript: 'test:ipc-registration',
    timeoutMs: 120_000,
  }),
  Object.freeze({
    id: 'preload-contract',
    label: 'Preload contract tests',
    category: 'security',
    npmScript: 'test:preload-contract',
    timeoutMs: 120_000,
  }),
  Object.freeze({
    id: 'safe-eval',
    label: 'Safe evaluation tests',
    category: 'security',
    npmScript: 'test:safe-eval',
    timeoutMs: 120_000,
  }),
  Object.freeze({
    id: 'qa-toolchain',
    label: 'QA toolchain tests',
    category: 'development-quality',
    npmScript: 'test:qa-toolchain',
    timeoutMs: 120_000,
  }),
  Object.freeze({
    id: 'i18n-static',
    label: 'Static localization checks',
    category: 'development-quality',
    npmScript: 'test:i18n-static',
    timeoutMs: 120_000,
  }),
])

function usage() {
  return [
    'Usage: node scripts/run-automation-health.cjs [options]',
    '',
    'Options:',
    '  --plan                 Print the selected plan without running it',
    '  --full                 Include the extended read-only checks',
    '  --output-dir=<path>    Directory for JSON and HTML reports',
    '  --json                 Print machine-readable output to stdout',
  ].join('\n')
}

function parseArgs(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv)) {
    throw new TypeError('argv must be an array')
  }

  const parsed = {
    plan: false,
    full: false,
    json: false,
    outputDir: null,
  }
  const seen = new Set()

  for (const arg of argv) {
    if (arg === '--plan' || arg === '--full' || arg === '--json') {
      const key = arg.slice(2)
      if (seen.has(key)) {
        throw new Error(`Duplicate option: ${arg}`)
      }
      seen.add(key)
      parsed[key] = true
      continue
    }

    if (typeof arg === 'string' && arg.startsWith('--output-dir=')) {
      if (seen.has('outputDir')) {
        throw new Error('Duplicate option: --output-dir')
      }
      const outputDir = arg.slice('--output-dir='.length).trim()
      if (!outputDir) {
        throw new Error('--output-dir requires a non-empty path')
      }
      if (outputDir.includes('\0')) {
        throw new Error('--output-dir cannot contain a null byte')
      }
      seen.add('outputDir')
      parsed.outputDir = outputDir
      continue
    }

    throw new Error(`Unknown option: ${String(arg)}`)
  }

  return parsed
}

function resolveNpmInvocation(options = {}) {
  const platform = options.platform || process.platform
  const env = options.env || process.env

  if (platform === 'win32') {
    return {
      executable: env.ComSpec || env.COMSPEC || 'cmd.exe',
      argsPrefix: ['/d', '/s', '/c', 'npm.cmd'],
      displayExecutable: 'npm.cmd',
    }
  }

  return {
    executable: 'npm',
    argsPrefix: [],
    displayExecutable: 'npm',
  }
}

function createPlan(options = {}) {
  const full = options.full === true
  const npm = resolveNpmInvocation(options)
  const definitions = full
    ? [...QUICK_STAGE_DEFINITIONS, ...FULL_STAGE_DEFINITIONS]
    : [...QUICK_STAGE_DEFINITIONS]

  return {
    schemaVersion: SCHEMA_VERSION,
    mode: full ? 'full' : 'quick',
    scope: {
      readOnlyChecks: true,
      network: false,
      install: false,
      delete: false,
    },
    limits: {
      maxStreamBytes: MAX_STREAM_BYTES,
      maxStreamLines: MAX_STREAM_LINES,
      maxCaptureBufferBytes: MAX_CAPTURE_BUFFER_BYTES,
    },
    stages: definitions.map((definition) => ({
      ...definition,
      readOnly: true,
      network: false,
      command: {
        executable: npm.executable,
        args: [...npm.argsPrefix, 'run', definition.npmScript],
        display: `${npm.displayExecutable} run ${definition.npmScript}`,
      },
    })),
  }
}

function lineCount(value) {
  if (!value) return 0
  return value.split('\n').length
}

function boundedTail(value, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_STREAM_BYTES
  const maxLines = options.maxLines ?? MAX_STREAM_LINES
  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative integer')
  }
  if (!Number.isInteger(maxLines) || maxLines < 0) {
    throw new RangeError('maxLines must be a non-negative integer')
  }

  const raw = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '')
  const normalized = raw.replace(/\r\n?/g, '\n')
  const originalBytes = Buffer.byteLength(normalized, 'utf8')
  const originalLines = lineCount(normalized)
  let text = normalized

  if (maxLines === 0) {
    text = ''
  } else {
    const lines = text.split('\n')
    if (lines.length > maxLines) {
      text = lines.slice(-maxLines).join('\n')
    }
  }

  let keptBuffer = Buffer.from(text, 'utf8')
  if (keptBuffer.length > maxBytes) {
    let start = keptBuffer.length - maxBytes
    while (start < keptBuffer.length && (keptBuffer[start] & 0xc0) === 0x80) {
      start += 1
    }
    text = keptBuffer.subarray(start).toString('utf8')
    keptBuffer = Buffer.from(text, 'utf8')
  }

  const keptBytes = keptBuffer.length
  const keptLines = lineCount(text)
  return {
    text,
    truncated: text !== normalized,
    originalBytes,
    originalLines,
    keptBytes,
    keptLines,
  }
}

function isoTime(milliseconds) {
  return new Date(milliseconds).toISOString()
}

function readClock(now) {
  const value = Number(now())
  if (!Number.isFinite(value)) {
    throw new TypeError('Clock must return a finite millisecond timestamp')
  }
  return value
}

function defaultRunCommand(command, args, options) {
  return spawnSync(command, args, options)
}

function normalizeProcessResult(rawResult, thrownError) {
  const raw = rawResult && typeof rawResult === 'object' ? rawResult : {}
  const error = thrownError || raw.error || null
  const errorCode = error && typeof error === 'object' ? error.code : null
  const timedOut = raw.timedOut === true || raw.status === 'timed_out' || errorCode === 'ETIMEDOUT'
  const numericExitCode = Number.isInteger(raw.exitCode)
    ? raw.exitCode
    : Number.isInteger(raw.status)
      ? raw.status
      : null

  let status
  let exitCode
  if (timedOut) {
    status = 'timed_out'
    exitCode = 124
  } else if (error) {
    status = 'spawn_error'
    exitCode = numericExitCode === 0 ? 1 : (numericExitCode ?? 1)
  } else if (numericExitCode === 0) {
    status = 'passed'
    exitCode = 0
  } else {
    status = 'failed'
    exitCode = numericExitCode ?? 1
  }

  const errorText = error instanceof Error ? error.stack || error.message : String(error || '')
  let stderr = raw.stderr ?? ''
  if (errorText && !String(stderr)) {
    stderr = errorText
  }

  return {
    status,
    exitCode,
    signal: raw.signal || null,
    stdout: raw.stdout ?? '',
    stderr,
    error: errorText,
  }
}

function run(plan, options = {}) {
  if (!plan || !Array.isArray(plan.stages)) {
    throw new TypeError('plan.stages must be an array')
  }

  const now = options.now || Date.now
  const runCommand = options.runCommand || defaultRunCommand
  const cwd = path.resolve(options.cwd || process.cwd())
  const startedMs = readClock(now)
  const stageResults = []
  const childEnv = {
    ...process.env,
    ...(options.env || {}),
    CI: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    NO_UPDATE_NOTIFIER: '1',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_offline: 'true',
    npm_config_update_notifier: 'false',
  }

  for (const stage of plan.stages) {
    if (!stage || !stage.command || !Array.isArray(stage.command.args)) {
      throw new TypeError('Every stage must have a command and argument array')
    }
    if (!Number.isInteger(stage.timeoutMs) || stage.timeoutMs <= 0) {
      throw new RangeError(`Stage ${String(stage.id)} must have a positive timeoutMs`)
    }

    const stageStartedMs = readClock(now)
    let rawResult = null
    let thrownError = null
    try {
      rawResult = runCommand(stage.command.executable, [...stage.command.args], {
        cwd,
        env: childEnv,
        encoding: 'utf8',
        stdio: 'pipe',
        shell: false,
        windowsHide: true,
        timeout: stage.timeoutMs,
        maxBuffer: MAX_CAPTURE_BUFFER_BYTES,
      })
    } catch (error) {
      thrownError = error
    }
    const stageFinishedMs = readClock(now)
    const normalized = normalizeProcessResult(rawResult, thrownError)
    const stdout = boundedTail(normalized.stdout)
    const stderr = boundedTail(normalized.stderr)
    const boundedError = boundedTail(normalized.error, {
      maxBytes: MAX_ERROR_BYTES,
      maxLines: 12,
    })
    const durationMs = Math.max(0, stageFinishedMs - stageStartedMs)

    stageResults.push({
      id: stage.id,
      label: stage.label,
      category: stage.category,
      npmScript: stage.npmScript || null,
      readOnly: stage.readOnly === true,
      timeoutMs: stage.timeoutMs,
      command: {
        executable: stage.command.executable,
        args: [...stage.command.args],
        display:
          stage.command.display || [stage.command.executable, ...stage.command.args].join(' '),
      },
      startedAt: isoTime(stageStartedMs),
      finishedAt: isoTime(stageFinishedMs),
      duration: durationMs,
      durationMs,
      status: normalized.status,
      exitCode: normalized.exitCode,
      signal: normalized.signal,
      stdout: stdout.text,
      stderr: stderr.text,
      error: boundedError.text || null,
      output: {
        stdout: {
          truncated: stdout.truncated,
          originalBytes: stdout.originalBytes,
          originalLines: stdout.originalLines,
          keptBytes: stdout.keptBytes,
          keptLines: stdout.keptLines,
        },
        stderr: {
          truncated: stderr.truncated,
          originalBytes: stderr.originalBytes,
          originalLines: stderr.originalLines,
          keptBytes: stderr.keptBytes,
          keptLines: stderr.keptLines,
        },
      },
    })
  }

  const finishedMs = readClock(now)
  const summary = {
    total: stageResults.length,
    passed: stageResults.filter((stage) => stage.status === 'passed').length,
    failed: stageResults.filter((stage) => stage.status === 'failed').length,
    timedOut: stageResults.filter((stage) => stage.status === 'timed_out').length,
    spawnErrors: stageResults.filter((stage) => stage.status === 'spawn_error').length,
  }
  const ok = summary.passed === summary.total

  return {
    schemaVersion: SCHEMA_VERSION,
    mode: plan.mode || 'custom',
    scope: plan.scope || null,
    limits: {
      maxStreamBytes: MAX_STREAM_BYTES,
      maxStreamLines: MAX_STREAM_LINES,
      maxCaptureBufferBytes: MAX_CAPTURE_BUFFER_BYTES,
    },
    cwd,
    startedAt: isoTime(startedMs),
    finishedAt: isoTime(finishedMs),
    durationMs: Math.max(0, finishedMs - startedMs),
    status: ok ? 'passed' : 'failed',
    ok,
    exitCode: ok ? 0 : 1,
    summary,
    stages: stageResults,
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderHtml(result) {
  const rows = result.stages
    .map(
      (stage) => `
        <tr>
          <td>${escapeHtml(stage.label || stage.id)}</td>
          <td>${escapeHtml(stage.category || '')}</td>
          <td><span class="status ${escapeHtml(stage.status)}">${escapeHtml(stage.status)}</span></td>
          <td>${escapeHtml(stage.exitCode)}</td>
          <td>${escapeHtml(stage.durationMs)} ms</td>
          <td><code>${escapeHtml(stage.command.display)}</code></td>
        </tr>
        <tr class="logs">
          <td colspan="6">
            <details>
              <summary>bounded output tail</summary>
              <h3>stdout</h3>
              <pre>${escapeHtml(stage.stdout || '(empty)')}</pre>
              <h3>stderr</h3>
              <pre>${escapeHtml(stage.stderr || '(empty)')}</pre>
            </details>
          </td>
        </tr>`,
    )
    .join('')

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>Automation health report</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 2rem auto; max-width: 1100px; padding: 0 1rem; }
    .summary { display: flex; flex-wrap: wrap; gap: .75rem; margin: 1rem 0; }
    .summary span { border: 1px solid #7776; border-radius: .4rem; padding: .45rem .7rem; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #7776; padding: .55rem; text-align: left; vertical-align: top; }
    .status.passed { color: #16833f; }
    .status.failed, .status.timed_out, .status.spawn_error { color: #c0392b; }
    .logs td { padding: 0 .55rem .55rem; }
    pre { border: 1px solid #7776; max-height: 20rem; overflow: auto; padding: .75rem; white-space: pre-wrap; }
    code { overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <h1>Automation health report</h1>
  <p>Mode: <strong>${escapeHtml(result.mode)}</strong> · Status: <strong>${escapeHtml(result.status)}</strong></p>
  <div class="summary">
    <span>Total ${escapeHtml(result.summary.total)}</span>
    <span>Passed ${escapeHtml(result.summary.passed)}</span>
    <span>Failed ${escapeHtml(result.summary.failed)}</span>
    <span>Timed out ${escapeHtml(result.summary.timedOut)}</span>
    <span>Spawn errors ${escapeHtml(result.summary.spawnErrors)}</span>
    <span>Duration ${escapeHtml(result.durationMs)} ms</span>
  </div>
  <p>Started ${escapeHtml(result.startedAt)} · Finished ${escapeHtml(result.finishedAt)}</p>
  <table>
    <thead><tr><th>Stage</th><th>Category</th><th>Status</th><th>Exit</th><th>Duration</th><th>Command</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>
`
}

function report(runResult, options = {}) {
  if (!runResult || !Array.isArray(runResult.stages)) {
    throw new TypeError('runResult.stages must be an array')
  }
  const outputDir = path.resolve(options.outputDir || DEFAULT_OUTPUT_DIR)
  const jsonPath = path.join(outputDir, 'automation-health.json')
  const htmlPath = path.join(outputDir, 'automation-health.html')
  const finalResult = {
    ...runResult,
    artifacts: {
      jsonPath,
      htmlPath,
    },
  }

  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(jsonPath, `${JSON.stringify(finalResult, null, 2)}\n`, 'utf8')
  fs.writeFileSync(htmlPath, renderHtml(finalResult), 'utf8')

  return {
    result: finalResult,
    outputDir,
    jsonPath,
    htmlPath,
  }
}

function renderPlanText(plan) {
  const lines = [
    `Automation health plan (${plan.mode})`,
    `Scope: read-only checks, offline, no install, no delete`,
  ]
  for (const stage of plan.stages) {
    lines.push(`- ${stage.id}: ${stage.command.display} (timeout ${stage.timeoutMs} ms)`)
  }
  return `${lines.join('\n')}\n`
}

function renderSummaryText(written) {
  const result = written.result
  const lines = [
    `Automation health: ${result.status} (${result.summary.passed}/${result.summary.total} passed, ${result.durationMs} ms)`,
  ]
  for (const stage of result.stages) {
    lines.push(`- ${stage.id}: ${stage.status} (exit ${stage.exitCode}, ${stage.durationMs} ms)`)
  }
  lines.push(`JSON: ${written.jsonPath}`)
  lines.push(`HTML: ${written.htmlPath}`)
  return `${lines.join('\n')}\n`
}

function main(argv = process.argv.slice(2), dependencies = {}) {
  const writeStdout = dependencies.writeStdout || ((value) => process.stdout.write(value))
  const writeStderr = dependencies.writeStderr || ((value) => process.stderr.write(value))
  let args

  try {
    args = parseArgs(argv)
  } catch (error) {
    writeStderr(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`)
    return 2
  }

  try {
    const plan = createPlan({
      full: args.full,
      platform: dependencies.platform,
      env: dependencies.env,
    })

    if (args.plan) {
      writeStdout(args.json ? `${JSON.stringify(plan, null, 2)}\n` : renderPlanText(plan))
      return 0
    }

    const runResult = run(plan, {
      cwd: dependencies.cwd,
      env: dependencies.env,
      now: dependencies.now,
      runCommand: dependencies.runCommand,
    })
    const written = report(runResult, {
      outputDir: args.outputDir || dependencies.outputDir || DEFAULT_OUTPUT_DIR,
    })
    writeStdout(
      args.json ? `${JSON.stringify(written.result, null, 2)}\n` : renderSummaryText(written),
    )
    return runResult.exitCode
  } catch (error) {
    writeStderr(
      `Automation health failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`,
    )
    return 2
  }
}

if (require.main === module) {
  process.exitCode = main()
}

module.exports = {
  DEFAULT_OUTPUT_DIR,
  MAX_CAPTURE_BUFFER_BYTES,
  MAX_STREAM_BYTES,
  MAX_STREAM_LINES,
  boundedTail,
  createPlan,
  escapeHtml,
  main,
  parseArgs,
  renderHtml,
  report,
  resolveNpmInvocation,
  run,
  usage,
}
