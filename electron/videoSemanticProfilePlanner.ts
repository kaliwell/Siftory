import {
  VIDEO_SEMANTIC_PROFILE_IDS,
  VIDEO_SEMANTIC_PROFILE_REVISION,
  VIDEO_SEMANTIC_PROFILES,
  isVideoSemanticProfileId,
  type VideoSemanticProfileId,
  type VideoSemanticProfilePlan,
  type VideoSemanticProfileSignals,
} from '../shared/videoSemantic'

type ScoreMap = Record<VideoSemanticProfileId, number>

const PROFILE_TIE_BREAK_ORDER = new Map(
  VIDEO_SEMANTIC_PROFILE_IDS.map((profileId, index) => [profileId, index]),
)

const PROFILE_HINTS: Readonly<Partial<Record<VideoSemanticProfileId, readonly string[]>>> = {
  'film-series-animation': ['movie', 'film', 'episode', 'season', 'anime', '电影', '剧集', '动漫'],
  'short-form-vlog': ['short', 'vlog', 'reel', 'tiktok', '短视频', '竖屏'],
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
  'game-stream': ['gameplay', 'stream', 'gaming', '游戏', '直播'],
  'surveillance-fixed': ['cctv', 'surveillance', 'camera', '监控', '摄像头'],
  sports: ['sport', 'match', 'football', 'basketball', 'soccer', '比赛', '足球', '篮球'],
}

function emptyScores(): ScoreMap {
  return Object.fromEntries(
    VIDEO_SEMANTIC_PROFILE_IDS.map((profileId) => [profileId, 0]),
  ) as ScoreMap
}

function clamp01(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(1, value))
}

function finitePositive(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return value
}

function roundScore(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 10_000) / 10_000
}

function addScore(
  scores: ScoreMap,
  reasons: Map<VideoSemanticProfileId, string[]>,
  profileId: VideoSemanticProfileId,
  amount: number,
  reason: string,
): void {
  if (!Number.isFinite(amount) || amount === 0) return
  scores[profileId] += amount
  if (amount > 0) reasons.get(profileId)?.push(reason)
}

function containsHint(text: string, hints: readonly string[]): boolean {
  return hints.some((hint) => text.includes(hint))
}

function buildPlan(
  profileId: VideoSemanticProfileId,
  decision: VideoSemanticProfilePlan['decision'],
  confidence: number,
  scores: ScoreMap,
  reasons: readonly string[],
): VideoSemanticProfilePlan {
  const normalizedScores = emptyScores()
  for (const id of VIDEO_SEMANTIC_PROFILE_IDS) normalizedScores[id] = roundScore(scores[id])
  return {
    profileId,
    profileRevision: VIDEO_SEMANTIC_PROFILE_REVISION,
    decision,
    confidence: roundScore(confidence),
    reasons: [...new Set(reasons)],
    scores: normalizedScores,
    policy: VIDEO_SEMANTIC_PROFILES[profileId].policy,
  }
}

export function planVideoSemanticProfile(
  input: VideoSemanticProfileSignals,
): VideoSemanticProfilePlan {
  const override = input.userOverride
  if (override !== 'auto' && isVideoSemanticProfileId(override)) {
    const scores = emptyScores()
    scores[override] = 1
    return buildPlan(override, 'user-override', 1, scores, ['user-override'])
  }

  const durationMs = finitePositive(input.durationMs)
  const width = finitePositive(input.width)
  const height = finitePositive(input.height)
  const shotChangeRate = clamp01(input.shotChangeRate)
  const speechRatio = clamp01(input.speechRatio)
  const ocrCoverage = clamp01(input.ocrCoverage)
  const motionDensity = clamp01(input.motionDensity)
  const screenContentRatio = clamp01(input.screenContentRatio)
  const fixedCameraScore = clamp01(input.fixedCameraScore)
  const audioPeakDensity = clamp01(input.audioPeakDensity)
  const hintText = [input.fileName, ...(input.pathHints ?? [])]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLocaleLowerCase('zh-CN')

  const hasStrongSignal = [
    durationMs,
    width,
    height,
    shotChangeRate,
    speechRatio,
    ocrCoverage,
    motionDensity,
    screenContentRatio,
    fixedCameraScore,
    audioPeakDensity,
  ].some((value) => value !== undefined)

  const scores = emptyScores()
  const reasons = new Map(
    VIDEO_SEMANTIC_PROFILE_IDS.map((profileId) => [profileId, [] as string[]]),
  )
  scores.general = 0.3
  reasons.get('general')?.push('balanced-default')

  if (!hasStrongSignal) {
    return buildPlan('general', 'fallback', 0.5, scores, ['insufficient-signals'])
  }

  const durationMinutes = durationMs === undefined ? undefined : durationMs / 60_000
  const portrait = width !== undefined && height !== undefined && height > width * 1.08

  if (durationMinutes !== undefined && durationMinutes <= 3) {
    addScore(scores, reasons, 'short-form-vlog', 0.24, 'short-duration')
  } else if (durationMinutes !== undefined && durationMinutes <= 10) {
    addScore(scores, reasons, 'short-form-vlog', 0.12, 'medium-short-duration')
  }
  if (portrait) addScore(scores, reasons, 'short-form-vlog', 0.4, 'portrait-video')
  if (shotChangeRate !== undefined && shotChangeRate >= 0.55) {
    addScore(scores, reasons, 'short-form-vlog', 0.18, 'frequent-cuts')
    addScore(scores, reasons, 'sports', 0.1, 'frequent-cuts')
  }

  if (durationMinutes !== undefined && durationMinutes >= 20) {
    addScore(scores, reasons, 'film-series-animation', 0.22, 'long-form')
    addScore(scores, reasons, 'meeting-interview-podcast', 0.08, 'long-form')
    addScore(scores, reasons, 'surveillance-fixed', 0.08, 'long-form')
  }
  if (shotChangeRate !== undefined && shotChangeRate >= 0.15 && shotChangeRate <= 0.65) {
    addScore(scores, reasons, 'film-series-animation', 0.18, 'narrative-cut-density')
  }
  if (speechRatio !== undefined && speechRatio >= 0.15 && speechRatio <= 0.8) {
    addScore(scores, reasons, 'film-series-animation', 0.12, 'mixed-dialogue')
  }

  if (speechRatio !== undefined && speechRatio >= 0.65) {
    addScore(scores, reasons, 'meeting-interview-podcast', 0.42, 'speech-dominant')
    addScore(scores, reasons, 'course-tutorial-screen', 0.16, 'speech-dominant')
  }
  if (motionDensity !== undefined && motionDensity <= 0.3) {
    addScore(scores, reasons, 'meeting-interview-podcast', 0.16, 'low-motion')
  }
  if (fixedCameraScore !== undefined && fixedCameraScore >= 0.55) {
    addScore(scores, reasons, 'meeting-interview-podcast', 0.16, 'mostly-fixed-camera')
  }

  if (screenContentRatio !== undefined && screenContentRatio >= 0.5) {
    addScore(scores, reasons, 'course-tutorial-screen', 0.34, 'screen-content')
    addScore(scores, reasons, 'game-stream', 0.25, 'screen-content')
  }
  if (ocrCoverage !== undefined && ocrCoverage >= 0.35) {
    addScore(scores, reasons, 'course-tutorial-screen', 0.28, 'text-heavy-frames')
    addScore(scores, reasons, 'game-stream', 0.12, 'text-overlay')
    addScore(scores, reasons, 'sports', 0.08, 'score-overlay')
  }
  if (motionDensity !== undefined && motionDensity <= 0.4) {
    addScore(scores, reasons, 'course-tutorial-screen', 0.08, 'stable-screen-content')
  }

  if (motionDensity !== undefined && motionDensity >= 0.6) {
    addScore(scores, reasons, 'game-stream', 0.24, 'high-motion')
    addScore(scores, reasons, 'sports', 0.32, 'high-motion')
  }
  if (audioPeakDensity !== undefined && audioPeakDensity >= 0.45) {
    addScore(scores, reasons, 'game-stream', 0.1, 'frequent-audio-peaks')
    addScore(scores, reasons, 'sports', 0.18, 'frequent-audio-peaks')
  }

  if (fixedCameraScore !== undefined && fixedCameraScore >= 0.65) {
    addScore(scores, reasons, 'surveillance-fixed', 0.34, 'fixed-camera')
  }
  if (motionDensity !== undefined && motionDensity <= 0.12) {
    addScore(scores, reasons, 'surveillance-fixed', 0.26, 'mostly-static')
  }
  if (shotChangeRate !== undefined && shotChangeRate <= 0.08) {
    addScore(scores, reasons, 'surveillance-fixed', 0.14, 'few-scene-cuts')
  }
  if (speechRatio !== undefined && speechRatio >= 0.5) scores['surveillance-fixed'] -= 0.18

  for (const [profileId, hints] of Object.entries(PROFILE_HINTS) as Array<
    [VideoSemanticProfileId, readonly string[]]
  >) {
    if (hintText && containsHint(hintText, hints)) {
      addScore(scores, reasons, profileId, 0.12, 'weak-path-hint')
    }
  }

  for (const profileId of VIDEO_SEMANTIC_PROFILE_IDS)
    scores[profileId] = roundScore(scores[profileId])
  const ranked = [...VIDEO_SEMANTIC_PROFILE_IDS].sort(
    (left, right) =>
      scores[right] - scores[left] ||
      (PROFILE_TIE_BREAK_ORDER.get(left) ?? 0) - (PROFILE_TIE_BREAK_ORDER.get(right) ?? 0),
  )
  const selected = ranked[0]
  const topScore = scores[selected]
  const secondScore = scores[ranked[1]]
  if (selected === 'general' || topScore < 0.42) {
    return buildPlan('general', 'fallback', 0.5, scores, ['low-profile-confidence'])
  }
  const confidence = Math.max(
    0.5,
    Math.min(0.99, 0.5 + (topScore - secondScore) * 0.6 + Math.max(0, topScore - 0.5) * 0.2),
  )
  return buildPlan(selected, 'automatic', confidence, scores, reasons.get(selected) ?? [])
}
