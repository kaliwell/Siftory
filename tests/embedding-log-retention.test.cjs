const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  appendEmbeddingDiagnostic,
  appendEmbeddingFailure,
  enforceEmbeddingFailureRetention,
  getEmbeddingLogHealth,
  resetEmbeddingLogRetentionForTests,
  selectRetainedEmbeddingJobs,
} = loadTsModule('electron/embeddingLogRetention.ts')

function tempFile(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-log-retention-'))
  return path.join(directory, name)
}

function rows(filePath) {
  return fs
    .readFileSync(filePath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test.beforeEach(() => resetEmbeddingLogRetentionForTests())

test('failure log deduplicates model, image, and reason while enforcing TTL and record limits', () => {
  const filePath = tempFile('embedding_failures.jsonl')
  const now = Date.parse('2026-07-30T00:00:00.000Z')
  fs.writeFileSync(
    filePath,
    [
      { time: '2026-01-01T00:00:00.000Z', modelName: 'old', imageId: 'old', error: 'old' },
      {
        time: '2026-01-01T00:00:00.000Z',
        modelName: 'clip',
        imageId: 'a',
        error: 'decode',
        count: 9,
      },
      { time: '2026-07-29T00:00:00.000Z', modelName: 'clip', imageId: 'a', error: 'decode' },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  )
  const incoming = {
    time: new Date(now).toISOString(),
    modelName: 'clip',
    imageId: 'a',
    error: 'decode',
  }
  assert.equal(
    appendEmbeddingFailure(
      filePath,
      incoming,
      { maxBytes: 4096, maxRecords: 2, ttlMs: 7 * 864e5 },
      now,
    ),
    true,
  )
  assert.equal(
    appendEmbeddingFailure(
      filePath,
      incoming,
      { maxBytes: 4096, maxRecords: 2, ttlMs: 7 * 864e5 },
      now,
    ),
    true,
  )
  assert.deepEqual(rows(filePath), [{ ...incoming, count: 3 }])
})

test('failure log keeps new unique failures on the bounded O(1) append path', () => {
  const filePath = tempFile('embedding_failures.jsonl')
  const policy = { maxBytes: 4096, maxRecords: 20, ttlMs: 7 * 864e5 }
  const now = Date.parse('2026-07-30T00:00:00.000Z')
  assert.equal(
    appendEmbeddingFailure(
      filePath,
      {
        time: new Date(now).toISOString(),
        modelName: 'clip',
        imageId: 'a',
        error: 'decode',
      },
      policy,
      now,
    ),
    true,
  )

  const originalReadFileSync = fs.readFileSync
  let retentionReads = 0
  fs.readFileSync = (...args) => {
    if (args[0] === filePath) retentionReads += 1
    return originalReadFileSync(...args)
  }
  try {
    assert.equal(
      appendEmbeddingFailure(
        filePath,
        {
          time: new Date(now + 1).toISOString(),
          modelName: 'clip',
          imageId: 'b',
          error: 'decode',
        },
        policy,
        now + 1,
      ),
      true,
    )
  } finally {
    fs.readFileSync = originalReadFileSync
  }
  assert.equal(retentionReads, 0)
  assert.equal(rows(filePath).length, 2)
})

test('failure retention compacts historical rows before a build produces a new failure', () => {
  const filePath = tempFile('embedding_failures.jsonl')
  const now = Date.parse('2026-07-30T00:00:00.000Z')
  fs.writeFileSync(
    filePath,
    [
      { time: '2026-01-01T00:00:00.000Z', modelName: 'dino', imageId: 'old', error: 'old' },
      { time: '2026-07-29T00:00:00.000Z', modelName: 'dino', imageId: 'a', error: 'decode' },
      { time: '2026-07-29T01:00:00.000Z', modelName: 'dino', imageId: 'a', error: 'decode' },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  )

  assert.equal(
    enforceEmbeddingFailureRetention(
      filePath,
      { maxBytes: 4096, maxRecords: 20, ttlMs: 7 * 864e5 },
      now,
    ),
    true,
  )
  assert.deepEqual(rows(filePath), [
    {
      time: '2026-07-29T01:00:00.000Z',
      modelName: 'dino',
      imageId: 'a',
      error: 'decode',
      count: 2,
    },
  ])
})

test('diagnostic log rotates by bytes and prunes backups by count', () => {
  const filePath = tempFile('embedding_diagnostics.jsonl')
  const policy = { maxBytes: 180, maxRecords: 50, ttlMs: 864e5, maxBackups: 2, compactEvery: 50 }
  for (let index = 0; index < 20; index++) {
    assert.equal(
      appendEmbeddingDiagnostic(
        filePath,
        {
          time: new Date(1_785_283_200_000 + index).toISOString(),
          event: 'probe',
          payload: 'x'.repeat(40),
        },
        policy,
        1_785_283_200_000 + index,
      ),
      true,
    )
  }
  const files = fs.readdirSync(path.dirname(filePath))
  assert.ok(files.includes(path.basename(filePath)))
  assert.ok(files.filter((name) => name.endsWith('.bak')).length <= 2)
  for (const name of files)
    assert.ok(fs.statSync(path.join(path.dirname(filePath), name)).size <= 180)
})

test('diagnostic log drops a single oversized event without exceeding its byte cap', () => {
  const filePath = tempFile('embedding_diagnostics.jsonl')
  const policy = {
    maxBytes: 100,
    maxRecords: 50,
    ttlMs: 864e5,
    maxBackups: 2,
    compactEvery: 50,
  }
  assert.equal(
    appendEmbeddingDiagnostic(
      filePath,
      { time: new Date().toISOString(), payload: 'x'.repeat(500) },
      policy,
    ),
    true,
  )
  assert.ok(fs.statSync(filePath).size <= policy.maxBytes)
  const health = getEmbeddingLogHealth().find((item) => item.name === 'diagnostics')
  assert.equal(health.ok, true)
  assert.equal(health.droppedRecords, 1)
})

test('log write failures are fail-safe and visible in health state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-log-failure-'))
  const occupied = path.join(root, 'occupied')
  fs.writeFileSync(occupied, 'do-not-change')
  assert.equal(
    appendEmbeddingDiagnostic(path.join(occupied, 'diagnostic.jsonl'), {
      time: new Date().toISOString(),
    }),
    false,
  )
  const diagnostic = getEmbeddingLogHealth().find((item) => item.name === 'diagnostics')
  assert.equal(diagnostic.ok, false)
  assert.match(diagnostic.lastError, /EEXIST|ENOTDIR/)
  assert.equal(fs.readFileSync(occupied, 'utf8'), 'do-not-change')
})

test('job retention preserves all active jobs and only bounded recent terminal history', () => {
  const now = 1_785_283_200_000
  const job = (id, status, ageDays) => ({
    id,
    imageId: String(id),
    path: String(id),
    status,
    modelName: 'clip',
    embeddingType: 'global',
    retries: 0,
    createdAt: now - ageDays * 864e5,
    finishedAt: now - ageDays * 864e5,
  })
  const retained = selectRetainedEmbeddingJobs(
    [
      job(1, 'pending', 100),
      job(2, 'running', 100),
      job(3, 'failed', 40),
      job(4, 'failed', 2),
      job(5, 'failed', 1),
      job(6, 'completed', 8),
      job(7, 'completed', 1),
      job(8, 'skipped', 1),
    ],
    now,
    { failedTtlMs: 30 * 864e5, completedTtlMs: 7 * 864e5, maxFailed: 1, maxCompleted: 1 },
  )
  assert.deepEqual(
    retained.map((item) => item.id),
    [1, 2, 5, 7],
  )
})

test('embedding runtime and maintenance IPC wire the bounded retention helpers', () => {
  const embeddingService = fs.readFileSync(
    path.resolve(__dirname, '../electron/embeddingService.ts'),
    'utf8',
  )
  const vectorDatabase = fs.readFileSync(
    path.resolve(__dirname, '../electron/vectorDatabaseService.ts'),
    'utf8',
  )
  const maintenance = fs.readFileSync(
    path.resolve(__dirname, '../electron/vectorMaintenanceService.ts'),
    'utf8',
  )

  assert.match(embeddingService, /appendEmbeddingDiagnostic\(getDiagnosticLogPath\(\)/)
  assert.match(embeddingService, /appendEmbeddingFailure\(getFailureLogPath\(\)/)
  assert.match(embeddingService, /enforceEmbeddingFailureRetention\(getFailureLogPath\(\)\)/)
  assert.match(embeddingService, /enforceEmbeddingJobRetention\(\)/)
  assert.match(vectorDatabase, /selectRetainedEmbeddingJobs\(jobs, now\)/)
  assert.match(maintenance, /logHealth: getEmbeddingLogHealth\(\)/)
})
