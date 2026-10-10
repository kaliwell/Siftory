const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const migration = loadTsModule('electron/vectorStoreMigrationService.ts')
const store = loadTsModule('electron/authoritativeVectorStore.ts')
const cacheApi = loadTsModule('electron/embeddingF16Cache.ts')
const vectorDb = loadTsModule('electron/vectorDatabaseService.ts')
const increment = loadTsModule('electron/embeddingIncrementLog.ts')

const MODEL = 'fixture_dinov2'
const TYPE = 'global'
const DIM = 3
const ROW_BYTES = DIM * 2

function row(imageId, vector) {
  return `${JSON.stringify({ modelName: MODEL, embeddingType: TYPE, imageId, dim: DIM, vector })}\n`
}

function entry(imageId, vector) {
  return {
    imageId,
    modelName: MODEL,
    modelVersion: '1',
    embeddingType: TYPE,
    dim: DIM,
    vector,
    norm: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function makeRoot(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `floating-clock-eil-${label}-`))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const embeddings = path.join(root, 'vector-db', 'embeddings')
  fs.mkdirSync(embeddings, { recursive: true })
  const source = path.join(embeddings, `${MODEL}__${TYPE}.jsonl`)
  return { root, source }
}

async function waitForMigration() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const progress = migration.getVectorStoreMigrationProgress()
    if (progress.state !== 'running') return progress
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('migration test timed out')
}

async function migrate(root, source) {
  migration.resetVectorStoreMigrationForTests()
  const preview = migration.createVectorStoreMigrationPreview(root, [
    {
      cacheDir: path.join(root, 'vector-db', 'embedding-cache'),
      modelName: MODEL,
      embeddingType: TYPE,
      dim: DIM,
      sourcePaths: [source],
    },
  ])
  assert.equal(migration.startVectorStoreMigration(root, preview.token).ok, true)
  const completed = await waitForMigration()
  assert.equal(completed.state, 'completed', completed.errors.join('\n'))
  return completed.generation
}

function setup(t, label, baseRows) {
  const { root, source } = makeRoot(t, label)
  fs.writeFileSync(source, baseRows)
  return { root, source }
}

function incrementPaths(root) {
  const storeRoot = path.join(root, 'vector-db', 'vector-store')
  const dir = increment.embeddingIncrementDir(storeRoot, MODEL, TYPE)
  return {
    dir,
    f16: path.join(dir, 'delta.f16'),
    paths: path.join(dir, 'delta.paths.jsonl'),
    commit: path.join(dir, 'delta.json'),
  }
}

function readCommit(root) {
  return JSON.parse(fs.readFileSync(incrementPaths(root).commit, 'utf8'))
}

/** Independent re-implementation of encodeNormalizedVector's semantics. */
function referenceEncodeF16(values) {
  let normSquared = 0
  for (let index = 0; index < DIM; index++) normSquared += Number(values[index]) ** 2
  const norm = Math.sqrt(normSquared)
  const output = Buffer.alloc(ROW_BYTES)
  for (let index = 0; index < DIM; index++) {
    output.writeUInt16LE(cacheApi.float32ToFloat16(Number(values[index]) / norm), index * 2)
  }
  return output
}

function jsonlRows(source) {
  const rows = []
  for (const line of fs.readFileSync(source, 'utf8').split('\n')) {
    if (!line) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      /* skip malformed (e.g. half-written crash tail) rows */
    }
  }
  return rows
}

function referenceTailF16(source, baseCount) {
  const rows = jsonlRows(source).slice(baseCount)
  return {
    rows,
    f16: Buffer.concat(rows.map((parsed) => referenceEncodeF16(parsed.vector.slice(0, DIM)))),
  }
}

test('appended increment segments correspond byte-for-byte to the JSONL tail', async (t) => {
  const { root, source } = setup(
    t,
    'bytes',
    row('C:\\images\\a.jpg', [1, 0, 0]) + row('C:\\images\\b.jpg', [0, 2, 0]),
  )
  const generation = await migrate(root, source)
  vectorDb.initVectorDatabase(root)
  increment.resetEmbeddingIncrementStateForTests()

  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\images\\c.jpg', [0, 0, 3]))
  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\images\\d.jpg', [1, 1, 0]))
  vectorDb.appendEmbeddingNoUpsert(entry('C:\\images\\e.jpg', [4, 0, 0]))

  const files = incrementPaths(root)
  const commit = readCommit(root)
  assert.equal(commit.version, increment.EMBEDDING_DELTA_VERSION)
  assert.equal(commit.generation, generation)
  assert.equal(commit.modelName, MODEL)
  assert.equal(commit.embeddingType, TYPE)
  assert.equal(commit.dim, DIM)
  assert.equal(commit.baseCount, 2)
  assert.equal(commit.baseSourceRecordCount, 2)
  assert.equal(commit.deltaCount, 3)
  const stat = fs.statSync(source)
  assert.equal(commit.sources.length, 1)
  assert.equal(commit.sources[0].size, stat.size)
  assert.equal(commit.sources[0].mtimeMs, stat.mtimeMs)
  assert.match(commit.sources[0].tailSha256, /^[a-f0-9]{64}$/)
  assert.ok(commit.sources[0].chunkIntegrity.anchoredSize < stat.size)

  // delta.f16 == encodeNormalizedVector over the JSONL tail rows.
  const reference = referenceTailF16(source, 2)
  assert.equal(reference.rows.length, 3)
  assert.deepEqual(fs.readFileSync(files.f16), reference.f16)

  // delta.paths.jsonl rows continue from the base generation count.
  const deltaPaths = fs.readFileSync(files.paths, 'utf8').split('\n').filter(Boolean)
  assert.deepEqual(
    deltaPaths.map((line) => JSON.parse(line)),
    reference.rows.map((parsed, index) => ({ row: 2 + index, path: parsed.imageId })),
  )

  // A full rebuild of the final JSONL ends with the same tail bytes.
  const referenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-eil-ref-'))
  t.after(() => fs.rmSync(referenceRoot, { recursive: true, force: true }))
  const handle = await cacheApi.ensureEmbeddingF16Cache({
    cacheDir: path.join(referenceRoot, 'cache'),
    modelName: MODEL,
    embeddingType: TYPE,
    dim: DIM,
    sourcePaths: [source],
    preferAuthoritative: false,
  })
  assert.equal(handle.meta.count, 5)
  const rebuilt = fs.readFileSync(handle.vectorPath)
  assert.deepEqual(rebuilt.subarray(2 * ROW_BYTES), fs.readFileSync(files.f16))
})

test('chunk anchors reject an early same-size rewrite outside the legacy tail window', async (t) => {
  const paddedBase = `${JSON.stringify({
    modelName: MODEL,
    embeddingType: TYPE,
    imageId: 'C:\\images\\a.jpg',
    dim: DIM,
    vector: [1, 0, 0],
    padding: 'x'.repeat(128 * 1024),
  })}\n`
  const { root, source } = setup(t, 'chunk-integrity', paddedBase)
  await migrate(root, source)
  vectorDb.initVectorDatabase(root)
  increment.resetEmbeddingIncrementStateForTests()

  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\images\\b.jpg', [0, 1, 0]))
  const commit = readCommit(root)
  const anchor = commit.sources[0]
  assert.equal(anchor.chunkIntegrity.version, 1)
  assert.equal(anchor.chunkIntegrity.chunks.length, 4)

  const changed = fs.readFileSync(source)
  const paddingOffset = changed.indexOf(Buffer.from('xxxx'))
  assert.ok(paddingOffset >= 0 && paddingOffset < 64 * 1024)
  changed[paddingOffset] = 'y'.charCodeAt(0)
  fs.writeFileSync(source, changed)
  fs.utimesSync(source, anchor.mtimeMs / 1000, anchor.mtimeMs / 1000)
  assert.equal(fs.statSync(source).size, anchor.size)
  assert.equal(
    store.sha256FileTailSync(source, anchor.size),
    anchor.tailSha256,
    'tail hash intentionally remains unchanged',
  )

  increment.resetEmbeddingIncrementStateForTests()
  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\images\\c.jpg', [0, 0, 1]))
  assert.equal(
    fs.existsSync(incrementPaths(root).dir),
    false,
    'corrupt prefix must discard the derived increment while preserving the JSONL append',
  )
  assert.ok(fs.readFileSync(source, 'utf8').includes('c.jpg'))
})

test('reader-lenient snapshots accept only verified append-only source growth', async (t) => {
  const paddedBase = `${JSON.stringify({
    modelName: MODEL,
    embeddingType: TYPE,
    imageId: 'C:\\images\\a.jpg',
    dim: DIM,
    vector: [1, 0, 0],
    padding: 'x'.repeat(128 * 1024),
  })}\n`
  const { root, source } = setup(t, 'reader-prefix-integrity', paddedBase)
  await migrate(root, source)
  vectorDb.initVectorDatabase(root)
  increment.resetEmbeddingIncrementStateForTests()

  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\images\\b.jpg', [0, 1, 0]))
  const anchor = readCommit(root).sources[0]
  const storeRoot = path.join(root, 'vector-db', 'vector-store')

  fs.appendFileSync(source, row('C:\\images\\external.jpg', [1, 1, 1]))
  const appendOnly = increment.readEmbeddingIncrementSnapshot(storeRoot, MODEL, TYPE, DIM, [source])
  assert.ok(appendOnly, 'a byte-identical prefix plus appended bytes remains readable')
  assert.equal(appendOnly.complete, false)

  const changed = fs.readFileSync(source)
  const paddingOffset = changed.indexOf(Buffer.from('xxxx'))
  assert.ok(paddingOffset >= 0 && paddingOffset < 64 * 1024)
  changed[paddingOffset] = 'y'.charCodeAt(0)
  fs.writeFileSync(source, changed)
  assert.ok(fs.statSync(source).size > anchor.size)
  assert.equal(
    store.sha256FileTailSync(source, anchor.size),
    anchor.tailSha256,
    'the legacy anchored tail intentionally does not cover the early rewrite',
  )
  assert.equal(
    increment.readEmbeddingIncrementSnapshot(storeRoot, MODEL, TYPE, DIM, [source]),
    null,
    'growth with a rewritten anchored prefix must not be treated as append-only',
  )
})

test('crash with a half-written JSONL line discards the increment and keeps appending', async (t) => {
  const { root, source } = setup(t, 'halfjsonl', row('C:\\images\\a.jpg', [1, 0, 0]))
  await migrate(root, source)
  vectorDb.initVectorDatabase(root)
  increment.resetEmbeddingIncrementStateForTests()

  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\images\\b.jpg', [0, 1, 0]))
  assert.equal(readCommit(root).deltaCount, 1)

  // Crash after a partial JSONL append: delta.json still anchors the old tail.
  fs.appendFileSync(source, '{"modelName":"dinov2_vitb14","imageId":"C:\\\\images\\\\x')
  increment.resetEmbeddingIncrementStateForTests()

  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\images\\c.jpg', [0, 0, 1]))
  const files = incrementPaths(root)
  assert.equal(fs.existsSync(files.dir), false, 'invalid increment dir must be discarded')

  // The append itself landed in the JSONL, which stays authoritative. It is
  // glued onto the newline-less crash tail, exactly like production: that
  // combined line is corrupt and skipped by line-oriented readers, while the
  // rows before the crash tail still parse.
  const rows = jsonlRows(source)
  assert.equal(rows.length, 2)
  assert.ok(fs.readFileSync(source, 'utf8').includes('c.jpg'))

  // Later appends keep working JSONL-only: the shard drifted past the base
  // generation, so no fresh increment may start until the next migration.
  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\images\\d.jpg', [1, 1, 0]))
  assert.equal(fs.existsSync(files.commit), false)
  const recovered = jsonlRows(source)
  assert.equal(recovered.length, 3)
  assert.equal(recovered.at(-1).imageId, 'C:\\images\\d.jpg')
})

test('crash with an uncommitted delta tail is truncated back to the commit point', async (t) => {
  const { root, source } = setup(t, 'halfdelta', row('C:\\images\\a.jpg', [1, 0, 0]))
  await migrate(root, source)
  vectorDb.initVectorDatabase(root)
  increment.resetEmbeddingIncrementStateForTests()

  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\images\\b.jpg', [0, 1, 0]))
  const files = incrementPaths(root)
  const committedF16 = fs.readFileSync(files.f16)

  // Crash after the delta segments grew but before delta.json was committed
  // (e.g. power loss kept the delta writes but not the JSONL/anchor writes).
  fs.appendFileSync(files.f16, Buffer.from([1, 2, 3, 4, 5]))
  fs.appendFileSync(files.paths, '{"row":2,"path":"C:\\\\images\\\\ghost')
  increment.resetEmbeddingIncrementStateForTests()

  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\images\\c.jpg', [0, 0, 1]))

  const commit = readCommit(root)
  assert.equal(commit.deltaCount, 2)
  const f16 = fs.readFileSync(files.f16)
  assert.equal(f16.length, 2 * ROW_BYTES)
  assert.deepEqual(f16.subarray(0, ROW_BYTES), committedF16, 'committed rows stay untouched')
  const pathRows = fs.readFileSync(files.paths, 'utf8').split('\n').filter(Boolean)
  assert.deepEqual(
    pathRows.map((line) => JSON.parse(line)),
    [
      { row: 1, path: 'C:\\images\\b.jpg' },
      { row: 2, path: 'C:\\images\\c.jpg' },
    ],
  )
  assert.deepEqual(f16, referenceTailF16(source, 1).f16)
})

test('crash during delta.json rewrite leaves the previous commit point intact', async (t) => {
  const { root, source } = setup(t, 'halfcommit', row('C:\\images\\a.jpg', [1, 0, 0]))
  await migrate(root, source)
  vectorDb.initVectorDatabase(root)
  increment.resetEmbeddingIncrementStateForTests()

  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\images\\b.jpg', [0, 1, 0]))
  const files = incrementPaths(root)
  const committedJson = fs.readFileSync(files.commit, 'utf8')

  // Crash mid rewrite: the temporary file is left behind, delta.json intact.
  fs.writeFileSync(path.join(files.dir, 'delta.json.99999.tmp'), '{"version":1,"deltaCo')
  increment.resetEmbeddingIncrementStateForTests()

  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\images\\c.jpg', [0, 0, 1]))
  assert.equal(readCommit(root).deltaCount, 2)
  assert.equal(
    fs.readdirSync(files.dir).some((name) => name.endsWith('.tmp')),
    false,
    'stale commit temp files must be cleaned',
  )
  assert.notEqual(fs.readFileSync(files.commit, 'utf8'), committedJson)

  // A genuinely corrupted commit point discards the whole increment instead.
  fs.writeFileSync(files.commit, '{"version":1,"deltaCo')
  increment.resetEmbeddingIncrementStateForTests()
  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\images\\d.jpg', [1, 1, 0]))
  assert.equal(fs.existsSync(files.dir), false)
  assert.equal(jsonlRows(source).at(-1).imageId, 'C:\\images\\d.jpg')
})

test('a same-process commit failure invalidates the prepared context before the next append', async (t) => {
  const { root, source } = setup(
    t,
    'same-process-commit-failure',
    row('C:\\images\\a.jpg', [1, 0, 0]),
  )
  await migrate(root, source)
  vectorDb.initVectorDatabase(root)
  increment.resetEmbeddingIncrementStateForTests()

  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\images\\b.jpg', [0, 1, 0]))
  const files = incrementPaths(root)
  assert.equal(readCommit(root).deltaCount, 1)

  const originalRenameSync = fs.renameSync
  let injected = false
  fs.renameSync = (from, to) => {
    if (!injected && path.resolve(to) === path.resolve(files.commit)) {
      injected = true
      throw new Error('simulated delta commit rename failure')
    }
    return originalRenameSync(from, to)
  }
  try {
    // The JSONL append remains successful even though its subordinate delta
    // commit fails; callers intentionally do not receive a false write error.
    await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\images\\c.jpg', [0, 0, 1]))
  } finally {
    fs.renameSync = originalRenameSync
  }
  assert.equal(injected, true)
  assert.equal(readCommit(root).deltaCount, 1, 'the previous commit point stays authoritative')

  // No reset/restart here. Reusing the failed in-memory context would append
  // after the uncommitted tail and publish a mismatched row. The next append
  // must revalidate, discard the stale increment, and continue JSONL-only.
  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\images\\d.jpg', [1, 1, 0]))
  assert.equal(fs.existsSync(files.dir), false)
  assert.deepEqual(
    jsonlRows(source).map((item) => item.imageId),
    ['C:\\images\\a.jpg', 'C:\\images\\b.jpg', 'C:\\images\\c.jpg', 'C:\\images\\d.jpg'],
  )
})

test('a cached same-process context rejects an external append before the next app append', async (t) => {
  const { root, source } = setup(
    t,
    'same-process-external-append',
    row('C:\\images\\a.jpg', [1, 0, 0]),
  )
  await migrate(root, source)
  vectorDb.initVectorDatabase(root)
  increment.resetEmbeddingIncrementStateForTests()

  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\images\\b.jpg', [0, 1, 0]))
  assert.equal(readCommit(root).deltaCount, 1)

  fs.appendFileSync(source, row('C:\\images\\external.jpg', [1, 1, 1]))
  // Deliberately do not reset the in-memory increment state. The cached
  // context must observe the external growth before this process appends.
  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\images\\c.jpg', [0, 0, 1]))

  assert.deepEqual(
    jsonlRows(source).map((item) => item.imageId),
    ['C:\\images\\a.jpg', 'C:\\images\\b.jpg', 'C:\\images\\external.jpg', 'C:\\images\\c.jpg'],
  )
  const files = incrementPaths(root)
  assert.equal(
    fs.existsSync(files.dir),
    false,
    'strict writer recovery discards the stale subordinate increment',
  )
  assert.equal(
    increment.readEmbeddingIncrementSnapshot(
      path.join(root, 'vector-db', 'vector-store'),
      MODEL,
      TYPE,
      DIM,
      [source],
    ),
    null,
    'no composite snapshot may omit the external row or report false completeness',
  )
})

test('corrupted or missing increment segments degrade to JSONL-only appends', async (t) => {
  const { root, source } = setup(t, 'corrupt', row('C:\\images\\a.jpg', [1, 0, 0]))
  await migrate(root, source)
  vectorDb.initVectorDatabase(root)
  increment.resetEmbeddingIncrementStateForTests()

  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\images\\b.jpg', [0, 1, 0]))
  const files = incrementPaths(root)
  assert.equal(readCommit(root).deltaCount, 1)

  // delta.f16 shorter than the committed deltaCount is corruption, not a
  // crash tail: the whole increment is discarded, the append still lands.
  fs.truncateSync(files.f16, ROW_BYTES - 2)
  increment.resetEmbeddingIncrementStateForTests()
  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\images\\c.jpg', [0, 0, 1]))
  assert.equal(fs.existsSync(files.dir), false)
  assert.equal(jsonlRows(source).length, 3)

  // Anchor tampering (source rewritten past its anchor) is also fail-safe.
  await migrate(root, source)
  vectorDb.initVectorDatabase(root)
  increment.resetEmbeddingIncrementStateForTests()
  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\images\\d.jpg', [2, 0, 0]))
  assert.equal(readCommit(root).deltaCount, 1)
  fs.appendFileSync(source, row('C:\\images\\external.jpg', [9, 9, 9]))
  increment.resetEmbeddingIncrementStateForTests()
  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\images\\e.jpg', [0, 2, 0]))
  assert.equal(fs.existsSync(incrementPaths(root).dir), false)
  assert.equal(jsonlRows(source).at(-1).imageId, 'C:\\images\\e.jpg')
})

test('concurrent appends serialize through the chain without interleaving', async (t) => {
  const { root, source } = setup(
    t,
    'serial',
    row('C:\\images\\a.jpg', [1, 0, 0]) + row('C:\\images\\b.jpg', [0, 1, 0]),
  )
  await migrate(root, source)
  vectorDb.initVectorDatabase(root)
  increment.resetEmbeddingIncrementStateForTests()

  const total = 20
  const pending = []
  for (let index = 0; index < total; index++) {
    pending.push(
      vectorDb.appendEmbeddingNoUpsertAsync(
        entry(`C:\\images\\img-${index}.jpg`, [index + 1, 2, 3]),
      ),
    )
  }
  await Promise.all(pending)

  const rows = jsonlRows(source)
  assert.equal(rows.length, 2 + total)

  const commit = readCommit(root)
  assert.equal(commit.deltaCount, total)
  assert.equal(commit.baseCount, 2)

  const files = incrementPaths(root)
  assert.equal(fs.statSync(files.f16).size, total * ROW_BYTES)
  assert.deepEqual(fs.readFileSync(files.f16), referenceTailF16(source, 2).f16)

  const pathRows = fs
    .readFileSync(files.paths, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  assert.equal(pathRows.length, total)
  for (let index = 0; index < total; index++) {
    assert.equal(pathRows[index].row, 2 + index)
    // Chain order is FIFO, so delta rows line up with the JSONL tail order.
    assert.equal(pathRows[index].path, rows[2 + index].imageId)
  }

  const manifest = store.readCurrentAuthoritativeManifest(
    path.join(root, 'vector-db', 'vector-store'),
  )
  assert.equal(manifest.entries[0].count, 2, 'base generation stays untouched by appends')
})

test('invalid vectors and known-model dimension lies reject before JSONL or delta writes', async (t) => {
  const { root, source } = setup(t, 'invalid-gate', row('C:\\images\\base.jpg', [1, 0, 0]))
  vectorDb.initVectorDatabase(root)
  increment.resetEmbeddingIncrementStateForTests()
  const before = fs.readFileSync(source)
  const invalidEntries = [
    entry('C:\\images\\zero.jpg', [0, 0, 0]),
    entry('C:\\images\\short.jpg', [1, 0]),
    entry('C:\\images\\null.jpg', [1, null, 0]),
    entry('C:\\images\\infinite.jpg', [1, Number.POSITIVE_INFINITY, 0]),
  ]
  for (const invalid of invalidEntries) {
    assert.throws(() => vectorDb.appendEmbeddingNoUpsert(invalid), /Invalid embedding vector/)
    let promise
    assert.doesNotThrow(() => {
      promise = vectorDb.appendEmbeddingNoUpsertAsync(invalid)
    })
    await assert.rejects(promise, /Invalid embedding vector/)
  }

  const wrongDeclaredDim = {
    ...entry('C:\\images\\known-wrong-dim.jpg', [1, 0, 0]),
    modelName: 'clip_vit_base_patch32',
  }
  assert.throws(
    () => vectorDb.appendEmbeddingNoUpsert(wrongDeclaredDim),
    /does not match.*capability/,
  )
  await assert.rejects(
    vectorDb.appendEmbeddingNoUpsertAsync(wrongDeclaredDim),
    /does not match.*capability/,
  )
  assert.deepEqual(fs.readFileSync(source), before)
  assert.equal(fs.existsSync(incrementPaths(root).dir), false)
})

test('post-validation setup errors are observable Promise rejections, never synchronous throws', async (t) => {
  const { root } = makeRoot(t, 'async-setup-error')
  vectorDb.initVectorDatabase(root)
  const targetPath = path.join(root, 'vector-db', 'embeddings', `${MODEL}__${TYPE}.jsonl`)
  let promise
  assert.doesNotThrow(() => {
    promise = vectorDb.appendEmbeddingNoUpsertAsync({
      ...entry('C:\\images\\a.jpg', [1, 0, 0]),
      hostileAfterValidation: 1n,
    })
  })
  await assert.rejects(promise, /BigInt/)
  assert.equal(fs.existsSync(targetPath), false)
})

test('legacy delta schema is rejected even when an exact-size row decodes as NaN', async (t) => {
  const { root, source } = setup(t, 'legacy-delta', row('C:\\images\\base.jpg', [1, 0, 0]))
  await migrate(root, source)
  vectorDb.initVectorDatabase(root)
  increment.resetEmbeddingIncrementStateForTests()
  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\images\\delta.jpg', [0, 1, 0]))

  const files = incrementPaths(root)
  const encoded = fs.readFileSync(files.f16)
  encoded.writeUInt16LE(0x7e00, 0)
  fs.writeFileSync(files.f16, encoded)
  const commit = readCommit(root)
  commit.version = 1
  fs.writeFileSync(files.commit, JSON.stringify(commit))

  const snapshot = increment.readEmbeddingIncrementSnapshot(
    path.join(root, 'vector-db', 'vector-store'),
    MODEL,
    TYPE,
    DIM,
    [source],
  )
  assert.equal(snapshot, null)
  assert.equal(
    cacheApi.readFreshEmbeddingF16Cache({
      cacheDir: path.join(root, 'vector-db', 'embedding-cache'),
      modelName: MODEL,
      embeddingType: TYPE,
      dim: DIM,
      sourcePaths: [source],
    }),
    null,
  )
})
