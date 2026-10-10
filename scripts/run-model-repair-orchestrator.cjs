#!/usr/bin/env node
'use strict'

const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const REPO_ROOT = path.resolve(__dirname, '..')
const REPORT_SCHEMA_VERSION = 1
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024
const RETAINED_OUTPUT_BYTES = 64 * 1024

const REPAIR_DEFINITIONS = Object.freeze({
  'local-user-models': Object.freeze({
    installer: 'install-local-user-models.cjs',
    consentFlag: '--accept-local-user-models',
    description: 'Install the six manifest-pinned local user-model candidates.',
  }),
  'ollama-video-model': Object.freeze({
    installer: 'install-video-semantic-ollama-model.cjs',
    consentFlag: '--accept-external-model',
    description: 'Ask an existing Ollama installation to pull the pinned video model.',
  }),
  'cuda-runtime': Object.freeze({
    installer: 'install-cuda-runtime.cjs',
    consentFlag: '--accept-nvidia-license',
    description: 'Install the fixed CUDA runtime components into an explicit app-data root.',
  }),
  'llama-video-runtime': Object.freeze({
    installer: 'install-video-semantic-llama-runtime.cjs',
    consentFlag: '--accept-local-evaluation',
    description: 'Install the pinned Vulkan llama.cpp runtime and local-evaluation model.',
  }),
})

const ALLOWED_REPAIR_IDS = Object.freeze(Object.keys(REPAIR_DEFINITIONS))

function usage() {
  return [
    'Usage:',
    '  node scripts/run-model-repair-orchestrator.cjs [--quick|--full] [--json]',
    '  node scripts/run-model-repair-orchestrator.cjs --plan [--full] [--json]',
    '  node scripts/run-model-repair-orchestrator.cjs --execute --repair=<id> --allow-download [consent]',
    '',
    'Safe defaults:',
    '  Without --execute, only read-only verification and planning are performed.',
    '  --plan lists checks and repairs without starting any child process.',
    '  No installer is started unless --execute, --allow-download, an allowed repair id,',
    "  and that installer's existing explicit consent flag are all supplied.",
    '',
    `Allowed repair ids: ${ALLOWED_REPAIR_IDS.join(', ')}`,
    '',
    'Output:',
    '  --json                    Keep stdout as one JSON report; stage JSONL goes to stderr.',
    '  --output=<file>           Atomically write the final JSON report.',
    '',
    'Shared paths:',
    '  --user-data=<dir>         User data for local user-model verification/installation.',
    '  --target-dir=<dir>        CUDA app-data root (defaults to the stable app-data root).',
    '  --cache-dir=<dir>         Required when executing the CUDA repair.',
    '  --ollama=<file>           Explicit Ollama executable.',
    '  --runtime-root=<dir>      Override llama.cpp health inspection root.',
    '  --media-root=<dir>        Override llama.cpp health evidence root.',
    '  --llama-cache-root=<dir>  Override llama.cpp cache inspection root.',
    '',
    'Existing installer consent/options (never implied):',
    '  --accept-local-user-models [--replace-existing]',
    '  --accept-external-model',
    '  --accept-nvidia-license [--worker-path=<file>] [--provider-gates=<file>]',
    '  --accept-local-evaluation --variant=vulkan',
  ].join('\n')
}

function readOptionValue(argv, index, name) {
  const argument = argv[index]
  const prefix = `--${name}=`
  if (argument.startsWith(prefix)) return { value: argument.slice(prefix.length), consumed: 0 }
  if (argument === `--${name}`) {
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`)
    return { value, consumed: 1 }
  }
  return null
}

function parseArgs(argv, environment = process.env, cwd = process.cwd()) {
  const options = {
    plan: false,
    execute: false,
    scope: 'quick',
    json: false,
    output: '',
    repairs: [],
    allowDownload: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    userDataPath: '',
    targetDir: '',
    cacheDir: '',
    ollamaPath: '',
    runtimeRoot: '',
    mediaRoot: '',
    llamaCacheRoot: '',
    workerPath: '',
    providerGatesPath: '',
    variant: '',
    replaceExisting: false,
    consents: {
      localUserModels: false,
      externalModel: false,
      nvidiaLicense: false,
      localEvaluation: false,
    },
    help: false,
  }

  const valueOptions = new Map([
    ['repair', 'repairs'],
    ['output', 'output'],
    ['user-data', 'userDataPath'],
    ['target-dir', 'targetDir'],
    ['cache-dir', 'cacheDir'],
    ['ollama', 'ollamaPath'],
    ['runtime-root', 'runtimeRoot'],
    ['media-root', 'mediaRoot'],
    ['llama-cache-root', 'llamaCacheRoot'],
    ['worker-path', 'workerPath'],
    ['provider-gates', 'providerGatesPath'],
    ['variant', 'variant'],
    ['timeout-ms', 'timeoutMs'],
  ])

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--plan') options.plan = true
    else if (argument === '--execute') options.execute = true
    else if (argument === '--quick') options.scope = 'quick'
    else if (argument === '--full') options.scope = 'full'
    else if (argument === '--json') options.json = true
    else if (argument === '--allow-download') options.allowDownload = true
    else if (argument === '--replace-existing') options.replaceExisting = true
    else if (argument === '--accept-local-user-models') options.consents.localUserModels = true
    else if (argument === '--accept-external-model') options.consents.externalModel = true
    else if (argument === '--accept-nvidia-license') options.consents.nvidiaLicense = true
    else if (argument === '--accept-local-evaluation') options.consents.localEvaluation = true
    else if (argument === '--help' || argument === '-h') options.help = true
    else {
      let matched = false
      for (const [cliName, property] of valueOptions) {
        const parsed = readOptionValue(argv, index, cliName)
        if (!parsed) continue
        matched = true
        index += parsed.consumed
        if (property === 'repairs') options.repairs.push(parsed.value)
        else if (property === 'timeoutMs') options.timeoutMs = Number(parsed.value)
        else options[property] = parsed.value
        break
      }
      if (!matched) throw new Error(`Unknown argument: ${argument}`)
    }
  }

  options.repairs = [...new Set(options.repairs)]
  for (const repairId of options.repairs) {
    if (!ALLOWED_REPAIR_IDS.includes(repairId)) {
      throw new Error(`Unsupported repair id: ${repairId}`)
    }
  }
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 10_000 ||
    options.timeoutMs > 1_800_000
  ) {
    throw new Error('--timeout-ms must be an integer from 10000 to 1800000')
  }
  if (options.plan && options.execute) throw new Error('--plan cannot be combined with --execute')
  if (options.execute && options.repairs.length === 0) {
    throw new Error('--execute requires at least one --repair=<allowed id>')
  }
  if (options.execute && !options.allowDownload) {
    throw new Error('--execute requires explicit --allow-download')
  }

  const stableAppDataRoot = path.resolve(
    environment.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'floating-clock-electron',
  )
  options.targetDir = path.resolve(options.targetDir || stableAppDataRoot)
  for (const property of [
    'output',
    'userDataPath',
    'cacheDir',
    'ollamaPath',
    'runtimeRoot',
    'mediaRoot',
    'llamaCacheRoot',
    'workerPath',
    'providerGatesPath',
  ]) {
    if (options[property]) options[property] = path.resolve(cwd, options[property])
  }
  return options
}

function consentProvided(options, repairId) {
  if (repairId === 'local-user-models') return options.consents.localUserModels
  if (repairId === 'ollama-video-model') return options.consents.externalModel
  if (repairId === 'cuda-runtime') return options.consents.nvidiaLicense
  if (repairId === 'llama-video-runtime') return options.consents.localEvaluation
  return false
}

function validateRepairRequest(options, repairId) {
  const definition = REPAIR_DEFINITIONS[repairId]
  if (!definition) return [`Unsupported repair id: ${repairId}`]
  const errors = []
  if (!options.execute) errors.push('installer execution requires --execute')
  if (!options.allowDownload) errors.push('installer execution requires --allow-download')
  if (!consentProvided(options, repairId)) {
    errors.push(`${repairId} requires caller-provided ${definition.consentFlag}`)
  }
  if (repairId === 'cuda-runtime' && !options.cacheDir) {
    errors.push('cuda-runtime requires an explicit --cache-dir')
  }
  if (repairId === 'llama-video-runtime' && options.variant !== 'vulkan') {
    errors.push('llama-video-runtime requires caller-provided --variant=vulkan')
  }
  return errors
}

function validateExecutionRequest(options) {
  if (!options.execute) return []
  return options.repairs.flatMap((repairId) => validateRepairRequest(options, repairId))
}

function scriptCommand(scriptName, args = []) {
  return {
    executable: process.execPath,
    args: [path.join(REPO_ROOT, 'scripts', scriptName), ...args],
    cwd: REPO_ROOT,
  }
}

function createDetectionStages(options) {
  const localArgs = ['--verify-only']
  if (options.userDataPath) localArgs.push(`--user-data=${options.userDataPath}`)
  const videoArgs = ['--verify-only']
  if (options.ollamaPath) videoArgs.push(`--ollama=${options.ollamaPath}`)
  const stages = [
    {
      id: 'models:local:verify',
      kind: 'verification',
      readOnly: true,
      command: scriptCommand('install-local-user-models.cjs', localArgs),
      suggestedRepairId: 'local-user-models',
    },
    {
      id: 'models:video:verify',
      kind: 'verification',
      readOnly: true,
      command: scriptCommand('install-video-semantic-ollama-model.cjs', videoArgs),
      suggestedRepairId: 'ollama-video-model',
    },
    {
      id: 'cuda-runtime:verify',
      kind: 'verification',
      readOnly: true,
      command: scriptCommand('install-cuda-runtime.cjs', [
        '--verify-only',
        `--target-dir=${options.targetDir}`,
      ]),
      suggestedRepairId: 'cuda-runtime',
    },
    {
      id: 'video-semantic:llama-preflight',
      kind: 'preflight',
      readOnly: true,
      command: scriptCommand('run-video-semantic-llama-preflight.cjs'),
      suggestedRepairId: 'llama-video-runtime',
    },
  ]
  if (options.scope === 'full') {
    stages.push({
      id: 'video-semantic:llama-health',
      kind: 'health-helper',
      readOnly: true,
      suggestedRepairId: 'llama-video-runtime',
    })
  }
  return stages
}

function buildRepairCommand(repairId, options) {
  const errors = validateRepairRequest(options, repairId)
  if (errors.length > 0) throw new Error(errors.join('; '))
  if (repairId === 'local-user-models') {
    const args = ['--accept-local-user-models']
    if (options.replaceExisting) args.push('--replace-existing')
    if (options.userDataPath) args.push(`--user-data=${options.userDataPath}`)
    return scriptCommand(REPAIR_DEFINITIONS[repairId].installer, args)
  }
  if (repairId === 'ollama-video-model') {
    const args = ['--accept-external-model']
    if (options.ollamaPath) args.push(`--ollama=${options.ollamaPath}`)
    return scriptCommand(REPAIR_DEFINITIONS[repairId].installer, args)
  }
  if (repairId === 'cuda-runtime') {
    const args = [
      `--target-dir=${options.targetDir}`,
      `--cache-dir=${options.cacheDir}`,
      '--accept-nvidia-license',
    ]
    if (options.workerPath) args.push(`--worker-path=${options.workerPath}`)
    if (options.providerGatesPath) args.push(`--provider-gates=${options.providerGatesPath}`)
    return scriptCommand(REPAIR_DEFINITIONS[repairId].installer, args)
  }
  if (repairId === 'llama-video-runtime') {
    return scriptCommand(REPAIR_DEFINITIONS[repairId].installer, [
      `--variant=${options.variant}`,
      '--accept-local-evaluation',
    ])
  }
  throw new Error(`Unsupported repair id: ${repairId}`)
}

function publicCommand(command) {
  if (!command) return undefined
  return {
    executable: path.basename(command.executable),
    script: path.basename(command.args[0] || ''),
    args: command.args.slice(1).map((argument) => {
      const separator = argument.indexOf('=')
      if (separator < 0) return argument
      const key = argument.slice(0, separator)
      if (!/(path|dir|root|ollama|user-data|worker|provider|output|cache)/i.test(key)) {
        return argument
      }
      return `${key}=<caller-path>`
    }),
  }
}

function buildRepairPlan(options) {
  return ALLOWED_REPAIR_IDS.map((id) => {
    const definition = REPAIR_DEFINITIONS[id]
    const errors = validateRepairRequest(options, id)
    return {
      id,
      requested: options.repairs.includes(id),
      eligible: options.execute && errors.length === 0,
      installer: definition.installer,
      description: definition.description,
      requirements: {
        execute: true,
        allowDownload: true,
        consentFlag: definition.consentFlag,
        ...(id === 'cuda-runtime' ? { explicitCacheDir: true } : {}),
        ...(id === 'llama-video-runtime' ? { variant: 'vulkan' } : {}),
      },
      missing: errors,
    }
  })
}

function createBoundedTextCollector(
  retainedBytes = RETAINED_OUTPUT_BYTES,
  hardLimitBytes = DEFAULT_OUTPUT_LIMIT_BYTES,
) {
  let totalBytes = 0
  let tail = Buffer.alloc(0)
  let exceeded = false
  return {
    append(value) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value))
      totalBytes += chunk.length
      if (totalBytes > hardLimitBytes) exceeded = true
      tail = Buffer.concat([tail, chunk])
      if (tail.length > retainedBytes) tail = tail.subarray(tail.length - retainedBytes)
      return !exceeded
    },
    snapshot() {
      return {
        text: tail.toString('utf8'),
        totalBytes,
        truncated: totalBytes > tail.length,
        hardLimitExceeded: exceeded,
      }
    },
  }
}

function boundedMessage(value, maxLength = 4096) {
  const text = value instanceof Error ? value.message : String(value || '')
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`
}

function runBoundedCommand(command, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes || DEFAULT_OUTPUT_LIMIT_BYTES
  return new Promise((resolve) => {
    const stdout = createBoundedTextCollector(RETAINED_OUTPUT_BYTES, maxOutputBytes)
    const stderr = createBoundedTextCollector(RETAINED_OUTPUT_BYTES, maxOutputBytes)
    let finished = false
    let timedOut = false
    let outputLimitExceeded = false
    let child

    const finish = (result) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve({
        ...result,
        stdout: stdout.snapshot(),
        stderr: stderr.snapshot(),
        timedOut,
        outputLimitExceeded,
      })
    }

    try {
      child = spawn(command.executable, command.args, {
        cwd: command.cwd,
        env: { ...process.env },
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({
        exitCode: null,
        signal: null,
        error: boundedMessage(error),
        stdout: stdout.snapshot(),
        stderr: stderr.snapshot(),
        timedOut: false,
        outputLimitExceeded: false,
      })
      return
    }

    const stopForOutput = () => {
      if (outputLimitExceeded) return
      outputLimitExceeded = true
      child.kill()
    }
    child.stdout.on('data', (chunk) => {
      if (!stdout.append(chunk)) stopForOutput()
    })
    child.stderr.on('data', (chunk) => {
      if (!stderr.append(chunk)) stopForOutput()
    })
    child.once('error', (error) => {
      finish({ exitCode: null, signal: null, error: boundedMessage(error) })
    })
    child.once('close', (exitCode, signal) => {
      finish({ exitCode, signal, error: undefined })
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
  })
}

function parseStagePayload(stageId, stdout) {
  const text = String(stdout || '').trim()
  const marker =
    stageId === 'models:local:verify'
      ? 'MODEL_INSTALL_RESULT '
      : stageId === 'models:video:verify'
        ? 'OLLAMA_MODEL_INSTALL_RESULT '
        : ''
  if (marker) {
    const line = text
      .split(/\r?\n/)
      .reverse()
      .find((candidate) => candidate.startsWith(marker))
    if (line) {
      try {
        return JSON.parse(line.slice(marker.length))
      } catch {
        return undefined
      }
    }
  }
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function createStageLogger(stream, clock = () => new Date().toISOString()) {
  return (event) => {
    stream.write(
      `${JSON.stringify({ schemaVersion: 1, kind: 'model-repair-stage', at: clock(), ...event })}\n`,
    )
  }
}

async function runCommandStage(stage, options, dependencies) {
  const startedAt = dependencies.now()
  dependencies.log({ event: 'start', stageId: stage.id, stageKind: stage.kind })
  let execution
  try {
    execution = await dependencies.runCommand(stage.command, {
      timeoutMs: options.timeoutMs,
      maxOutputBytes: DEFAULT_OUTPUT_LIMIT_BYTES,
    })
  } catch (error) {
    execution = {
      exitCode: null,
      error: boundedMessage(error),
      stdout: { text: '', totalBytes: 0, truncated: false, hardLimitExceeded: false },
      stderr: { text: '', totalBytes: 0, truncated: false, hardLimitExceeded: false },
      timedOut: false,
      outputLimitExceeded: false,
    }
  }
  const durationMs = Math.max(0, dependencies.now() - startedAt)
  const ok = execution.exitCode === 0 && !execution.timedOut && !execution.outputLimitExceeded
  const result = {
    id: stage.id,
    kind: stage.kind,
    status: ok ? 'passed' : 'failed',
    readOnly: stage.readOnly,
    durationMs,
    command: publicCommand(stage.command),
    exitCode: execution.exitCode,
    timedOut: execution.timedOut === true,
    outputLimitExceeded: execution.outputLimitExceeded === true,
    stdout: execution.stdout,
    stderr: execution.stderr,
    payload: parseStagePayload(stage.id, execution.stdout?.text),
    ...(ok
      ? {}
      : {
          error: boundedMessage(
            execution.error ||
              execution.stderr?.text ||
              `Stage exited with ${execution.exitCode ?? 'no exit code'}`,
          ),
          suggestedRepairId: stage.suggestedRepairId,
        }),
  }
  dependencies.log({
    event: 'finish',
    stageId: stage.id,
    status: result.status,
    durationMs,
    exitCode: result.exitCode,
  })
  return result
}

async function runHealthStage(stage, options, dependencies) {
  const startedAt = dependencies.now()
  dependencies.log({ event: 'start', stageId: stage.id, stageKind: stage.kind })
  try {
    const payload = await dependencies.runHealth({
      ...(options.runtimeRoot ? { runtimeRoot: options.runtimeRoot } : {}),
      ...(options.mediaRoot ? { mediaRoot: options.mediaRoot } : {}),
      ...(options.llamaCacheRoot ? { cacheRoot: options.llamaCacheRoot } : {}),
    })
    const durationMs = Math.max(0, dependencies.now() - startedAt)
    const result = {
      id: stage.id,
      kind: stage.kind,
      status: payload?.healthy === true ? 'passed' : 'failed',
      readOnly: true,
      durationMs,
      payload,
      ...(payload?.healthy === true
        ? {}
        : {
            error: 'llama.cpp health evidence is incomplete or unhealthy',
            suggestedRepairId: stage.suggestedRepairId,
          }),
    }
    dependencies.log({ event: 'finish', stageId: stage.id, status: result.status, durationMs })
    return result
  } catch (error) {
    const durationMs = Math.max(0, dependencies.now() - startedAt)
    const result = {
      id: stage.id,
      kind: stage.kind,
      status: 'failed',
      readOnly: true,
      durationMs,
      error: boundedMessage(error),
      suggestedRepairId: stage.suggestedRepairId,
    }
    dependencies.log({ event: 'finish', stageId: stage.id, status: 'failed', durationMs })
    return result
  }
}

function defaultHealthRunner(options) {
  const { buildHealthReport } = require('./report-video-semantic-llama-health.cjs')
  return buildHealthReport(options)
}

function reportSummary(stages, repairPlan) {
  return {
    stages: stages.length,
    passed: stages.filter((stage) => stage.status === 'passed').length,
    failed: stages.filter((stage) => stage.status === 'failed').length,
    skipped: stages.filter((stage) => stage.status === 'skipped').length,
    requestedRepairs: repairPlan.filter((repair) => repair.requested).map((repair) => repair.id),
    executableRepairs: repairPlan.filter((repair) => repair.eligible).map((repair) => repair.id),
  }
}

async function orchestrate(options, overrides = {}) {
  const dependencies = {
    now: overrides.now || (() => Date.now()),
    log: overrides.log || (() => undefined),
    runCommand: overrides.runCommand || runBoundedCommand,
    runHealth: overrides.runHealth || defaultHealthRunner,
  }
  const executionErrors = validateExecutionRequest(options)
  if (executionErrors.length > 0) throw new Error(executionErrors.join('; '))

  const startedAtMs = dependencies.now()
  const stages = []
  const detectionStages = createDetectionStages(options)
  const initialPlan = buildRepairPlan(options)

  if (!options.plan) {
    for (const stage of detectionStages) {
      stages.push(
        stage.kind === 'health-helper'
          ? await runHealthStage(stage, options, dependencies)
          : await runCommandStage(stage, options, dependencies),
      )
    }
  }

  if (options.execute) {
    for (const repairId of options.repairs) {
      const stage = {
        id: `repair:${repairId}`,
        kind: 'repair',
        readOnly: false,
        command: buildRepairCommand(repairId, options),
        suggestedRepairId: repairId,
      }
      stages.push(await runCommandStage(stage, options, dependencies))
    }
  }

  const repairPlan = initialPlan.map((repair) => ({
    ...repair,
    recommended:
      repair.requested ||
      stages.some((stage) => stage.status === 'failed' && stage.suggestedRepairId === repair.id),
  }))
  const summary = reportSummary(stages, repairPlan)
  const mode = options.plan ? 'plan' : options.execute ? 'execute' : 'check'
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: 'model-repair-orchestrator',
    mode,
    scope: options.scope,
    safety: {
      readOnly: !options.execute,
      childProcessesStarted: !options.plan,
      externalNetworkAllowed: options.execute && options.allowDownload,
      licenseAcceptanceInjected: false,
    },
    checks: detectionStages.map((stage) => ({
      id: stage.id,
      kind: stage.kind,
      readOnly: stage.readOnly,
      command: publicCommand(stage.command),
    })),
    stages,
    repairs: repairPlan,
    summary,
    durationMs: Math.max(0, dependencies.now() - startedAtMs),
    ok: executionErrors.length === 0 && summary.failed === 0,
  }
}

async function writeReportFile(filePath, report) {
  const target = path.resolve(filePath)
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    })
    await fsp.rename(temporary, target)
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  return target
}

async function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
    if (options.help) {
      process.stdout.write(`${usage()}\n`)
      return
    }
    const logStream = options.json ? process.stderr : process.stdout
    const report = await orchestrate(options, { log: createStageLogger(logStream) })
    if (options.output) await writeReportFile(options.output, report)
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else process.stdout.write(`MODEL_REPAIR_REPORT ${JSON.stringify(report)}\n`)
    if (!report.ok) process.exitCode = 1
  } catch (error) {
    const report = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      kind: 'model-repair-orchestrator',
      mode: options?.execute ? 'execute' : options?.plan ? 'plan' : 'check',
      ok: false,
      error: boundedMessage(error),
      stages: [],
    }
    const stream = options?.json ? process.stdout : process.stderr
    stream.write(`${options?.json ? JSON.stringify(report, null, 2) : JSON.stringify(report)}\n`)
    process.exitCode = 2
  }
}

if (require.main === module) void main()

module.exports = {
  ALLOWED_REPAIR_IDS,
  DEFAULT_OUTPUT_LIMIT_BYTES,
  REPAIR_DEFINITIONS,
  boundedMessage,
  buildRepairCommand,
  buildRepairPlan,
  consentProvided,
  createBoundedTextCollector,
  createDetectionStages,
  createStageLogger,
  orchestrate,
  parseArgs,
  parseStagePayload,
  publicCommand,
  runBoundedCommand,
  usage,
  validateExecutionRequest,
  validateRepairRequest,
  writeReportFile,
}
