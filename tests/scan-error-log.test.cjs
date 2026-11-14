const test = require('node:test')
const assert = require('node:assert/strict')
const { loadTsModule } = require('./guard-utils.cjs')
const { ScanErrorRecorder } = loadTsModule('electron/scanErrorLog.ts')
const { SearchDiagnosticStore } = loadTsModule('electron/searchDiagnosticStore.ts')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

test('burst failures reach disk without overflowing the bounded diagnostic queue', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'failure-log-disk-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const store = new SearchDiagnosticStore(root, 'test')
  const recorder = new ScanErrorRecorder()
  recorder.configure(
    (id, event, detail) => store.append(id, event, detail),
    () => store.flush(),
    () => store.pendingRecords < 48,
  )
  const reader = (cursor, limit) => ({
    generation: 1,
    cursor: Math.min(1543, cursor + limit),
    total: 1543,
    retained: 1543,
    omitted: 0,
    counts: { DECODE_FAIL: 1543 },
    entries: Array.from({ length: Math.min(limit, 1543 - cursor) }, (_, i) => ({
      code: 'DECODE_FAIL',
      source: `C:\\private\\file-${cursor + i}.png`,
      message: 'cannot decode',
    })),
  })
  recorder.begin(reader)
  await recorder.drain(reader)
  const snapshot = await store.snapshot()
  assert.equal(store.dropped, 0)
  assert.equal(snapshot.records.flatMap((r) => r.detail.items ?? []).length, 1543)
  assert.ok(!JSON.stringify(snapshot).includes('private'))
})

test('native error pages are drained completely without persisting private source paths', async () => {
  const recorder = new ScanErrorRecorder(),
    records = []
  recorder.configure((id, event, detail) => records.push({ id, event, detail }))
  const failures = Array.from({ length: 1543 }, (_, i) => ({
    code: 'DECODE_FAIL',
    source: `E:\\private\\client-${i}.png`,
    message: `decode failure E:\\private\\client-${i}.png token=SECRET`,
  }))
  const reader = (cursor, limit) => ({
    generation: 1,
    entries: failures.slice(cursor, cursor + limit),
    cursor: Math.min(failures.length, cursor + limit),
    total: 1543,
    retained: 1543,
    omitted: 0,
    counts: { DECODE_FAIL: 1543 },
  })
  recorder.begin(reader)
  await recorder.drain(reader)
  const batches = records.filter((r) => r.event === 'file-failures')
  assert.equal(batches.flatMap((r) => r.detail.items).length, 1543)
  assert.ok(batches.every((r) => r.detail.items.length <= 8))
  const json = JSON.stringify(records)
  assert.ok(!json.includes('client-'))
  assert.ok(!json.includes('SECRET'))
  assert.equal(recorder.status().nativeSummary.total, 1543)
  assert.equal(recorder.status().nativeSummary.omitted, 0)
  assert.equal(recorder.pathMappings(false), undefined)
  assert.equal(Object.values(recorder.pathMappings(true)).length, 1543)
})

test('generation switches and invalid failure feeds cannot loop or break scanning', async () => {
  const recorder = new ScanErrorRecorder(),
    records = []
  recorder.configure((_id, event, detail) => records.push({ event, detail }))
  const base = {
    generation: 2,
    cursor: 0,
    total: 0,
    retained: 0,
    omitted: 0,
    counts: {},
    entries: [],
  }
  recorder.begin(() => base)
  await recorder.drain(() => ({ ...base, generation: 3 }))
  recorder.begin(() => base)
  await recorder.drain(() => ({
    ...base,
    retained: 1,
    entries: [{ code: 'BAD', source: 'test.png', message: '' }],
  }))
  recorder.flush()
  assert.ok(records.some((r) => r.detail?.items?.some((i) => i.code === 'INVALID_FAILURE_PAGE')))
  recorder.begin(() => {
    throw Error('reader failed')
  })
  await assert.doesNotReject(
    recorder.drain(() => {
      throw Error('reader failed')
    }),
  )
})

test('repeated files retain one optional path mapping and bounded reason details', () => {
  const recorder = new ScanErrorRecorder(),
    records = []
  recorder.configure((_id, event, detail) => records.push({ event, detail }))
  recorder.record(
    'windows-shell',
    'SHELL_THUMBNAIL_FAILED',
    'E:\\private\\one.psd',
    Error('cannot decode'),
    'error',
    { step: 'thumbnail', sourceInfo: { depth: 16, channels: 1 } },
  )
  recorder.record(
    'project-preview',
    'NO_CONTENT_PREVIEW',
    'E:\\private\\one.psd',
    'x'.repeat(4000),
    'warning',
  )
  recorder.flush()
  const rows = records.flatMap((r) => r.detail.items ?? [])
  assert.equal(rows[0].sourceId, rows[1].sourceId)
  assert.equal(Object.keys(recorder.pathMappings(true)).length, 1)
  assert.ok(rows[1].reason.length <= 512)
  assert.deepEqual(rows[0].details.sourceInfo, { depth: 16, channels: 1 })
})
