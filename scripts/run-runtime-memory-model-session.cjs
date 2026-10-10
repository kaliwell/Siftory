#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('../tests/guard-utils.cjs')
const { readReceipt, sampleGpu } = require('./run-video-semantic-llama-smoke.cjs')
const {
  buildRoundRequest,
  selectProfileFrameSets,
} = require('./run-video-semantic-llama-soak.cjs')

const { LlamaCppVideoSemanticRuntime } = loadTsModule(
  'electron/llamaCppVideoSemanticRuntime.ts',
)
const { VIDEO_SEMANTIC_PROFILE_IDS } = loadTsModule('shared/videoSemantic.ts')
const { parseVideoSemanticModelOutput } = loadTsModule('electron/videoSemanticPrompt.ts')

const MODEL_ID = 'qwen3-vl-2b-instruct-q4-k-m'
const MODEL_REVISION = '52d6c8ffea26cc873ac5ad116f8631268d7eb503'
const PORT = 49_174

function option(argv, name, fallback = '') {
  return argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
}

function parseArgs(argv, projectRoot = path.resolve(__dirname, '..')) {
  const repetitions = Number(option(argv, 'repetitions', '3'))
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3) {
    throw new Error('--repetitions must be an integer between 1 and 3')
  }
  const allowedRoot = path.join(projectRoot, 'artifacts', 'benchmark', 'runtime-memory')
  const outputDir = path.resolve(option(argv, 'output-dir', path.join(allowedRoot, 'model-session')))
  const relative = path.relative(allowedRoot, outputDir)
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('--output-dir must stay under artifacts/benchmark/runtime-memory')
  }
  return { outputDir, repetitions, projectRoot }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function portAcceptingConnections(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const finish = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function waitForPortClosed(port) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (!(await portAcceptingConnections(port))) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

function snapshotSources(manifestPath, profileFrameSets) {
  const files = [manifestPath, ...profileFrameSets.flatMap((entry) => entry.frames.map((f) => f.imagePath))]
  return [...new Set(files)].map((filePath) => {
    const stat = fs.statSync(filePath)
    return { filePath, size: stat.size, mtimeMs: stat.mtimeMs }
  })
}

function sourcesUnchanged(snapshots) {
  return snapshots.every((snapshot) => {
    try {
      const stat = fs.statSync(snapshot.filePath)
      return stat.size === snapshot.size && stat.mtimeMs === snapshot.mtimeMs
    } catch {
      return false
    }
  })
}

function createRuntime(runtimeRoot, receipt) {
  return new LlamaCppVideoSemanticRuntime({
    serverExecutablePath: path.join(runtimeRoot, ...receipt.runtime.server.path.split('/')),
    modelPath: path.join(runtimeRoot, ...receipt.model.path.split('/')),
    mmprojPath: path.join(runtimeRoot, ...receipt.projector.path.split('/')),
    expectedServerSha256: receipt.runtime.server.sha256,
    expectedModelSha256: receipt.model.sha256,
    expectedMmprojSha256: receipt.projector.sha256,
    modelId: MODEL_ID,
    modelRevision: MODEL_REVISION,
    quantization: 'Q4_K_M',
    port: PORT,
    contextTokens: 4_096,
    gpuLayers: 20,
    startupTimeoutMs: 180_000,
    inspectTimeoutMs: 5_000,
  })
}

async function runModelSessionBenchmark(options) {
  fs.mkdirSync(options.outputDir, { recursive: true })
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const appRoot = path.join(appData, 'floating-clock-electron')
  const runtimeRoot = path.join(appRoot, 'runtimes', 'video-semantic-llama-cpp')
  const mediaRoot = path.join(appRoot, 'media-search')
  const manifestPath = path.join(mediaRoot, 'manifests', 'video_frames.jsonl')
  const receipt = readReceipt(runtimeRoot)
  const profileFrameSets = selectProfileFrameSets(
    mediaRoot,
    path.join(options.outputDir, 'frame-manifest-lookup.sqlite'),
  )
  if (profileFrameSets.length !== VIDEO_SEMANTIC_PROFILE_IDS.length) {
    throw new Error('The fixed eight-profile frame corpus is incomplete')
  }
  const sourceSnapshots = snapshotSources(manifestPath, profileFrameSets)
  const startedAt = new Date().toISOString()
  const rounds = []
  let terminalError = ''

  outer: for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
    for (let profileIndex = 0; profileIndex < profileFrameSets.length; profileIndex += 1) {
      const frameSet = profileFrameSets[profileIndex]
      const sequence = repetition * profileFrameSets.length + profileIndex
      const runtime = createRuntime(runtimeRoot, receipt)
      const lifecycleStartedAt = new Date().toISOString()
      const started = process.hrtime.bigint()
      const gpuBefore = sampleGpu()
      let runtimeState = 'unavailable'
      let parsed = false
      let outputSha256 = ''
      let error = ''
      let sidecarStopped
      try {
        const status = await runtime.inspect()
        runtimeState = status.state
        if (status.state !== 'ready') throw new Error(`runtime-${status.state}:${status.reason || 'unknown'}`)
        const round = buildRoundRequest(frameSet.frames, sequence, frameSet.profileId)
        const output = await runtime.generate(round.request)
        const parsedResult = parseVideoSemanticModelOutput(
          output,
          round.authority,
          round.prompt.transcriptRefs,
        )
        if (!parsedResult.ok) throw new Error(`model-output-invalid:${parsedResult.error}`)
        parsed = true
        outputSha256 = sha256(output)
      } catch (caught) {
        error = caught instanceof Error ? caught.message.slice(0, 300) : String(caught).slice(0, 300)
      } finally {
        try {
          await runtime.dispose()
        } catch (caught) {
          if (!error) {
            error =
              caught instanceof Error ? caught.message.slice(0, 300) : String(caught).slice(0, 300)
          }
        }
        sidecarStopped = await waitForPortClosed(PORT)
        if (sidecarStopped) await new Promise((resolve) => setTimeout(resolve, 500))
      }
      const gpuAfter = sampleGpu()
      const lifecycleCompletedAt = new Date().toISOString()
      const result = {
        sequence: sequence + 1,
        repetition: repetition + 1,
        profileId: frameSet.profileId,
        startedAt: lifecycleStartedAt,
        completedAt: lifecycleCompletedAt,
        runtimeState,
        latencyMs: Math.round(Number(process.hrtime.bigint() - started) / 1_000_000),
        parsed,
        outputSha256,
        gpuBefore,
        gpuAfter,
        sidecarStopped,
        error,
        ok: !error && parsed && sidecarStopped,
      }
      rounds.push(result)
      process.stderr.write(
        `model-session ${result.sequence}/${options.repetitions * profileFrameSets.length}: ${
          result.ok ? 'ok' : 'failed'
        }\n`,
      )
      if (!result.ok) {
        terminalError = result.error || 'model-session-lifecycle-failed'
        break outer
      }
    }
  }

  const expectedCycles = options.repetitions * VIDEO_SEMANTIC_PROFILE_IDS.length
  const sourceFilesUnchanged = sourcesUnchanged(sourceSnapshots)
  const resultDigest = sha256(
    rounds.map((round) => `${round.profileId}:${round.outputSha256}`).join('\n'),
  )
  const report = {
    schema: 'siftory-runtime-memory-model-session/v1',
    status:
      !terminalError && rounds.length === expectedCycles && sourceFilesUnchanged
        ? 'passed'
        : 'failed',
    startedAt,
    completedAt: new Date().toISOString(),
    profileCount: VIDEO_SEMANTIC_PROFILE_IDS.length,
    repetitions: options.repetitions,
    requestedCycles: expectedCycles,
    completedCycles: rounds.filter((round) => round.ok).length,
    model: {
      id: receipt.model.id,
      revision: receipt.model.revision,
      quantization: receipt.model.quantization,
      sha256: receipt.model.sha256,
      projectorSha256: receipt.projector.sha256,
    },
    resultDigest,
    safety: { sourceFilesUnchanged },
    terminalError,
    rounds,
  }
  const target = path.join(
    options.outputDir,
    `model-session-${report.completedAt.replace(/[:.]/g, '-')}.json`,
  )
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  process.stdout.write(
    `${JSON.stringify({
      ...report,
      rounds: undefined,
      lifecycleWindows: rounds.map((round) => ({
        startedAt: round.startedAt,
        completedAt: round.completedAt,
        profileId: round.profileId,
        repetition: round.repetition,
      })),
    })}\n`,
  )
  if (report.status !== 'passed') process.exitCode = 1
  return report
}

if (require.main === module) {
  runModelSessionBenchmark(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

module.exports = {
  parseArgs,
  runModelSessionBenchmark,
  sourcesUnchanged,
}
