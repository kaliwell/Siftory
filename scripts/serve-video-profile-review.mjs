#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PROFILE_REVIEW_SCHEMA_VERSION,
  VIDEO_PROFILES,
  normalizeProfileJudgment,
  summarizeSelectedProfileReview,
} from '../tools/video-semantic-review/profile-model.mjs'
import {
  BENCHMARK_REVIEW_SCHEMA_VERSION,
  normalizeBenchmarkJudgment,
  summarizeBenchmarkReview,
} from '../tools/video-semantic-review/benchmark-model.mjs'
import {
  REGRESSION_REVIEW_SCHEMA_VERSION,
  REGRESSION_SAMPLE_IDS,
  normalizeRegressionJudgment,
  summarizeRegressionReview,
} from '../tools/video-semantic-review/regression-model.mjs'

const MAX_REQUEST_BYTES = 128 * 1024
const MAX_CANDIDATES = 192
const MITIGATION_SAMPLE_IDS = Object.freeze([
  'candidate-ae6547234445',
  'candidate-04feba1e556c',
  'candidate-5b8d8fefcbd9',
  'candidate-d0eda23e1fcb',
  'candidate-42ffe764c25a',
  'candidate-82c306ae2374',
])
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const staticRoot = path.resolve(scriptDir, '..', 'tools', 'video-semantic-review')
const STATIC_FILES = new Map([
  ['/profiles', ['profiles.html', 'text/html; charset=utf-8']],
  ['/profiles.html', ['profiles.html', 'text/html; charset=utf-8']],
  ['/profile-app.mjs', ['profile-app.mjs', 'text/javascript; charset=utf-8']],
  ['/profile-model.mjs', ['profile-model.mjs', 'text/javascript; charset=utf-8']],
  ['/benchmark', ['benchmark.html', 'text/html; charset=utf-8']],
  ['/benchmark.html', ['benchmark.html', 'text/html; charset=utf-8']],
  ['/benchmark-app.mjs', ['benchmark-app.mjs', 'text/javascript; charset=utf-8']],
  ['/benchmark-model.mjs', ['benchmark-model.mjs', 'text/javascript; charset=utf-8']],
  ['/regression', ['regression.html', 'text/html; charset=utf-8']],
  ['/regression.html', ['regression.html', 'text/html; charset=utf-8']],
  ['/shadow', ['regression.html', 'text/html; charset=utf-8']],
  ['/shadow.html', ['regression.html', 'text/html; charset=utf-8']],
  ['/mitigation', ['regression.html', 'text/html; charset=utf-8']],
  ['/mitigation.html', ['regression.html', 'text/html; charset=utf-8']],
  ['/regression-app.mjs', ['regression-app.mjs', 'text/javascript; charset=utf-8']],
  ['/regression-model.mjs', ['regression-model.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
])
const PLAYABLE_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm'])
const GAP_PROFILE_IDS = Object.freeze(['meeting-interview-podcast', 'sports'])
const GAP_CATEGORY_PROFILES = new Map([
  ['02_meeting', 'meeting-interview-podcast'],
  ['03_sports', 'sports'],
  ['04_general', 'general'],
  ['05_surveillance', 'surveillance-fixed'],
])
const GAP_PROFILE_SETS = Object.freeze({
  'meeting-sports': Object.freeze({
    mode: 'gap',
    targetProfileIds: GAP_PROFILE_IDS,
    reviewFileName: 'video-profile-gap-corpus-review.json',
    presentation: Object.freeze({
      eyebrow: 'VAL-206 · 会议与体育缺口验收',
      title: '会议 / 体育精选样本',
      lede: '播放中间 20 秒，确认精选素材是否确实属于会议、访谈或体育。结果独立保存，不覆盖原 44 条基线。',
      exportFileName: 'video-profile-gap-corpus-summary.json',
    }),
  }),
  'final-coverage': Object.freeze({
    mode: 'gap-final-coverage',
    targetProfileIds: Object.freeze(['general', 'surveillance-fixed']),
    reviewFileName: 'video-profile-final-coverage-review.json',
    presentation: Object.freeze({
      eyebrow: 'VAL-212 · 最后覆盖缺口验收',
      title: '通用 / 固定监控精选样本',
      lede: '请完整观看或播放中间 20 秒，确认建议类型。监控组可能含事故或爆炸画面，如感不适请直接跳过。来源信息已隐藏，结果与会议/体育批次分开保存。',
      exportFileName: 'video-profile-final-coverage-summary.json',
    }),
  }),
})

export function resolveProfileReviewListenHost(value) {
  return value === 'lan' || value === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1'
}

function listLanAddresses() {
  return Object.values(os.networkInterfaces())
    .flatMap((entries) => entries || [])
    .filter(
      (entry) =>
        entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.'),
    )
    .map((entry) => entry.address)
    .filter((address, index, values) => values.indexOf(address) === index)
}

function readJsonLines(file) {
  try {
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
  } catch {
    return []
  }
}

function readBoundedJson(file) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_REQUEST_BYTES) return null
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function externalGapCandidate(record, videoPath, profileId) {
  if (record?.sourceType !== 'wikimedia-commons') return null
  const digest = String(record?.sha256 || '').toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(digest)) return null
  if (record.candidateId !== `candidate-${sha256(`profile-gap-external:${digest}`).slice(0, 12)}`)
    return null
  let sourcePage
  let sourceUrl
  try {
    sourcePage = new URL(String(record?.sourcePage || ''))
    sourceUrl = new URL(String(record?.sourceUrl || ''))
  } catch {
    return null
  }
  if (
    sourcePage.protocol !== 'https:' ||
    sourcePage.hostname !== 'commons.wikimedia.org' ||
    sourceUrl.protocol !== 'https:' ||
    sourceUrl.hostname !== 'upload.wikimedia.org'
  )
    return null
  if (!/^(?:CC BY(?:-SA)?|Public domain)/i.test(String(record?.license || ''))) return null
  const durationMs = Number(record?.durationMs)
  const width = Number(record?.width)
  const height = Number(record?.height)
  const sizeBytes = Number(record?.sizeBytes)
  let stat
  try {
    stat = fs.statSync(videoPath)
  } catch {
    return null
  }
  if (
    !stat.isFile() ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    stat.size !== sizeBytes ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 5_000 ||
    durationMs > 4 * 60 * 60_000 ||
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    width > 8_192 ||
    !Number.isSafeInteger(height) ||
    height <= 0 ||
    height > 8_192
  )
    return null
  const spanMs = Math.min(20_000, durationMs)
  const startMs = Math.max(0, Math.floor((durationMs - spanMs) / 2))
  return {
    sampleId: record.candidateId,
    videoId: `profile-gap-${digest.slice(0, 40)}`,
    videoPath,
    durationMs,
    width,
    height,
    videoCodec: String(record?.videoCodec || '').slice(0, 32),
    audioCodec: String(record?.audioCodec || '').slice(0, 32),
    durationBucket: durationBucket(durationMs),
    orientation: orientation(width, height),
    hasAudio: Boolean(record?.audioCodec),
    hasTranscript: false,
    proposedProfileId: profileId,
    proposalReason: '开放许可缺口素材（仍需人工确认）',
    target: { startMs, endMs: Math.min(durationMs, startMs + spanMs) },
  }
}

function durationBucket(durationMs) {
  if (durationMs < 120_000) return 'short'
  if (durationMs < 1_800_000) return 'medium'
  return 'long'
}

function orientation(width, height) {
  if (height > width * 1.08) return 'portrait'
  if (width > height * 1.08) return 'landscape'
  return 'square'
}

const HINTS = Object.freeze({
  'film-series-animation': ['movie', 'film', 'episode', 'season', 'anime', '电影', '剧集', '动漫'],
  'meeting-interview-podcast': ['meeting', 'interview', 'podcast', '会议', '访谈', '播客'],
  'course-tutorial-screen': [
    'course',
    'tutorial',
    'lesson',
    'screenrecord',
    '课程',
    '教程',
    '录屏',
  ],
  'game-stream': ['gameplay', 'gaming', 'game', 'stream', '游戏', '直播'],
  'surveillance-fixed': ['cctv', 'surveillance', 'camera', '监控', '摄像头'],
  sports: ['sport', 'match', 'football', 'basketball', 'soccer', '比赛', '足球', '篮球'],
  'short-form-vlog': ['short', 'vlog', 'reel', 'tiktok', '短视频', '竖屏'],
})

function proposedProfile(video) {
  const hintText = `${video.name || ''} ${video.path || ''}`.toLocaleLowerCase('zh-CN')
  for (const [profileId, hints] of Object.entries(HINTS)) {
    if (hints.some((hint) => hintText.includes(hint))) {
      return { profileId, reason: '文件弱提示（需人工确认）' }
    }
  }
  if (video.height > video.width * 1.08 || video.durationMs <= 180_000) {
    return { profileId: 'short-form-vlog', reason: '时长/横竖屏弱提示（需人工确认）' }
  }
  return { profileId: 'general', reason: '默认通用（需人工确认）' }
}

export function buildProfileCandidates(mediaRoot, maximum = MAX_CANDIDATES) {
  const manifests = path.join(mediaRoot, 'manifests')
  const transcriptRoot = path.join(mediaRoot, 'transcripts')
  const videos = readJsonLines(path.join(manifests, 'video_files.jsonl')).filter((video) => {
    const ext = path.extname(String(video.path || '')).toLowerCase()
    return (
      typeof video.videoId === 'string' &&
      typeof video.path === 'string' &&
      !video.missing &&
      video.metadataStatus === 'done' &&
      Number.isSafeInteger(video.durationMs) &&
      video.durationMs >= 5_000 &&
      Number(video.width) > 0 &&
      Number(video.height) > 0 &&
      PLAYABLE_EXTENSIONS.has(ext) &&
      fs.existsSync(video.path)
    )
  })
  const strata = new Map()
  const items = []
  for (const video of videos) {
    const transcriptPath = path.join(transcriptRoot, `asr-${video.videoId}.json`)
    const facts = {
      durationBucket: durationBucket(video.durationMs),
      orientation: orientation(video.width, video.height),
      hasAudio: Boolean(video.audioCodec),
      hasTranscript: fs.existsSync(transcriptPath),
    }
    const sourceKey = sha256(path.dirname(video.path).toLocaleLowerCase()).slice(0, 4)
    const key = [
      facts.durationBucket,
      facts.orientation,
      facts.hasAudio ? 'audio' : 'silent',
      facts.hasTranscript ? 'transcript' : 'no-transcript',
      sourceKey,
    ].join(':')
    const item = { video, facts }
    items.push(item)
    const values = strata.get(key) || []
    values.push(item)
    strata.set(key, values)
  }
  for (const values of strata.values()) {
    values.sort((left, right) =>
      sha256(`vid-016:${left.video.videoId}`).localeCompare(
        sha256(`vid-016:${right.video.videoId}`),
      ),
    )
  }
  const queues = [...strata.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, values]) => values)
  const selected = []
  const selectedIds = new Set()
  const stableItems = [...items].sort((left, right) =>
    sha256(`vid-016:${left.video.videoId}`).localeCompare(sha256(`vid-016:${right.video.videoId}`)),
  )
  const retain = (candidates, limit) => {
    for (const item of candidates) {
      if (selected.length >= maximum || limit <= 0) break
      if (selectedIds.has(item.video.videoId)) continue
      selected.push(item)
      selectedIds.add(item.video.videoId)
      limit -= 1
    }
  }
  retain(
    stableItems.filter((item) => item.facts.hasTranscript),
    maximum,
  )
  retain(
    stableItems.filter((item) => item.facts.durationBucket === 'long'),
    32,
  )
  retain(
    stableItems.filter((item) => item.facts.durationBucket === 'medium'),
    64,
  )
  while (selected.length < maximum && queues.some((queue) => queue.length)) {
    for (const queue of queues) {
      const item = queue.shift()
      if (item && !selectedIds.has(item.video.videoId)) {
        selected.push(item)
        selectedIds.add(item.video.videoId)
      }
      if (selected.length >= maximum) break
    }
  }
  return selected.map(({ video, facts }) => {
    const suggestion = proposedProfile(video)
    const spanMs = Math.min(20_000, video.durationMs)
    const startMs = Math.max(0, Math.floor((video.durationMs - spanMs) / 2))
    return {
      sampleId: `candidate-${sha256(`profile-review:${video.videoId}`).slice(0, 12)}`,
      videoId: video.videoId,
      videoPath: video.path,
      durationMs: video.durationMs,
      width: video.width,
      height: video.height,
      videoCodec: String(video.videoCodec || ''),
      audioCodec: String(video.audioCodec || ''),
      ...facts,
      proposedProfileId: suggestion.profileId,
      proposalReason: suggestion.reason,
      target: { startMs, endMs: Math.min(video.durationMs, startMs + spanMs) },
    }
  })
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export function buildProfileGapCandidates(
  mediaRoot,
  corpusRoot,
  targetProfileIds = GAP_PROFILE_IDS,
) {
  const resolvedRoot = path.resolve(corpusRoot)
  const manifest = readBoundedJson(path.join(resolvedRoot, 'local-curated-manifest.json'))
  if (!Array.isArray(manifest)) throw new Error('Gap corpus manifest is missing or invalid')
  const canonicalById = new Map(
    buildProfileCandidates(mediaRoot, 4_096).map((candidate) => [candidate.sampleId, candidate]),
  )
  const seen = new Set()
  const candidates = []
  for (const record of manifest) {
    const profileId = GAP_CATEGORY_PROFILES.get(record?.category)
    if (
      !profileId ||
      !targetProfileIds.includes(profileId) ||
      !/^candidate-[a-f0-9]{12}$/.test(String(record?.candidateId || ''))
    )
      continue
    const canonical = canonicalById.get(record.candidateId)
    const videoPath = path.resolve(String(record?.localPath || ''))
    if (
      seen.has(record.candidateId) ||
      !isPathInside(resolvedRoot, videoPath) ||
      !PLAYABLE_EXTENSIONS.has(path.extname(videoPath).toLowerCase()) ||
      !fs.existsSync(videoPath)
    )
      continue
    const candidate = canonical || externalGapCandidate(record, videoPath, profileId)
    if (!candidate) continue
    seen.add(record.candidateId)
    candidates.push({
      ...candidate,
      videoPath,
      proposedProfileId: profileId,
      proposalReason: canonical ? '精选缺口素材（仍需人工确认）' : candidate.proposalReason,
    })
  }
  return candidates
}

function publicCandidate(candidate) {
  return {
    sampleId: candidate.sampleId,
    durationMs: candidate.durationMs,
    resolution: `${candidate.width}×${candidate.height}`,
    videoCodec: candidate.videoCodec,
    audioCodec: candidate.audioCodec,
    durationBucket: candidate.durationBucket,
    orientation: candidate.orientation,
    hasAudio: candidate.hasAudio,
    hasTranscript: candidate.hasTranscript,
    proposedProfileId: candidate.proposedProfileId,
    proposalReason: candidate.proposalReason,
    target: candidate.target,
    available: fs.existsSync(candidate.videoPath),
  }
}

function resolveActiveProfileBenchmark(mediaRoot) {
  const benchmarkRoot = path.join(mediaRoot, 'semantic', 'benchmarks')
  const finalRoot = path.join(benchmarkRoot, 'qwen3-vl-2b-profile-final')
  const finalPlan = readBoundedJson(path.join(finalRoot, 'full-plan.json'))
  if (Array.isArray(finalPlan?.samples) && finalPlan.samples.length === 80) {
    return {
      root: finalRoot,
      plan: finalPlan,
      baselineRoot: path.join(benchmarkRoot, 'qwen3-vl-2b-profile-v1'),
    }
  }
  const root = path.join(benchmarkRoot, 'qwen3-vl-2b-profile-v1')
  return { root, plan: readBoundedJson(path.join(root, 'full-plan.json')), baselineRoot: null }
}

function readActiveProfileResult(root, baselineRoot, sampleId) {
  return (
    readBoundedJson(path.join(root, `${sampleId}.json`)) ||
    (baselineRoot ? readBoundedJson(path.join(baselineRoot, `${sampleId}.json`)) : null)
  )
}

function resolvePublicProfileBenchmarkStatus(mediaRoot) {
  const { root, plan, baselineRoot } = resolveActiveProfileBenchmark(mediaRoot)
  const job = readBoundedJson(path.join(root, 'full-job.json'))
  if (!job || !Array.isArray(plan?.samples)) {
    return { available: false, state: 'not-started', total: 0, completed: 0, failed: 0 }
  }
  let parsePassed = 0
  let resultCount = 0
  let totalLatencyMs = 0
  const perProfile = Object.fromEntries(
    VIDEO_PROFILES.map((profile) => [profile.id, { planned: 0, results: 0, parsePassed: 0 }]),
  )
  for (const sample of plan.samples) {
    if (!perProfile[sample.profileId]) continue
    perProfile[sample.profileId].planned += 1
    const result = readActiveProfileResult(root, baselineRoot, sample.sampleId)
    if (!result || result?.sample?.sampleId !== sample.sampleId) continue
    resultCount += 1
    perProfile[sample.profileId].results += 1
    if (result?.parse?.ok === true) {
      parsePassed += 1
      perProfile[sample.profileId].parsePassed += 1
    }
    if (Number.isFinite(result?.metrics?.latencyMs)) totalLatencyMs += result.metrics.latencyMs
  }
  return {
    available: true,
    state: String(job.state || 'unknown'),
    total: Number(job.total) || plan.samples.length,
    completed: Number(job.completed) || resultCount,
    failed: Number(job.failed) || 0,
    resultCount,
    parsePassed,
    averageLatencyMs: resultCount ? Math.round(totalLatencyMs / resultCount) : 0,
    currentSampleId: typeof job.currentSampleId === 'string' ? job.currentSampleId : null,
    coverage: job.coverage || plan.coverage || {},
    perProfile,
    updatedAt: job.updatedAt || null,
  }
}

function boundedStringList(value, maximumItems = 24, maximumLength = 240) {
  return Array.isArray(value)
    ? value
        .slice(0, maximumItems)
        .map((item) => String(item || '').slice(0, maximumLength))
        .filter(Boolean)
    : []
}

function publicSemanticResult(result) {
  const value =
    result?.parse?.ok === true && result.parse.value && typeof result.parse.value === 'object'
      ? result.parse.value
      : null
  if (!value) return null
  return {
    summary: String(value.summary || '').slice(0, 2_000),
    scenes: boundedStringList(value.scenes),
    events: Array.isArray(value.events)
      ? value.events.slice(0, 24).map((event) => ({
          label: String(event?.label || '').slice(0, 120),
          description: String(event?.description || '').slice(0, 1_000),
          startMs: Number.isFinite(event?.startMs) ? Math.max(0, Math.round(event.startMs)) : 0,
          endMs: Number.isFinite(event?.endMs) ? Math.max(0, Math.round(event.endMs)) : 0,
          confidence: Number.isFinite(event?.confidence) ? event.confidence : null,
        }))
      : [],
    persons: Array.isArray(value.persons)
      ? value.persons
          .slice(0, 20)
          .map((person) => {
            const description = String(person?.description || '').slice(0, 500)
            const actions = boundedStringList(person?.actions, 12, 120)
            return [description, actions.length ? `动作：${actions.join('、')}` : '']
              .filter(Boolean)
              .join('；')
          })
          .filter(Boolean)
      : [],
    objects: boundedStringList(value.objects),
    visualText: boundedStringList(value.visualText, 24, 500),
    searchTags: boundedStringList(value.searchTags),
    warnings: boundedStringList(value.warnings, 12, 800),
  }
}

function resolveProfileBenchmarkAuthorities(mediaRoot, candidates) {
  const { root, plan, baselineRoot } = resolveActiveProfileBenchmark(mediaRoot)
  const byId = new Map(candidates.map((candidate) => [candidate.sampleId, candidate]))
  if (!Array.isArray(plan?.samples)) return { root, plan: null, samples: [], byId }
  const samples = plan.samples.flatMap((planned) => {
    if (!/^candidate-[a-f0-9]{12}$/.test(String(planned?.sampleId || ''))) return []
    const candidate = byId.get(planned.sampleId)
    if (!candidate || !fs.existsSync(candidate.videoPath)) return []
    const profile = VIDEO_PROFILES.find((item) => item.id === planned.profileId)
    if (!profile) return []
    const result = readActiveProfileResult(root, baselineRoot, planned.sampleId)
    const semanticResult =
      result?.sample?.sampleId === planned.sampleId ? publicSemanticResult(result) : null
    const startMs = Number.isFinite(result?.sample?.segmentStartMs)
      ? result.sample.segmentStartMs
      : candidate.target.startMs
    const endMs = Number.isFinite(result?.sample?.segmentEndMs)
      ? result.sample.segmentEndMs
      : candidate.target.endMs
    return [
      {
        sampleId: planned.sampleId,
        profileId: profile.id,
        profileLabel: profile.shortLabel,
        resultState: semanticResult ? 'ready' : result ? 'invalid' : 'pending',
        target: {
          startMs: Math.max(0, Math.round(startMs)),
          endMs: Math.max(0, Math.round(endMs)),
        },
        result: semanticResult,
        latencyMs: Number.isFinite(result?.metrics?.latencyMs)
          ? Math.max(0, Math.round(result.metrics.latencyMs))
          : 0,
        peakGpuUsedMiB: Number.isFinite(result?.metrics?.peakGpuUsedMiB)
          ? Math.max(0, Math.round(result.metrics.peakGpuUsedMiB))
          : 0,
        modelLabel: String(result?.runtime?.model?.modelId || 'qwen3-vl:2b').slice(0, 120),
      },
    ]
  })
  return { root, plan, samples, byId }
}

function publicSemanticRun(result) {
  const semanticResult = publicSemanticResult(result)
  return {
    resultState: semanticResult ? 'ready' : result ? 'invalid' : 'pending',
    result: semanticResult,
    latencyMs: Number.isFinite(result?.metrics?.latencyMs)
      ? Math.max(0, Math.round(result.metrics.latencyMs))
      : 0,
    peakGpuUsedMiB: Number.isFinite(result?.metrics?.peakGpuUsedMiB)
      ? Math.max(0, Math.round(result.metrics.peakGpuUsedMiB))
      : 0,
    promptVersion: String(result?.parse?.value?.promptVersion || 'unknown').slice(0, 80),
  }
}

function semanticRunDifference(v1, v7) {
  const fields = [
    ['summary', 4],
    ['scenes', 2],
    ['events', 4],
    ['persons', 3],
    ['objects', 2],
    ['visualText', 2],
    ['searchTags', 1],
    ['warnings', 1],
  ]
  const changedFields = fields
    .filter(
      ([field]) =>
        JSON.stringify(v1.result?.[field] ?? null) !== JSON.stringify(v7.result?.[field] ?? null),
    )
    .map(([field]) => field)
  return {
    changedFields,
    changeScore: fields
      .filter(([field]) => changedFields.includes(field))
      .reduce((sum, [, weight]) => sum + weight, 0),
  }
}

function resolveProfileRegressionAuthorities(
  mediaRoot,
  candidates,
  baselineJudgments,
  sampleIds = REGRESSION_SAMPLE_IDS,
  resultDirectory = 'qwen3-vl-2b-profile-v3-regression',
  baselineDirectory = 'qwen3-vl-2b-profile-v1',
) {
  const benchmarkRoot = path.join(mediaRoot, 'semantic', 'benchmarks', baselineDirectory)
  const regressionRoot = path.join(mediaRoot, 'semantic', 'benchmarks', resultDirectory)
  const plan = readBoundedJson(path.join(benchmarkRoot, 'full-plan.json'))
  const plannedById = new Map(
    Array.isArray(plan?.samples) ? plan.samples.map((sample) => [sample.sampleId, sample]) : [],
  )
  const byId = new Map(candidates.map((candidate) => [candidate.sampleId, candidate]))
  const samples = sampleIds.flatMap((sampleId) => {
    const planned = plannedById.get(sampleId)
    const candidate = byId.get(sampleId)
    const profile = VIDEO_PROFILES.find((item) => item.id === planned?.profileId)
    if (!planned || !candidate || !profile || !fs.existsSync(candidate.videoPath)) return []
    const v1Result = readBoundedJson(path.join(benchmarkRoot, `${sampleId}.json`))
    const v7Result = readBoundedJson(path.join(regressionRoot, `${sampleId}.json`))
    const v1 =
      v1Result?.sample?.sampleId === sampleId
        ? publicSemanticRun(v1Result)
        : publicSemanticRun(null)
    const v7 =
      v7Result?.sample?.sampleId === sampleId
        ? publicSemanticRun(v7Result)
        : publicSemanticRun(null)
    const startMs = Number.isFinite(v7Result?.sample?.segmentStartMs)
      ? v7Result.sample.segmentStartMs
      : (planned.target?.startMs ?? candidate.target.startMs)
    const endMs = Number.isFinite(v7Result?.sample?.segmentEndMs)
      ? v7Result.sample.segmentEndMs
      : (planned.target?.endMs ?? candidate.target.endMs)
    return [
      {
        sampleId,
        profileId: profile.id,
        profileLabel: profile.shortLabel,
        baselineVerdict: normalizeBenchmarkJudgment(baselineJudgments?.[sampleId]).verdict,
        target: {
          startMs: Math.max(0, Math.round(startMs)),
          endMs: Math.max(0, Math.round(endMs)),
        },
        resolution: `${candidate.width}×${candidate.height}`,
        orientation: candidate.orientation,
        sourceAspectRatio: Number((candidate.width / candidate.height).toFixed(6)),
        difference: semanticRunDifference(v1, v7),
        v1,
        v7,
      },
    ]
  })
  return { samples, byId }
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

function serveVideo(request, response, videoPath) {
  const stat = fs.statSync(videoPath)
  const total = stat.size
  const range = request.headers.range
  securityHeaders(response)
  response.setHeader('Accept-Ranges', 'bytes')
  response.setHeader(
    'Content-Type',
    path.extname(videoPath).toLowerCase() === '.webm' ? 'video/webm' : 'video/mp4',
  )
  if (!range) {
    response.writeHead(200, { 'Content-Length': total })
    if (request.method === 'HEAD') return response.end()
    return fs.createReadStream(videoPath).pipe(response)
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(range)
  const start = match ? Number(match[1]) : Number.NaN
  const requestedEnd = match?.[2]
    ? Number(match[2])
    : Math.min(total - 1, start + 4 * 1024 * 1024 - 1)
  const end = Math.min(total - 1, requestedEnd)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    response.writeHead(416, { 'Content-Range': `bytes */${total}` })
    return response.end()
  }
  response.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${total}`,
    'Content-Length': end - start + 1,
  })
  if (request.method === 'HEAD') return response.end()
  fs.createReadStream(videoPath, { start, end }).pipe(response)
}

export async function createVideoProfileReviewServer(options = {}) {
  const mediaRoot = path.resolve(
    options.mediaRoot ||
      process.env.FLOATING_CLOCK_MEDIA_SEARCH_DIR ||
      path.join(process.env.APPDATA || '', 'floating-clock-electron', 'media-search'),
  )
  const gapCorpusRoot = options.gapCorpusRoot ? path.resolve(options.gapCorpusRoot) : null
  const gapMode = Boolean(gapCorpusRoot)
  const gapProfileSet = gapMode ? options.gapProfileSet || 'meeting-sports' : null
  const gapConfiguration = gapMode ? GAP_PROFILE_SETS[gapProfileSet] : null
  if (gapMode && !gapConfiguration) {
    throw new Error(`Unknown gap profile set: ${gapProfileSet}`)
  }
  const targetProfileIds = gapMode
    ? gapConfiguration.targetProfileIds
    : VIDEO_PROFILES.map((profile) => profile.id)
  const activeProfiles = VIDEO_PROFILES.filter((profile) => targetProfileIds.includes(profile.id))
  const reviewFile = path.resolve(
    options.reviewFile ||
      path.join(
        mediaRoot,
        'semantic',
        'reviews',
        gapMode ? gapConfiguration.reviewFileName : 'video-profile-corpus-review.json',
      ),
  )
  const benchmarkReviewFile = path.resolve(
    options.benchmarkReviewFile ||
      path.join(mediaRoot, 'semantic', 'reviews', 'video-profile-semantic-review.json'),
  )
  const regressionReviewFile = path.resolve(
    options.regressionReviewFile ||
      path.join(mediaRoot, 'semantic', 'reviews', 'video-profile-regression-review.json'),
  )
  const shadowReviewFile = path.resolve(
    options.shadowReviewFile ||
      path.join(mediaRoot, 'semantic', 'reviews', 'video-profile-shadow-review.json'),
  )
  const mitigationReviewFile = path.resolve(
    options.mitigationReviewFile ||
      path.join(mediaRoot, 'semantic', 'reviews', 'video-profile-v8-mitigation-review.json'),
  )
  const token = options.token || crypto.randomBytes(24).toString('base64url')
  const listenHost = resolveProfileReviewListenHost(options.host)
  const lanAccessEnabled = listenHost === '0.0.0.0'
  const candidates = gapMode
    ? buildProfileGapCandidates(mediaRoot, gapCorpusRoot, targetProfileIds)
    : buildProfileCandidates(mediaRoot, options.maximumCandidates ?? MAX_CANDIDATES)
  const profileCorpusRoot = path.resolve(
    options.profileCorpusRoot || process.env.VIDEO_GAP_CORPUS || '<VIDEO_GAP_CORPUS>',
  )
  const benchmarkCandidates = gapMode
    ? candidates
    : [
        ...new Map(
          [
            ...buildProfileCandidates(mediaRoot, 4_096),
            ...(fs.existsSync(profileCorpusRoot)
              ? buildProfileGapCandidates(
                  mediaRoot,
                  profileCorpusRoot,
                  VIDEO_PROFILES.map((profile) => profile.id),
                )
              : []),
          ].map((candidate) => [candidate.sampleId, candidate]),
        ).values(),
      ]
  const byId = new Map(candidates.map((candidate) => [candidate.sampleId, candidate]))
  const parsed = readBoundedJson(reviewFile)
  let reviewState = {
    schemaVersion: PROFILE_REVIEW_SCHEMA_VERSION,
    updatedAt: parsed?.updatedAt ?? null,
    judgments: Object.fromEntries(
      candidates.map((candidate) => [
        candidate.sampleId,
        normalizeProfileJudgment(parsed?.judgments?.[candidate.sampleId]),
      ]),
    ),
  }
  const parsedBenchmarkReview = readBoundedJson(benchmarkReviewFile)
  let benchmarkReviewState = {
    schemaVersion: BENCHMARK_REVIEW_SCHEMA_VERSION,
    updatedAt: parsedBenchmarkReview?.updatedAt ?? null,
    judgments: {},
  }
  const parsedRegressionReview = readBoundedJson(regressionReviewFile)
  let regressionReviewState = {
    schemaVersion: REGRESSION_REVIEW_SCHEMA_VERSION,
    updatedAt: parsedRegressionReview?.updatedAt ?? null,
    judgments: {},
  }
  const parsedShadowReview = readBoundedJson(shadowReviewFile)
  let shadowReviewState = {
    schemaVersion: REGRESSION_REVIEW_SCHEMA_VERSION,
    updatedAt: parsedShadowReview?.updatedAt ?? null,
    judgments: {},
  }
  const parsedMitigationReview = readBoundedJson(mitigationReviewFile)
  let mitigationReviewState = {
    schemaVersion: REGRESSION_REVIEW_SCHEMA_VERSION,
    updatedAt: parsedMitigationReview?.updatedAt ?? null,
    judgments: {},
  }
  const benchmarkAuthorities = () =>
    resolveProfileBenchmarkAuthorities(mediaRoot, benchmarkCandidates)
  const regressionAuthorities = () =>
    resolveProfileRegressionAuthorities(
      mediaRoot,
      candidates,
      {
        ...(parsedBenchmarkReview?.judgments || {}),
        ...(benchmarkReviewState.judgments || {}),
      },
      options.regressionSampleIds || REGRESSION_SAMPLE_IDS,
    )
  const shadowAuthorities = () => {
    const baselinePlan = readBoundedJson(
      path.join(mediaRoot, 'semantic', 'benchmarks', 'qwen3-vl-2b-profile-v1', 'full-plan.json'),
    )
    const sampleIds = Array.isArray(baselinePlan?.samples)
      ? baselinePlan.samples.map((sample) => sample.sampleId)
      : []
    return resolveProfileRegressionAuthorities(
      mediaRoot,
      candidates,
      {
        ...(parsedBenchmarkReview?.judgments || {}),
        ...(benchmarkReviewState.judgments || {}),
      },
      sampleIds,
      'qwen3-vl-2b-profile-v7-shadow',
    )
  }
  const mitigationAuthorities = () =>
    resolveProfileRegressionAuthorities(
      mediaRoot,
      candidates,
      {},
      options.mitigationSampleIds || MITIGATION_SAMPLE_IDS,
      'qwen3-vl-2b-profile-v8-mitigation',
      'qwen3-vl-2b-profile-v7-shadow',
    )
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    const staticFile = STATIC_FILES.get(url.pathname)
    if (staticFile && request.method === 'GET') {
      const [relativePath, contentType] = staticFile
      securityHeaders(response)
      response.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      )
      response.writeHead(200, { 'Content-Type': contentType })
      return fs.createReadStream(path.join(staticRoot, relativePath)).pipe(response)
    }
    if (!url.pathname.startsWith('/api/profile/')) return sendText(response, 404, 'Not found')
    const authorized =
      request.headers['x-review-token'] === token || url.searchParams.get('token') === token
    if (!authorized) return sendJson(response, 403, { ok: false, error: 'invalid-review-token' })
    if (request.method === 'GET' && url.pathname === '/api/profile/state') {
      const samples = candidates.map(publicCandidate)
      return sendJson(response, 200, {
        ok: true,
        schemaVersion: PROFILE_REVIEW_SCHEMA_VERSION,
        profiles: activeProfiles,
        targetProfileIds,
        targetPerProfile: 10,
        mode: gapMode ? gapConfiguration.mode : 'full',
        presentation: gapMode
          ? gapConfiguration.presentation
          : {
              eyebrow: 'VID-016 · 真实素材分层验收',
              title: '多类型视频样本库',
              lede: '播放中间20秒，确认它属于哪一类。每类满10条后，才会进入Qwen召回、幻觉和时间点基准。',
              exportFileName: 'video-profile-corpus-summary.json',
            },
        samples,
        judgments: reviewState.judgments,
        summary: summarizeSelectedProfileReview(
          samples,
          reviewState.judgments,
          10,
          targetProfileIds,
        ),
        updatedAt: reviewState.updatedAt,
        privacy: {
          loopbackOnly: !lanAccessEnabled,
          lanAccessEnabled,
          tokenRequired: true,
          originalPathsExposed: false,
          originalNamesExposed: false,
        },
      })
    }
    if (request.method === 'GET' && url.pathname === '/api/profile/benchmark/state') {
      return sendJson(response, 200, {
        ok: true,
        benchmark: resolvePublicProfileBenchmarkStatus(mediaRoot),
      })
    }
    if (request.method === 'GET' && url.pathname === '/api/profile/benchmark/review-state') {
      const authorities = benchmarkAuthorities()
      benchmarkReviewState.judgments = Object.fromEntries(
        authorities.samples.map((sample) => [
          sample.sampleId,
          normalizeBenchmarkJudgment(
            benchmarkReviewState.judgments[sample.sampleId] ||
              parsedBenchmarkReview?.judgments?.[sample.sampleId],
          ),
        ]),
      )
      return sendJson(response, 200, {
        ok: true,
        schemaVersion: BENCHMARK_REVIEW_SCHEMA_VERSION,
        profiles: VIDEO_PROFILES,
        samples: authorities.samples,
        judgments: benchmarkReviewState.judgments,
        summary: summarizeBenchmarkReview(authorities.samples, benchmarkReviewState.judgments),
        benchmark: resolvePublicProfileBenchmarkStatus(mediaRoot),
        updatedAt: benchmarkReviewState.updatedAt,
        privacy: {
          tokenRequired: true,
          originalPathsExposed: false,
          originalNamesExposed: false,
          rawModelOutputExposed: false,
        },
      })
    }
    if (request.method === 'GET' && url.pathname === '/api/profile/benchmark/regression-state') {
      const authorities = regressionAuthorities()
      regressionReviewState.judgments = Object.fromEntries(
        authorities.samples.map((sample) => [
          sample.sampleId,
          normalizeRegressionJudgment(
            regressionReviewState.judgments[sample.sampleId] ||
              parsedRegressionReview?.judgments?.[sample.sampleId],
          ),
        ]),
      )
      return sendJson(response, 200, {
        ok: true,
        schemaVersion: REGRESSION_REVIEW_SCHEMA_VERSION,
        samples: authorities.samples,
        judgments: regressionReviewState.judgments,
        summary: summarizeRegressionReview(authorities.samples, regressionReviewState.judgments),
        updatedAt: regressionReviewState.updatedAt,
        note: 'V7 为真实复测存档；正式索引还会应用最新确定性后处理守卫。',
        privacy: {
          tokenRequired: true,
          originalPathsExposed: false,
          originalNamesExposed: false,
          rawModelOutputExposed: false,
          privateNotesExposedOnlyToThisReviewSession: true,
        },
      })
    }
    if (request.method === 'GET' && url.pathname === '/api/profile/benchmark/shadow-state') {
      const authorities = shadowAuthorities()
      shadowReviewState.judgments = Object.fromEntries(
        authorities.samples.map((sample) => [
          sample.sampleId,
          normalizeRegressionJudgment(
            shadowReviewState.judgments[sample.sampleId] ||
              parsedShadowReview?.judgments?.[sample.sampleId],
          ),
        ]),
      )
      return sendJson(response, 200, {
        ok: true,
        schemaVersion: REGRESSION_REVIEW_SCHEMA_VERSION,
        samples: authorities.samples,
        judgments: shadowReviewState.judgments,
        summary: summarizeRegressionReview(authorities.samples, shadowReviewState.judgments),
        updatedAt: shadowReviewState.updatedAt,
        note: 'V7影子结果与V1使用同一冻结计划；请重点确认原“像”样本没有退化。',
        privacy: {
          tokenRequired: true,
          originalPathsExposed: false,
          originalNamesExposed: false,
          rawModelOutputExposed: false,
          privateNotesExposedOnlyToThisReviewSession: true,
        },
      })
    }
    if (request.method === 'GET' && url.pathname === '/api/profile/benchmark/mitigation-state') {
      const authorities = mitigationAuthorities()
      mitigationReviewState.judgments = Object.fromEntries(
        authorities.samples.map((sample) => [
          sample.sampleId,
          normalizeRegressionJudgment(
            mitigationReviewState.judgments[sample.sampleId] ||
              parsedMitigationReview?.judgments?.[sample.sampleId],
          ),
        ]),
      )
      return sendJson(response, 200, {
        ok: true,
        schemaVersion: REGRESSION_REVIEW_SCHEMA_VERSION,
        samples: authorities.samples,
        judgments: mitigationReviewState.judgments,
        summary: summarizeRegressionReview(authorities.samples, mitigationReviewState.judgments),
        updatedAt: mitigationReviewState.updatedAt,
        note: '左侧为V7影子存档，右侧为V8.1定向缓解结果；偏好字段内部沿用v1=左、v7=右以保持旧导出兼容。',
        privacy: {
          tokenRequired: true,
          originalPathsExposed: false,
          originalNamesExposed: false,
          rawModelOutputExposed: false,
          privateNotesExposedOnlyToThisReviewSession: true,
        },
      })
    }
    const benchmarkVideoMatch = /^\/api\/profile\/benchmark\/video\/(candidate-[a-f0-9]{12})$/.exec(
      url.pathname,
    )
    if ((request.method === 'GET' || request.method === 'HEAD') && benchmarkVideoMatch) {
      const authorities = benchmarkAuthorities()
      const planned = authorities.samples.find(
        (sample) => sample.sampleId === benchmarkVideoMatch[1],
      )
      const candidate = authorities.byId.get(benchmarkVideoMatch[1])
      if (
        !planned ||
        planned.resultState !== 'ready' ||
        !candidate ||
        !fs.existsSync(candidate.videoPath)
      )
        return sendText(response, 404, 'Benchmark video unavailable')
      return serveVideo(request, response, candidate.videoPath)
    }
    const benchmarkReviewMatch =
      /^\/api\/profile\/benchmark\/review\/(candidate-[a-f0-9]{12})$/.exec(url.pathname)
    if (request.method === 'POST' && benchmarkReviewMatch) {
      const authorities = benchmarkAuthorities()
      const sample = authorities.samples.find((item) => item.sampleId === benchmarkReviewMatch[1])
      if (!sample || sample.resultState !== 'ready')
        return sendJson(response, 409, { ok: false, error: 'benchmark-result-not-ready' })
      try {
        const body = await readBody(request)
        const judgment = normalizeBenchmarkJudgment(body?.judgment)
        if (body?.markReviewed === true && judgment.verdict !== 'unreviewed')
          judgment.reviewedAt = new Date().toISOString()
        benchmarkReviewState = {
          schemaVersion: BENCHMARK_REVIEW_SCHEMA_VERSION,
          updatedAt: new Date().toISOString(),
          judgments: { ...benchmarkReviewState.judgments, [sample.sampleId]: judgment },
        }
        saveReviewFile(benchmarkReviewFile, benchmarkReviewState)
        return sendJson(response, 200, {
          ok: true,
          judgment,
          updatedAt: benchmarkReviewState.updatedAt,
        })
      } catch (error) {
        return sendJson(response, 400, {
          ok: false,
          error: error instanceof Error ? error.message : 'invalid-benchmark-review',
        })
      }
    }
    const regressionReviewMatch =
      /^\/api\/profile\/benchmark\/regression-review\/(candidate-[a-f0-9]{12})$/.exec(url.pathname)
    if (request.method === 'POST' && regressionReviewMatch) {
      const authorities = regressionAuthorities()
      const sample = authorities.samples.find((item) => item.sampleId === regressionReviewMatch[1])
      if (!sample || sample.v1.resultState !== 'ready' || sample.v7.resultState !== 'ready')
        return sendJson(response, 409, { ok: false, error: 'regression-result-not-ready' })
      try {
        const body = await readBody(request)
        const judgment = normalizeRegressionJudgment(body?.judgment)
        if (
          body?.markReviewed === true &&
          judgment.verdict !== 'unreviewed' &&
          judgment.preferredOutput !== 'unselected'
        )
          judgment.reviewedAt = new Date().toISOString()
        regressionReviewState = {
          schemaVersion: REGRESSION_REVIEW_SCHEMA_VERSION,
          updatedAt: new Date().toISOString(),
          judgments: { ...regressionReviewState.judgments, [sample.sampleId]: judgment },
        }
        saveReviewFile(regressionReviewFile, regressionReviewState)
        return sendJson(response, 200, {
          ok: true,
          judgment,
          updatedAt: regressionReviewState.updatedAt,
        })
      } catch (error) {
        return sendJson(response, 400, {
          ok: false,
          error: error instanceof Error ? error.message : 'invalid-regression-review',
        })
      }
    }
    const shadowReviewMatch =
      /^\/api\/profile\/benchmark\/shadow-review\/(candidate-[a-f0-9]{12})$/.exec(url.pathname)
    if (request.method === 'POST' && shadowReviewMatch) {
      const authorities = shadowAuthorities()
      const sample = authorities.samples.find((item) => item.sampleId === shadowReviewMatch[1])
      if (!sample || sample.v1.resultState !== 'ready' || sample.v7.resultState !== 'ready')
        return sendJson(response, 409, { ok: false, error: 'shadow-result-not-ready' })
      try {
        const body = await readBody(request)
        const judgment = normalizeRegressionJudgment(body?.judgment)
        if (
          body?.markReviewed === true &&
          judgment.verdict !== 'unreviewed' &&
          judgment.preferredOutput !== 'unselected'
        )
          judgment.reviewedAt = new Date().toISOString()
        shadowReviewState = {
          schemaVersion: REGRESSION_REVIEW_SCHEMA_VERSION,
          updatedAt: new Date().toISOString(),
          judgments: { ...shadowReviewState.judgments, [sample.sampleId]: judgment },
        }
        saveReviewFile(shadowReviewFile, shadowReviewState)
        return sendJson(response, 200, {
          ok: true,
          judgment,
          updatedAt: shadowReviewState.updatedAt,
        })
      } catch (error) {
        return sendJson(response, 400, {
          ok: false,
          error: error instanceof Error ? error.message : 'invalid-shadow-review',
        })
      }
    }
    const mitigationReviewMatch =
      /^\/api\/profile\/benchmark\/mitigation-review\/(candidate-[a-f0-9]{12})$/.exec(url.pathname)
    if (request.method === 'POST' && mitigationReviewMatch) {
      const authorities = mitigationAuthorities()
      const sample = authorities.samples.find((item) => item.sampleId === mitigationReviewMatch[1])
      if (!sample || sample.v1.resultState !== 'ready' || sample.v7.resultState !== 'ready')
        return sendJson(response, 409, { ok: false, error: 'mitigation-result-not-ready' })
      try {
        const body = await readBody(request)
        const judgment = normalizeRegressionJudgment(body?.judgment)
        if (
          body?.markReviewed === true &&
          judgment.verdict !== 'unreviewed' &&
          judgment.preferredOutput !== 'unselected'
        )
          judgment.reviewedAt = new Date().toISOString()
        mitigationReviewState = {
          schemaVersion: REGRESSION_REVIEW_SCHEMA_VERSION,
          updatedAt: new Date().toISOString(),
          judgments: { ...mitigationReviewState.judgments, [sample.sampleId]: judgment },
        }
        saveReviewFile(mitigationReviewFile, mitigationReviewState)
        return sendJson(response, 200, {
          ok: true,
          judgment,
          updatedAt: mitigationReviewState.updatedAt,
        })
      } catch (error) {
        return sendJson(response, 400, {
          ok: false,
          error: error instanceof Error ? error.message : 'invalid-mitigation-review',
        })
      }
    }
    const videoMatch = /^\/api\/profile\/video\/(candidate-[a-f0-9]{12})$/.exec(url.pathname)
    if ((request.method === 'GET' || request.method === 'HEAD') && videoMatch) {
      const candidate = byId.get(videoMatch[1])
      if (!candidate || !fs.existsSync(candidate.videoPath))
        return sendText(response, 404, 'Video unavailable')
      return serveVideo(request, response, candidate.videoPath)
    }
    const reviewMatch = /^\/api\/profile\/review\/(candidate-[a-f0-9]{12})$/.exec(url.pathname)
    if (request.method === 'POST' && reviewMatch && byId.has(reviewMatch[1])) {
      try {
        const body = await readBody(request)
        const judgment = normalizeProfileJudgment(body?.judgment)
        if (body?.markReviewed === true && judgment.verdict !== 'unreviewed')
          judgment.reviewedAt = new Date().toISOString()
        reviewState = {
          schemaVersion: PROFILE_REVIEW_SCHEMA_VERSION,
          updatedAt: new Date().toISOString(),
          judgments: { ...reviewState.judgments, [reviewMatch[1]]: judgment },
        }
        saveReviewFile(reviewFile, reviewState)
        return sendJson(response, 200, { ok: true, judgment, updatedAt: reviewState.updatedAt })
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
    server.listen(options.port ?? 4181, listenHost, resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  const localUrl = `http://127.0.0.1:${port}/profiles?token=${encodeURIComponent(token)}`
  const lanUrls = lanAccessEnabled
    ? listLanAddresses().map(
        (address) => `http://${address}:${port}/profiles?token=${encodeURIComponent(token)}`,
      )
    : []
  return {
    server,
    token,
    reviewFile,
    benchmarkReviewFile,
    regressionReviewFile,
    shadowReviewFile,
    mitigationReviewFile,
    candidateCount: candidates.length,
    gapMode,
    gapProfileSet,
    targetProfileIds,
    listenHost,
    localUrl,
    lanUrls,
    url: lanUrls[0] || localUrl,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const portText = process.argv.find((argument) => argument.startsWith('--port='))?.slice(7)
  const tokenText = process.argv.find((argument) => argument.startsWith('--token='))?.slice(8)
  const hostText = process.argv.find((argument) => argument.startsWith('--host='))?.slice(7)
  const gapCorpusArgument = process.argv.find((argument) => argument.startsWith('--gap-corpus='))
  const gapCorpusText = gapCorpusArgument?.slice('--gap-corpus='.length)
  if (gapCorpusArgument !== undefined && !gapCorpusText)
    throw new Error('Gap corpus is not configured: set VIDEO_GAP_CORPUS or pass --gap-corpus=<dir>')
  const gapProfileSetText = process.argv
    .find((argument) => argument.startsWith('--gap-profile-set='))
    ?.slice('--gap-profile-set='.length)
  const port = portText === undefined ? 4181 : Number(portText)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535)
    throw new Error('Use --port=0..65535')
  if (tokenText !== undefined && !/^[A-Za-z0-9_-]{16,128}$/.test(tokenText))
    throw new Error('Use a 16-128 character URL-safe --token value')
  if (hostText !== undefined && !['loopback', 'lan'].includes(hostText))
    throw new Error('Use --host=loopback or --host=lan')
  if (gapProfileSetText !== undefined && !GAP_PROFILE_SETS[gapProfileSetText])
    throw new Error('Use --gap-profile-set=meeting-sports or --gap-profile-set=final-coverage')
  const running = await createVideoProfileReviewServer({
    port,
    host: hostText,
    ...(gapCorpusText ? { gapCorpusRoot: gapCorpusText } : {}),
    ...(gapProfileSetText ? { gapProfileSet: gapProfileSetText } : {}),
    ...(tokenText ? { token: tokenText } : {}),
  })
  console.log(
    running.gapMode
      ? '\nVAL-206 会议/体育缺口验收网页已启动：'
      : '\nVID-016 多类型视频样本验收网页已启动：',
  )
  console.log(`本机：${running.localUrl}`)
  for (const url of running.lanUrls) console.log(`局域网：${url}`)
  console.log(`\n候选数：${running.candidateCount}`)
  console.log(`复核数据保存在：${running.reviewFile}`)
  console.log(
    running.lanUrls.length
      ? '已显式开启局域网访问，所有数据API仍需要随机令牌；按 Ctrl+C 停止。\n'
      : '仅监听 127.0.0.1；按 Ctrl+C 停止。\n',
  )
  const close = async () => {
    await running.close()
    process.exit(0)
  }
  process.once('SIGINT', () => void close())
  process.once('SIGTERM', () => void close())
}
