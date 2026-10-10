const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const benchmark = require('../scripts/run-video-profile-benchmark.cjs')
const videoTodo = require('../scripts/next-value-optimization-task.cjs')
const videoTodoAutomation = require('../scripts/run-video-semantic-todo.cjs')
const finalProfileAudit = require('../scripts/run-video-profile-final-audit.cjs')

let model
let service

test.before(async () => {
  model = await import('../tools/video-semantic-review/profile-model.mjs')
  service = await import('../scripts/serve-video-profile-review.mjs')
})

test('LAN access is explicit while the default remains loopback-only', () => {
  assert.equal(service.resolveProfileReviewListenHost(), '127.0.0.1')
  assert.equal(service.resolveProfileReviewListenHost('loopback'), '127.0.0.1')
  assert.equal(service.resolveProfileReviewListenHost('lan'), '0.0.0.0')
  assert.equal(service.resolveProfileReviewListenHost('0.0.0.0'), '0.0.0.0')
})

test('video semantic remaining TODO closes after final 8x10 review and report pass', () => {
  const markdown = fs.readFileSync(
    'docs/current/2026-08-15-video-semantic-remaining-auto-todo.md',
    'utf8',
  )
  const tasks = videoTodo.parseValueTaskRows(markdown)
  const snapshot = videoTodo.buildValueTodoSnapshot(tasks)
  assert.equal(snapshot.ok, true)
  assert.equal(tasks.length, 12)
  assert.equal(snapshot.selected, null)
  assert.equal(snapshot.ready.length, 0)
  assert.equal(snapshot.counts.verified, 12)
  assert.equal(snapshot.counts.active, 0)
  assert.equal(snapshot.blocked.length, 0)
  assert.equal(tasks.find((task) => task.id === 'VAL-212')?.status, 'verified')
  assert.equal(tasks.find((task) => task.id === 'VAL-208')?.status, 'verified')
})

test('video semantic automation creates an anonymous protect-correct diff priority', () => {
  const sample = { sampleId: 'candidate-0123456789ab', profileId: 'general' }
  const result = (summary, events = []) => ({
    sample: sample,
    parse: {
      ok: true,
      value: {
        summary,
        scenes: ['room'],
        events,
        persons: [],
        objects: ['door'],
        visualText: [],
        searchTags: ['door'],
        warnings: [],
      },
    },
    videoPath: 'C:\\private\\secret.mp4',
  })
  const report = videoTodoAutomation.buildDifferencePriority(
    { samples: [sample] },
    { [sample.sampleId]: { verdict: 'consistent' } },
    new Map([[sample.sampleId, result('A closed door.')]]),
    new Map([[sample.sampleId, result('A person opens a door.', [{ label: 'open' }])]]),
  )
  assert.equal(report.summary.paired, 1)
  assert.equal(report.summary.protectCorrect, 1)
  assert.equal(report.records[0].priorityTier, 'protect-correct')
  assert.deepEqual(report.records[0].changedFields, ['summary', 'events'])
  assert.equal(report.records[0].changeScore, 8)
  assert.doesNotMatch(JSON.stringify(report), /secret|videoPath|closed door|person opens/)
  assert.deepEqual(videoTodoAutomation.parseArgs(['--dry-run']), {
    dryRun: true,
    planPath: path.resolve('docs/current/2026-08-15-video-semantic-remaining-auto-todo.md'),
  })
})

test('final profile audit refuses to claim complete 8x10 coverage from partial truth', () => {
  const profileReviews = [
    {
      judgments: {
        'candidate-000000000001': {
          verdict: 'accepted',
          profileId: 'general',
        },
        'candidate-000000000002': {
          verdict: 'accepted',
          profileId: 'meeting-interview-podcast',
        },
      },
    },
  ]
  const semanticPlan = {
    samples: [
      { sampleId: 'candidate-000000000001', profileId: 'general' },
      { sampleId: 'candidate-000000000003', profileId: 'sports' },
    ],
  }
  const semanticReview = {
    judgments: {
      'candidate-000000000001': {
        verdict: 'consistent',
        hallucination: 'none',
        timestamp: 'accurate',
        watchedFullSegment: true,
      },
      'candidate-000000000003': {
        verdict: 'partial',
        hallucination: 'minor',
        timestamp: 'not-applicable',
        watchedFullSegment: true,
      },
    },
  }
  const report = finalProfileAudit.buildFinalProfileAudit({
    profileReviews,
    semanticPlan,
    semanticReview,
    now: new Date('2026-08-15T00:00:00.000Z'),
  })
  assert.equal(report.gates.deepTruthReady, true)
  assert.equal(report.gates.profileTruthReady, false)
  assert.equal(report.gates.semanticCoverageReady, false)
  assert.equal(report.gates.formalRecallAvailable, false)
  assert.equal(report.gates.finalReady, false)
  assert.equal(report.recommendation, 'complete-profile-truth-coverage')
  assert.equal(report.profileTruth.general.accepted, 1)
  assert.equal(report.semantic.sports.minorHallucination, 1)
  assert.doesNotMatch(JSON.stringify(report), /candidate-[a-f0-9]{12}|"originalPath":|"videoPath":/)
})

test('final profile audit renders an aggregate-only 8x10 report when all gates pass', () => {
  const samples = finalProfileAudit.PROFILE_IDS.flatMap((profileId, profileIndex) =>
    Array.from({ length: 10 }, (_, sampleIndex) => ({
      sampleId: `candidate-${(profileIndex * 10 + sampleIndex).toString(16).padStart(12, '0')}`,
      profileId,
    })),
  )
  const profileReviews = [
    {
      judgments: Object.fromEntries(
        samples.map((sample) => [
          sample.sampleId,
          { verdict: 'accepted', profileId: sample.profileId },
        ]),
      ),
    },
  ]
  const semanticReview = {
    judgments: Object.fromEntries(
      samples.map((sample, index) => [
        sample.sampleId,
        {
          verdict: index % 10 === 9 ? 'partial' : 'consistent',
          hallucination: index === 0 ? 'minor' : 'none',
          timestamp: index % 2 === 0 ? 'accurate' : 'not-applicable',
          watchedFullSegment: true,
        },
      ]),
    ),
  }
  const report = finalProfileAudit.buildFinalProfileAudit({
    profileReviews,
    semanticPlan: { samples },
    semanticReview,
    now: new Date('2026-08-15T00:00:00.000Z'),
  })
  const markdown = finalProfileAudit.renderFinalProfileReport(report)
  assert.equal(report.gates.finalReady, true)
  assert.match(markdown, /最终工程验收通过/)
  assert.match(markdown, /语义接受率代理指标/)
  assert.match(markdown, /formalRecallAvailable=false/)
  assert.match(markdown, /VID-016：通过/)
  assert.doesNotMatch(markdown, /candidate-|originalPath|videoPath|语义正文内容/)
})

test('final profile audit tolerates a final-coverage review that has not been created yet', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-profile-final-audit-'))
  try {
    const reviewRoot = path.join(root, 'semantic', 'reviews')
    const benchmarkRoot = path.join(root, 'semantic', 'benchmarks', 'qwen3-vl-2b-profile-v1')
    fs.mkdirSync(reviewRoot, { recursive: true })
    fs.mkdirSync(benchmarkRoot, { recursive: true })
    fs.writeFileSync(path.join(reviewRoot, 'video-profile-corpus-review.json'), '{}')
    fs.writeFileSync(path.join(reviewRoot, 'video-profile-gap-corpus-review.json'), '{}')
    fs.writeFileSync(path.join(reviewRoot, 'video-profile-semantic-review.json'), '{}')
    fs.writeFileSync(path.join(benchmarkRoot, 'full-plan.json'), '{"samples":[]}')
    assert.doesNotThrow(() => finalProfileAudit.run({ mediaRoot: root, dryRun: true }))
    const finalRoot = path.join(root, 'semantic', 'benchmarks', 'qwen3-vl-2b-profile-final')
    fs.mkdirSync(finalRoot, { recursive: true })
    fs.writeFileSync(
      path.join(finalRoot, 'full-plan.json'),
      JSON.stringify({
        samples: Array.from({ length: 80 }, (_, index) => ({
          sampleId: `candidate-${index.toString(16).padStart(12, '0')}`,
          profileId: finalProfileAudit.PROFILE_IDS[index % finalProfileAudit.PROFILE_IDS.length],
        })),
      }),
    )
    assert.equal(
      finalProfileAudit.run({ mediaRoot: root, dryRun: true }).report.totals.semanticPlanned,
      80,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('video semantic adoption gate detects regressions in previously consistent samples', () => {
  const samples = [
    { sampleId: 'candidate-0123456789ab', profileId: 'general' },
    { sampleId: 'candidate-abcdef012345', profileId: 'film-series-animation' },
  ]
  const gate = videoTodoAutomation.summarizeAdoptionGate(
    { samples },
    {
      [samples[0].sampleId]: { verdict: 'consistent' },
      [samples[1].sampleId]: { verdict: 'partial' },
    },
    {
      [samples[0].sampleId]: { verdict: 'regressed', preferredOutput: 'v1' },
      [samples[1].sampleId]: { verdict: 'improved', preferredOutput: 'v7' },
    },
  )
  assert.equal(gate.complete, true)
  assert.equal(gate.protectCorrect.regressed, 1)
  assert.equal(gate.universalAdoptionPassed, false)
  assert.equal(gate.recommendation, 'targeted-mitigation-required')
  assert.deepEqual(gate.regressedSampleIds, [samples[0].sampleId])
  assert.doesNotMatch(JSON.stringify(gate), /"(?:videoPath|originalName|semanticText)":/)
})

test('video semantic V8 mitigation gate retains V7 when any reviewed sample regresses', () => {
  const samples = [
    { sampleId: 'candidate-0123456789ab', profileId: 'general' },
    { sampleId: 'candidate-abcdef012345', profileId: 'surveillance-fixed' },
  ]
  const gate = videoTodoAutomation.summarizeMitigationGate(
    { samples },
    {
      [samples[0].sampleId]: { verdict: 'improved', preferredOutput: 'v7' },
      [samples[1].sampleId]: { verdict: 'regressed', preferredOutput: 'neither' },
    },
  )
  assert.equal(gate.complete, true)
  assert.equal(gate.preferences.rightV81, 1)
  assert.equal(gate.verdicts.regressed, 1)
  assert.equal(gate.noRegressionPassed, false)
  assert.equal(gate.recommendation, 'retain-v7-default')
  assert.deepEqual(gate.regressedSampleIds, [samples[1].sampleId])
  assert.doesNotMatch(JSON.stringify(gate), /"(?:videoPath|originalName|semanticText)":/)
})

test('profile review requires ten accepted anonymous samples in every profile', () => {
  const samples = []
  const judgments = {}
  for (const profile of model.VIDEO_PROFILES) {
    for (let index = 0; index < 10; index += 1) {
      const sampleId = `candidate-${profile.id.slice(0, 3)}-${index}`
      samples.push({ sampleId, durationBucket: 'short', orientation: 'landscape' })
      judgments[sampleId] = { verdict: 'accepted', profileId: profile.id }
    }
  }
  assert.equal(model.summarizeProfileReview(samples, judgments).readyForBenchmark, true)
  judgments[samples[0].sampleId] = { verdict: 'skipped' }
  assert.equal(model.summarizeProfileReview(samples, judgments).readyForBenchmark, false)
})

test('partial benchmark plan is anonymous, bounded, and reports missing profiles', () => {
  const candidates = Array.from({ length: 15 }, (_, index) => ({
    sampleId: `candidate-${index.toString(16).padStart(12, '0')}`,
  }))
  const judgments = Object.fromEntries(
    candidates.map((sample, index) => [
      sample.sampleId,
      {
        verdict: 'accepted',
        profileId: index < 12 ? 'short-form-vlog' : 'general',
      },
    ]),
  )
  const plan = benchmark.buildPlan(candidates, { judgments }, 10, false)
  assert.equal(plan.samples.length, 13)
  assert.equal(plan.coverage['short-form-vlog'].selected, 10)
  assert.equal(plan.coverage.general.selected, 3)
  assert.equal(plan.coverage.sports.selected, 0)
  assert.equal(plan.coverage.sports.covered, false)
  assert.doesNotMatch(JSON.stringify(plan), /"(?:videoPath|originalName)":/)
  const shadowPlan = benchmark.buildPlan(
    candidates,
    { judgments },
    10,
    false,
    '2026-08-15.profile-v7-shadow',
  )
  assert.equal(shadowPlan.benchmarkRevision, '2026-08-15.profile-v7-shadow')
  assert.equal(benchmark.SHADOW_RESULT_SET, 'profile-v7-shadow')
  assert.equal(benchmark.MITIGATION_RESULT_SET, 'profile-v8-mitigation')
  assert.deepEqual(benchmark.MITIGATION_SAMPLE_IDS, [
    'candidate-ae6547234445',
    'candidate-04feba1e556c',
    'candidate-5b8d8fefcbd9',
    'candidate-d0eda23e1fcb',
    'candidate-42ffe764c25a',
    'candidate-82c306ae2374',
  ])
})

test('final profile plan preserves all 44 frozen samples and fills every profile to ten', () => {
  const baselineCounts = [4, 10, 6, 10, 3, 2, 5, 4]
  const baselineSamples = []
  const candidates = []
  const judgments = {}
  for (const [profileIndex, profileId] of benchmark.PROFILE_IDS.entries()) {
    for (let index = 0; index < 10; index += 1) {
      const sampleId = `candidate-${profileIndex.toString(16)}${index
        .toString(16)
        .padStart(11, '0')}`
      candidates.push({ sampleId })
      judgments[sampleId] = { verdict: 'accepted', profileId }
      if (index < baselineCounts[profileIndex]) baselineSamples.push({ sampleId, profileId })
    }
  }
  assert.equal(baselineSamples.length, 44)
  const plan = benchmark.buildFinalPlan(
    candidates,
    { judgments },
    { benchmarkRevision: benchmark.BENCHMARK_REVISION, samples: baselineSamples },
  )
  assert.equal(plan.samples.length, 80)
  assert.equal(plan.baselineReused, 44)
  assert.ok(
    baselineSamples.every((sample) =>
      plan.samples.some((item) => item.sampleId === sample.sampleId),
    ),
  )
  assert.ok(Object.values(plan.coverage).every((row) => row.selected === 10 && row.complete))
  assert.deepEqual([...new Set(plan.samples.flatMap(Object.keys))], ['sampleId', 'profileId'])
  assert.equal(plan.privacy.originalPathsIncluded, false)
  assert.equal(plan.privacy.originalNamesIncluded, false)
})

test('final profile truth merge rejects conflicting accepted labels', () => {
  assert.throws(
    () =>
      benchmark.mergeProfileReviews(
        {
          judgments: {
            'candidate-0123456789ab': { verdict: 'accepted', profileId: 'general' },
          },
        },
        {
          judgments: {
            'candidate-0123456789ab': { verdict: 'accepted', profileId: 'sports' },
          },
        },
      ),
    /Conflicting profile truth/,
  )
})

test('final profile truth merge does not let a scoped skip erase accepted baseline truth', () => {
  const merged = benchmark.mergeProfileReviews(
    {
      judgments: {
        'candidate-0123456789ab': { verdict: 'accepted', profileId: 'general' },
      },
    },
    {
      judgments: {
        'candidate-0123456789ab': { verdict: 'skipped' },
      },
    },
  )
  assert.equal(merged.judgments['candidate-0123456789ab'].verdict, 'accepted')
  assert.equal(merged.judgments['candidate-0123456789ab'].profileId, 'general')
})

test('prepared final evidence uses the strict 40-hex frame authority format', () => {
  assert.match(benchmark.evidenceFrameId('candidate-0123456789ab', 12_345), /^[a-f0-9]{40}$/)
})

test('final semantic pilot resolves reclassified gap samples across all profiles', () => {
  const source = fs.readFileSync('scripts/run-video-semantic-pilot.cjs', 'utf8')
  assert.match(source, /VIDEO_SEMANTIC_PROFILE_IDS/)
  assert.match(
    source,
    /buildProfileGapCandidates\(\s*mediaRoot,\s*DEFAULT_PROFILE_CORPUS_ROOT,\s*VIDEO_SEMANTIC_PROFILE_IDS,?\s*\)/,
  )
  assert.doesNotMatch(
    source,
    /buildProfileGapCandidates\(mediaRoot, DEFAULT_PROFILE_CORPUS_ROOT, \[judgment\.profileId\]\)/,
  )
})

test('profile benchmark pauses immediately for a missing local runtime', () => {
  assert.equal(
    benchmark.isRuntimeUnavailableFailure('Video semantic runtime is not ready: fetch failed'),
    true,
  )
  assert.equal(
    benchmark.isRuntimeUnavailableFailure('runner-completed-without-valid-result'),
    false,
  )
})

test('profile export excludes paths, names, notes, and skipped candidates', () => {
  const samples = [
    {
      sampleId: 'candidate-0123456789ab',
      durationBucket: 'long',
      orientation: 'portrait',
      hasAudio: true,
      hasTranscript: false,
      videoPath: 'C:\\private\\secret.mp4',
      originalName: 'secret.mp4',
    },
    { sampleId: 'candidate-abcdef012345' },
  ]
  const report = model.buildProfileReviewExport(samples, {
    [samples[0].sampleId]: { verdict: 'accepted', profileId: 'general', notes: 'private note' },
    [samples[1].sampleId]: { verdict: 'skipped' },
  })
  assert.equal(report.records.length, 1)
  assert.doesNotMatch(JSON.stringify(report), /secret|private note|"(?:videoPath|originalName)":/)
})

test('gap corpus summary only requires meeting and sports targets', () => {
  const samples = [{ sampleId: 'candidate-0123456789ab' }, { sampleId: 'candidate-abcdef012345' }]
  const judgments = {
    [samples[0].sampleId]: {
      verdict: 'accepted',
      profileId: 'meeting-interview-podcast',
    },
    [samples[1].sampleId]: { verdict: 'accepted', profileId: 'sports' },
  }
  const targetProfileIds = ['meeting-interview-podcast', 'sports']
  const summary = model.summarizeSelectedProfileReview(samples, judgments, 1, targetProfileIds)
  assert.equal(summary.readyProfiles, 2)
  assert.equal(summary.totalProfiles, 2)
  assert.equal(summary.readyForBenchmark, true)
  assert.deepEqual(Object.keys(summary.perProfile), targetProfileIds)
  const report = model.buildProfileReviewExport(samples, judgments, new Date(0), targetProfileIds)
  assert.equal(report.summary.totalProfiles, 2)
})

test('semantic benchmark review normalizes judgments and exports anonymous proxy metrics', async () => {
  const semantic = await import('../tools/video-semantic-review/benchmark-model.mjs')
  const samples = [
    {
      sampleId: 'candidate-0123456789ab',
      profileId: 'general',
      resultState: 'ready',
      videoPath: 'secret.mp4',
    },
    { sampleId: 'candidate-abcdef012345', profileId: 'sports', resultState: 'pending' },
  ]
  const judgments = {
    [samples[0].sampleId]: {
      verdict: 'partial',
      hallucination: 'minor',
      timestamp: 'approximate',
      notes: 'private note',
    },
  }
  const summary = semantic.summarizeBenchmarkReview(samples, judgments)
  assert.equal(summary.reviewed, 1)
  assert.equal(summary.semanticAcceptancePercent, 100)
  assert.equal(summary.strictConsistencyPercent, 0)
  assert.equal(summary.pending, 1)
  assert.equal(summary.fullWatch.completed, 0)
  assert.equal(summary.fullWatch.incomplete, 1)
  assert.equal(summary.deepTruthReady, false)
  const report = semantic.buildBenchmarkReviewExport(samples, judgments)
  assert.equal(report.records.length, 1)
  assert.match(report.metricNote, /不等同于正式召回率/)
  assert.doesNotMatch(JSON.stringify(report), /private note|secret\.mp4|videoPath/)
})

test('regression review requires both decisions and exports no private notes', async () => {
  const regression = await import('../tools/video-semantic-review/regression-model.mjs')
  const samples = [
    {
      sampleId: 'candidate-0123456789ab',
      profileId: 'general',
      baselineVerdict: 'partial',
      v1: { resultState: 'ready' },
      v7: { resultState: 'ready' },
      videoPath: 'C:\\private\\secret.mp4',
    },
  ]
  const incomplete = { verdict: 'improved', notes: 'private note' }
  assert.equal(regression.isRegressionJudgmentComplete(incomplete), false)
  const judgments = {
    [samples[0].sampleId]: {
      ...incomplete,
      preferredOutput: 'v7',
      watchedFullSegment: true,
    },
  }
  const summary = regression.summarizeRegressionReview(samples, judgments)
  assert.equal(summary.reviewed, 1)
  assert.equal(summary.verdicts.improved, 1)
  assert.equal(summary.preferences.v7, 1)
  const report = regression.buildRegressionReviewExport(samples, judgments)
  assert.equal(report.records.length, 1)
  assert.doesNotMatch(JSON.stringify(report), /private note|secret\.mp4|videoPath|notes/)
})

test('profile server stratifies playable videos, redacts identity, streams ranges, and persists labels', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-profile-review-'))
  const mediaRoot = path.join(root, 'media-search')
  const manifests = path.join(mediaRoot, 'manifests')
  const reviewFile = path.join(root, 'private', 'review.json')
  fs.mkdirSync(manifests, { recursive: true })
  const rows = []
  for (let index = 0; index < 12; index += 1) {
    const videoPath = path.join(root, `original-secret-${index}.mp4`)
    fs.writeFileSync(videoPath, Buffer.from(`0123456789abcdef-${index}`))
    rows.push({
      videoId: `video-${index}`,
      path: videoPath,
      name: `private-${index}.mp4`,
      metadataStatus: 'done',
      missing: false,
      durationMs: index < 4 ? 30_000 : index < 8 ? 300_000 : 2_000_000,
      width: index % 2 ? 720 : 1280,
      height: index % 2 ? 1280 : 720,
      videoCodec: 'h264',
      audioCodec: index % 3 ? 'aac' : '',
    })
  }
  fs.writeFileSync(
    path.join(manifests, 'video_files.jsonl'),
    `${rows.map(JSON.stringify).join('\n')}\n`,
  )
  const running = await service.createVideoProfileReviewServer({
    mediaRoot,
    reviewFile,
    maximumCandidates: 6,
    token: 'fixture-profile-token',
    port: 0,
  })
  try {
    const origin = new URL(running.url).origin
    assert.equal((await fetch(`${origin}/api/profile/state`)).status, 403)
    const state = await (
      await fetch(`${origin}/api/profile/state`, {
        headers: { 'X-Review-Token': 'fixture-profile-token' },
      })
    ).json()
    assert.equal(state.samples.length, 6)
    assert.equal(state.privacy.loopbackOnly, true)
    assert.equal(state.privacy.lanAccessEnabled, false)
    assert.equal(state.privacy.tokenRequired, true)
    assert.doesNotMatch(JSON.stringify(state), /original-secret|private-|videoId|videoPath/)
    assert.ok(new Set(state.samples.map((sample) => sample.durationBucket)).size >= 2)
    const sample = state.samples[0]
    const range = await fetch(
      `${origin}/api/profile/video/${sample.sampleId}?token=fixture-profile-token`,
      { headers: { Range: 'bytes=2-5' } },
    )
    assert.equal(range.status, 206)
    assert.equal(await range.text(), '2345')
    const saved = await (
      await fetch(`${origin}/api/profile/review/${sample.sampleId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Review-Token': 'fixture-profile-token' },
        body: JSON.stringify({
          markReviewed: true,
          judgment: { verdict: 'accepted', profileId: 'sports', notes: 'bounded' },
        }),
      })
    ).json()
    assert.equal(saved.ok, true)
    assert.equal(saved.judgment.profileId, 'sports')
    assert.doesNotMatch(fs.readFileSync(reviewFile, 'utf8'), /original-secret|videoPath/)
  } finally {
    await running.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('profile gap mode uses only bounded meeting and sports copies with separate review state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-profile-gap-'))
  const mediaRoot = path.join(root, 'media-search')
  const manifests = path.join(mediaRoot, 'manifests')
  const corpusRoot = path.join(root, 'gap-corpus')
  fs.mkdirSync(manifests, { recursive: true })
  fs.mkdirSync(path.join(corpusRoot, '02_meeting'), { recursive: true })
  fs.mkdirSync(path.join(corpusRoot, '03_sports'), { recursive: true })
  const fixtures = [
    {
      videoId: 'meeting-video',
      category: '02_meeting',
      profileId: 'meeting-interview-podcast',
    },
    { videoId: 'sports-video', category: '03_sports', profileId: 'sports' },
    { videoId: 'escaped-video', category: '03_sports', profileId: 'sports', escaped: true },
  ]
  const rows = []
  const curated = []
  for (const [index, fixture] of fixtures.entries()) {
    const originalPath = path.join(root, `private-original-${index}.mp4`)
    fs.writeFileSync(originalPath, Buffer.from(`0123456789abcdef-${index}`))
    rows.push({
      videoId: fixture.videoId,
      path: originalPath,
      name: `private-original-${index}.mp4`,
      metadataStatus: 'done',
      missing: false,
      durationMs: 60_000 + index * 10_000,
      width: 1280,
      height: 720,
      videoCodec: 'h264',
      audioCodec: 'aac',
    })
    const sampleId = `candidate-${crypto
      .createHash('sha256')
      .update(`profile-review:${fixture.videoId}`)
      .digest('hex')
      .slice(0, 12)}`
    const localPath = fixture.escaped
      ? originalPath
      : path.join(corpusRoot, fixture.category, `curated-${index}.mp4`)
    if (!fixture.escaped) fs.copyFileSync(originalPath, localPath)
    curated.push({
      candidateId: sampleId,
      category: fixture.category,
      localPath,
      originalPath,
    })
  }
  fs.writeFileSync(
    path.join(manifests, 'video_files.jsonl'),
    `${rows.map(JSON.stringify).join('\n')}\n`,
  )
  fs.writeFileSync(
    path.join(corpusRoot, 'local-curated-manifest.json'),
    `\uFEFF${JSON.stringify(curated)}`,
  )
  const candidates = service.buildProfileGapCandidates(mediaRoot, corpusRoot)
  assert.equal(candidates.length, 2)
  assert.deepEqual(candidates.map((candidate) => candidate.proposedProfileId).sort(), [
    'meeting-interview-podcast',
    'sports',
  ])
  assert.ok(candidates.every((candidate) => candidate.videoPath.startsWith(corpusRoot)))

  const running = await service.createVideoProfileReviewServer({
    mediaRoot,
    gapCorpusRoot: corpusRoot,
    token: 'fixture-gap-token',
    port: 0,
  })
  try {
    const origin = new URL(running.url).origin
    const state = await (
      await fetch(`${origin}/api/profile/state`, {
        headers: { 'X-Review-Token': 'fixture-gap-token' },
      })
    ).json()
    assert.equal(state.mode, 'gap')
    assert.equal(state.samples.length, 2)
    assert.deepEqual(state.targetProfileIds, ['meeting-interview-podcast', 'sports'])
    assert.equal(state.profiles.length, 2)
    assert.equal(state.summary.totalProfiles, 2)
    assert.match(running.reviewFile, /video-profile-gap-corpus-review\.json$/)
    assert.doesNotMatch(
      JSON.stringify(state),
      /private-original|curated-|"videoPath":|"originalPath":/,
    )
  } finally {
    await running.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('profile gap mode accepts bounded Wikimedia records without exposing source identity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-profile-gap-external-'))
  const mediaRoot = path.join(root, 'media-search')
  const corpusRoot = path.join(root, 'gap-corpus')
  const manifests = path.join(mediaRoot, 'manifests')
  const meetingRoot = path.join(corpusRoot, '02_meeting')
  fs.mkdirSync(manifests, { recursive: true })
  fs.mkdirSync(meetingRoot, { recursive: true })
  fs.writeFileSync(path.join(manifests, 'video_files.jsonl'), '')
  const videoPath = path.join(meetingRoot, 'commons-interview.webm')
  const bytes = Buffer.from('bounded-wikimedia-video-fixture')
  fs.writeFileSync(videoPath, bytes)
  const digest = crypto.createHash('sha256').update(bytes).digest('hex')
  const candidateId = `candidate-${crypto
    .createHash('sha256')
    .update(`profile-gap-external:${digest}`)
    .digest('hex')
    .slice(0, 12)}`
  const record = {
    candidateId,
    category: '02_meeting',
    localPath: videoPath,
    sourceType: 'wikimedia-commons',
    sourcePage: 'https://commons.wikimedia.org/wiki/File:Bounded_interview.webm',
    sourceUrl: 'https://upload.wikimedia.org/wikipedia/commons/bounded.webm',
    license: 'CC BY-SA 4.0',
    sha256: digest,
    sizeBytes: bytes.length,
    durationMs: 90_000,
    width: 640,
    height: 360,
    videoCodec: 'vp9',
    audioCodec: 'opus',
  }
  fs.writeFileSync(
    path.join(corpusRoot, 'local-curated-manifest.json'),
    JSON.stringify([
      record,
      {
        ...record,
        candidateId: `candidate-${'f'.repeat(12)}`,
        localPath: path.join(meetingRoot, 'invalid.webm'),
        sourcePage: 'https://example.com/private-video',
      },
    ]),
  )
  const candidates = service.buildProfileGapCandidates(mediaRoot, corpusRoot)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].sampleId, candidateId)
  assert.equal(candidates[0].proposedProfileId, 'meeting-interview-podcast')
  assert.equal(candidates[0].durationBucket, 'short')

  const running = await service.createVideoProfileReviewServer({
    mediaRoot,
    gapCorpusRoot: corpusRoot,
    token: 'fixture-external-gap-token',
    port: 0,
  })
  try {
    const origin = new URL(running.url).origin
    const state = await (
      await fetch(`${origin}/api/profile/state`, {
        headers: { 'X-Review-Token': 'fixture-external-gap-token' },
      })
    ).json()
    assert.equal(state.samples.length, 1)
    assert.equal(state.samples[0].sampleId, candidateId)
    assert.doesNotMatch(
      JSON.stringify(state),
      /commons-interview|wikimedia\.org|upload\.wikimedia|sourcePage|sourceUrl|sha256/,
    )
  } finally {
    await running.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('final coverage gap mode isolates general and fixed-surveillance truth', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-profile-final-gap-'))
  const mediaRoot = path.join(root, 'media-search')
  const corpusRoot = path.join(root, 'gap-corpus')
  fs.mkdirSync(path.join(mediaRoot, 'manifests'), { recursive: true })
  fs.writeFileSync(path.join(mediaRoot, 'manifests', 'video_files.jsonl'), '')
  const records = []
  for (const [index, fixture] of [
    { category: '04_general', profileId: 'general' },
    { category: '05_surveillance', profileId: 'surveillance-fixed' },
  ].entries()) {
    const targetRoot = path.join(corpusRoot, fixture.category)
    fs.mkdirSync(targetRoot, { recursive: true })
    const videoPath = path.join(targetRoot, `fixture-${index}.webm`)
    const bytes = Buffer.from(`bounded-final-coverage-${index}`)
    fs.writeFileSync(videoPath, bytes)
    const digest = crypto.createHash('sha256').update(bytes).digest('hex')
    records.push({
      candidateId: `candidate-${crypto
        .createHash('sha256')
        .update(`profile-gap-external:${digest}`)
        .digest('hex')
        .slice(0, 12)}`,
      category: fixture.category,
      localPath: videoPath,
      sourceType: 'wikimedia-commons',
      sourcePage: 'https://commons.wikimedia.org/wiki/File:Bounded_fixture.webm',
      sourceUrl: 'https://upload.wikimedia.org/wikipedia/commons/bounded.webm',
      license: 'CC BY-SA 4.0',
      sha256: digest,
      sizeBytes: bytes.length,
      durationMs: 30_000,
      width: 640,
      height: 360,
      videoCodec: 'vp9',
      audioCodec: '',
    })
  }
  fs.writeFileSync(path.join(corpusRoot, 'local-curated-manifest.json'), JSON.stringify(records))
  assert.equal(service.buildProfileGapCandidates(mediaRoot, corpusRoot).length, 0)
  assert.deepEqual(
    service
      .buildProfileGapCandidates(mediaRoot, corpusRoot, ['general', 'surveillance-fixed'])
      .map((candidate) => candidate.proposedProfileId),
    ['general', 'surveillance-fixed'],
  )

  const running = await service.createVideoProfileReviewServer({
    mediaRoot,
    gapCorpusRoot: corpusRoot,
    gapProfileSet: 'final-coverage',
    token: 'fixture-final-gap-token',
    port: 0,
  })
  try {
    const origin = new URL(running.url).origin
    const state = await (
      await fetch(`${origin}/api/profile/state`, {
        headers: { 'X-Review-Token': 'fixture-final-gap-token' },
      })
    ).json()
    assert.equal(state.mode, 'gap-final-coverage')
    assert.deepEqual(state.targetProfileIds, ['general', 'surveillance-fixed'])
    assert.equal(state.samples.length, 2)
    assert.match(running.reviewFile, /video-profile-final-coverage-review\.json$/)
    assert.equal(state.presentation.exportFileName, 'video-profile-final-coverage-summary.json')
    assert.doesNotMatch(
      JSON.stringify(state),
      /fixture-\d|wikimedia\.org|sourcePage|sourceUrl|sha256/,
    )
  } finally {
    await running.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('profile server exposes bounded benchmark output, video ranges, and atomic semantic reviews', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-benchmark-review-'))
  const mediaRoot = path.join(root, 'media-search')
  const manifests = path.join(mediaRoot, 'manifests')
  fs.mkdirSync(manifests, { recursive: true })
  const videoPath = path.join(root, 'highly-private-name.mp4')
  fs.writeFileSync(videoPath, Buffer.from('0123456789abcdef'))
  fs.writeFileSync(
    path.join(manifests, 'video_files.jsonl'),
    `${JSON.stringify({
      videoId: 'private-video-id',
      path: videoPath,
      name: 'highly-private-name.mp4',
      metadataStatus: 'done',
      missing: false,
      durationMs: 80_000,
      width: 1280,
      height: 720,
      videoCodec: 'h264',
      audioCodec: 'aac',
    })}\n`,
  )
  const candidate = service.buildProfileCandidates(mediaRoot, 1)[0]
  const benchmarkRoot = path.join(mediaRoot, 'semantic', 'benchmarks', 'qwen3-vl-2b-profile-v1')
  fs.mkdirSync(benchmarkRoot, { recursive: true })
  fs.writeFileSync(
    path.join(benchmarkRoot, 'full-plan.json'),
    JSON.stringify({
      samples: [{ sampleId: candidate.sampleId, profileId: 'general' }],
      coverage: {},
    }),
  )
  fs.writeFileSync(
    path.join(benchmarkRoot, 'full-job.json'),
    JSON.stringify({
      state: 'running',
      total: 1,
      completed: 1,
      failed: 0,
    }),
  )
  fs.writeFileSync(
    path.join(benchmarkRoot, `${candidate.sampleId}.json`),
    JSON.stringify({
      sample: { sampleId: candidate.sampleId, segmentStartMs: 30_000, segmentEndMs: 50_000 },
      runtime: { model: { modelId: 'qwen3-vl:2b' } },
      metrics: { latencyMs: 1234, peakGpuUsedMiB: 1536 },
      parse: {
        ok: true,
        value: {
          summary: 'A person opens a door.',
          scenes: ['hallway'],
          events: [
            { label: 'open', description: 'Person opens a door.', startMs: 31_000, endMs: 33_000 },
          ],
          persons: [{ description: 'one person', actions: ['opening'] }],
          objects: ['door'],
          visualText: [],
          searchTags: ['door opening'],
          warnings: [],
          sourceFingerprint: 'private-fingerprint',
        },
      },
    }),
  )
  const regressionRoot = path.join(
    mediaRoot,
    'semantic',
    'benchmarks',
    'qwen3-vl-2b-profile-v3-regression',
  )
  fs.mkdirSync(regressionRoot, { recursive: true })
  fs.writeFileSync(
    path.join(regressionRoot, `${candidate.sampleId}.json`),
    JSON.stringify({
      sample: { sampleId: candidate.sampleId, segmentStartMs: 30_000, segmentEndMs: 50_000 },
      metrics: { latencyMs: 1111, peakGpuUsedMiB: 1400 },
      parse: {
        ok: true,
        value: {
          promptVersion: '2026-08-15.v7',
          summary: 'A person walks through a doorway.',
          scenes: ['hallway'],
          events: [],
          persons: ['one person'],
          objects: ['door'],
          visualText: [],
          searchTags: ['walking through doorway'],
          warnings: [],
        },
      },
    }),
  )
  const shadowRoot = path.join(mediaRoot, 'semantic', 'benchmarks', 'qwen3-vl-2b-profile-v7-shadow')
  fs.mkdirSync(shadowRoot, { recursive: true })
  fs.copyFileSync(
    path.join(regressionRoot, `${candidate.sampleId}.json`),
    path.join(shadowRoot, `${candidate.sampleId}.json`),
  )
  fs.copyFileSync(
    path.join(benchmarkRoot, 'full-plan.json'),
    path.join(shadowRoot, 'full-plan.json'),
  )
  const mitigationRoot = path.join(
    mediaRoot,
    'semantic',
    'benchmarks',
    'qwen3-vl-2b-profile-v8-mitigation',
  )
  fs.mkdirSync(mitigationRoot, { recursive: true })
  const mitigationFixture = JSON.parse(
    fs.readFileSync(path.join(regressionRoot, `${candidate.sampleId}.json`), 'utf8'),
  )
  mitigationFixture.parse.value.promptVersion = '2026-08-15.v8.1'
  mitigationFixture.parse.value.summary = 'A person passes through a doorway.'
  fs.writeFileSync(
    path.join(mitigationRoot, `${candidate.sampleId}.json`),
    JSON.stringify(mitigationFixture),
  )
  const semanticReviewFile = path.join(root, 'reviews', 'semantic.json')
  const regressionReviewFile = path.join(root, 'reviews', 'regression.json')
  const shadowReviewFile = path.join(root, 'reviews', 'shadow.json')
  const mitigationReviewFile = path.join(root, 'reviews', 'mitigation.json')
  fs.mkdirSync(path.dirname(semanticReviewFile), { recursive: true })
  fs.writeFileSync(
    semanticReviewFile,
    JSON.stringify({
      schemaVersion: 1,
      judgments: {
        [candidate.sampleId]: {
          verdict: 'partial',
          hallucination: 'none',
          timestamp: 'not-applicable',
        },
      },
    }),
  )
  const running = await service.createVideoProfileReviewServer({
    mediaRoot,
    maximumCandidates: 1,
    token: 'fixture-benchmark-token',
    port: 0,
    benchmarkReviewFile: semanticReviewFile,
    regressionReviewFile,
    shadowReviewFile,
    mitigationReviewFile,
    regressionSampleIds: [candidate.sampleId],
    mitigationSampleIds: [candidate.sampleId],
  })
  try {
    const origin = new URL(running.url).origin
    const headers = { 'X-Review-Token': 'fixture-benchmark-token' }
    const startupRegressionState = await (
      await fetch(`${origin}/api/profile/benchmark/regression-state`, { headers })
    ).json()
    assert.equal(startupRegressionState.samples[0].baselineVerdict, 'partial')
    const state = await (
      await fetch(`${origin}/api/profile/benchmark/review-state`, { headers })
    ).json()
    assert.equal(state.samples.length, 1)
    assert.equal(state.samples[0].result.summary, 'A person opens a door.')
    assert.equal(state.samples[0].resultState, 'ready')
    assert.doesNotMatch(
      JSON.stringify(state),
      /highly-private|private-video-id|private-fingerprint|videoPath/,
    )
    const range = await fetch(
      `${origin}/api/profile/benchmark/video/${candidate.sampleId}?token=fixture-benchmark-token`,
      { headers: { Range: 'bytes=3-7' } },
    )
    assert.equal(range.status, 206)
    assert.equal(await range.text(), '34567')
    const saved = await (
      await fetch(`${origin}/api/profile/benchmark/review/${candidate.sampleId}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          markReviewed: true,
          judgment: {
            verdict: 'consistent',
            hallucination: 'none',
            timestamp: 'accurate',
            notes: 'private note',
          },
        }),
      })
    ).json()
    assert.equal(saved.judgment.verdict, 'consistent')
    assert.ok(fs.existsSync(semanticReviewFile))
    assert.doesNotMatch(fs.readFileSync(semanticReviewFile, 'utf8'), /highly-private|videoPath/)
    const regressionState = await (
      await fetch(`${origin}/api/profile/benchmark/regression-state`, { headers })
    ).json()
    assert.equal(regressionState.samples.length, 1)
    assert.equal(regressionState.samples[0].v1.result.summary, 'A person opens a door.')
    assert.equal(regressionState.samples[0].v7.result.summary, 'A person walks through a doorway.')
    assert.equal(regressionState.samples[0].resolution, '1280×720')
    assert.equal(regressionState.samples[0].sourceAspectRatio, 1.777778)
    assert.equal(regressionState.samples[0].baselineVerdict, 'consistent')
    assert.doesNotMatch(
      JSON.stringify(regressionState),
      /highly-private|private-video-id|videoPath/,
    )
    const regressionSaved = await (
      await fetch(`${origin}/api/profile/benchmark/regression-review/${candidate.sampleId}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          markReviewed: true,
          judgment: {
            verdict: 'improved',
            preferredOutput: 'v7',
            watchedFullSegment: true,
            notes: 'private comparison',
          },
        }),
      })
    ).json()
    assert.equal(regressionSaved.judgment.verdict, 'improved')
    assert.ok(fs.existsSync(regressionReviewFile))
    assert.doesNotMatch(fs.readFileSync(regressionReviewFile, 'utf8'), /highly-private|videoPath/)
    const shadowState = await (
      await fetch(`${origin}/api/profile/benchmark/shadow-state`, { headers })
    ).json()
    assert.equal(shadowState.samples.length, 1)
    assert.equal(shadowState.samples[0].v7.result.summary, 'A person walks through a doorway.')
    assert.deepEqual(shadowState.samples[0].difference.changedFields, [
      'summary',
      'events',
      'persons',
      'searchTags',
    ])
    assert.equal(shadowState.samples[0].difference.changeScore, 12)
    const shadowSaved = await (
      await fetch(`${origin}/api/profile/benchmark/shadow-review/${candidate.sampleId}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          markReviewed: true,
          judgment: { verdict: 'same', preferredOutput: 'equivalent' },
        }),
      })
    ).json()
    assert.equal(shadowSaved.judgment.verdict, 'same')
    assert.ok(fs.existsSync(shadowReviewFile))
    const mitigationState = await (
      await fetch(`${origin}/api/profile/benchmark/mitigation-state`, { headers })
    ).json()
    assert.equal(mitigationState.samples.length, 1)
    assert.equal(mitigationState.samples[0].v1.result.summary, 'A person walks through a doorway.')
    assert.equal(mitigationState.samples[0].v7.result.summary, 'A person passes through a doorway.')
    const mitigationSaved = await (
      await fetch(`${origin}/api/profile/benchmark/mitigation-review/${candidate.sampleId}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          markReviewed: true,
          judgment: { verdict: 'improved', preferredOutput: 'v7' },
        }),
      })
    ).json()
    assert.equal(mitigationSaved.judgment.verdict, 'improved')
    assert.ok(fs.existsSync(mitigationReviewFile))
  } finally {
    await running.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('profile review page includes complete portrait-safe controls', () => {
  const html = fs.readFileSync('tools/video-semantic-review/profiles.html', 'utf8')
  const app = fs.readFileSync('tools/video-semantic-review/profile-app.mjs', 'utf8')
  const css = fs.readFileSync('tools/video-semantic-review/styles.css', 'utf8')
  const pilot = fs.readFileSync('scripts/run-video-semantic-pilot.cjs', 'utf8')
  assert.match(html, /id="profileButtons"/)
  assert.match(html, /id="playSegment"/)
  assert.match(html, /id="exportSummary"/)
  assert.match(html, /id="benchmarkStatus"/)
  assert.match(app, /\/api\/profile\/video\//)
  assert.match(app, /\/api\/profile\/benchmark\/state/)
  assert.match(app, /buildProfileReviewExport/)
  assert.match(css, /\.profile-player-shell video[^}]+object-fit:\s*contain/s)
  assert.match(css, /min-height:\s*100dvh/)
  assert.match(css, /env\(safe-area-inset-bottom\)/)
  assert.match(css, /touch-action:\s*manipulation/)
  assert.match(css, /scroll-snap-type:\s*x proximity/)
  assert.match(pilot, /--profile-sample=/)
  assert.match(pilot, /profile-v7-shadow/)
  assert.match(pilot, /human review authority/)
  assert.doesNotMatch(html, /https?:\/\//)
})

test('semantic benchmark page includes mobile verdict and quality controls', () => {
  const html = fs.readFileSync('tools/video-semantic-review/benchmark.html', 'utf8')
  const app = fs.readFileSync('tools/video-semantic-review/benchmark-app.mjs', 'utf8')
  const css = fs.readFileSync('tools/video-semantic-review/styles.css', 'utf8')
  assert.match(html, /data-verdict="consistent"/)
  assert.match(html, /data-verdict="partial"/)
  assert.match(html, /id="hallucinationButtons"/)
  assert.match(html, /id="timestampButtons"/)
  assert.match(html, /id="watchedFullSegment"/)
  assert.match(html, /value="deep-unreviewed"/)
  assert.match(html, /未判定或未完整观看/)
  assert.match(html, /VAL-207 深度真值验收/)
  assert.match(app, /\/api\/profile\/benchmark\/review-state/)
  assert.match(app, /buildBenchmarkReviewExport/)
  assert.match(app, /filter === 'deep-unreviewed'/)
  assert.match(app, /judgment\.verdict === 'unreviewed' \|\| !judgment\.watchedFullSegment/)
  assert.match(app, /judgment\.verdict !== 'unreviewed' &&\s*judgment\.watchedFullSegment/)
  assert.match(app, /fullyWatched/)
  assert.match(app, /summary\.deepTruthReady/)
  assert.match(html, /完整观看后导出（0\/44）/)
  assert.match(css, /\.benchmark-player-shell[^}]+height:\s*min\(57vh/s)
  assert.match(css, /\.verdict-grid button[^}]+touch-action:\s*manipulation/s)
  assert.doesNotMatch(html, /https?:\/\//)
})

test('regression comparison page includes mobile V1/V7 controls and anonymous export', () => {
  const html = fs.readFileSync('tools/video-semantic-review/regression.html', 'utf8')
  const app = fs.readFileSync('tools/video-semantic-review/regression-app.mjs', 'utf8')
  const css = fs.readFileSync('tools/video-semantic-review/styles.css', 'utf8')
  assert.match(html, /id="v1Card"/)
  assert.match(html, /id="v7Card"/)
  assert.match(html, /data-verdict="improved"/)
  assert.match(html, /data-verdict="regressed"/)
  assert.match(html, /id="preferenceButtons"/)
  assert.match(html, /id="watchedFullSegment"/)
  assert.match(app, /\/api\/profile\/benchmark\/regression-state/)
  assert.match(app, /\/api\/profile\/benchmark\/shadow-state/)
  assert.match(app, /\/api\/profile\/benchmark\/mitigation-state/)
  assert.match(app, /video-profile-shadow-review-summary\.json/)
  assert.match(app, /video-profile-v8-mitigation-review-summary\.json/)
  assert.match(css, /\.shadow-review-page \.regression-sample-strip/)
  assert.match(app, /buildRegressionReviewExport/)
  assert.match(app, /loadedmetadata/)
  assert.match(app, /--video-source-ratio/)
  assert.match(css, /\.regression-compare-grid[^}]+grid-template-columns:\s*repeat\(2/s)
  assert.match(css, /@media \(max-width: 760px\)[\s\S]+\.regression-compare-grid/s)
  assert.match(
    css,
    /\.regression-review-page \.regression-player-shell video[^}]+object-fit:\s*contain/s,
  )
  assert.doesNotMatch(html, /https?:\/\//)
})
