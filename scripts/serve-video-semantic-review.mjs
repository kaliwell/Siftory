#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  REVIEW_SAMPLES,
  REVIEW_SCHEMA_VERSION,
  createEmptyJudgment,
  normalizeJudgment,
  targetRange,
} from '../tools/video-semantic-review/model.mjs'
import {
  AUDIO_REVIEW_SAMPLE,
  AUDIO_REVIEW_SCHEMA_VERSION,
  normalizeAudioJudgment,
} from '../tools/video-semantic-review/audio-model.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const staticRoot = path.resolve(scriptDir, '..', 'tools', 'video-semantic-review')
const MAX_REQUEST_BYTES = 128 * 1024
const MAX_RESULT_BYTES = 2 * 1024 * 1024

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/model.mjs', ['model.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/audio', ['audio.html', 'text/html; charset=utf-8']],
  ['/audio.html', ['audio.html', 'text/html; charset=utf-8']],
  ['/audio-app.mjs', ['audio-app.mjs', 'text/javascript; charset=utf-8']],
  ['/audio-model.mjs', ['audio-model.mjs', 'text/javascript; charset=utf-8']],
])

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return []
  return fs
    .readFileSync(filePath, 'utf8')
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

function readBoundedJson(filePath, maximumBytes = MAX_RESULT_BYTES) {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size <= 0 || stat.size > maximumBytes) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function contentTypeFor(videoPath) {
  const extension = path.extname(videoPath).toLowerCase()
  if (extension === '.webm') return 'video/webm'
  if (extension === '.mov') return 'video/quicktime'
  if (extension === '.mkv') return 'video/x-matroska'
  if (extension === '.avi') return 'video/x-msvideo'
  return 'video/mp4'
}

function securityHeaders(response) {
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('X-Frame-Options', 'DENY')
}

function sendJson(response, statusCode, value) {
  securityHeaders(response)
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

function sendText(response, statusCode, value) {
  securityHeaders(response)
  response.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' })
  response.end(value)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    request.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_REQUEST_BYTES) {
        reject(new Error('request-too-large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid-json'))
      }
    })
    request.on('error', reject)
  })
}

function loadReviewFile(reviewFile) {
  const parsed = readBoundedJson(reviewFile, MAX_REQUEST_BYTES)
  const source = parsed?.judgments && typeof parsed.judgments === 'object' ? parsed.judgments : {}
  const judgments = {}
  for (const sample of REVIEW_SAMPLES) {
    judgments[sample.sampleId] = normalizeJudgment(source[sample.sampleId])
  }
  return { schemaVersion: REVIEW_SCHEMA_VERSION, updatedAt: parsed?.updatedAt ?? null, judgments }
}

function loadAudioReviewFile(reviewFile) {
  const parsed = readBoundedJson(reviewFile, MAX_REQUEST_BYTES)
  const source = parsed?.judgments && typeof parsed.judgments === 'object' ? parsed.judgments : {}
  const judgments = {}
  for (const [segmentId, judgment] of Object.entries(source)) {
    if (/^turn-\d{2,3}$/.test(segmentId)) judgments[segmentId] = normalizeAudioJudgment(judgment)
  }
  return {
    schemaVersion: AUDIO_REVIEW_SCHEMA_VERSION,
    generationId: typeof parsed?.generationId === 'string' ? parsed.generationId : null,
    updatedAt: parsed?.updatedAt ?? null,
    judgments,
  }
}

function saveReviewFile(reviewFile, state) {
  fs.mkdirSync(path.dirname(reviewFile), { recursive: true })
  const stage = `${reviewFile}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  fs.writeFileSync(stage, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  try {
    fs.renameSync(stage, reviewFile)
  } finally {
    if (fs.existsSync(stage)) fs.rmSync(stage, { force: true })
  }
}

function resolveAuthorities(mediaRoot, resultsRoot) {
  const videos = readJsonLines(path.join(mediaRoot, 'manifests', 'video_files.jsonl'))
  const authorities = new Map()
  for (const definition of REVIEW_SAMPLES) {
    const video = videos.find(
      (candidate) =>
        typeof candidate.videoId === 'string' &&
        candidate.videoId.startsWith(definition.prefix) &&
        typeof candidate.path === 'string' &&
        !candidate.missing &&
        fs.existsSync(candidate.path),
    )
    const result = readBoundedJson(path.join(resultsRoot, `${definition.sampleId}.json`))
    const durationMs = Number(video?.durationMs) || definition.durationMs
    const range =
      Number.isSafeInteger(result?.sample?.segmentStartMs) &&
      Number.isSafeInteger(result?.sample?.segmentEndMs)
        ? { startMs: result.sample.segmentStartMs, endMs: result.sample.segmentEndMs }
        : targetRange(durationMs)
    authorities.set(definition.sampleId, { definition, video, result, range })
  }
  return authorities
}

function resolveAudioAuthority(mediaRoot) {
  const videos = readJsonLines(path.join(mediaRoot, 'manifests', 'video_files.jsonl'))
  const video = videos.find(
    (candidate) =>
      typeof candidate.videoId === 'string' &&
      candidate.videoId.startsWith(AUDIO_REVIEW_SAMPLE.prefix) &&
      typeof candidate.path === 'string' &&
      !candidate.missing &&
      fs.existsSync(candidate.path),
  )
  const job = readBoundedJson(path.join(mediaRoot, 'audio-semantic', 'build-job.json'))
  const jobVideo = Array.isArray(job?.videos)
    ? job.videos.find((candidate) => candidate?.videoId === video?.videoId)
    : null
  const transcript = video
    ? readBoundedJson(path.join(mediaRoot, 'transcripts', `asr-${video.videoId}.json`))
    : null
  const generationMatches =
    typeof job?.generationId === 'string' && transcript?.generationId === job.generationId
  const authoritative =
    Boolean(video) &&
    job?.state === 'completed' &&
    Boolean(jobVideo) &&
    generationMatches &&
    Array.isArray(transcript?.segments)
  const issue = !video
    ? 'anonymous-source-unavailable'
    : job?.state !== 'completed'
      ? 'audio-semantic-job-not-completed'
      : !jobVideo
        ? 'audio-semantic-job-video-mismatch'
        : !generationMatches
          ? 'transcript-generation-mismatch'
          : !Array.isArray(transcript?.segments)
            ? 'transcript-segments-unavailable'
            : null
  const rawSegments = authoritative ? transcript.segments.slice(0, 1_000) : []
  const segments = rawSegments.flatMap((segment, index) => {
    const startMs = Number(segment?.startMs)
    const endMs = Number(segment?.endMs)
    if (
      !Number.isSafeInteger(startMs) ||
      !Number.isSafeInteger(endMs) ||
      startMs < 0 ||
      endMs <= startMs
    )
      return []
    return [
      {
        segmentId: `turn-${String(index + 1).padStart(2, '0')}`,
        startMs,
        endMs,
        contextStartMs: Math.max(0, startMs - 350),
        contextEndMs: Math.min(Number(video.durationMs) || endMs + 350, endMs + 350),
        speakerId:
          typeof segment.speakerId === 'string' && segment.speakerId.length <= 80
            ? segment.speakerId
            : null,
        language:
          typeof segment.language === 'string'
            ? segment.language.slice(0, 40)
            : typeof transcript.language === 'string'
              ? transcript.language.slice(0, 40)
              : null,
        emotion: typeof segment.emotion === 'string' ? segment.emotion.slice(0, 40) : null,
        audioEvents: Array.isArray(segment.audioEvents)
          ? segment.audioEvents.filter((value) => typeof value === 'string').slice(0, 12)
          : [],
        transcriptText: typeof segment.text === 'string' ? segment.text.slice(0, 2_000) : '',
      },
    ]
  })
  const referenceSegments = Object.fromEntries(
    [...new Set(segments.map((segment) => segment.speakerId).filter(Boolean))].map((speakerId) => {
      const best = segments
        .filter((segment) => segment.speakerId === speakerId)
        .sort((left, right) => right.endMs - right.startMs - (left.endMs - left.startMs))[0]
      return [speakerId, best?.segmentId]
    }),
  )
  return {
    video,
    segments,
    referenceSegments,
    issue,
    metadata: {
      sampleId: AUDIO_REVIEW_SAMPLE.sampleId,
      available: authoritative,
      durationMs: Number(video?.durationMs) || Number(jobVideo?.durationMs) || 0,
      generationId: authoritative ? job.generationId : null,
      jobId: authoritative && typeof job.jobId === 'string' ? job.jobId : null,
      modelId: authoritative ? String(transcript.modelId || '') : '',
      modelRevision: authoritative ? String(transcript.modelRevision || '') : '',
      completedChunks: authoritative ? Number(job.completedSegments) || 0 : 0,
      totalChunks: authoritative ? Number(job.totalSegments) || 0 : 0,
      failedChunks: authoritative ? Number(job.failedSegments) || 0 : 0,
    },
  }
}

function publicSample(authority) {
  const { definition, video, result, range } = authority
  const parsed = result?.parse
  const candidate = parsed?.ok === true ? parsed.value : null
  return {
    sampleId: definition.sampleId,
    sizeLabel: definition.sizeLabel,
    durationMs: Number(video?.durationMs) || definition.durationMs,
    resolution:
      Number(video?.width) > 0 && Number(video?.height) > 0
        ? `${video.width}×${video.height}`
        : definition.resolution,
    codec: typeof video?.videoCodec === 'string' ? video.videoCodec : definition.codec,
    profile: definition.profile,
    available: Boolean(video),
    target: range,
    inference: {
      ok: parsed?.ok === true,
      error:
        parsed?.ok === false
          ? String(parsed.error || result?.runtimeFailure || 'strict-json-failed').slice(0, 500)
          : result
            ? undefined
            : 'benchmark-result-missing',
      candidate,
      latencyMs: Number.isFinite(result?.metrics?.latencyMs) ? result.metrics.latencyMs : undefined,
      peakGpuUsedMiB: Number.isFinite(result?.metrics?.peakGpuUsedMiB)
        ? result.metrics.peakGpuUsedMiB
        : undefined,
      model:
        parsed?.ok === true
          ? {
              modelId: candidate?.modelId,
              modelRevision: candidate?.modelRevision,
              quantization: candidate?.quantization,
            }
          : undefined,
    },
  }
}

function serveVideo(request, response, videoPath) {
  const stat = fs.statSync(videoPath)
  const total = stat.size
  const range = request.headers.range
  securityHeaders(response)
  response.setHeader('Accept-Ranges', 'bytes')
  response.setHeader('Content-Type', contentTypeFor(videoPath))
  if (!range) {
    response.writeHead(200, { 'Content-Length': total })
    if (request.method === 'HEAD') return response.end()
    fs.createReadStream(videoPath).pipe(response)
    return
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(range)
  const start = match ? Number(match[1]) : Number.NaN
  const requestedEnd = match?.[2]
    ? Number(match[2])
    : Math.min(total - 1, start + 4 * 1024 * 1024 - 1)
  const end = Math.min(total - 1, requestedEnd)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    response.writeHead(416, { 'Content-Range': `bytes */${total}` })
    response.end()
    return
  }
  response.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${total}`,
    'Content-Length': end - start + 1,
  })
  if (request.method === 'HEAD') return response.end()
  fs.createReadStream(videoPath, { start, end }).pipe(response)
}

export async function createVideoSemanticReviewServer(options = {}) {
  const mediaRoot = path.resolve(
    options.mediaRoot ||
      process.env.FLOATING_CLOCK_MEDIA_SEARCH_DIR ||
      path.join(process.env.APPDATA || '', 'floating-clock-electron', 'media-search'),
  )
  const resultsRoot = path.resolve(
    options.resultsRoot ||
      path.join(mediaRoot, 'semantic', 'benchmarks', 'qwen3-vl-2b-pilot-v6-adaptive'),
  )
  const reviewFile = path.resolve(
    options.reviewFile ||
      path.join(mediaRoot, 'semantic', 'reviews', 'qwen3-vl-2b-20-sample-review.json'),
  )
  const audioReviewFile = path.resolve(
    options.audioReviewFile ||
      path.join(mediaRoot, 'semantic', 'reviews', 'sensevoice-speaker-sample-a569-review.json'),
  )
  const token = options.token || crypto.randomBytes(24).toString('base64url')
  let reviewState = loadReviewFile(reviewFile)
  let audioReviewState = loadAudioReviewFile(audioReviewFile)

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    const authorized =
      request.headers['x-review-token'] === token || url.searchParams.get('token') === token
    const staticFile = STATIC_FILES.get(url.pathname)
    if (staticFile && request.method === 'GET') {
      const [relativePath, contentType] = staticFile
      securityHeaders(response)
      response.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      )
      response.writeHead(200, { 'Content-Type': contentType })
      fs.createReadStream(path.join(staticRoot, relativePath)).pipe(response)
      return
    }
    if (!url.pathname.startsWith('/api/')) return sendText(response, 404, 'Not found')
    if (!authorized) return sendJson(response, 403, { ok: false, error: 'invalid-review-token' })

    const authorities = resolveAuthorities(mediaRoot, resultsRoot)
    if (request.method === 'GET' && url.pathname === '/api/state') {
      return sendJson(response, 200, {
        ok: true,
        schemaVersion: REVIEW_SCHEMA_VERSION,
        samples: [...authorities.values()].map(publicSample),
        judgments: reviewState.judgments,
        updatedAt: reviewState.updatedAt,
        privacy: {
          loopbackOnly: true,
          originalPathsExposed: false,
          originalNamesExposed: false,
          reviewFileInsidePrivateMediaData: true,
        },
      })
    }

    const audioAuthority = resolveAudioAuthority(mediaRoot)
    if (request.method === 'GET' && url.pathname === '/api/audio/state') {
      const judgments = Object.fromEntries(
        audioAuthority.segments.map((segment) => [
          segment.segmentId,
          normalizeAudioJudgment(audioReviewState.judgments[segment.segmentId]),
        ]),
      )
      return sendJson(response, 200, {
        ok: true,
        schemaVersion: AUDIO_REVIEW_SCHEMA_VERSION,
        metadata: audioAuthority.metadata,
        issue: audioAuthority.issue,
        segments: audioAuthority.segments,
        referenceSegments: audioAuthority.referenceSegments,
        judgments,
        updatedAt: audioReviewState.updatedAt,
        privacy: {
          loopbackOnly: true,
          originalPathsExposed: false,
          originalNamesExposed: false,
          transcriptTextExported: false,
          reviewFileInsidePrivateMediaData: true,
        },
      })
    }

    if (
      (request.method === 'GET' || request.method === 'HEAD') &&
      url.pathname === `/api/audio/video/${AUDIO_REVIEW_SAMPLE.sampleId}`
    ) {
      const videoPath = audioAuthority.metadata.available ? audioAuthority.video?.path : null
      if (!videoPath || !fs.existsSync(videoPath))
        return sendText(response, 404, 'Audio review source unavailable')
      return serveVideo(request, response, videoPath)
    }

    const audioReviewMatch = /^\/api\/audio\/review\/(turn-\d{2,3})$/.exec(url.pathname)
    if (
      request.method === 'POST' &&
      audioReviewMatch &&
      audioAuthority.segments.some((segment) => segment.segmentId === audioReviewMatch[1])
    ) {
      try {
        const body = await readBody(request)
        const judgment = normalizeAudioJudgment(body?.judgment)
        if (body?.markReviewed === true) judgment.reviewedAt = new Date().toISOString()
        audioReviewState = {
          schemaVersion: AUDIO_REVIEW_SCHEMA_VERSION,
          generationId: audioAuthority.metadata.generationId,
          updatedAt: new Date().toISOString(),
          judgments: { ...audioReviewState.judgments, [audioReviewMatch[1]]: judgment },
        }
        saveReviewFile(audioReviewFile, audioReviewState)
        return sendJson(response, 200, {
          ok: true,
          judgment,
          updatedAt: audioReviewState.updatedAt,
        })
      } catch (error) {
        return sendJson(response, 400, {
          ok: false,
          error: error instanceof Error ? error.message : 'invalid-audio-review',
        })
      }
    }

    const videoMatch = /^\/api\/video\/(sample-[a-f0-9]{4})$/.exec(url.pathname)
    if ((request.method === 'GET' || request.method === 'HEAD') && videoMatch) {
      const videoPath = authorities.get(videoMatch[1])?.video?.path
      if (!videoPath || !fs.existsSync(videoPath))
        return sendText(response, 404, 'Video unavailable')
      return serveVideo(request, response, videoPath)
    }

    const reviewMatch = /^\/api\/review\/(sample-[a-f0-9]{4})$/.exec(url.pathname)
    if (request.method === 'POST' && reviewMatch && authorities.has(reviewMatch[1])) {
      try {
        const body = await readBody(request)
        const judgment = normalizeJudgment(body?.judgment)
        if (body?.markReviewed === true) judgment.reviewedAt = new Date().toISOString()
        reviewState = {
          schemaVersion: REVIEW_SCHEMA_VERSION,
          updatedAt: new Date().toISOString(),
          judgments: { ...reviewState.judgments, [reviewMatch[1]]: judgment },
        }
        saveReviewFile(reviewFile, reviewState)
        return sendJson(response, 200, {
          ok: true,
          judgment,
          updatedAt: reviewState.updatedAt,
        })
      } catch (error) {
        return sendJson(response, 400, {
          ok: false,
          error: error instanceof Error ? error.message : 'invalid-review',
        })
      }
    }
    return sendJson(response, 404, { ok: false, error: 'not-found' })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 4178, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  return {
    server,
    token,
    mediaRoot,
    reviewFile,
    audioReviewFile,
    url: `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`,
    audioUrl: `http://127.0.0.1:${port}/audio?token=${encodeURIComponent(token)}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const portText = process.argv.find((argument) => argument.startsWith('--port='))?.slice(7)
  const tokenText = process.argv.find((argument) => argument.startsWith('--token='))?.slice(8)
  const modeText = process.argv.find((argument) => argument.startsWith('--mode='))?.slice(7)
  const port = portText === undefined ? 4178 : Number(portText)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error('Use --port=0..65535')
  }
  if (tokenText !== undefined && !/^[A-Za-z0-9_-]{16,128}$/.test(tokenText)) {
    throw new Error('Use a 16-128 character URL-safe --token value')
  }
  if (modeText !== undefined && !['video', 'audio'].includes(modeText)) {
    throw new Error('Use --mode=video or --mode=audio')
  }
  const running = await createVideoSemanticReviewServer({
    port,
    ...(tokenText ? { token: tokenText } : {}),
  })
  const audioMode = modeText === 'audio'
  console.log(`\n${audioMode ? '音频说话人' : '视频语义'}人工验收网页已启动：`)
  console.log(audioMode ? running.audioUrl : running.url)
  console.log(`\n复核数据保存在：${audioMode ? running.audioReviewFile : running.reviewFile}`)
  console.log('仅监听 127.0.0.1；按 Ctrl+C 停止。\n')
  const close = async () => {
    await running.close()
    process.exit(0)
  }
  process.once('SIGINT', () => void close())
  process.once('SIGTERM', () => void close())
}
