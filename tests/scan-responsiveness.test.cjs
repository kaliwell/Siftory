const test = require('node:test')
const assert = require('node:assert/strict')
const { loadTsModule } = require('./guard-utils.cjs')
const { ScanResponsiveness } = loadTsModule('electron/scanResponsiveness.ts')

test('scan telemetry distinguishes synchronous blocking from awaited work without changing results', async () => {
  const records = []
  const recorder = new ScanResponsiveness((id, event, detail) =>
    records.push({ id, event, detail }),
  )
  try {
    recorder.source(7, '.psd')
    const value = recorder.measure('blocking', () => {
      const until = performance.now() + 15
      while (performance.now() < until) {
        /* Deliberately block to measure timer lag. */
      }
      return 42
    })
    assert.equal(value, 42)
    assert.equal(
      await recorder.measure(
        'awaited',
        () => new Promise((resolve) => setTimeout(() => resolve(43), 80)),
      ),
      43,
    )
    const error = new Error('private file error')
    assert.throws(
      () =>
        recorder.measure('throws', () => {
          throw error
        }),
      (e) => e === error,
    )
    await assert.rejects(
      recorder.measure('rejects', () => Promise.reject(error)),
      (e) => e === error,
    )
  } finally {
    recorder.close()
  }
  const window = records.find((r) => r.event === 'preview-main-window').detail
  assert.ok(window.stages.blocking.maxSyncMs >= 10)
  assert.ok(window.stages.awaited.maxMs >= 60)
  assert.ok(window.stages.awaited.maxSyncMs < window.stages.awaited.maxMs)
  assert.equal(window.stages.throws.count, 1)
  assert.equal(window.stages.rejects.count, 1)
  assert.deepEqual(window.pendingStages, [])
  assert.deepEqual(window.source, { ordinal: 7, extension: '.psd' })
  assert.ok(!JSON.stringify(records).includes('private file error'))
  assert.equal(new Set(records.map((r) => r.id)).size, 1)
})

test('renderer samples are numeric and rate limited; close clears sampling and is idempotent', () => {
  const records = []
  const recorder = new ScanResponsiveness((_id, event, detail) => records.push({ event, detail }))
  const sample = {
    elapsedMs: 5000,
    maxTimerLagMs: 10,
    maxFrameGapMs: 20,
    longTaskCount: 1,
    longTaskMaxMs: 60,
  }
  for (const invalid of [
    null,
    {},
    { ...sample, path: '/private' },
    { ...sample, longTaskCount: NaN },
    { ...sample, elapsedMs: -1 },
    { ...sample, maxFrameGapMs: Infinity },
  ]) {
    assert.equal(recorder.renderer(invalid), false)
  }
  assert.equal(recorder.renderer(sample), true)
  assert.equal(recorder.renderer(sample), false)
  recorder.close()
  const count = records.length
  recorder.close()
  assert.equal(recorder.renderer(sample), false)
  assert.equal(records.length, count)
  assert.equal(recorder.timer._destroyed, true)
})

test('diagnostic storage failure does not fail scans and synchronous stalls appear at close', () => {
  const records = []
  const recorder = new ScanResponsiveness((_id, event, detail) => {
    records.push({ event, detail })
    throw new Error('storage unavailable')
  })
  assert.equal(
    recorder.measure('native', () => {
      const until = performance.now() + 250
      while (performance.now() < until) {
        /* Deliberately block to exercise native stall reporting. */
      }
      return true
    }),
    true,
  )
  recorder.close()
  assert.ok(records.find((r) => r.event === 'preview-main-window').detail.maxTimerLagMs >= 40)
})
