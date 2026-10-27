const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { loadTsModule } = require('./guard-utils.cjs')
const { SearchDiagnosticStore, queryImageDimensions } = loadTsModule(
  'electron/searchDiagnosticStore.ts',
)

async function fixture(t, limit) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'siftory-search-diagnostics-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return { directory, store: new SearchDiagnosticStore(directory, 'test', limit) }
}

test('concurrent first use waits for the complete identity key write', async (t) => {
  const { directory, store } = await fixture(t)
  const keyPath = path.join(directory, 'identity-key')
  const originalWrite = fs.writeFile.bind(fs)
  t.mock.method(fs, 'writeFile', async (file, bytes, options) => {
    if (file !== keyPath || options?.flag !== 'wx') return originalWrite(file, bytes, options)
    const handle = await fs.open(file, 'wx', options.mode)
    try {
      await new Promise((resolve) => setTimeout(resolve, 30))
      await handle.writeFile(bytes)
    } finally {
      await handle.close()
    }
  })
  const ids = await Promise.all(Array.from({ length: 12 }, (_, i) => store.identity(`item-${i}`)))
  assert.equal(new Set(ids).size, 12)
  assert.equal((await fs.readFile(keyPath)).length, 32)
  const restarted = new SearchDiagnosticStore(directory, 'test')
  assert.equal(await restarted.identity('item-0'), ids[0])
})

test('a failed initialization never publishes an invalid key and can be retried', async (t) => {
  const { directory, store } = await fixture(t)
  const keyPath = path.join(directory, 'identity-key')
  await fs.writeFile(keyPath, Buffer.alloc(0))
  await assert.rejects(store.identity('item'), /Invalid diagnostic identity key/)
  const repairedKey = Buffer.alloc(32, 7)
  await fs.writeFile(keyPath, repairedKey)
  assert.equal(
    await store.identity('item'),
    crypto.createHmac('sha256', repairedKey).update('item').digest('hex').slice(0, 24),
  )
})

test('records persist across sessions, redact paths and secrets, and retain stable identities', async (t) => {
  const { directory, store } = await fixture(t)
  store.append('query-a', 'start', {
    imagePath: 'C:\\private\\customer.png',
    error: 'token=TOPSECRET C:\\private\\customer.png',
  })
  await store.flush()
  const other = new SearchDiagnosticStore(directory, 'test')
  assert.notEqual(other.sessionId, store.sessionId)
  assert.equal(await other.identity('same-path'), await store.identity('same-path'))
  const report = await other.snapshot()
  assert.equal(report.records[0].traceId, 'query-a')
  const json = JSON.stringify(report)
  assert.ok(!json.includes('customer.png'))
  assert.ok(!json.includes('TOPSECRET'))
  assert.equal(report.containsImageBytes, false)
})

test('same bytes under different paths correlate and changed bytes are distinguishable', async (t) => {
  const { directory, store } = await fixture(t)
  const a = path.join(directory, 'a.png'),
    b = path.join(directory, 'b.png')
  const header = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header)
  header.writeUInt32BE(80, 16)
  header.writeUInt32BE(60, 20)
  await fs.writeFile(a, header)
  await fs.writeFile(b, header)
  const first = await store.fingerprint(a),
    second = await store.fingerprint(b)
  assert.equal(first.status, 'stable')
  assert.equal(first.sha256, second.sha256)
  assert.notEqual(first.pathId, second.pathId)
  assert.equal(first.width, 80)
  assert.equal(first.height, 60)
  await fs.appendFile(a, 'changed')
  assert.notEqual((await store.fingerprint(a)).sha256, first.sha256)
})

test('rotation never exceeds five bounded files and expired records are excluded', async (t) => {
  const { directory, store } = await fixture(t, 1024)
  for (let i = 0; i < 70; i++) {
    store.append('q', 'phase', { i, message: 'x'.repeat(250) })
    await store.flush()
  }
  const files = (await fs.readdir(directory)).filter((n) => n.endsWith('.jsonl'))
  assert.equal(files.length, 5)
  for (const name of files) assert.ok((await fs.stat(path.join(directory, name))).size <= 1024)
  const expired = new Date(Date.now() - 15 * 86400000)
  for (const name of files) await fs.utimes(path.join(directory, name), expired, expired)
  assert.equal((await store.snapshot()).records.length, 0)
})

test('bounded queue reports dropped events instead of growing without limit', async (t) => {
  const { store } = await fixture(t)
  for (let i = 0; i < 1000; i++) store.append('q', 'stage', { i })
  await store.flush()
  assert.equal(store.dropped, 872)
  assert.equal((await store.snapshot()).records.length, 128)
})

test('export waits for tracked fingerprint work, tolerates truncated tails, and clear retains identity', async (t) => {
  const { directory, store } = await fixture(t)
  const id = await store.identity('expected')
  store.track(
    new Promise((resolve) =>
      setTimeout(() => {
        store.append('q', 'late', {})
        resolve()
      }, 10),
    ),
  )
  assert.equal((await store.snapshot()).records.length, 1)
  await fs.appendFile(path.join(directory, 'search-0.jsonl'), '{incomplete')
  assert.equal((await store.snapshot()).records.length, 1)
  await store.clear()
  assert.equal((await store.snapshot()).records.length, 0)
  assert.equal(await store.identity('expected'), id)
})

test('disk failures are contained and surfaced without rejecting query logging', async (t) => {
  const { directory } = await fixture(t)
  const blocked = path.join(directory, 'not-a-directory')
  await fs.writeFile(blocked, 'blocked')
  const store = new SearchDiagnosticStore(blocked, 'test')
  store.append('q', 'start')
  await store.flush()
  assert.ok(store.error)
  assert.equal(store.dropped, 1)
  assert.equal((await store.fingerprint(path.join(directory, 'missing'))).status, 'unavailable')
})

test('malformed image headers are bounded and reported as unknown dimensions', () => {
  assert.deepEqual(queryImageDimensions(Buffer.from([255, 216, 255, 192, 0, 1])), {
    format: 'jpeg',
  })
  assert.deepEqual(queryImageDimensions(Buffer.alloc(0)), { format: 'unknown' })
})

test('query copies are explicit, verified against the searched bytes, and cleared with logs', async (t) => {
  const { directory, store } = await fixture(t)
  const input = path.join(directory, 'input.png')
  await fs.writeFile(input, 'exact searched bytes')
  const fingerprint = await store.fingerprint(input)
  assert.equal((await store.exportQueryCopies()).length, 0)
  const trace = '11111111-1111-4111-a111-111111111111'
  assert.equal(await store.saveQueryCopy(trace, input, fingerprint.sha256), true)
  const copies = await store.exportQueryCopies()
  assert.equal(copies.length, 1)
  assert.equal(Buffer.from(copies[0].base64, 'base64').toString(), 'exact searched bytes')
  await fs.writeFile(input, 'replaced input')
  assert.equal(await store.saveQueryCopy(trace, input, fingerprint.sha256), false)
  assert.equal(await store.saveQueryCopy('../../elsewhere', input, fingerprint.sha256), false)
  await store.clear()
  assert.equal((await store.exportQueryCopies()).length, 0)
})

test('query copies enforce per-input and aggregate retention bounds', async (t) => {
  const { directory, store } = await fixture(t)
  const file = path.join(directory, 'input.png')
  await fs.writeFile(file, Buffer.alloc(1024))
  const { sha256 } = await store.fingerprint(file)
  for (let i = 0; i < 7; i++)
    assert.equal(
      await store.saveQueryCopy(`11111111-1111-4111-a111-11111111111${i}`, file, sha256),
      true,
    )
  assert.equal((await store.exportQueryCopies()).length, 4)
  await fs.writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 1))
  assert.equal(
    await store.saveQueryCopy('11111111-1111-4111-a111-111111111111', file, sha256),
    false,
  )
})

test('a partial final record from a crash does not swallow the next session record', async (t) => {
  const { directory, store } = await fixture(t)
  store.append('before', 'start')
  await store.flush()
  await fs.appendFile(path.join(directory, 'search-0.jsonl'), '{partial')
  const restarted = new SearchDiagnosticStore(directory, 'test')
  restarted.append('after', 'start')
  await restarted.flush()
  const records = (await restarted.snapshot()).records
  assert.deepEqual(
    records.map((x) => x.traceId),
    ['before', 'after'],
  )
})
