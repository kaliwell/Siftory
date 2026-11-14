const test = require('node:test')
const assert = require('node:assert/strict')
const { loadTsModule } = require('./guard-utils.cjs')
const { PerformanceDiagnosticSession, summarizeResponsiveness } = loadTsModule(
  'electron/performanceDiagnosticSession.ts',
)

test('manual recording owns its lifetime, deduplicates start/phase, and flushes on stop', () => {
  const records = []
  const session = new PerformanceDiagnosticSession(
    (id, event, detail) => records.push({ id, event, detail }),
    () => ({ logicalCpus: 24 }),
  )
  assert.equal(session.mark(), false)
  const recorder = session.start()
  try {
    assert.equal(session.start(), recorder)
    session.phase('scanning', 10)
    session.phase('scanning', 20)
    session.phase('indexing', 20)
    assert.equal(session.mark(), true)
    assert.equal(session.mark(), false)
    assert.equal(
      recorder.measure('native-upsert', () => 42),
      42,
    )
    session.phase('idle', 21)
    assert.equal(session.recorder, recorder, 'scan completion must not stop manual recording')
  } finally {
    session.stop()
  }
  assert.equal(session.recorder, undefined)
  assert.equal(recorder.timer._destroyed, true)
  assert.deepEqual(
    records.filter((r) => r.event === 'scan-state').map((r) => r.detail.state),
    ['scanning', 'indexing', 'idle'],
  )
  assert.ok(
    records.some(
      (r) => r.event === 'preview-main-window' && r.detail.stages['native-upsert'].count === 1,
    ),
  )
  const count = records.length
  session.stop()
  assert.equal(records.length, count)
  const next = session.start()
  assert.notEqual(next.id, recorder.id)
  assert.equal(session.mark(), true, 'a new test resets marker throttling')
  session.stop()
})

test('optional metadata and storage failures cannot trap a recording session', () => {
  const session = new PerformanceDiagnosticSession(
    () => {
      throw new Error('disk unavailable')
    },
    () => {
      throw new Error('metadata unavailable')
    },
  )
  assert.doesNotThrow(() => session.start())
  assert.equal(session.mark(), true)
  assert.doesNotThrow(() => session.phase('indexing', 1))
  assert.doesNotThrow(() => session.stop())
  assert.equal(session.recorder, undefined)
})

test('export summary separates async latency from blocking and reports missing renderer samples', () => {
  const summary = summarizeResponsiveness([
    null,
    {},
    {
      event: 'preview-main-window',
      detail: {
        maxTimerLagMs: 1200,
        stages: {
          pdf: { count: 1, maxMs: 15000, maxSyncMs: 2 },
          native: { count: 3, maxMs: 800, maxSyncMs: 799 },
        },
      },
    },
    {
      event: 'preview-main-window',
      detail: { maxTimerLagMs: 200, stages: { native: { count: 2, maxMs: 900, maxSyncMs: 850 } } },
    },
    { event: 'user-stutter-marker' },
    { event: 'stall-detected' },
  ])
  assert.equal(summary.mainMaxDelayMs, 1200)
  assert.equal(summary.rendererWindows, 0)
  assert.equal(summary.markers, 1)
  assert.equal(summary.stallSignals, 1)
  assert.deepEqual(summary.slowestSynchronousSteps[0], {
    name: 'native',
    count: 5,
    maxMs: 900,
    maxSyncMs: 850,
  })
  assert.match(summary.interpretation, /Missing samples do not prove/)
})

test('renderer stalls generate explicit signals while frame gaps alone remain observations', () => {
  const records = []
  const session = new PerformanceDiagnosticSession(
    (_id, event, detail) => records.push({ event, detail }),
    () => ({}),
  )
  const recorder = session.start()
  try {
    assert.equal(
      recorder.renderer({
        elapsedMs: 5000,
        maxTimerLagMs: 150,
        maxFrameGapMs: 250,
        longTaskCount: 1,
        longTaskMaxMs: 120,
      }),
      true,
    )
  } finally {
    session.stop()
  }
  const summary = summarizeResponsiveness(records)
  assert.equal(summary.rendererWindows, 1)
  assert.equal(summary.rendererMaxDelayMs, 150)
  assert.equal(summary.longTaskMaxMs, 120)
  assert.equal(summary.stallSignals, 1)
})
