// Unit tests for the subject embedding cache
// (electron/subjectEmbeddingStore.ts): keying, round-trip, negative
// markers, compaction. Uses a temp HOME-free store via electron-stub-free
// os.tmpdir fallback (store resolves to <tmpdir>/subject-embeddings).

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const STORE_DIR = path.join(os.tmpdir(), 'subject-embeddings')
const STORE_FILE = path.join(STORE_DIR, 'embeddings.jsonl')

// fresh module state per file is not available through guard-utils cache,
// so tests share one store — use unique key namespaces per test.
const { loadTsModule } = require('./guard-utils.cjs')
const store = loadTsModule('electron/subjectEmbeddingStore.ts')

test('key format includes kind, path and rounded mtime', () => {
  const k = store.subjectEmbeddingKey('face', 'C:/a/b.jpg', 1234.6)
  assert.equal(k, 'face|C:/a/b.jpg|1235')
})

test('statMtimeMs returns null for missing files', () => {
  assert.equal(store.statMtimeMs('definitely/not/here.jpg'), null)
  assert.ok(store.statMtimeMs(__filename) > 0)
})

test('put/get round-trip including negative marker', async () => {
  const k1 = store.subjectEmbeddingKey('face', '/t/a.jpg', 1)
  const k2 = store.subjectEmbeddingKey('face', '/t/b.jpg', 1)
  store.putSubjectEmbedding(k1, [0.1, 0.2, 0.3])
  store.putSubjectEmbedding(k2, []) // negative marker
  assert.deepEqual(store.getSubjectEmbedding(k1), [0.1, 0.2, 0.3])
  assert.deepEqual(store.getSubjectEmbedding(k2), [])
  assert.equal(store.getSubjectEmbedding('face|/t/none.jpg|1'), null)
  // allow the append queue to flush, then verify persistence format
  await new Promise((r) => setTimeout(r, 200))
  const body = fs.readFileSync(STORE_FILE, 'utf8')
  assert.ok(body.includes(k1))
})

test('store survives reload of the JSONL file', () => {
  // ensureLoaded already ran; simulate a cold reader by parsing the file
  const k = store.subjectEmbeddingKey('osnet', '/t/cold.jpg', 7)
  store.putSubjectEmbedding(k, [1, 2])
  return new Promise((resolve) =>
    setTimeout(() => {
      const lines = fs.readFileSync(STORE_FILE, 'utf8').split('\n').filter(Boolean)
      const found = lines.map((l) => JSON.parse(l)).find((e) => e.key === k)
      assert.ok(found, 'key persisted to JSONL')
      assert.deepEqual(found.vector, [1, 2])
      resolve()
    }, 200),
  )
})

test('source cleanup write blocking covers crop, face, osnet and negative-marker keys', async () => {
  const namespace = `scope-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const selectedRoot = path.join(os.tmpdir(), namespace, 'selected')
  const otherRoot = path.join(os.tmpdir(), namespace, 'other')
  const selectedKeys = [
    store.subjectEmbeddingKey('crop:subject', path.join(selectedRoot, 'crop.jpg'), 1),
    store.subjectEmbeddingKey('face:model', path.join(selectedRoot, 'face.jpg'), 2),
    store.subjectEmbeddingKey('osnet:model', path.join(selectedRoot, 'person.jpg'), 3),
  ]
  const otherKey = store.subjectEmbeddingKey('crop:subject', path.join(otherRoot, 'other.jpg'), 1)
  for (const key of selectedKeys) {
    assert.equal(store.subjectEmbeddingPathFromKey(key).includes(selectedRoot), true)
  }

  const release = store.blockSubjectEmbeddingWritesForSource(selectedRoot)
  try {
    store.putSubjectEmbedding(selectedKeys[0], [0.1, 0.2])
    store.putSubjectEmbedding(selectedKeys[1], [])
    store.putSubjectEmbedding(selectedKeys[2], [0.3, 0.4])
    store.putSubjectEmbedding(otherKey, [0.5, 0.6])
  } finally {
    release()
  }
  await store.flushSubjectEmbeddingStoreWrites()
  for (const key of selectedKeys) assert.equal(store.getSubjectEmbedding(key), null)
  assert.deepEqual(store.getSubjectEmbedding(otherKey), [0.5, 0.6])
})
