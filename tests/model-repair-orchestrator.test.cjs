const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  ALLOWED_REPAIR_IDS,
  boundedMessage,
  buildRepairCommand,
  createBoundedTextCollector,
  createDetectionStages,
  createStageLogger,
  orchestrate,
  parseArgs,
  validateExecutionRequest,
  writeReportFile,
} = require('../scripts/run-model-repair-orchestrator.cjs')

function commandResult(exitCode = 0, stdout = '{}', stderr = '') {
  const output = (text) => ({
    text,
    totalBytes: Buffer.byteLength(text),
    truncated: false,
    hardLimitExceeded: false,
  })
  return {
    exitCode,
    signal: null,
    stdout: output(stdout),
    stderr: output(stderr),
    timedOut: false,
    outputLimitExceeded: false,
  }
}

test('safe defaults run only the quick read-only verification plan without consent flags', () => {
  const options = parseArgs([], { APPDATA: path.join('C:\\', 'Users', 'tester', 'AppData') })
  assert.equal(options.execute, false)
  assert.equal(options.plan, false)
  assert.equal(options.scope, 'quick')
  assert.equal(options.allowDownload, false)
  assert.deepEqual(Object.values(options.consents), [false, false, false, false])

  const stages = createDetectionStages(options)
  assert.deepEqual(
    stages.map((stage) => stage.id),
    [
      'models:local:verify',
      'models:video:verify',
      'cuda-runtime:verify',
      'video-semantic:llama-preflight',
    ],
  )
  const argumentsText = stages.flatMap((stage) => stage.command.args).join(' ')
  assert.doesNotMatch(argumentsText, /--accept-/)
  assert.match(argumentsText, /--verify-only/)
})

test('full scope adds the read-only health helper without invoking the health CLI writer', () => {
  const stages = createDetectionStages(parseArgs(['--full']))
  assert.equal(stages.length, 5)
  assert.deepEqual(stages.at(-1), {
    id: 'video-semantic:llama-health',
    kind: 'health-helper',
    readOnly: true,
    suggestedRepairId: 'llama-video-runtime',
  })
})

test('plan mode starts no child process and reports every allowlisted repair', async () => {
  let commands = 0
  const report = await orchestrate(parseArgs(['--plan', '--full']), {
    runCommand: async () => {
      commands++
      throw new Error('plan must not run commands')
    },
    runHealth: async () => {
      throw new Error('plan must not inspect health')
    },
  })
  assert.equal(commands, 0)
  assert.equal(report.ok, true)
  assert.equal(report.mode, 'plan')
  assert.equal(report.safety.readOnly, true)
  assert.equal(report.safety.childProcessesStarted, false)
  assert.equal(report.safety.externalNetworkAllowed, false)
  assert.equal(report.safety.licenseAcceptanceInjected, false)
  assert.deepEqual(
    report.repairs.map((repair) => repair.id),
    ALLOWED_REPAIR_IDS,
  )
})

test('execution fails closed before any installer when download or consent gates are missing', () => {
  assert.throws(() => parseArgs(['--execute', '--repair=local-user-models']), /allow-download/)
  assert.throws(
    () => parseArgs(['--execute', '--allow-download', '--repair=unknown']),
    /Unsupported repair id/,
  )
  const missingConsent = parseArgs(['--execute', '--allow-download', '--repair=local-user-models'])
  assert.match(validateExecutionRequest(missingConsent).join('\n'), /accept-local-user-models/)

  const missingCudaCache = parseArgs([
    '--execute',
    '--allow-download',
    '--repair=cuda-runtime',
    '--accept-nvidia-license',
  ])
  assert.match(validateExecutionRequest(missingCudaCache).join('\n'), /cache-dir/)

  const missingVariant = parseArgs([
    '--execute',
    '--allow-download',
    '--repair=llama-video-runtime',
    '--accept-local-evaluation',
  ])
  assert.match(validateExecutionRequest(missingVariant).join('\n'), /variant=vulkan/)
})

test('repair builders forward only caller-provided installer consent and bounded options', () => {
  const local = parseArgs([
    '--execute',
    '--allow-download',
    '--repair=local-user-models',
    '--accept-local-user-models',
    '--replace-existing',
    '--user-data=C:\\safe-user-data',
  ])
  const localCommand = buildRepairCommand('local-user-models', local)
  assert.equal(path.basename(localCommand.args[0]), 'install-local-user-models.cjs')
  assert.ok(localCommand.args.includes('--accept-local-user-models'))
  assert.ok(localCommand.args.includes('--replace-existing'))
  assert.doesNotMatch(localCommand.args.join(' '), /accept-external|accept-nvidia|local-evaluation/)

  const llama = parseArgs([
    '--execute',
    '--allow-download',
    '--repair=llama-video-runtime',
    '--accept-local-evaluation',
    '--variant=vulkan',
  ])
  assert.deepEqual(buildRepairCommand('llama-video-runtime', llama).args.slice(1), [
    '--variant=vulkan',
    '--accept-local-evaluation',
  ])
})

test('checks continue after bounded failures and produce repair recommendations', async () => {
  const seen = []
  let time = 0
  const report = await orchestrate(parseArgs(['--full']), {
    now: () => ++time,
    runCommand: async (command) => {
      const script = path.basename(command.args[0])
      seen.push(script)
      if (script === 'install-local-user-models.cjs') {
        return commandResult(2, '', 'local models are unavailable')
      }
      return commandResult()
    },
    runHealth: async () => ({ healthy: false, installed: false }),
  })
  assert.equal(seen.length, 4)
  assert.equal(report.stages.length, 5)
  assert.equal(report.summary.passed, 3)
  assert.equal(report.summary.failed, 2)
  assert.equal(report.ok, false)
  assert.equal(report.repairs.find((repair) => repair.id === 'local-user-models').recommended, true)
  assert.equal(
    report.repairs.find((repair) => repair.id === 'llama-video-runtime').recommended,
    true,
  )
})

test('explicit execution invokes only the selected allowlisted installer after read-only checks', async () => {
  const calls = []
  const options = parseArgs([
    '--execute',
    '--allow-download',
    '--repair=ollama-video-model',
    '--accept-external-model',
  ])
  const report = await orchestrate(options, {
    runCommand: async (command) => {
      calls.push(command.args.slice())
      return commandResult()
    },
  })
  const mutating = calls.filter((args) => !args.includes('--verify-only'))
  assert.equal(mutating.length, 2)
  const selectedInstaller = mutating.find(
    (args) => path.basename(args[0]) === 'install-video-semantic-ollama-model.cjs',
  )
  assert.ok(selectedInstaller)
  assert.ok(selectedInstaller.includes('--accept-external-model'))
  assert.equal(
    mutating.filter((args) => args.some((argument) => argument.startsWith('--accept-'))).length,
    1,
  )
  assert.equal(report.safety.readOnly, false)
  assert.equal(report.safety.externalNetworkAllowed, true)
  assert.deepEqual(report.summary.requestedRepairs, ['ollama-video-model'])
})

test('output and errors stay bounded while an explicit output file is atomic JSON', async (t) => {
  const collector = createBoundedTextCollector(8, 12)
  assert.equal(collector.append('12345678901234567890'), false)
  assert.deepEqual(collector.snapshot(), {
    text: '34567890',
    totalBytes: 20,
    truncated: true,
    hardLimitExceeded: true,
  })
  assert.equal(boundedMessage('x'.repeat(5000)).length, 4097)

  const events = []
  const logger = createStageLogger(
    { write: (line) => events.push(JSON.parse(line)) },
    () => '2026-08-24T00:00:00.000Z',
  )
  logger({ event: 'start', stageId: 'models:local:verify' })
  assert.deepEqual(events[0], {
    schemaVersion: 1,
    kind: 'model-repair-stage',
    at: '2026-08-24T00:00:00.000Z',
    event: 'start',
    stageId: 'models:local:verify',
  })

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-repair-output-'))
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
  const outputPath = path.join(tempRoot, 'report.json')
  const report = { schemaVersion: 1, ok: true }
  assert.equal(await writeReportFile(outputPath, report), outputPath)
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), report)
  assert.deepEqual(
    fs.readdirSync(tempRoot).filter((name) => name.endsWith('.tmp')),
    [],
  )
})
