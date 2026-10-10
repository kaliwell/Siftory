#!/usr/bin/env node

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { loadTsModule } = require('../tests/guard-utils.cjs')

const {
  OllamaVideoSemanticRuntime,
  OLLAMA_VIDEO_SEMANTIC_LOW_VRAM_CONTEXT_TOKENS,
  OLLAMA_VIDEO_SEMANTIC_LOW_VRAM_GPU_LAYERS,
} = loadTsModule('electron/ollamaVideoSemanticRuntime.ts')
const { buildVideoSemanticPrompt, parseVideoSemanticModelOutput } = loadTsModule(
  'electron/videoSemanticPrompt.ts',
)
const {
  VIDEO_SEMANTIC_OLLAMA_TEST_IDENTITY,
  VIDEO_SEMANTIC_PROFILE_IDS,
  isVideoSemanticProfileId,
} = loadTsModule('shared/videoSemantic.ts')

const PILOT_REVISION = '2026-08-14.v6-adaptive'
const CONTEXT_ATTEMPT_TOKENS = Object.freeze([
  OLLAMA_VIDEO_SEMANTIC_LOW_VRAM_CONTEXT_TOKENS,
  12_288,
])
const MAX_EVIDENCE_FRAMES = 4
const GPU_LAYERS = OLLAMA_VIDEO_SEMANTIC_LOW_VRAM_GPU_LAYERS
const MINIMUM_FREE_GPU_MIB = 2_560
const FINAL_PROFILE_RESULT_SET = 'profile-final'
const FINAL_PROFILE_BENCHMARK_REVISION = '2026-08-15.profile-final'
const DEFAULT_PROFILE_CORPUS_ROOT = process.env.VIDEO_GAP_CORPUS || '<VIDEO_GAP_CORPUS>'
const SAMPLE_PREFIXES = Object.freeze([
  '25ed523fd145',
  '097fb3d0b5aa',
  '248aeaa4c13d',
  'ceda2034bb2d',
  '07ace04a0011',
  '94614cebcf3c',
  'e49e32410674',
  '83d93d2223d3',
  'ebe4b0bf974f',
  '19d2ffb469eb',
  'a5512f5def6e',
  'e666daf94850',
  '59faa4639800',
  '021b1160eeed',
  '2952263bb731',
  '270229404eef',
  'a5695170b24d',
  '39de224eca70',
  '5c66930f2990',
  '0b0594e401c4',
])

function readJsonLines(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function sampleGpu() {
  try {
    const output = execFileSync(
      'nvidia-smi.exe',
      ['--query-gpu=memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', timeout: 2_000, windowsHide: true },
    )
    const [usedMiB, totalMiB, utilizationPercent] = output
      .trim()
      .split(/\r?\n/)[0]
      .split(',')
      .map((value) => Number(value.trim()))
    if (![usedMiB, totalMiB, utilizationPercent].every(Number.isFinite)) return null
    return { usedMiB, totalMiB, utilizationPercent }
  } catch {
    return null
  }
}

function selectEvidence(video, framesRoot, allFrames, maximumFrames) {
  const usable = allFrames
    .filter(
      (frame) =>
        frame.videoId === video.videoId &&
        frame.status === 'done' &&
        typeof frame.imagePath === 'string' &&
        fs.existsSync(frame.imagePath),
    )
    .sort((left, right) => left.timestampMs - right.timestampMs)
  if (usable.length < 4) throw new Error('Selected sample has fewer than four ready frames')

  const spanMs = Math.min(20_000, Math.max(1_000, video.durationMs))
  const startMs = Math.max(0, Math.floor((video.durationMs - spanMs) / 2))
  const endMs = Math.min(video.durationMs, startMs + spanMs)
  let candidates = usable.filter(
    (frame) => frame.timestampMs >= startMs && frame.timestampMs < endMs,
  )
  if (candidates.length < 4) {
    const midpoint = (startMs + endMs) / 2
    candidates = [...usable]
      .sort(
        (left, right) =>
          Math.abs(left.timestampMs - midpoint) - Math.abs(right.timestampMs - midpoint),
      )
      .slice(0, 6)
      .sort((left, right) => left.timestampMs - right.timestampMs)
  } else if (candidates.length > 6) {
    const positions = [0, 0.2, 0.4, 0.6, 0.8, 1]
    candidates = positions.map(
      (position) => candidates[Math.floor(position * (candidates.length - 1))],
    )
  }

  const unique = [...new Map(candidates.map((frame) => [frame.frameId, frame])).values()]
  const selected = Array.from({ length: Math.min(maximumFrames, unique.length) }, (_, index) =>
    unique.length <= maximumFrames
      ? unique[index]
      : unique[Math.round((index * (unique.length - 1)) / (maximumFrames - 1))],
  )
  for (const frame of selected) {
    const resolved = path.resolve(frame.imagePath)
    const relative = path.relative(framesRoot, resolved)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Evidence frame escaped the controlled frame cache')
    }
    const stat = fs.statSync(resolved)
    if (!stat.isFile() || stat.size <= 0 || stat.size > 2 * 1024 * 1024) {
      throw new Error('Evidence frame size is invalid')
    }
  }
  return { startMs, endMs, frames: selected }
}

async function main() {
  const requested = process.argv
    .find((argument) => argument.startsWith('--sample='))
    ?.slice('--sample='.length)
  const requestedProfileSample = process.argv
    .find((argument) => argument.startsWith('--profile-sample='))
    ?.slice('--profile-sample='.length)
  const profileMode = Boolean(requestedProfileSample)
  const requestedResultSet = process.argv
    .find((argument) => argument.startsWith('--result-set='))
    ?.slice('--result-set='.length)
  if (requested && requestedProfileSample) {
    throw new Error('Use either --sample or --profile-sample, not both')
  }
  if (!profileMode && (!requested || !SAMPLE_PREFIXES.includes(requested))) {
    throw new Error(`Use one approved --sample prefix: ${SAMPLE_PREFIXES.join(', ')}`)
  }
  if (profileMode && !/^candidate-[a-f0-9]{12}$/.test(requestedProfileSample)) {
    throw new Error('Use an anonymous candidate ID from the approved profile review')
  }
  if (
    requestedResultSet &&
    (!profileMode ||
      ![
        'profile-v2-regression',
        'profile-v3-regression',
        'profile-v7-shadow',
        'profile-v8-mitigation',
        FINAL_PROFILE_RESULT_SET,
      ].includes(requestedResultSet))
  ) {
    throw new Error('Use an approved profile result set only with an approved profile sample')
  }
  const requestedFrames = Number(
    process.argv.find((argument) => argument.startsWith('--frames='))?.slice('--frames='.length) ??
      MAX_EVIDENCE_FRAMES,
  )
  if (![2, MAX_EVIDENCE_FRAMES].includes(requestedFrames)) {
    throw new Error(`Use --frames=2 or --frames=${MAX_EVIDENCE_FRAMES}`)
  }
  const pilotRevision = profileMode
    ? `${
        requestedResultSet === FINAL_PROFILE_RESULT_SET
          ? FINAL_PROFILE_BENCHMARK_REVISION
          : requestedResultSet
            ? `2026-08-15.${requestedResultSet}`
            : '2026-08-15.profile-v1'
      }${requestedFrames === MAX_EVIDENCE_FRAMES ? '' : `.f${requestedFrames}`}`
    : requestedFrames === MAX_EVIDENCE_FRAMES
      ? PILOT_REVISION
      : `${PILOT_REVISION}.f${requestedFrames}-canary`

  const mediaRoot = path.join(process.env.APPDATA, 'floating-clock-electron', 'media-search')
  const manifestRoot = path.join(mediaRoot, 'manifests')
  const framesRoot = path.join(mediaRoot, 'frames')
  const videos = readJsonLines(path.join(manifestRoot, 'video_files.jsonl'))
  let allFrames = readJsonLines(path.join(manifestRoot, 'video_frames.jsonl'))
  let video
  let sampleId
  let profileId
  if (profileMode) {
    const reviewRoot = path.join(mediaRoot, 'semantic', 'reviews')
    const reviewFiles = [
      path.join(reviewRoot, 'video-profile-corpus-review.json'),
      ...(requestedResultSet === FINAL_PROFILE_RESULT_SET
        ? [
            path.join(reviewRoot, 'video-profile-gap-corpus-review.json'),
            path.join(reviewRoot, 'video-profile-final-coverage-review.json'),
          ]
        : []),
    ]
    const judgments = {}
    for (const reviewFile of reviewFiles) {
      let review
      try {
        review = JSON.parse(fs.readFileSync(reviewFile, 'utf8').replace(/^\uFEFF/, ''))
      } catch {
        continue
      }
      for (const [candidateId, value] of Object.entries(review?.judgments || {})) {
        const previous = judgments[candidateId]
        if (
          previous?.verdict === 'accepted' &&
          value?.verdict === 'accepted' &&
          previous.profileId !== value.profileId
        ) {
          throw new Error(`Conflicting profile truth: ${candidateId}`)
        }
        if (previous?.verdict === 'accepted' && value?.verdict !== 'accepted') continue
        judgments[candidateId] = value
      }
    }
    const judgment = judgments[requestedProfileSample]
    if (judgment?.verdict !== 'accepted' || !isVideoSemanticProfileId(judgment.profileId)) {
      throw new Error('Profile sample is not approved by the human review authority')
    }
    const { buildProfileCandidates, buildProfileGapCandidates } =
      await import('./serve-video-profile-review.mjs')
    const baseCandidates = buildProfileCandidates(
      mediaRoot,
      requestedResultSet === FINAL_PROFILE_RESULT_SET ? 4_096 : undefined,
    )
    const gapCandidates =
      requestedResultSet === FINAL_PROFILE_RESULT_SET && fs.existsSync(DEFAULT_PROFILE_CORPUS_ROOT)
        ? buildProfileGapCandidates(
            mediaRoot,
            DEFAULT_PROFILE_CORPUS_ROOT,
            VIDEO_SEMANTIC_PROFILE_IDS,
          )
        : []
    const candidate = [...baseCandidates, ...gapCandidates].find(
      (item) => item.sampleId === requestedProfileSample,
    )
    if (requestedResultSet === FINAL_PROFILE_RESULT_SET) {
      const evidenceManifest = JSON.parse(
        fs.readFileSync(
          path.join(
            mediaRoot,
            'semantic',
            'benchmarks',
            'qwen3-vl-2b-profile-final',
            'evidence-manifest.json',
          ),
          'utf8',
        ),
      )
      allFrames = [...allFrames, ...(evidenceManifest?.records || [])]
    }
    video = candidate ? videos.find((item) => item.videoId === candidate.videoId) : undefined
    if (!video && candidate?.videoId?.startsWith('profile-gap-')) {
      const stat = fs.statSync(candidate.videoPath)
      video = {
        videoId: candidate.videoId,
        metadataStatus: 'done',
        missing: false,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        durationMs: candidate.durationMs,
        width: candidate.width,
        height: candidate.height,
        videoCodec: candidate.videoCodec,
      }
    }
    sampleId = requestedProfileSample
    profileId = judgment.profileId
  } else {
    video = videos.find((candidate) => candidate.videoId?.startsWith(requested))
    sampleId = `sample-${requested.slice(0, 4)}`
    profileId = video?.durationMs <= 120_000 ? 'short-form-vlog' : 'general'
  }
  if (
    !video ||
    video.missing ||
    video.metadataStatus !== 'done' ||
    !Number.isSafeInteger(video.durationMs) ||
    video.durationMs <= 0
  ) {
    throw new Error('Approved sample is not available in the authoritative video manifest')
  }

  const evidence = selectEvidence(video, framesRoot, allFrames, requestedFrames)
  const preflightGpu = sampleGpu()
  if (preflightGpu && preflightGpu.totalMiB - preflightGpu.usedMiB < MINIMUM_FREE_GPU_MIB) {
    throw new Error(`waiting-for-free-gpu-memory: requires ${MINIMUM_FREE_GPU_MIB} MiB free`)
  }
  const model = VIDEO_SEMANTIC_OLLAMA_TEST_IDENTITY
  const runtime = new OllamaVideoSemanticRuntime({
    modelName: model.modelName,
    expectedDigest: model.modelDigest,
    expectedQuantization: model.quantization,
    contextTokens: CONTEXT_ATTEMPT_TOKENS[0],
    gpuLayers: GPU_LAYERS,
  })
  const runtimeStatus = await runtime.inspect()
  if (runtimeStatus.state !== 'ready' || !runtimeStatus.model) {
    throw new Error(
      `Video semantic runtime is not ready: ${runtimeStatus.reason || runtimeStatus.state}`,
    )
  }

  const evidenceFrameIds = evidence.frames.map((frame) => frame.frameId)
  const authority = {
    generationId: `pilot-${pilotRevision}`,
    assetId: video.videoId,
    videoId: video.videoId,
    startMs: evidence.startMs,
    endMs: evidence.endMs,
    profileId,
    evidenceFrameIds,
    evidenceFrameDigest: sha256(evidenceFrameIds.join('\n')),
    modelId: runtimeStatus.model.modelId,
    modelRevision: runtimeStatus.model.modelRevision,
    quantization: runtimeStatus.model.quantization,
    sourceFingerprint: sha256(
      `${video.videoId}\0${video.sizeBytes}\0${video.mtimeMs}\0${video.durationMs}`,
    ),
    createdAt: Date.now(),
  }
  const prompt = buildVideoSemanticPrompt({
    authority,
    frames: evidence.frames.map((frame) => ({
      frameId: frame.frameId,
      timestampMs: frame.timestampMs,
    })),
  })
  const images = evidence.frames.map((frame) => ({
    frameId: frame.frameId,
    timestampMs: frame.timestampMs,
    mimeType: 'image/jpeg',
    dataBase64: fs.readFileSync(frame.imagePath).toString('base64'),
  }))

  const gpuSamples = []
  let peakRssBytes = process.memoryUsage().rss
  const capture = () => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss)
    const gpu = sampleGpu()
    if (gpu) gpuSamples.push(gpu)
  }
  capture()
  const interval = setInterval(capture, 750)
  const started = process.hrtime.bigint()
  let rawOutput
  let completedContextTokens
  let terminalRuntimeError
  const generationAttempts = []
  try {
    for (const contextTokens of CONTEXT_ATTEMPT_TOKENS) {
      const attemptRuntime =
        contextTokens === CONTEXT_ATTEMPT_TOKENS[0]
          ? runtime
          : new OllamaVideoSemanticRuntime({
              modelName: model.modelName,
              expectedDigest: model.modelDigest,
              expectedQuantization: model.quantization,
              contextTokens,
              gpuLayers: GPU_LAYERS,
            })
      const attemptStarted = process.hrtime.bigint()
      try {
        rawOutput = await attemptRuntime.generate({
          jobId: `pilot-${sampleId}`,
          plannedSegmentId: `pilot-${sampleId}`,
          prompt,
          images,
          maximumOutputTokens: 1_024,
          timeoutMs: 180_000,
        })
        completedContextTokens = contextTokens
        generationAttempts.push({
          contextTokens,
          latencyMs: Math.round(Number(process.hrtime.bigint() - attemptStarted) / 1_000_000),
          ok: true,
        })
        break
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown-runtime-error'
        generationAttempts.push({
          contextTokens,
          latencyMs: Math.round(Number(process.hrtime.bigint() - attemptStarted) / 1_000_000),
          ok: false,
          reason,
        })
        const isStrictOutputFailure =
          reason === 'Ollama chat response did not contain a JSON object'
        if (isStrictOutputFailure && contextTokens !== CONTEXT_ATTEMPT_TOKENS.at(-1)) continue
        if (isStrictOutputFailure) {
          terminalRuntimeError = reason
          break
        }
        throw error
      }
    }
  } finally {
    clearInterval(interval)
    capture()
  }
  if (typeof rawOutput !== 'string' && !terminalRuntimeError) {
    throw new Error('Ollama adaptive context attempts produced no output')
  }
  const latencyMs = Number(process.hrtime.bigint() - started) / 1_000_000
  const parsed =
    typeof rawOutput === 'string'
      ? parseVideoSemanticModelOutput(rawOutput, authority, prompt.transcriptRefs)
      : { ok: false, error: 'runtime-output-missing', warnings: [terminalRuntimeError] }
  const result = {
    schemaVersion: 1,
    pilotRevision,
    observedAt: new Date().toISOString(),
    sample: {
      sampleId,
      profileId,
      sizeBytes: video.sizeBytes,
      durationMs: video.durationMs,
      width: video.width,
      height: video.height,
      codec: video.videoCodec,
      segmentStartMs: evidence.startMs,
      segmentEndMs: evidence.endMs,
      evidenceFrameCount: evidence.frames.length,
      evidenceTimestampsMs: evidence.frames.map((frame) => frame.timestampMs),
    },
    runtime: runtimeStatus,
    configuration: {
      contextAttemptTokens: CONTEXT_ATTEMPT_TOKENS,
      completedContextTokens,
      gpuLayers: GPU_LAYERS,
      maximumEvidenceFrames: requestedFrames,
      minimumFreeGpuMiB: MINIMUM_FREE_GPU_MIB,
    },
    metrics: {
      latencyMs: Math.round(latencyMs),
      outputBytes: typeof rawOutput === 'string' ? Buffer.byteLength(rawOutput, 'utf8') : 0,
      outputSha256: typeof rawOutput === 'string' ? sha256(rawOutput) : undefined,
      peakProcessRssBytes: peakRssBytes,
      baselineGpuUsedMiB: gpuSamples[0]?.usedMiB,
      peakGpuUsedMiB: gpuSamples.length
        ? Math.max(...gpuSamples.map((sample) => sample.usedMiB))
        : undefined,
      peakGpuUtilizationPercent: gpuSamples.length
        ? Math.max(...gpuSamples.map((sample) => sample.utilizationPercent))
        : undefined,
      gpuTotalMiB: gpuSamples[0]?.totalMiB,
      generationAttempts,
    },
    parse: parsed,
    runtimeFailure: terminalRuntimeError,
    rawOutput: parsed.ok || typeof rawOutput !== 'string' ? undefined : rawOutput,
    privacy: {
      originalVideoRead: false,
      controlledCachedFramesOnly: true,
      originalPathRecorded: false,
      originalNameRecorded: false,
    },
    host: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model },
  }
  const outputDirectory = profileMode
    ? requestedResultSet
      ? requestedResultSet === FINAL_PROFILE_RESULT_SET
        ? 'qwen3-vl-2b-profile-final'
        : `qwen3-vl-2b-${requestedResultSet}`
      : 'qwen3-vl-2b-profile-v1'
    : requestedFrames === MAX_EVIDENCE_FRAMES
      ? 'qwen3-vl-2b-pilot-v6-adaptive'
      : `qwen3-vl-2b-pilot-v6-adaptive-f${requestedFrames}-canary`
  const outputRoot = path.join(mediaRoot, 'semantic', 'benchmarks', outputDirectory)
  fs.mkdirSync(outputRoot, { recursive: true })
  const outputFile = path.join(outputRoot, `${result.sample.sampleId}.json`)
  fs.writeFileSync(outputFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  console.log(
    JSON.stringify(
      {
        sampleId: result.sample.sampleId,
        sizeBytes: result.sample.sizeBytes,
        frameCount: result.sample.evidenceFrameCount,
        latencyMs: result.metrics.latencyMs,
        peakGpuUsedMiB: result.metrics.peakGpuUsedMiB,
        parseOk: parsed.ok,
        outputFile,
      },
      null,
      2,
    ),
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
