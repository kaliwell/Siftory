const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { RuntimeMemoryTraceWriter } = loadTsModule('electron/runtimeMemoryTrace.ts')

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-runtime-trace-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('runtime memory events correlate safe stages without paths or unbounded strings', (t) => {
  const root = sandbox(t)
  const writer = new RuntimeMemoryTraceWriter({ directory: root })
  assert.equal(
    writer.emit({
      runId: 'run-1',
      stage: 'inference',
      phase: 'finish',
      model: 'clip_vit_base_patch32',
      provider: 'dml',
      durationMs: 12.5,
      metrics: { batchSize: 4, tensorBytes: 1024, fallback: false },
    }),
    true,
  )
  const output = fs.readFileSync(path.join(root, 'runtime-memory-events-00.jsonl'), 'utf8')
  const event = JSON.parse(output.trim())
  assert.equal(event.runId, 'run-1')
  assert.equal(event.stage, 'inference')
  assert.equal(event.model, 'clip_vit_base_patch32')
  assert.equal(event.provider, 'dml')
  assert.equal(event.pid, process.pid)
  assert.doesNotMatch(output, /Users|commandLine|executablePath/)
  assert.throws(
    () => writer.emit({ runId: 'C:\\private', stage: 'search', phase: 'start' }),
    /runId is invalid/,
  )
  assert.throws(
    () =>
      writer.emit({
        runId: 'run-2',
        stage: 'search',
        phase: 'point',
        metrics: { bad_value: 1 },
      }),
    /metric name is invalid/,
  )
})

test('runtime memory event files rotate within line, file, and retained-byte bounds', (t) => {
  const root = sandbox(t)
  const writer = new RuntimeMemoryTraceWriter({
    directory: root,
    maxLineBytes: 256,
    maxFileBytes: 512,
    maxFiles: 3,
  })
  for (let index = 0; index < 100; index++) {
    writer.emit({
      runId: `run-${index}`,
      stage: 'search',
      phase: 'point',
      metrics: { candidateCount: index },
    })
  }
  const stats = writer.stats()
  assert.equal(stats.files, 3)
  assert.ok(stats.retainedBytes <= 3 * 512)
  for (const name of fs.readdirSync(root)) {
    const content = fs.readFileSync(path.join(root, name), 'utf8')
    assert.ok(Buffer.byteLength(content) <= 512)
    for (const line of content.split(/\r?\n/).filter(Boolean)) {
      assert.ok(Buffer.byteLength(line) + 1 <= 256)
      assert.equal(JSON.parse(line).schema, 'siftory-runtime-memory-event/v1')
    }
  }
})

test('runtime memory trace refuses symlink directories and existing managed targets', (t) => {
  const root = sandbox(t)
  const existing = path.join(root, 'existing')
  fs.mkdirSync(existing)
  fs.writeFileSync(path.join(existing, 'runtime-memory-events-00.jsonl'), 'owned', 'utf8')
  assert.throws(() => new RuntimeMemoryTraceWriter({ directory: existing }), /already exists/)
})
