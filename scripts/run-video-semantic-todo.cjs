#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const { buildValueTodoSnapshot, parseValueTaskRows } = require('./next-value-optimization-task.cjs')

const projectRoot = path.resolve(__dirname, '..')
const DEFAULT_PLAN_PATH = path.join(
  projectRoot,
  'docs',
  'current',
  '2026-08-15-video-semantic-remaining-auto-todo.md',
)
const DIFFERENCE_FIELDS = Object.freeze([
  ['summary', 4],
  ['scenes', 2],
  ['events', 4],
  ['persons', 3],
  ['objects', 2],
  ['visualText', 2],
  ['searchTags', 1],
  ['warnings', 1],
])

function parseArgs(argv) {
  const options = { dryRun: false, planPath: DEFAULT_PLAN_PATH }
  for (const argument of argv) {
    if (argument === '--dry-run') options.dryRun = true
    else if (argument.startsWith('--plan=')) options.planPath = path.resolve(argument.slice(7))
    else throw new Error(`Unknown argument: ${argument}`)
  }
  return options
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const stage = `${file}.${process.pid}.tmp`
  fs.writeFileSync(stage, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  try {
    fs.renameSync(stage, file)
  } finally {
    if (fs.existsSync(stage)) fs.rmSync(stage, { force: true })
  }
}

function semanticValue(result) {
  if (result?.parse?.ok !== true || !result.parse.value) return null
  return Object.fromEntries(
    DIFFERENCE_FIELDS.map(([field]) => [field, result.parse.value[field] ?? null]),
  )
}

function buildDifferencePriority(plan, baselineJudgments, v1Results, v7Results) {
  if (!Array.isArray(plan?.samples)) throw new Error('missing-shadow-plan')
  const records = plan.samples.map((sample) => {
    const v1 = v1Results.get(sample.sampleId)
    const v7 = v7Results.get(sample.sampleId)
    if (
      v1?.sample?.sampleId !== sample.sampleId ||
      v7?.sample?.sampleId !== sample.sampleId ||
      v1?.sample?.profileId !== sample.profileId ||
      v7?.sample?.profileId !== sample.profileId ||
      v1?.parse?.ok !== true ||
      v7?.parse?.ok !== true
    ) {
      throw new Error(`incomplete-paired-result:${sample.sampleId}`)
    }
    const left = semanticValue(v1)
    const right = semanticValue(v7)
    const changedFields = DIFFERENCE_FIELDS.filter(
      ([field]) => JSON.stringify(left[field]) !== JSON.stringify(right[field]),
    ).map(([field]) => field)
    const changeScore = DIFFERENCE_FIELDS.filter(([field]) => changedFields.includes(field)).reduce(
      (sum, [, weight]) => sum + weight,
      0,
    )
    const baselineVerdict = baselineJudgments?.[sample.sampleId]?.verdict || 'unreviewed'
    return {
      sampleId: sample.sampleId,
      profileId: sample.profileId,
      baselineVerdict,
      priorityTier: baselineVerdict === 'consistent' ? 'protect-correct' : 'known-regression',
      changedFields,
      changeScore,
    }
  })
  records.sort(
    (left, right) =>
      Number(right.priorityTier === 'protect-correct') -
        Number(left.priorityTier === 'protect-correct') ||
      right.changeScore - left.changeScore ||
      left.sampleId.localeCompare(right.sampleId),
  )
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      baseline: 'qwen3-vl-2b-profile-v1',
      candidate: 'qwen3-vl-2b-profile-v7-shadow',
    },
    privacy: {
      anonymousSampleIdsOnly: true,
      originalPathsIncluded: false,
      originalNamesIncluded: false,
      semanticTextIncluded: false,
      freeTextIncluded: false,
    },
    summary: {
      paired: records.length,
      protectCorrect: records.filter((record) => record.priorityTier === 'protect-correct').length,
      knownRegression: records.filter((record) => record.priorityTier === 'known-regression')
        .length,
      changedSummary: records.filter((record) => record.changedFields.includes('summary')).length,
      minimumChangeScore: records.length
        ? Math.min(...records.map((record) => record.changeScore))
        : 0,
      maximumChangeScore: records.length
        ? Math.max(...records.map((record) => record.changeScore))
        : 0,
    },
    records,
  }
}

function loadResultMap(root, samples) {
  return new Map(
    samples.map((sample) => [
      sample.sampleId,
      readJson(path.join(root, `${sample.sampleId}.json`)),
    ]),
  )
}

function summarizeAdoptionGate(plan, baselineJudgments, shadowJudgments) {
  const verdicts = { improved: 0, same: 0, regressed: 0 }
  const preferences = { v1: 0, v7: 0, neither: 0, equivalent: 0 }
  const protectCorrect = { total: 0, improved: 0, same: 0, regressed: 0 }
  const byProfile = {}
  const regressedSampleIds = []
  let reviewed = 0
  let watchedFullSegment = 0
  for (const sample of plan.samples) {
    const judgment = shadowJudgments?.[sample.sampleId]
    const complete =
      ['improved', 'same', 'regressed'].includes(judgment?.verdict) &&
      ['v1', 'v7', 'neither', 'equivalent'].includes(judgment?.preferredOutput)
    if (!complete) continue
    reviewed += 1
    verdicts[judgment.verdict] += 1
    preferences[judgment.preferredOutput] += 1
    if (judgment.watchedFullSegment === true) watchedFullSegment += 1
    const baselineVerdict = baselineJudgments?.[sample.sampleId]?.verdict || 'unreviewed'
    byProfile[sample.profileId] ||= {
      total: 0,
      improved: 0,
      same: 0,
      regressed: 0,
      v1Preferred: 0,
      v7Preferred: 0,
    }
    const profile = byProfile[sample.profileId]
    profile.total += 1
    profile[judgment.verdict] += 1
    if (judgment.preferredOutput === 'v1') profile.v1Preferred += 1
    if (judgment.preferredOutput === 'v7') profile.v7Preferred += 1
    if (baselineVerdict === 'consistent') {
      protectCorrect.total += 1
      protectCorrect[judgment.verdict] += 1
      if (judgment.verdict === 'regressed') regressedSampleIds.push(sample.sampleId)
    }
  }
  const complete = reviewed === plan.samples.length
  const universalAdoptionPassed = complete && protectCorrect.regressed === 0
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    privacy: {
      anonymousSampleIdsOnly: true,
      originalPathsIncluded: false,
      originalNamesIncluded: false,
      semanticTextIncluded: false,
      freeTextIncluded: false,
    },
    reviewed,
    planned: plan.samples.length,
    complete,
    watchedFullSegment,
    verdicts,
    preferences,
    protectCorrect,
    byProfile,
    regressedSampleIds,
    universalAdoptionPassed,
    recommendation: universalAdoptionPassed
      ? 'adopt-v7-candidate'
      : complete
        ? 'targeted-mitigation-required'
        : 'human-review-incomplete',
  }
}

function summarizeMitigationGate(plan, judgments) {
  const verdicts = { improved: 0, same: 0, regressed: 0 }
  const preferences = { leftV7: 0, rightV81: 0, neither: 0, equivalent: 0 }
  const regressedSampleIds = []
  let reviewed = 0
  let watchedFullSegment = 0
  for (const sample of plan.samples || []) {
    const judgment = judgments?.[sample.sampleId]
    if (
      !['improved', 'same', 'regressed'].includes(judgment?.verdict) ||
      !['v1', 'v7', 'neither', 'equivalent'].includes(judgment?.preferredOutput)
    )
      continue
    reviewed += 1
    verdicts[judgment.verdict] += 1
    if (judgment.preferredOutput === 'v1') preferences.leftV7 += 1
    else if (judgment.preferredOutput === 'v7') preferences.rightV81 += 1
    else preferences[judgment.preferredOutput] += 1
    if (judgment.watchedFullSegment === true) watchedFullSegment += 1
    if (judgment.verdict === 'regressed') regressedSampleIds.push(sample.sampleId)
  }
  const planned = Array.isArray(plan.samples) ? plan.samples.length : 0
  const complete = planned > 0 && reviewed === planned
  const noRegressionPassed = complete && verdicts.regressed === 0
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      baseline: 'qwen3-vl-2b-profile-v7-shadow',
      candidate: 'qwen3-vl-2b-profile-v8-mitigation',
    },
    privacy: {
      anonymousSampleIdsOnly: true,
      originalPathsIncluded: false,
      originalNamesIncluded: false,
      semanticTextIncluded: false,
      freeTextIncluded: false,
    },
    planned,
    reviewed,
    complete,
    watchedFullSegment,
    verdicts,
    preferences,
    regressedSampleIds,
    noRegressionPassed,
    recommendation: noRegressionPassed
      ? 'adopt-v8-candidate'
      : complete
        ? 'retain-v7-default'
        : 'human-review-incomplete',
  }
}

function run(options = {}) {
  const planPath = path.resolve(options.planPath || DEFAULT_PLAN_PATH)
  const tasks = parseValueTaskRows(fs.readFileSync(planPath, 'utf8'))
  const todo = buildValueTodoSnapshot(tasks)
  if (!todo.ok) throw new Error(todo.errors.join('; ') || 'invalid-video-semantic-todo')
  const mediaRoot = path.join(
    options.appDataPath || process.env.APPDATA || '',
    'floating-clock-electron',
    'media-search',
  )
  const benchmarkRoot = path.join(mediaRoot, 'semantic', 'benchmarks')
  const v1Root = path.join(benchmarkRoot, 'qwen3-vl-2b-profile-v1')
  const v7Root = path.join(benchmarkRoot, 'qwen3-vl-2b-profile-v7-shadow')
  const plan = readJson(path.join(v7Root, 'full-plan.json'))
  const job = readJson(path.join(v7Root, 'full-job.json'))
  if (job.state !== 'completed' || job.completed !== 44 || job.failed !== 0) {
    throw new Error('v7-shadow-benchmark-not-complete')
  }
  const baselineReview = readJson(
    path.join(mediaRoot, 'semantic', 'reviews', 'video-profile-semantic-review.json'),
  )
  const report = buildDifferencePriority(
    plan,
    baselineReview.judgments,
    loadResultMap(v1Root, plan.samples),
    loadResultMap(v7Root, plan.samples),
  )
  const outputFile = path.join(
    mediaRoot,
    'semantic',
    'workflows',
    'vid-016-shadow-difference-priority.json',
  )
  if (!options.dryRun) atomicWriteJson(outputFile, report)
  const shadowReviewFile = path.join(
    mediaRoot,
    'semantic',
    'reviews',
    'video-profile-shadow-review.json',
  )
  const adoptionGate = fs.existsSync(shadowReviewFile)
    ? summarizeAdoptionGate(plan, baselineReview.judgments, readJson(shadowReviewFile).judgments)
    : summarizeAdoptionGate(plan, baselineReview.judgments, {})
  const adoptionFile = path.join(
    mediaRoot,
    'semantic',
    'workflows',
    'vid-016-v7-adoption-gate.json',
  )
  if (!options.dryRun) atomicWriteJson(adoptionFile, adoptionGate)
  const mitigationRoot = path.join(benchmarkRoot, 'qwen3-vl-2b-profile-v8-mitigation')
  const mitigationPlan = readJson(path.join(mitigationRoot, 'full-plan.json'))
  const mitigationJob = readJson(path.join(mitigationRoot, 'full-job.json'))
  if (
    mitigationJob.state !== 'completed' ||
    mitigationJob.completed !== mitigationPlan.samples.length ||
    mitigationJob.failed !== 0
  ) {
    throw new Error('v8-mitigation-benchmark-not-complete')
  }
  const mitigationReviewFile = path.join(
    mediaRoot,
    'semantic',
    'reviews',
    'video-profile-v8-mitigation-review.json',
  )
  const mitigationGate = summarizeMitigationGate(
    mitigationPlan,
    fs.existsSync(mitigationReviewFile) ? readJson(mitigationReviewFile).judgments : {},
  )
  const mitigationGateFile = path.join(
    mediaRoot,
    'semantic',
    'workflows',
    'vid-016-v8-mitigation-gate.json',
  )
  if (!options.dryRun) atomicWriteJson(mitigationGateFile, mitigationGate)
  return {
    ok: true,
    dryRun: options.dryRun === true,
    planPath,
    outputFile,
    adoptionFile,
    mitigationGateFile,
    todo: {
      selected: todo.selected?.id || null,
      ready: todo.ready.map((task) => task.id),
      blocked: todo.blocked.map((task) => ({ id: task.id, waitingFor: task.waitingFor })),
    },
    report,
    adoptionGate,
    mitigationGate,
  }
}

if (require.main === module) {
  try {
    const result = run(parseArgs(process.argv.slice(2)))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`)
    process.exitCode = 1
  }
}

module.exports = {
  DIFFERENCE_FIELDS,
  buildDifferencePriority,
  parseArgs,
  run,
  summarizeAdoptionGate,
  summarizeMitigationGate,
}
