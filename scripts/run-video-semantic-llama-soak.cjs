#!/usr/bin/env node

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('../tests/guard-utils.cjs')
const { readReceipt, sampleGpu } = require('./run-video-semantic-llama-smoke.cjs')

const { LlamaCppVideoSemanticRuntime } = loadTsModule('electron/llamaCppVideoSemanticRuntime.ts')
const { VIDEO_SEMANTIC_PROFILE_IDS } = loadTsModule('shared/videoSemantic.ts')
const { buildVideoSemanticPrompt, parseVideoSemanticModelOutput } = loadTsModule(
  'electron/videoSemanticPrompt.ts',
)
const { VideoFrameManifestLookup } = loadTsModule('electron/videoFrameManifestLookup.ts')

const MODEL_ID = 'qwen3-vl-2b-instruct-q4-k-m'
const MODEL_REVISION = '52d6c8ffea26cc873ac5ad116f8631268d7eb503'
const SOAK_ROUNDS = VIDEO_SEMANTIC_PROFILE_IDS.length
const PORT = 49_173

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function percentile(values, fraction) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

function summarizeRounds(rounds) {
  const latencies = rounds.map((round) => round.latencyMs)
  const gpuSamples = rounds.flatMap((round) => [round.gpuBefore, round.gpuAfter]).filter(Boolean)
  return {
    attempted: rounds.length,
    passed: rounds.filter((round) => round.ok).length,
    failed: rounds.filter((round) => !round.ok).length,
    strictJson: rounds.filter((round) => round.parsed).length,
    averageLatencyMs:
      latencies.length > 0
        ? Math.round(latencies.reduce((total, value) => total + value, 0) / latencies.length)
        : 0,
    p95LatencyMs: percentile(latencies, 0.95),
    maximumGpuUsedMiB:
      gpuSamples.length > 0 ? Math.max(...gpuSamples.map((sample) => sample.usedMiB)) : undefined,
  }
}

function buildRoundRequest(frames, roundIndex, profileId = 'general') {
  const frameIds = frames.map((frame) => frame.frameId)
  const timestamps = frames.map((frame) => frame.timestampMs)
  const anonymousVideoId = `local-soak-${sha256(frames[0].videoId).slice(0, 16)}`
  const authority = {
    generationId: `vid017-local-soak-v1-${roundIndex + 1}`,
    assetId: anonymousVideoId,
    videoId: anonymousVideoId,
    startMs: Math.min(...timestamps),
    endMs: Math.max(...timestamps) + 1,
    profileId,
    evidenceFrameIds: frameIds,
    evidenceFrameDigest: sha256(frameIds.join('\n')),
    modelId: MODEL_ID,
    modelRevision: MODEL_REVISION,
    quantization: 'Q4_K_M',
    sourceFingerprint: sha256(`${frames[0].videoId}\0${frameIds.join('\0')}`),
    createdAt: Date.now(),
  }
  const prompt = buildVideoSemanticPrompt({
    authority,
    frames: frames.map((frame) => ({
      frameId: frame.frameId,
      timestampMs: frame.timestampMs,
    })),
  })
  prompt.messages[0].content +=
    '\nValidation mode: return a minimal record. Use one short summary sentence and at most two entries per array.'
  return {
    authority,
    prompt,
    request: {
      jobId: `vid017-local-soak-${roundIndex + 1}`,
      plannedSegmentId: `vid017-local-soak-segment-${roundIndex + 1}`,
      prompt,
      images: frames.map((frame) => ({
        frameId: frame.frameId,
        timestampMs: frame.timestampMs,
        mimeType: 'image/jpeg',
        dataBase64: fs.readFileSync(frame.imagePath).toString('base64'),
      })),
      maximumOutputTokens: 1_024,
      timeoutMs: 300_000,
      contextTokens: 4_096,
    },
  }
}

function selectProfileFrameSets(mediaRoot, manifestLookupDatabasePath) {
  const benchmarkRoot = path.join(mediaRoot, 'semantic', 'benchmarks')
  const plan = JSON.parse(
    fs.readFileSync(
      path.join(benchmarkRoot, 'qwen3-vl-2b-profile-final', 'full-plan.json'),
      'utf8',
    ),
  )
  const samplesByProfile = new Map(VIDEO_SEMANTIC_PROFILE_IDS.map((id) => [id, []]))
  for (const sample of plan.samples || []) {
    if (samplesByProfile.has(sample.profileId)) samplesByProfile.get(sample.profileId).push(sample)
  }
  const selected = []
  const neededFrameIds = new Set()
  for (const profileId of VIDEO_SEMANTIC_PROFILE_IDS) {
    let selection
    for (const sample of samplesByProfile.get(profileId)) {
      for (const revision of ['qwen3-vl-2b-profile-final', 'qwen3-vl-2b-profile-v1']) {
        const resultPath = path.join(benchmarkRoot, revision, `${sample.sampleId}.json`)
        if (!fs.existsSync(resultPath)) continue
        const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
        const frameIds = result.parse?.value?.evidenceFrameIds
        if (result.parse?.ok === true && Array.isArray(frameIds) && frameIds.length >= 4) {
          selection = {
            profileId,
            sampleId: sample.sampleId,
            frameIds: frameIds.slice(0, 4),
            timestamps: (result.sample?.evidenceTimestampsMs || []).slice(0, 4),
            frameCollection: revision.endsWith('profile-final') ? 'profile-final' : 'profile-v1',
          }
          break
        }
      }
      if (selection) break
    }
    if (!selection) throw new Error(`No controlled cached frame set for profile ${profileId}`)
    selected.push(selection)
    for (const frameId of selection.frameIds) neededFrameIds.add(frameId)
  }
  const frameMap = new Map()
  const manifestPath = path.join(mediaRoot, 'manifests', 'video_frames.jsonl')
  if (manifestLookupDatabasePath) {
    const lookup = new VideoFrameManifestLookup(manifestPath, manifestLookupDatabasePath)
    for (const frameId of neededFrameIds) {
      const frame = lookup.findReady(frameId)
      if (frame) frameMap.set(frameId, frame)
    }
  } else {
    const manifest = fs.readFileSync(manifestPath, 'utf8')
    for (const line of manifest.split(/\r?\n/)) {
      if (!line) continue
      const frame = JSON.parse(line)
      if (neededFrameIds.has(frame.frameId) && frame.status === 'done')
        frameMap.set(frame.frameId, frame)
    }
  }
  const controlledFrameRoot = path.resolve(mediaRoot, 'frames')
  return selected.map((entry) => ({
    profileId: entry.profileId,
    frames: entry.frameIds.map((frameId) => {
      const index = entry.frameIds.indexOf(frameId)
      const frame = frameMap.get(frameId) || {
        frameId,
        videoId: entry.sampleId,
        timestampMs: entry.timestamps[index],
        imagePath: path.join(
          controlledFrameRoot,
          entry.frameCollection,
          entry.sampleId,
          `${frameId}.jpg`,
        ),
      }
      const imagePath = path.resolve(frame.imagePath)
      if (!imagePath.startsWith(`${controlledFrameRoot}${path.sep}`) || !fs.existsSync(imagePath)) {
        throw new Error(`Frame escaped or is missing for ${entry.profileId}`)
      }
      return { ...frame, imagePath }
    }),
  }))
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
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (!(await portAcceptingConnections(port))) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

async function runSoak() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const runtimeRoot = path.join(
    appData,
    'floating-clock-electron',
    'runtimes',
    'video-semantic-llama-cpp',
  )
  const mediaRoot = path.join(appData, 'floating-clock-electron', 'media-search')
  const receipt = readReceipt(runtimeRoot)
  const profileFrameSets = selectProfileFrameSets(mediaRoot)
  const runtime = new LlamaCppVideoSemanticRuntime({
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
  const startedAt = new Date().toISOString()
  const rounds = []
  let runtimeStatus
  let terminalError
  try {
    runtimeStatus = await runtime.inspect()
    if (runtimeStatus.state !== 'ready') {
      throw new Error(`runtime-${runtimeStatus.state}:${runtimeStatus.reason || 'unknown'}`)
    }
    for (let index = 0; index < SOAK_ROUNDS; index += 1) {
      const gpuBefore = sampleGpu()
      const started = process.hrtime.bigint()
      let rawOutput
      let parsed
      let error
      const attempts = []
      const frameSet = profileFrameSets[index]
      try {
        const round = buildRoundRequest(frameSet.frames, index, frameSet.profileId)
        for (const maximumOutputTokens of [1_024]) {
          const attemptStarted = process.hrtime.bigint()
          try {
            rawOutput = await runtime.generate({ ...round.request, maximumOutputTokens })
            attempts.push({
              maximumOutputTokens,
              latencyMs: Math.round(Number(process.hrtime.bigint() - attemptStarted) / 1_000_000),
              ok: true,
            })
            break
          } catch (caught) {
            const message = caught instanceof Error ? caught.message : String(caught)
            attempts.push({
              maximumOutputTokens,
              latencyMs: Math.round(Number(process.hrtime.bigint() - attemptStarted) / 1_000_000),
              ok: false,
              reason: message.includes('truncated at token limit')
                ? 'token-limit'
                : 'runtime-error',
            })
            if (!message.includes('truncated at token limit') || maximumOutputTokens === 1_024) {
              throw caught
            }
          }
        }
        parsed = parseVideoSemanticModelOutput(
          rawOutput,
          round.authority,
          round.prompt.transcriptRefs,
        )
        if (!parsed.ok) throw new Error(`model-output-invalid:${parsed.error}`)
      } catch (caught) {
        error =
          caught instanceof Error ? caught.message.slice(0, 300) : String(caught).slice(0, 300)
      }
      const latencyMs = Math.round(Number(process.hrtime.bigint() - started) / 1_000_000)
      const gpuAfter = sampleGpu()
      const result = {
        round: index + 1,
        profileId: frameSet.profileId,
        latencyMs,
        outputBytes: typeof rawOutput === 'string' ? Buffer.byteLength(rawOutput, 'utf8') : 0,
        outputSha256: typeof rawOutput === 'string' ? sha256(rawOutput) : undefined,
        attempts,
        parsed: parsed?.ok === true,
        gpuBefore,
        gpuAfter,
        error,
        ok: !error && parsed?.ok === true,
      }
      rounds.push(result)
      process.stdout.write(
        `round ${result.round}/${SOAK_ROUNDS}: ${result.ok ? 'ok' : 'failed'} ${latencyMs}ms\n`,
      )
    }
  } catch (caught) {
    terminalError =
      caught instanceof Error ? caught.message.slice(0, 300) : String(caught).slice(0, 300)
  } finally {
    await runtime.dispose()
  }
  const sidecarStopped = await waitForPortClosed(PORT)
  const summary = summarizeRounds(rounds)
  const report = {
    schemaVersion: 1,
    taskId: 'VID-017',
    scope: 'local-evaluation-only',
    startedAt,
    completedAt: new Date().toISOString(),
    runtime: {
      release: receipt.runtime.release,
      commit: receipt.runtime.commit,
      variant: receipt.runtime.variant,
      serverSha256: receipt.runtime.server.sha256,
    },
    model: {
      id: receipt.model.id,
      revision: receipt.model.revision,
      quantization: receipt.model.quantization,
      sha256: receipt.model.sha256,
      projectorSha256: receipt.projector.sha256,
    },
    sample: {
      profileCount: profileFrameSets.length,
      frameCountPerRound: 4,
      evidenceDigest: sha256(
        profileFrameSets.flatMap((entry) => entry.frames.map((frame) => frame.frameId)).join('\n'),
      ),
    },
    runtimeStatus,
    rounds,
    summary,
    sidecarStopped,
    terminalError,
    ok:
      !terminalError &&
      runtimeStatus?.state === 'ready' &&
      summary.attempted === SOAK_ROUNDS &&
      summary.passed === SOAK_ROUNDS &&
      summary.strictJson === SOAK_ROUNDS &&
      new Set(rounds.map((round) => round.profileId)).size === SOAK_ROUNDS &&
      sidecarStopped,
  }
  const reportRoot = path.join(mediaRoot, 'semantic', 'benchmarks', 'llama-cpp-local-soak')
  await fsp.mkdir(reportRoot, { recursive: true })
  await fsp.writeFile(
    path.join(reportRoot, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  )
  process.stdout.write(`${JSON.stringify({ ...report, rounds: undefined }, null, 2)}\n`)
  if (!report.ok) process.exitCode = 1
  return report
}

function readReusableSoakReport() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const reportPath = path.join(
    appData,
    'floating-clock-electron',
    'media-search',
    'semantic',
    'benchmarks',
    'llama-cpp-local-soak',
    'report.json',
  )
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
    const valid =
      report.taskId === 'VID-017' &&
      report.scope === 'local-evaluation-only' &&
      report.ok === true &&
      report.summary?.attempted === SOAK_ROUNDS &&
      report.summary?.passed === SOAK_ROUNDS &&
      report.summary?.strictJson === SOAK_ROUNDS &&
      report.sample?.profileCount === SOAK_ROUNDS &&
      report.sidecarStopped === true
    return valid ? report : undefined
  } catch {
    return undefined
  }
}

if (require.main === module) {
  const reusable = process.argv.includes('--reuse-valid') ? readReusableSoakReport() : undefined
  if (reusable) {
    process.stdout.write(
      `${JSON.stringify({ reused: true, summary: reusable.summary }, null, 2)}\n`,
    )
  } else {
    runSoak().catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
  }
}

module.exports = {
  buildRoundRequest,
  percentile,
  runSoak,
  readReusableSoakReport,
  selectProfileFrameSets,
  summarizeRounds,
}
