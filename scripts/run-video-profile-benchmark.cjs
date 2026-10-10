#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const PROFILE_IDS = Object.freeze([
  'general',
  'film-series-animation',
  'short-form-vlog',
  'meeting-interview-podcast',
  'course-tutorial-screen',
  'game-stream',
  'surveillance-fixed',
  'sports',
])
const BENCHMARK_REVISION = '2026-08-15.profile-v1'
const SHADOW_RESULT_SET = 'profile-v7-shadow'
const MITIGATION_RESULT_SET = 'profile-v8-mitigation'
const FINAL_RESULT_SET = 'profile-final'
const FINAL_BENCHMARK_REVISION = '2026-08-15.profile-final'
const DEFAULT_PROFILE_CORPUS_ROOT = process.env.VIDEO_GAP_CORPUS || '<VIDEO_GAP_CORPUS>'
const MITIGATION_SAMPLE_IDS = Object.freeze([
  'candidate-ae6547234445',
  'candidate-04feba1e556c',
  'candidate-5b8d8fefcbd9',
  'candidate-d0eda23e1fcb',
  'candidate-42ffe764c25a',
  'candidate-82c306ae2374',
])

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const stage = `${file}.${process.pid}.tmp`
  fs.writeFileSync(stage, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(stage, file)
}

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

function readOptionalJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

function mergeProfileReviews(...reviews) {
  const judgments = {}
  for (const review of reviews) {
    for (const [sampleId, judgment] of Object.entries(review?.judgments || {})) {
      const previous = judgments[sampleId]
      if (
        previous?.verdict === 'accepted' &&
        judgment?.verdict === 'accepted' &&
        previous.profileId !== judgment.profileId
      ) {
        throw new Error(`Conflicting profile truth: ${sampleId}`)
      }
      if (previous?.verdict === 'accepted' && judgment?.verdict !== 'accepted') continue
      judgments[sampleId] = judgment
    }
  }
  return { judgments }
}

function buildPlan(candidates, review, perProfile, smoke, benchmarkRevision = BENCHMARK_REVISION) {
  const availableIds = new Set(candidates.map((candidate) => candidate.sampleId))
  const samples = []
  const coverage = {}
  for (const profileId of PROFILE_IDS) {
    const accepted = Object.entries(review?.judgments || {})
      .filter(
        ([sampleId, judgment]) =>
          availableIds.has(sampleId) &&
          judgment?.verdict === 'accepted' &&
          judgment.profileId === profileId,
      )
      .map(([sampleId]) => sampleId)
      .sort()
    const selected = accepted.slice(0, smoke ? 1 : perProfile)
    coverage[profileId] = {
      accepted: accepted.length,
      selected: selected.length,
      target: perProfile,
      covered: selected.length > 0,
      complete: selected.length >= perProfile,
    }
    samples.push(...selected.map((sampleId) => ({ sampleId, profileId })))
  }
  return {
    schemaVersion: 1,
    benchmarkRevision,
    mode: smoke ? 'smoke' : 'full',
    perProfile,
    createdAt: new Date().toISOString(),
    coverage,
    samples,
    privacy: {
      anonymousSampleIdsOnly: true,
      originalPathsIncluded: false,
      originalNamesIncluded: false,
    },
  }
}

function buildFinalPlan(candidates, review, baselinePlan, perProfile = 10) {
  if (!Array.isArray(baselinePlan?.samples) || baselinePlan.samples.length !== 44) {
    throw new Error('The frozen V1 baseline plan must contain exactly 44 samples')
  }
  const availableIds = new Set(candidates.map((candidate) => candidate.sampleId))
  const acceptedByProfile = new Map(
    PROFILE_IDS.map((profileId) => [
      profileId,
      Object.entries(review?.judgments || {})
        .filter(
          ([sampleId, judgment]) =>
            availableIds.has(sampleId) &&
            judgment?.verdict === 'accepted' &&
            judgment.profileId === profileId,
        )
        .map(([sampleId]) => sampleId)
        .sort(),
    ]),
  )
  const baselineIds = new Set()
  for (const sample of baselinePlan.samples) {
    if (
      baselineIds.has(sample.sampleId) ||
      !acceptedByProfile.get(sample.profileId)?.includes(sample.sampleId)
    ) {
      throw new Error(`Frozen baseline sample is no longer approved: ${sample.sampleId}`)
    }
    baselineIds.add(sample.sampleId)
  }
  const samples = []
  const coverage = {}
  for (const profileId of PROFILE_IDS) {
    const baseline = baselinePlan.samples
      .filter((sample) => sample.profileId === profileId)
      .map((sample) => ({ sampleId: sample.sampleId, profileId }))
    const additions = acceptedByProfile
      .get(profileId)
      .filter((sampleId) => !baselineIds.has(sampleId))
      .slice(0, Math.max(0, perProfile - baseline.length))
      .map((sampleId) => ({ sampleId, profileId }))
    const selected = [...baseline, ...additions]
    coverage[profileId] = {
      accepted: acceptedByProfile.get(profileId).length,
      selected: selected.length,
      target: perProfile,
      covered: selected.length > 0,
      complete: selected.length >= perProfile,
      baselineReused: baseline.length,
      additions: additions.length,
    }
    samples.push(...selected)
  }
  return {
    schemaVersion: 1,
    benchmarkRevision: FINAL_BENCHMARK_REVISION,
    mode: 'full',
    perProfile,
    createdAt: new Date().toISOString(),
    baselinePlanRevision: baselinePlan.benchmarkRevision,
    baselineReused: baselinePlan.samples.length,
    coverage,
    samples,
    privacy: {
      anonymousSampleIdsOnly: true,
      originalPathsIncluded: false,
      originalNamesIncluded: false,
    },
  }
}

function resolveFfmpeg() {
  const bundled = path.join(__dirname, '..', 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe')
  return fs.existsSync(bundled) ? bundled : 'ffmpeg.exe'
}

function evidenceFrameId(sampleId, timestampMs) {
  return require('node:crypto')
    .createHash('sha256')
    .update(`${sampleId}:${timestampMs}`)
    .digest('hex')
    .slice(0, 40)
}

function prepareFinalEvidence(plan, candidates, mediaRoot, outputRoot, frameCounts) {
  const candidateById = new Map(candidates.map((candidate) => [candidate.sampleId, candidate]))
  const evidenceRoot = path.join(mediaRoot, 'frames', 'profile-final')
  const records = []
  let preparedSamples = 0
  for (const sample of plan.samples) {
    const candidate = candidateById.get(sample.sampleId)
    if (!candidate || (frameCounts.get(candidate.videoId) || 0) >= 4) continue
    const span = Math.max(1_000, candidate.target.endMs - candidate.target.startMs)
    const timestamps = [0.1, 0.35, 0.65, 0.9].map((position) =>
      Math.min(
        candidate.target.endMs - 1,
        Math.max(candidate.target.startMs, Math.round(candidate.target.startMs + span * position)),
      ),
    )
    const sampleRoot = path.join(evidenceRoot, sample.sampleId)
    fs.mkdirSync(sampleRoot, { recursive: true })
    for (const timestampMs of timestamps) {
      const frameId = evidenceFrameId(sample.sampleId, timestampMs)
      const imagePath = path.join(sampleRoot, `${frameId}.jpg`)
      let valid = false
      try {
        const stat = fs.statSync(imagePath)
        valid = stat.isFile() && stat.size > 0 && stat.size <= 2 * 1024 * 1024
      } catch {
        // Missing or unreadable cached frames are regenerated below.
      }
      if (!valid) {
        const stage = `${imagePath}.${process.pid}.tmp.jpg`
        fs.rmSync(stage, { force: true })
        try {
          execFileSync(
            resolveFfmpeg(),
            [
              '-hide_banner',
              '-loglevel',
              'error',
              '-i',
              candidate.videoPath,
              '-ss',
              (timestampMs / 1_000).toFixed(3),
              '-frames:v',
              '1',
              '-vf',
              'scale=960:960:force_original_aspect_ratio=decrease',
              '-q:v',
              '3',
              '-y',
              stage,
            ],
            { stdio: ['ignore', 'ignore', 'pipe'], timeout: 90_000, windowsHide: true },
          )
          const stat = fs.statSync(stage)
          if (!stat.isFile() || stat.size <= 0 || stat.size > 2 * 1024 * 1024) {
            throw new Error('Prepared evidence frame size is invalid')
          }
          fs.renameSync(stage, imagePath)
        } finally {
          fs.rmSync(stage, { force: true })
        }
      }
      records.push({
        frameId,
        videoId: candidate.videoId,
        status: 'done',
        imagePath,
        timestampMs,
      })
    }
    preparedSamples += 1
  }
  atomicWriteJson(path.join(outputRoot, 'evidence-manifest.json'), {
    schemaVersion: 1,
    benchmarkRevision: FINAL_BENCHMARK_REVISION,
    preparedSamples,
    records,
  })
  return { preparedSamples, records: records.length }
}

function validCompletedResult(file, sample, benchmarkRevision = BENCHMARK_REVISION) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return (
      parsed?.sample?.sampleId === sample.sampleId &&
      parsed?.sample?.profileId === sample.profileId &&
      parsed?.pilotRevision?.startsWith(benchmarkRevision)
    )
  } catch {
    return false
  }
}

function isRuntimeUnavailableFailure(reason) {
  return /Video semantic runtime is not ready|ECONNREFUSED|fetch failed/i.test(String(reason || ''))
}

async function main() {
  const mode =
    process.argv.find((argument) => argument.startsWith('--mode='))?.slice('--mode='.length) ||
    'full'
  if (!['smoke', 'full'].includes(mode)) throw new Error('Use --mode=smoke or --mode=full')
  const resultSet = process.argv
    .find((argument) => argument.startsWith('--result-set='))
    ?.slice('--result-set='.length)
  if (
    resultSet &&
    ![SHADOW_RESULT_SET, MITIGATION_RESULT_SET, FINAL_RESULT_SET].includes(resultSet)
  ) {
    throw new Error(
      `Use --result-set=${SHADOW_RESULT_SET}, --result-set=${MITIGATION_RESULT_SET}, or --result-set=${FINAL_RESULT_SET}`,
    )
  }
  if (resultSet && mode !== 'full') {
    throw new Error('Profile shadow and mitigation result sets require --mode=full')
  }
  const planOnly = process.argv.includes('--plan-only')
  const force = process.argv.includes('--force')
  const perProfile = Number(
    process.argv
      .find((argument) => argument.startsWith('--per-profile='))
      ?.slice('--per-profile='.length) || 10,
  )
  if (!Number.isSafeInteger(perProfile) || perProfile < 1 || perProfile > 10) {
    throw new Error('Use --per-profile=1..10')
  }

  const mediaRoot = path.join(process.env.APPDATA, 'floating-clock-electron', 'media-search')
  const reviewRoot = path.join(mediaRoot, 'semantic', 'reviews')
  const reviewFile = path.join(reviewRoot, 'video-profile-corpus-review.json')
  const benchmarkRevision =
    resultSet === FINAL_RESULT_SET
      ? FINAL_BENCHMARK_REVISION
      : resultSet
        ? `2026-08-15.${resultSet}`
        : BENCHMARK_REVISION
  const outputDirectory =
    resultSet === FINAL_RESULT_SET
      ? 'qwen3-vl-2b-profile-final'
      : resultSet
        ? `qwen3-vl-2b-${resultSet}`
        : 'qwen3-vl-2b-profile-v1'
  const outputRoot = path.join(mediaRoot, 'semantic', 'benchmarks', outputDirectory)
  const baseReview = JSON.parse(fs.readFileSync(reviewFile, 'utf8'))
  const { buildProfileCandidates, buildProfileGapCandidates } =
    await import('./serve-video-profile-review.mjs')
  const baseCandidates = buildProfileCandidates(
    mediaRoot,
    resultSet === FINAL_RESULT_SET ? 4_096 : undefined,
  )
  const profileCorpusRoot = path.resolve(
    process.argv
      .find((argument) => argument.startsWith('--profile-corpus='))
      ?.slice('--profile-corpus='.length) || DEFAULT_PROFILE_CORPUS_ROOT,
  )
  const gapCandidates =
    resultSet === FINAL_RESULT_SET && fs.existsSync(profileCorpusRoot)
      ? buildProfileGapCandidates(mediaRoot, profileCorpusRoot, PROFILE_IDS)
      : []
  const candidates = [
    ...new Map(
      [...baseCandidates, ...gapCandidates].map((candidate) => [candidate.sampleId, candidate]),
    ).values(),
  ]
  const review =
    resultSet === FINAL_RESULT_SET
      ? mergeProfileReviews(
          baseReview,
          readOptionalJson(path.join(reviewRoot, 'video-profile-gap-corpus-review.json')),
          readOptionalJson(path.join(reviewRoot, 'video-profile-final-coverage-review.json')),
        )
      : baseReview
  const frameCounts = new Map()
  for (const frame of readJsonLines(path.join(mediaRoot, 'manifests', 'video_frames.jsonl'))) {
    if (
      frame?.status === 'done' &&
      typeof frame.videoId === 'string' &&
      typeof frame.imagePath === 'string' &&
      fs.existsSync(frame.imagePath)
    ) {
      frameCounts.set(frame.videoId, (frameCounts.get(frame.videoId) || 0) + 1)
    }
  }
  const eligibleCandidates = candidates.filter(
    (candidate) => resultSet === FINAL_RESULT_SET || (frameCounts.get(candidate.videoId) || 0) >= 4,
  )
  const reviewedPlan = buildPlan(
    candidates,
    review,
    perProfile,
    mode === 'smoke',
    benchmarkRevision,
  )
  let plan = buildPlan(eligibleCandidates, review, perProfile, mode === 'smoke', benchmarkRevision)
  for (const profileId of PROFILE_IDS) {
    plan.coverage[profileId].reviewedAccepted = reviewedPlan.coverage[profileId].accepted
    plan.coverage[profileId].eligibleAccepted = plan.coverage[profileId].accepted
    plan.coverage[profileId].excludedInsufficientFrames = Math.max(
      0,
      reviewedPlan.coverage[profileId].accepted - plan.coverage[profileId].accepted,
    )
  }
  const executionOrder = [...PROFILE_IDS].sort(
    (left, right) =>
      Number(plan.coverage[right].complete) - Number(plan.coverage[left].complete) ||
      plan.coverage[right].selected - plan.coverage[left].selected ||
      PROFILE_IDS.indexOf(left) - PROFILE_IDS.indexOf(right),
  )
  const executionRank = new Map(executionOrder.map((profileId, index) => [profileId, index]))
  plan.samples.sort(
    (left, right) =>
      executionRank.get(left.profileId) - executionRank.get(right.profileId) ||
      left.sampleId.localeCompare(right.sampleId),
  )
  if (resultSet === FINAL_RESULT_SET) {
    if (mode !== 'full' || perProfile !== 10) {
      throw new Error('Final profile coverage requires --mode=full --per-profile=10')
    }
    const baselinePlanFile = path.join(
      mediaRoot,
      'semantic',
      'benchmarks',
      'qwen3-vl-2b-profile-v1',
      'full-plan.json',
    )
    const baselinePlan = JSON.parse(fs.readFileSync(baselinePlanFile, 'utf8'))
    plan = buildFinalPlan(eligibleCandidates, review, baselinePlan, perProfile)
  } else if (resultSet) {
    const baselinePlanFile = path.join(
      mediaRoot,
      'semantic',
      'benchmarks',
      'qwen3-vl-2b-profile-v1',
      'full-plan.json',
    )
    const baselinePlan = JSON.parse(fs.readFileSync(baselinePlanFile, 'utf8'))
    if (!Array.isArray(baselinePlan.samples) || baselinePlan.samples.length !== 44) {
      throw new Error('The frozen V1 baseline plan must contain exactly 44 samples')
    }
    const eligibleById = new Map(plan.samples.map((sample) => [sample.sampleId, sample]))
    for (const sample of baselinePlan.samples) {
      const eligible = eligibleById.get(sample.sampleId)
      if (!eligible || eligible.profileId !== sample.profileId) {
        throw new Error(`Frozen baseline sample is no longer eligible: ${sample.sampleId}`)
      }
    }
    const selectedSamples =
      resultSet === MITIGATION_RESULT_SET
        ? MITIGATION_SAMPLE_IDS.map((sampleId) => {
            const sample = baselinePlan.samples.find((item) => item.sampleId === sampleId)
            if (!sample) throw new Error(`Mitigation sample is absent from baseline: ${sampleId}`)
            return { sampleId: sample.sampleId, profileId: sample.profileId }
          })
        : baselinePlan.samples.map((sample) => ({
            sampleId: sample.sampleId,
            profileId: sample.profileId,
          }))
    plan = {
      ...plan,
      benchmarkRevision,
      shadowOf:
        resultSet === MITIGATION_RESULT_SET
          ? 'qwen3-vl-2b-profile-v7-shadow'
          : 'qwen3-vl-2b-profile-v1',
      sourceBenchmarkRevision:
        resultSet === MITIGATION_RESULT_SET
          ? '2026-08-15.profile-v7-shadow'
          : baselinePlan.benchmarkRevision,
      samples: selectedSamples,
    }
  }
  if (plan.samples.length === 0) throw new Error('No approved profile samples are available')
  if (resultSet === FINAL_RESULT_SET && plan.samples.length !== PROFILE_IDS.length * perProfile) {
    throw new Error(`Final profile plan is incomplete: ${plan.samples.length}/80`)
  }
  fs.mkdirSync(outputRoot, { recursive: true })
  const evidencePreparation =
    resultSet === FINAL_RESULT_SET
      ? prepareFinalEvidence(plan, eligibleCandidates, mediaRoot, outputRoot, frameCounts)
      : null
  atomicWriteJson(path.join(outputRoot, `${mode}-plan.json`), plan)
  if (planOnly) {
    console.log(
      JSON.stringify({
        mode,
        resultSet: resultSet || 'profile-v1',
        benchmarkRevision,
        outputRoot,
        total: plan.samples.length,
        baselineReused: plan.baselineReused || 0,
        evidencePreparation,
        shadowOf: plan.shadowOf || null,
        coverage: plan.coverage,
      }),
    )
    return
  }

  const stateFile = path.join(outputRoot, `${mode}-job.json`)
  const state = {
    schemaVersion: 1,
    benchmarkRevision,
    resultSet: resultSet || 'profile-v1',
    mode,
    state: 'running',
    total: plan.samples.length,
    completed: 0,
    failed: 0,
    skippedExisting: 0,
    currentSampleId: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    failures: [],
    coverage: plan.coverage,
  }
  atomicWriteJson(stateFile, state)
  let consecutiveFailures = 0
  const baselineRoot = path.join(mediaRoot, 'semantic', 'benchmarks', 'qwen3-vl-2b-profile-v1')
  const baselineIds = new Set(
    resultSet === FINAL_RESULT_SET
      ? JSON.parse(fs.readFileSync(path.join(baselineRoot, 'full-plan.json'), 'utf8')).samples.map(
          (sample) => sample.sampleId,
        )
      : [],
  )
  for (const [index, sample] of plan.samples.entries()) {
    const resultFile = path.join(outputRoot, `${sample.sampleId}.json`)
    state.currentSampleId = sample.sampleId
    state.updatedAt = new Date().toISOString()
    atomicWriteJson(stateFile, state)
    const reusableBaseline =
      resultSet === FINAL_RESULT_SET &&
      baselineIds.has(sample.sampleId) &&
      validCompletedResult(
        path.join(baselineRoot, `${sample.sampleId}.json`),
        sample,
        BENCHMARK_REVISION,
      )
    if (
      !force &&
      (reusableBaseline || validCompletedResult(resultFile, sample, benchmarkRevision))
    ) {
      state.completed += 1
      state.skippedExisting += 1
      consecutiveFailures = 0
      console.log(`[${index + 1}/${plan.samples.length}] ${sample.sampleId} cached`)
      continue
    }
    try {
      const stdout = execFileSync(
        process.execPath,
        [
          path.join(__dirname, 'run-video-semantic-pilot.cjs'),
          `--profile-sample=${sample.sampleId}`,
          ...(resultSet ? [`--result-set=${resultSet}`] : []),
        ],
        {
          cwd: path.join(__dirname, '..'),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 7 * 60 * 1000,
          windowsHide: true,
        },
      )
      if (!validCompletedResult(resultFile, sample, benchmarkRevision)) {
        throw new Error('runner-completed-without-valid-result')
      }
      state.completed += 1
      consecutiveFailures = 0
      let parseOk = false
      try {
        parseOk = JSON.parse(stdout).parseOk === true
      } catch {
        parseOk = JSON.parse(fs.readFileSync(resultFile, 'utf8'))?.parse?.ok === true
      }
      console.log(
        `[${index + 1}/${plan.samples.length}] ${sample.sampleId} ${sample.profileId} parse=${parseOk}`,
      )
    } catch (error) {
      consecutiveFailures += 1
      state.failed += 1
      const failureReason = String(error?.stderr || error?.message || error).slice(0, 1_000)
      state.failures.push({
        sampleId: sample.sampleId,
        profileId: sample.profileId,
        reason: failureReason,
      })
      console.error(`[${index + 1}/${plan.samples.length}] ${sample.sampleId} failed`)
      if (isRuntimeUnavailableFailure(failureReason)) {
        state.state = 'paused'
        state.reason = 'runtime-not-ready'
        break
      }
      if (consecutiveFailures >= 3) {
        state.state = 'paused'
        state.reason = 'three-consecutive-failures'
        break
      }
    } finally {
      state.updatedAt = new Date().toISOString()
      atomicWriteJson(stateFile, state)
    }
  }
  state.currentSampleId = null
  if (state.state === 'running') state.state = 'completed'
  state.completedAt = state.state === 'completed' ? new Date().toISOString() : undefined
  state.updatedAt = new Date().toISOString()
  atomicWriteJson(stateFile, state)
  console.log(
    JSON.stringify({
      mode,
      resultSet: resultSet || 'profile-v1',
      state: state.state,
      total: state.total,
      completed: state.completed,
      failed: state.failed,
      coverage: state.coverage,
    }),
  )
  if (state.state !== 'completed') process.exitCode = 2
}

module.exports = {
  PROFILE_IDS,
  BENCHMARK_REVISION,
  SHADOW_RESULT_SET,
  MITIGATION_RESULT_SET,
  FINAL_RESULT_SET,
  FINAL_BENCHMARK_REVISION,
  MITIGATION_SAMPLE_IDS,
  buildPlan,
  buildFinalPlan,
  evidenceFrameId,
  mergeProfileReviews,
  validCompletedResult,
  isRuntimeUnavailableFailure,
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error)
    process.exitCode = 1
  })
}
