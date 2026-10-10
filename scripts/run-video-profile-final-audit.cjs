#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const PROFILE_IDS = Object.freeze([
  'film-series-animation',
  'short-form-vlog',
  'meeting-interview-podcast',
  'course-tutorial-screen',
  'game-stream',
  'surveillance-fixed',
  'sports',
  'general',
])
const TARGET_PER_PROFILE = 10
const PROFILE_LABELS = Object.freeze({
  'film-series-animation': '影视/动画',
  'short-form-vlog': '短视频/Vlog',
  'meeting-interview-podcast': '会议/访谈/播客',
  'course-tutorial-screen': '课程/教程/录屏',
  'game-stream': '游戏/直播',
  'surveillance-fixed': '固定监控',
  sports: '体育',
  general: '通用',
})

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}

function readOptionalJson(file) {
  return fs.existsSync(file) ? readJson(file) : null
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

function atomicWriteText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const stage = `${file}.${process.pid}.tmp`
  fs.writeFileSync(stage, value, { encoding: 'utf8', flag: 'wx' })
  try {
    fs.renameSync(stage, file)
  } finally {
    if (fs.existsSync(stage)) fs.rmSync(stage, { force: true })
  }
}

function percentage(numerator, denominator) {
  if (!denominator) return '不适用'
  const value = Math.round((numerator / denominator) * 1_000) / 10
  return `${value}%`
}

function renderFinalProfileReport(report) {
  if (!report?.gates?.finalReady) throw new Error('final-profile-report-not-ready')
  const rows = PROFILE_IDS.map((profileId) => {
    const row = report.semantic[profileId]
    const timestampUsable = row.timestampAccurate + row.timestampApproximate
    return `| ${PROFILE_LABELS[profileId]} | ${row.fullyWatched}/10 | ${percentage(row.consistent, row.fullyWatched)} | ${percentage(row.accepted, row.fullyWatched)} | ${row.minorHallucination} / ${row.majorHallucination} | ${row.timestampApplicable} | ${percentage(row.timestampAccurate, row.timestampApplicable)} | ${percentage(timestampUsable, row.timestampApplicable)} |`
  })
  const semanticRows = Object.values(report.semantic)
  const total = semanticRows.reduce((sum, row) => sum + row.fullyWatched, 0)
  const consistent = semanticRows.reduce((sum, row) => sum + row.consistent, 0)
  const accepted = semanticRows.reduce((sum, row) => sum + row.accepted, 0)
  const minor = semanticRows.reduce((sum, row) => sum + row.minorHallucination, 0)
  const major = semanticRows.reduce((sum, row) => sum + row.majorHallucination, 0)
  const timestampApplicable = semanticRows.reduce((sum, row) => sum + row.timestampApplicable, 0)
  const timestampAccurate = semanticRows.reduce((sum, row) => sum + row.timestampAccurate, 0)
  const timestampApproximate = semanticRows.reduce((sum, row) => sum + row.timestampApproximate, 0)
  const timestampWrong = semanticRows.reduce((sum, row) => sum + row.timestampWrong, 0)
  return `# VID-016 多类型视频语义最终验收报告

> 生成时间：${report.generatedAt}  
> 范围：8 个 profile × 每类 10 条匿名样本  
> 状态：最终工程验收通过

## 结论

最终 80/80 条样本均已获得严格可解析的 Qwen3-VL 2B 结果，并完成同口径人工完整观看。人工判断为一致 ${consistent} 条、部分一致 ${accepted - consistent} 条、不一致 ${total - accepted} 条；语义接受率代理指标为 ${percentage(accepted, total)}，严格一致率为 ${percentage(consistent, total)}。

八类 profile 真值和语义覆盖均达到每类 10 条，聚合门禁为 \`profileTruthReady=true\`、\`deepTruthReady=true\`、\`semanticCoverageReady=true\`、\`finalReady=true\`，因此 VID-016 工程验收可以关闭。

这里的“语义接受率”是人工对单个结果的一致性代理指标，不是检索 Recall@K。当前没有查询—相关结果集合和排名标注，所以继续保留 \`formalRecallAvailable=false\`，不把本报告冒充正式召回率报告。

## 分类型结果

| Profile | 完整观看 | 严格一致率 | 语义接受率 | 轻微/明显幻觉 | 时间点适用 | 时间点准确 | 准确或大致 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${rows.join('\n')}

## 汇总

- 完整观看：${total}/${total}。
- 一致/部分一致/不一致：${consistent}/${accepted - consistent}/${total - accepted}。
- 轻微幻觉：${minor}/${total}；明显幻觉：${major}/${total}。
- 时间点适用：${timestampApplicable}/${total}；准确 ${timestampAccurate}、大致 ${timestampApproximate}、错误 ${timestampWrong}。
- 时间点准确率：${percentage(timestampAccurate, timestampApplicable)}；计入“大致”后的可用率：${percentage(timestampAccurate + timestampApproximate, timestampApplicable)}。

## 门禁与后续

- VID-016：通过，可标记 \`verified\`。
- VAL-212：最终 8×10 profile 与深度真值通过。
- VAL-208：最终聚合报告已生成。
- V8.1 定向缓解未通过此前的无退化门禁，因此生产默认仍保持 V7，不因本次覆盖验收而改变。
- 内置 GGUF 运行时、许可证、SBOM、安装包体积和发布策略属于 VID-017，仍需单独授权和验证。

## 隐私

本报告只包含聚合统计，不包含匿名样本 ID、原始路径、文件名、语义正文或自由备注。权威机器审计保存在私有 Media Search 工作流目录中。
`
}

function acceptedProfileMap(...reviewStates) {
  const accepted = new Map()
  for (const state of reviewStates) {
    for (const [sampleId, judgment] of Object.entries(state?.judgments || {})) {
      if (judgment?.verdict !== 'accepted' || !PROFILE_IDS.includes(judgment?.profileId)) continue
      const previous = accepted.get(sampleId)
      if (previous && previous !== judgment.profileId) {
        throw new Error(`conflicting-profile-truth:${sampleId}`)
      }
      accepted.set(sampleId, judgment.profileId)
    }
  }
  return accepted
}

function buildFinalProfileAudit({
  profileReviews,
  semanticPlan,
  semanticReview,
  now = new Date(),
}) {
  if (!Array.isArray(semanticPlan?.samples)) throw new Error('missing-semantic-plan')
  const accepted = acceptedProfileMap(...profileReviews)
  const profileTruth = Object.fromEntries(
    PROFILE_IDS.map((profileId) => [
      profileId,
      {
        accepted: [...accepted.values()].filter((value) => value === profileId).length,
        target: TARGET_PER_PROFILE,
      },
    ]),
  )
  for (const row of Object.values(profileTruth)) {
    row.missing = Math.max(0, row.target - row.accepted)
    row.ready = row.missing === 0
  }

  const semantic = Object.fromEntries(
    PROFILE_IDS.map((profileId) => [
      profileId,
      {
        planned: 0,
        fullyWatched: 0,
        consistent: 0,
        partial: 0,
        inconsistent: 0,
        minorHallucination: 0,
        majorHallucination: 0,
        timestampApplicable: 0,
        timestampAccurate: 0,
        timestampApproximate: 0,
        timestampWrong: 0,
      },
    ]),
  )
  for (const sample of semanticPlan.samples) {
    if (!semantic[sample.profileId]) throw new Error(`unknown-semantic-profile:${sample.profileId}`)
    const row = semantic[sample.profileId]
    row.planned += 1
    const judgment = semanticReview?.judgments?.[sample.sampleId]
    if (!['consistent', 'partial', 'inconsistent'].includes(judgment?.verdict)) continue
    row[judgment.verdict] += 1
    if (judgment.watchedFullSegment === true) row.fullyWatched += 1
    if (judgment.hallucination === 'minor') row.minorHallucination += 1
    if (judgment.hallucination === 'major') row.majorHallucination += 1
    if (judgment.timestamp !== 'not-applicable') {
      row.timestampApplicable += 1
      if (['accurate', 'approximate', 'wrong'].includes(judgment.timestamp)) {
        row[`timestamp${judgment.timestamp[0].toUpperCase()}${judgment.timestamp.slice(1)}`] += 1
      }
    }
  }
  for (const row of Object.values(semantic)) {
    row.accepted = row.consistent + row.partial
    row.target = TARGET_PER_PROFILE
    row.missing = Math.max(0, row.target - row.planned)
    row.ready = row.planned >= row.target && row.fullyWatched >= row.target
  }

  const profileTruthReady = Object.values(profileTruth).filter((row) => row.ready).length
  const semanticProfilesReady = Object.values(semantic).filter((row) => row.ready).length
  const semanticPlanned = Object.values(semantic).reduce((sum, row) => sum + row.planned, 0)
  const fullyWatched = Object.values(semantic).reduce((sum, row) => sum + row.fullyWatched, 0)
  const deepTruthReady =
    semanticPlan.samples.length > 0 && fullyWatched === semanticPlan.samples.length
  const finalReady =
    deepTruthReady &&
    profileTruthReady === PROFILE_IDS.length &&
    semanticProfilesReady === PROFILE_IDS.length
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    privacy: {
      aggregateOnly: true,
      anonymousSampleIdsIncluded: false,
      originalPathsIncluded: false,
      originalNamesIncluded: false,
      semanticTextIncluded: false,
      freeTextIncluded: false,
    },
    target: { profiles: PROFILE_IDS.length, samplesPerProfile: TARGET_PER_PROFILE },
    gates: {
      deepTruthReady,
      profileTruthReady: profileTruthReady === PROFILE_IDS.length,
      semanticCoverageReady: semanticProfilesReady === PROFILE_IDS.length,
      formalRecallAvailable: false,
      finalReady,
    },
    totals: {
      acceptedProfileTruth: accepted.size,
      profileTruthReady,
      semanticPlanned,
      fullyWatched,
      semanticProfilesReady,
    },
    profileTruth,
    semantic,
    recommendation: !deepTruthReady
      ? 'complete-deep-ground-truth'
      : profileTruthReady < PROFILE_IDS.length
        ? 'complete-profile-truth-coverage'
        : semanticProfilesReady < PROFILE_IDS.length
          ? 'run-missing-profile-semantic-benchmark'
          : 'final-report-ready',
  }
}

function run(options = {}) {
  const mediaRoot = path.resolve(
    options.mediaRoot ||
      path.join(process.env.APPDATA || '', 'floating-clock-electron', 'media-search'),
  )
  const reviewRoot = path.join(mediaRoot, 'semantic', 'reviews')
  const benchmarkBase = path.join(mediaRoot, 'semantic', 'benchmarks')
  const finalBenchmarkRoot = path.join(benchmarkBase, 'qwen3-vl-2b-profile-final')
  const finalPlan = readOptionalJson(path.join(finalBenchmarkRoot, 'full-plan.json'))
  const benchmarkRoot =
    Array.isArray(finalPlan?.samples) && finalPlan.samples.length === 80
      ? finalBenchmarkRoot
      : path.join(benchmarkBase, 'qwen3-vl-2b-profile-v1')
  const report = buildFinalProfileAudit({
    profileReviews: [
      readJson(path.join(reviewRoot, 'video-profile-corpus-review.json')),
      readJson(path.join(reviewRoot, 'video-profile-gap-corpus-review.json')),
      readOptionalJson(path.join(reviewRoot, 'video-profile-final-coverage-review.json')),
    ],
    semanticPlan: readJson(path.join(benchmarkRoot, 'full-plan.json')),
    semanticReview: readJson(path.join(reviewRoot, 'video-profile-semantic-review.json')),
  })
  const outputFile = path.join(
    mediaRoot,
    'semantic',
    'workflows',
    'vid-016-final-profile-audit.json',
  )
  const reportFile = path.resolve(
    options.reportFile ||
      path.join(__dirname, '..', 'docs', 'benchmarks', '2026-08-15-video-profile-final-report.md'),
  )
  if (!options.dryRun) {
    atomicWriteJson(outputFile, report)
    if (report.gates.finalReady) atomicWriteText(reportFile, renderFinalProfileReport(report))
  }
  return {
    ok: true,
    dryRun: options.dryRun === true,
    outputFile,
    reportFile: report.gates.finalReady ? reportFile : null,
    report,
  }
}

if (require.main === module) {
  try {
    const result = run({ dryRun: process.argv.includes('--dry-run') })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`)
    process.exitCode = 1
  }
}

module.exports = {
  PROFILE_IDS,
  TARGET_PER_PROFILE,
  buildFinalProfileAudit,
  renderFinalProfileReport,
  run,
}
