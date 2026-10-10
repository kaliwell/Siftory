#!/usr/bin/env node

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { loadTsModule } = require('../tests/guard-utils.cjs')

const { LlamaCppVideoSemanticRuntime } = loadTsModule('electron/llamaCppVideoSemanticRuntime.ts')
const { buildVideoSemanticPrompt, parseVideoSemanticModelOutput } = loadTsModule(
  'electron/videoSemanticPrompt.ts',
)

const MODEL_ID = 'qwen3-vl-2b-instruct-q4-k-m'
const MODEL_REVISION = '52d6c8ffea26cc873ac5ad116f8631268d7eb503'
const RUNTIME_RELEASE = 'b10441'
const FRAME_COUNT = 4

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function within(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function sampleGpu() {
  try {
    const output = execFileSync(
      'nvidia-smi.exe',
      [
        '--query-gpu=name,memory.used,memory.total,utilization.gpu',
        '--format=csv,noheader,nounits',
      ],
      { encoding: 'utf8', timeout: 3_000, windowsHide: true },
    )
    const [name, usedMiB, totalMiB, utilizationPercent] = output
      .trim()
      .split(/\r?\n/)[0]
      .split(',')
      .map((value) => value.trim())
    return {
      name,
      usedMiB: Number(usedMiB),
      totalMiB: Number(totalMiB),
      utilizationPercent: Number(utilizationPercent),
    }
  } catch {
    return null
  }
}

function readReceipt(runtimeRoot) {
  const receipt = JSON.parse(
    fs.readFileSync(path.join(runtimeRoot, 'installation-receipt.json'), 'utf8'),
  )
  if (
    receipt.schemaVersion !== 1 ||
    receipt.scope !== 'local-evaluation-only' ||
    receipt.redistributionApproved !== false ||
    receipt.packagedByDefault !== false ||
    receipt.runtime?.release !== RUNTIME_RELEASE ||
    receipt.model?.revision !== MODEL_REVISION
  ) {
    throw new Error('local runtime receipt is not an approved evaluation identity')
  }
  return receipt
}

function selectFrames(mediaRoot) {
  const manifestPath = path.join(
    mediaRoot,
    'semantic',
    'benchmarks',
    'qwen3-vl-2b-profile-final',
    'evidence-manifest.json',
  )
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const frameRoot = path.join(mediaRoot, 'frames')
  const groups = new Map()
  for (const frame of manifest.records || []) {
    if (
      frame?.status !== 'done' ||
      typeof frame.videoId !== 'string' ||
      typeof frame.frameId !== 'string' ||
      !Number.isSafeInteger(frame.timestampMs) ||
      typeof frame.imagePath !== 'string' ||
      !within(frameRoot, frame.imagePath) ||
      !fs.existsSync(frame.imagePath)
    ) {
      continue
    }
    const group = groups.get(frame.videoId) || []
    group.push(frame)
    groups.set(frame.videoId, group)
  }
  const selectedGroup = [...groups.values()]
    .map((frames) => frames.sort((left, right) => left.timestampMs - right.timestampMs))
    .find((frames) => frames.length >= FRAME_COUNT)
  if (!selectedGroup) throw new Error('controlled evidence manifest has no four-frame sample')
  const positions = Array.from({ length: FRAME_COUNT }, (_, index) =>
    Math.round((index * (selectedGroup.length - 1)) / (FRAME_COUNT - 1)),
  )
  return positions.map((position) => selectedGroup[position])
}

async function runSmoke() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const runtimeRoot = path.join(
    appData,
    'floating-clock-electron',
    'runtimes',
    'video-semantic-llama-cpp',
  )
  const mediaRoot = path.join(appData, 'floating-clock-electron', 'media-search')
  const receipt = readReceipt(runtimeRoot)
  const frames = selectFrames(mediaRoot)
  const frameIds = frames.map((frame) => frame.frameId)
  const timestamps = frames.map((frame) => frame.timestampMs)
  const startedAt = new Date().toISOString()
  const started = process.hrtime.bigint()
  const preflightGpu = sampleGpu()
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
    port: 49_173,
    contextTokens: 4_096,
    gpuLayers: 20,
    startupTimeoutMs: 180_000,
    inspectTimeoutMs: 5_000,
  })
  let status
  let rawOutput
  let parsed
  let error
  try {
    status = await runtime.inspect()
    if (status.state !== 'ready') {
      throw new Error(`runtime-${status.state}:${status.reason || 'unknown'}`)
    }
    const authority = {
      generationId: 'vid017-local-smoke-v1',
      assetId: `local-smoke-${sha256(frames[0].videoId).slice(0, 16)}`,
      videoId: `local-smoke-${sha256(frames[0].videoId).slice(0, 16)}`,
      startMs: Math.min(...timestamps),
      endMs: Math.max(...timestamps) + 1,
      profileId: 'general',
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
    rawOutput = await runtime.generate({
      jobId: 'vid017-local-smoke',
      plannedSegmentId: 'vid017-local-smoke-segment',
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
    })
    parsed = parseVideoSemanticModelOutput(rawOutput, authority, prompt.transcriptRefs)
    if (!parsed.ok) throw new Error(`model-output-invalid:${parsed.error}`)
  } catch (caught) {
    error = caught instanceof Error ? caught.message.slice(0, 500) : String(caught).slice(0, 500)
  } finally {
    await runtime.dispose()
  }
  const latencyMs = Number(process.hrtime.bigint() - started) / 1_000_000
  const postflightGpu = sampleGpu()
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
      projectorQuantization: receipt.projector.quantization,
      projectorSha256: receipt.projector.sha256,
    },
    sample: {
      frameCount: frames.length,
      timestampsMs: timestamps,
      evidenceDigest: sha256(frameIds.join('\n')),
    },
    gpu: { preflight: preflightGpu, postflight: postflightGpu },
    runtimeStatus: status,
    latencyMs: Math.round(latencyMs),
    outputBytes: typeof rawOutput === 'string' ? Buffer.byteLength(rawOutput, 'utf8') : 0,
    outputSha256: typeof rawOutput === 'string' ? sha256(rawOutput) : undefined,
    parsed: parsed?.ok === true,
    summaryLength: parsed?.ok === true ? parsed.value.summary.length : 0,
    eventCount: parsed?.ok === true ? parsed.value.events.length : 0,
    personCount: parsed?.ok === true ? parsed.value.persons.length : 0,
    searchTagCount: parsed?.ok === true ? parsed.value.searchTags.length : 0,
    error,
    ok: !error && status?.state === 'ready' && parsed?.ok === true,
  }
  const reportRoot = path.join(mediaRoot, 'semantic', 'benchmarks', 'llama-cpp-local-smoke')
  await fsp.mkdir(reportRoot, { recursive: true })
  if (typeof rawOutput === 'string') {
    await fsp.writeFile(path.join(reportRoot, 'raw-output.txt'), rawOutput, 'utf8')
  }
  await fsp.writeFile(
    path.join(reportRoot, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  )
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.ok) process.exitCode = 1
  return report
}

if (require.main === module) {
  runSmoke().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

module.exports = { readReceipt, runSmoke, sampleGpu, selectFrames, within }
