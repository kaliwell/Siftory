const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fsSync = require('node:fs')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { JsonLinesStore } = loadTsModule('electron/vectorDatabaseService.ts')
const { runJsonLinesTransaction, recoverJsonLinesTransaction, jsonLinesTransactionFiles } =
  loadTsModule('electron/jsonLinesTransaction.ts')
const {
  runAssetMetadataTransaction,
  recoverAssetMetadataTransaction,
  assetMetadataTransactionFiles,
} = loadTsModule('electron/assetMetadataTransaction.ts')
const { assetLibraryRestoreFiles, createAssetLibraryBackupIfDue, recoverAssetLibraryRestore } =
  loadTsModule('electron/assetLibraryBackup.ts')

const GUARD_UTILS_PATH = path.join(__dirname, 'guard-utils.cjs')
const CHILD_TIMEOUT_MS = 20000
const KILL_SETTLE_MS = 300

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'floating-clock-fault-injection-'))
  try {
    await run(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errnoError(code, message) {
  const error = new Error(message || code)
  error.code = code
  return error
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fsSync.readFileSync(filePath)).digest('hex')
}

function stageOrphans(dir) {
  return fsSync
    .readdirSync(dir)
    .filter((name) => name.startsWith(jsonLinesTransactionFiles.stagePrefix))
}

async function createSeededPair(dir) {
  const left = new JsonLinesStore('left.jsonl', () => dir)
  const right = new JsonLinesStore('right.jsonl', () => dir)
  const leftRecord = left.insert({ value: 'old-left' })
  const rightRecord = right.insert({ value: 'old-right' })
  await Promise.all([left.flush(), right.flush()])
  return { left, right, leftRecord, rightRecord }
}

// ── Power-loss child harness ──────────────────────────────
// Child scripts run the real transaction code, write a marker file at a
// precise point, then freeze with Atomics.wait. The parent polls for the
// marker and kills the child (TerminateProcess on Windows ≈ SIGKILL), which
// emulates a power cut without stdout flush races.

function buildChildScript(body) {
  return [
    `'use strict'`,
    `const fs = require('node:fs')`,
    `const path = require('node:path')`,
    `const { loadTsModule } = require(${JSON.stringify(GUARD_UTILS_PATH)})`,
    `const writeFileSyncOriginal = fs.writeFileSync`,
    `function markAndFreeze(markerPath) {`,
    `  writeFileSyncOriginal.call(fs, markerPath, '')`,
    `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)`,
    `}`,
    body,
  ].join('\n')
}

function runChildUntilMarker(scriptPath, markerPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let sawMarker = false
    let settled = false
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(result)
    }
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const poll = setInterval(() => {
      if (!sawMarker && fsSync.existsSync(markerPath)) {
        sawMarker = true
        child.kill('SIGKILL')
      }
    }, 20)
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(
        new Error(
          `child did not reach the freeze marker in time\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      )
    }, CHILD_TIMEOUT_MS)
    child.on('error', (error) => finish(error))
    child.on('exit', (code, signal) => {
      if (!sawMarker) {
        finish(
          new Error(
            `child exited before the freeze marker (code=${code} signal=${signal})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        )
        return
      }
      finish(null, { code, signal, stdout, stderr })
    })
  })
}

function jsonlTransactionChildScript(dbDir, markerPath, patchSnippet) {
  return buildChildScript(`
const DB_DIR = ${JSON.stringify(dbDir)}
const MARKER_PATH = ${JSON.stringify(markerPath)}
const JOURNAL_NAME = ${JSON.stringify(jsonLinesTransactionFiles.journal)}
const STAGE_PREFIX = ${JSON.stringify(jsonLinesTransactionFiles.stagePrefix)}
const { JsonLinesStore } = loadTsModule('electron/vectorDatabaseService.ts')
const { runJsonLinesTransaction } = loadTsModule('electron/jsonLinesTransaction.ts')
${patchSnippet}
async function main() {
  const left = new JsonLinesStore('left.jsonl', () => DB_DIR)
  const right = new JsonLinesStore('right.jsonl', () => DB_DIR)
  const leftRecord = left.insert({ value: 'old-left' })
  const rightRecord = right.insert({ value: 'old-right' })
  await Promise.all([left.flush(), right.flush()])
  await runJsonLinesTransaction(DB_DIR, [left, right], () => {
    left.update(leftRecord.id, { value: 'new-left' })
    right.update(rightRecord.id, { value: 'new-right' })
  })
}
main().catch((error) => {
  try {
    process.stderr.write(String((error && error.stack) || error))
  } catch {}
  process.exitCode = 1
})
`)
}

// ── Part A: fs patch injection ────────────────────────────

test('ENOSPC during the second stage write rolls the transaction back cleanly', async () => {
  await withTempDir(async (dir) => {
    const { left, right, leftRecord, rightRecord } = await createSeededPair(dir)
    const originalWriteFileSync = fsSync.writeFileSync
    fsSync.writeFileSync = function (file, data, ...rest) {
      if (typeof data === 'string' && data.includes('new-right')) {
        throw errnoError('ENOSPC', 'no space left on device')
      }
      return originalWriteFileSync.call(this, file, data, ...rest)
    }
    try {
      await assert.rejects(
        runJsonLinesTransaction(dir, [left, right], () => {
          left.update(leftRecord.id, { value: 'new-left' })
          right.update(rightRecord.id, { value: 'new-right' })
        }),
        { code: 'ENOSPC' },
      )
    } finally {
      fsSync.writeFileSync = originalWriteFileSync
    }
    assert.equal(fsSync.existsSync(path.join(dir, jsonLinesTransactionFiles.journal)), false)
    assert.deepEqual(stageOrphans(dir), [])
    assert.match(fsSync.readFileSync(path.join(dir, 'left.jsonl'), 'utf8'), /old-left/)
    assert.match(fsSync.readFileSync(path.join(dir, 'right.jsonl'), 'utf8'), /old-right/)
    assert.equal(left.getById(leftRecord.id).value, 'old-left')
    assert.equal(right.getById(rightRecord.id).value, 'old-right')
    // The journal was never published, so both stores stay usable.
    left.update(leftRecord.id, { value: 'after-failure' })
    await left.flush()
    assert.equal(
      new JsonLinesStore('left.jsonl', () => dir).getById(leftRecord.id).value,
      'after-failure',
    )
  })
})

test('EPERM publishing the journal cleans the temporary journal and stages', async () => {
  await withTempDir(async (dir) => {
    const { left, right, leftRecord, rightRecord } = await createSeededPair(dir)
    const journalTmpName = `${jsonLinesTransactionFiles.journal}.tmp`
    const originalRenameSync = fsSync.renameSync
    fsSync.renameSync = function (source, _target) {
      if (path.basename(String(source)) === journalTmpName) {
        throw errnoError('EPERM', 'operation not permitted')
      }
      return originalRenameSync.apply(this, arguments)
    }
    try {
      await assert.rejects(
        runJsonLinesTransaction(dir, [left, right], () => {
          left.update(leftRecord.id, { value: 'new-left' })
          right.update(rightRecord.id, { value: 'new-right' })
        }),
        { code: 'EPERM' },
      )
    } finally {
      fsSync.renameSync = originalRenameSync
    }
    assert.equal(fsSync.existsSync(path.join(dir, jsonLinesTransactionFiles.journal)), false)
    assert.equal(fsSync.existsSync(path.join(dir, journalTmpName)), false)
    assert.deepEqual(stageOrphans(dir), [])
    assert.match(fsSync.readFileSync(path.join(dir, 'left.jsonl'), 'utf8'), /old-left/)
    assert.match(fsSync.readFileSync(path.join(dir, 'right.jsonl'), 'utf8'), /old-right/)
    assert.equal(left.getById(leftRecord.id).value, 'old-left')
    assert.equal(right.getById(rightRecord.id).value, 'old-right')
  })
})

test('EACCES replacing a target after journal publish locks the stores and keeps the journal', async () => {
  await withTempDir(async (dir) => {
    const { left, right, leftRecord, rightRecord } = await createSeededPair(dir)
    const originalRenameSync = fsSync.renameSync
    fsSync.renameSync = function (source, _target) {
      if (path.basename(String(source)).startsWith(jsonLinesTransactionFiles.stagePrefix)) {
        throw errnoError('EACCES', 'permission denied')
      }
      return originalRenameSync.apply(this, arguments)
    }
    try {
      await assert.rejects(
        runJsonLinesTransaction(dir, [left, right], () => {
          left.update(leftRecord.id, { value: 'new-left' })
          right.update(rightRecord.id, { value: 'new-right' })
        }),
        /recovery failed; asset data is locked/i,
      )
    } finally {
      fsSync.renameSync = originalRenameSync
    }
    // The published journal is retained for the next startup.
    assert.equal(fsSync.existsSync(path.join(dir, jsonLinesTransactionFiles.journal)), true)
    assert.match(fsSync.readFileSync(path.join(dir, 'left.jsonl'), 'utf8'), /old-left/)
    assert.match(fsSync.readFileSync(path.join(dir, 'right.jsonl'), 'utf8'), /old-right/)
    assert.match(left.getPersistenceStatus().unavailableError || '', /restart is required/i)
    assert.match(right.getPersistenceStatus().unavailableError || '', /restart is required/i)
    assert.throws(() => left.update(leftRecord.id, { value: 'blocked' }), /restart is required/i)
    // Once the fault clears, startup recovery completes the commit.
    assert.equal(recoverJsonLinesTransaction(dir), true)
    assert.match(fsSync.readFileSync(path.join(dir, 'left.jsonl'), 'utf8'), /new-left/)
    assert.match(fsSync.readFileSync(path.join(dir, 'right.jsonl'), 'utf8'), /new-right/)
  })
})

test('EIO from fsync during a stage write fails the transaction before publish', async () => {
  await withTempDir(async (dir) => {
    const { left, right, leftRecord, rightRecord } = await createSeededPair(dir)
    const stageFds = new Set()
    const originalOpenSync = fsSync.openSync
    const originalCloseSync = fsSync.closeSync
    const originalFsyncSync = fsSync.fsyncSync
    fsSync.openSync = function (file, flags, mode) {
      const fd = originalOpenSync.call(this, file, flags, mode)
      if (path.basename(String(file)).startsWith(jsonLinesTransactionFiles.stagePrefix)) {
        stageFds.add(fd)
      }
      return fd
    }
    fsSync.closeSync = function (fd) {
      stageFds.delete(fd)
      return originalCloseSync.call(this, fd)
    }
    fsSync.fsyncSync = function (fd) {
      if (stageFds.has(fd)) throw errnoError('EIO', 'input/output error')
      return originalFsyncSync.call(this, fd)
    }
    try {
      await assert.rejects(
        runJsonLinesTransaction(dir, [left, right], () => {
          left.update(leftRecord.id, { value: 'new-left' })
          right.update(rightRecord.id, { value: 'new-right' })
        }),
        { code: 'EIO' },
      )
    } finally {
      fsSync.openSync = originalOpenSync
      fsSync.closeSync = originalCloseSync
      fsSync.fsyncSync = originalFsyncSync
    }
    assert.equal(fsSync.existsSync(path.join(dir, jsonLinesTransactionFiles.journal)), false)
    assert.deepEqual(stageOrphans(dir), [])
    assert.match(fsSync.readFileSync(path.join(dir, 'left.jsonl'), 'utf8'), /old-left/)
    assert.match(fsSync.readFileSync(path.join(dir, 'right.jsonl'), 'utf8'), /old-right/)
    // The journal was never published, so the stores stay writable.
    assert.equal(left.getPersistenceStatus().unavailableError, undefined)
    assert.equal(right.getPersistenceStatus().unavailableError, undefined)
  })
})

test('asset metadata recovery completes idempotently after an injected rename failure', async () => {
  await withTempDir(async (dir) => {
    const newAssets = '{"id":2,"path":"new.jpg"}\n'
    const newState = '{"nextId":3}'
    await fs.writeFile(path.join(dir, 'assets.jsonl'), '{"id":1,"path":"old.jpg"}\n')
    await fs.writeFile(path.join(dir, 'state.json'), '{"nextId":2}')
    const originalRename = fsSync.promises.rename
    fsSync.promises.rename = async function (source, target) {
      if (path.basename(String(target)) === 'state.json') {
        throw errnoError('EACCES', 'permission denied')
      }
      return originalRename.apply(this, arguments)
    }
    try {
      await assert.rejects(
        runAssetMetadataTransaction(dir, async (stagePaths) => {
          await fs.writeFile(stagePaths.assetsPath, newAssets)
          await fs.writeFile(stagePaths.statePath, newState)
        }),
        /recovery failed; restart is required/i,
      )
    } finally {
      fsSync.promises.rename = originalRename
    }
    // assets.jsonl was already replaced; state.json is still pending in the journal.
    assert.equal(fsSync.readFileSync(path.join(dir, 'assets.jsonl'), 'utf8'), newAssets)
    assert.equal(fsSync.readFileSync(path.join(dir, 'state.json'), 'utf8'), '{"nextId":2}')
    assert.equal(fsSync.existsSync(path.join(dir, assetMetadataTransactionFiles.journal)), true)
    // After the fault clears, recovery finishes the remaining rename.
    assert.equal(recoverAssetMetadataTransaction(dir), true)
    assert.equal(fsSync.readFileSync(path.join(dir, 'assets.jsonl'), 'utf8'), newAssets)
    assert.equal(fsSync.readFileSync(path.join(dir, 'state.json'), 'utf8'), newState)
    assert.equal(fsSync.existsSync(path.join(dir, assetMetadataTransactionFiles.journal)), false)
    assert.equal(recoverAssetMetadataTransaction(dir), false)
  })
})

test('directory fsync failures are tolerated by both transaction implementations', async () => {
  await withTempDir(async (dir) => {
    const jsonlDir = path.join(dir, 'jsonl')
    const metaDir = path.join(dir, 'meta')
    await fs.mkdir(jsonlDir, { recursive: true })
    await fs.mkdir(metaDir, { recursive: true })
    const isDirectoryOpen = (target, flags) =>
      flags === 'r' &&
      [jsonlDir, metaDir].some(
        (directory) => path.resolve(String(target)) === path.resolve(directory),
      )
    const originalPromisesOpen = fsSync.promises.open
    const originalOpenSync = fsSync.openSync
    fsSync.promises.open = async function (target, flags, ...rest) {
      if (isDirectoryOpen(target, flags)) throw errnoError('EPERM', 'directory sync unsupported')
      return originalPromisesOpen.call(this, target, flags, ...rest)
    }
    fsSync.openSync = function (target, flags, mode) {
      if (isDirectoryOpen(target, flags)) throw errnoError('EPERM', 'directory sync unsupported')
      return originalOpenSync.call(this, target, flags, mode)
    }
    try {
      await fs.writeFile(path.join(metaDir, 'assets.jsonl'), '{"id":1,"path":"old.jpg"}\n')
      await fs.writeFile(path.join(metaDir, 'state.json'), '{"nextId":2}')
      await runAssetMetadataTransaction(metaDir, async (stagePaths) => {
        await fs.writeFile(stagePaths.assetsPath, '{"id":2,"path":"new.jpg"}\n')
        await fs.writeFile(stagePaths.statePath, '{"nextId":3}')
      })
      assert.match(fsSync.readFileSync(path.join(metaDir, 'assets.jsonl'), 'utf8'), /new\.jpg/)
      assert.match(fsSync.readFileSync(path.join(metaDir, 'state.json'), 'utf8'), /"nextId":3/)

      const store = new JsonLinesStore('records.jsonl', () => jsonlDir)
      const record = store.insert({ value: 'old' })
      await store.flush()
      await runJsonLinesTransaction(jsonlDir, [store], () => {
        store.update(record.id, { value: 'new' })
      })
      assert.match(fsSync.readFileSync(path.join(jsonlDir, 'records.jsonl'), 'utf8'), /new/)
    } finally {
      fsSync.promises.open = originalPromisesOpen
      fsSync.openSync = originalOpenSync
    }
  })
})

// ── Part B: power-loss simulation via child kill ──────────

test('power loss after journal publish recovers to a consistent all-new state', async () => {
  await withTempDir(async (dir) => {
    const dbDir = path.join(dir, 'db')
    await fs.mkdir(dbDir, { recursive: true })
    const markerPath = path.join(dir, 'journal-published.marker')
    const scriptPath = path.join(dir, 'child-journal-published.cjs')
    await fs.writeFile(
      scriptPath,
      jsonlTransactionChildScript(
        dbDir,
        markerPath,
        `const originalRenameSync = fs.renameSync
fs.renameSync = function (source, target) {
  const result = originalRenameSync.call(fs, source, target)
  if (path.basename(String(target)) === JOURNAL_NAME) markAndFreeze(MARKER_PATH)
  return result
}`,
      ),
    )
    await runChildUntilMarker(scriptPath, markerPath)
    await sleep(KILL_SETTLE_MS)
    assert.equal(recoverJsonLinesTransaction(dbDir), true)
    assert.match(fsSync.readFileSync(path.join(dbDir, 'left.jsonl'), 'utf8'), /new-left/)
    assert.match(fsSync.readFileSync(path.join(dbDir, 'right.jsonl'), 'utf8'), /new-right/)
    assert.equal(fsSync.existsSync(path.join(dbDir, jsonLinesTransactionFiles.journal)), false)
    assert.deepEqual(stageOrphans(dbDir), [])
  })
})

test('power loss between stage replacements is completed by recovery', async () => {
  await withTempDir(async (dir) => {
    const dbDir = path.join(dir, 'db')
    await fs.mkdir(dbDir, { recursive: true })
    const markerPath = path.join(dir, 'first-rename.marker')
    const scriptPath = path.join(dir, 'child-between-renames.cjs')
    await fs.writeFile(
      scriptPath,
      jsonlTransactionChildScript(
        dbDir,
        markerPath,
        `const originalRenameSync = fs.renameSync
let stagedRenames = 0
fs.renameSync = function (source, target) {
  const result = originalRenameSync.call(fs, source, target)
  if (path.basename(String(source)).startsWith(STAGE_PREFIX)) {
    stagedRenames += 1
    if (stagedRenames === 1) markAndFreeze(MARKER_PATH)
  }
  return result
}`,
      ),
    )
    await runChildUntilMarker(scriptPath, markerPath)
    await sleep(KILL_SETTLE_MS)
    assert.equal(recoverJsonLinesTransaction(dbDir), true)
    const leftText = fsSync.readFileSync(path.join(dbDir, 'left.jsonl'), 'utf8')
    const rightText = fsSync.readFileSync(path.join(dbDir, 'right.jsonl'), 'utf8')
    // Recovery completes the pending rename: every target is new, never mixed.
    assert.match(leftText, /new-left/)
    assert.match(rightText, /new-right/)
    assert.equal(fsSync.existsSync(path.join(dbDir, jsonLinesTransactionFiles.journal)), false)
    assert.deepEqual(stageOrphans(dbDir), [])
  })
})

test('writeSnapshot power loss leaves a .tmp orphan but keeps the target intact (current behavior)', async () => {
  await withTempDir(async (dir) => {
    const dbDir = path.join(dir, 'db')
    await fs.mkdir(dbDir, { recursive: true })
    const markerPath = path.join(dir, 'tmp-written.marker')
    const scriptPath = path.join(dir, 'child-write-snapshot.cjs')
    await fs.writeFile(
      scriptPath,
      buildChildScript(`
const DB_DIR = ${JSON.stringify(dbDir)}
const MARKER_PATH = ${JSON.stringify(markerPath)}
const { JsonLinesStore } = loadTsModule('electron/vectorDatabaseService.ts')
async function main() {
  const store = new JsonLinesStore('records.jsonl', () => DB_DIR)
  const record = store.insert({ value: 'old' })
  await store.flush()
  const originalWriteFileSync = fs.writeFileSync
  fs.writeFileSync = function (file, data, options) {
    const result = originalWriteFileSync.apply(fs, arguments)
    if (String(file).endsWith('records.jsonl.tmp')) markAndFreeze(MARKER_PATH)
    return result
  }
  store.update(record.id, { value: 'new' })
  await store.flush()
}
main().catch((error) => {
  try {
    process.stderr.write(String((error && error.stack) || error))
  } catch {}
  process.exitCode = 1
})
`),
    )
    await runChildUntilMarker(scriptPath, markerPath)
    await sleep(KILL_SETTLE_MS)
    const targetPath = path.join(dbDir, 'records.jsonl')
    const tmpPath = path.join(dbDir, 'records.jsonl.tmp')
    assert.match(fsSync.readFileSync(targetPath, 'utf8'), /old/)
    assert.equal(
      fsSync.existsSync(tmpPath),
      true,
      'current behavior: the .tmp orphan survives a mid-write power loss',
    )
    // The next snapshot write reuses and replaces the orphan.
    const store = new JsonLinesStore('records.jsonl', () => dbDir)
    const record = store.getAll()[0]
    store.update(record.id, { value: 'rewritten' })
    await store.flush()
    assert.match(fsSync.readFileSync(targetPath, 'utf8'), /rewritten/)
    assert.equal(fsSync.existsSync(tmpPath), false)
  })
})

test('commitPreparedPath journal completes a replacement killed after moving the final aside', async () => {
  await withTempDir(async (dir) => {
    const markerPath = path.join(dir, 'moved-aside.marker')
    const scriptPath = path.join(dir, 'child-commit-prepared.cjs')
    await fs.writeFile(
      scriptPath,
      buildChildScript(`
const DIR = ${JSON.stringify(dir)}
const MARKER_PATH = ${JSON.stringify(markerPath)}
const { createPreparedSiblingPath, commitPreparedPath } = loadTsModule(
  'electron/localFileTransaction.ts',
)
async function main() {
  const finalPath = path.join(DIR, 'final.txt')
  fs.writeFileSync(finalPath, 'original', 'utf8')
  const preparedPath = createPreparedSiblingPath(finalPath)
  fs.writeFileSync(preparedPath, 'replacement', 'utf8')
  const originalRename = fs.promises.rename
  let movedAside = false
  fs.promises.rename = async function (source, target) {
    const result = await originalRename.call(fs.promises, source, target)
    if (!movedAside) {
      movedAside = true
      markAndFreeze(MARKER_PATH)
    }
    return result
  }
  await commitPreparedPath(preparedPath, finalPath)
}
main().catch((error) => {
  try {
    process.stderr.write(String((error && error.stack) || error))
  } catch {}
  process.exitCode = 1
})
`),
    )
    await runChildUntilMarker(scriptPath, markerPath)
    await sleep(KILL_SETTLE_MS)
    // The crash lands in the old missing-final window, but a durable journal
    // now describes both surviving siblings.
    assert.equal(fsSync.existsSync(path.join(dir, 'final.txt')), false)
    const backups = fsSync
      .readdirSync(dir)
      .filter((name) => name.startsWith('.final.txt.floatingclock-') && name.endsWith('.bak'))
    assert.equal(backups.length, 1)
    assert.equal(fsSync.readFileSync(path.join(dir, backups[0]), 'utf8'), 'original')
    const prepared = fsSync
      .readdirSync(dir)
      .filter((name) => name.startsWith('.final.txt.floatingclock-') && name.endsWith('.part'))
    assert.equal(prepared.length, 1)
    const journals = fsSync
      .readdirSync(dir)
      .filter(
        (name) =>
          name.startsWith('.final.txt.floatingclock-') && name.endsWith('.transaction.json'),
      )
    assert.equal(journals.length, 1)

    const { recoverPreparedPathTransactions } = loadTsModule('electron/localFileTransaction.ts')
    assert.equal(recoverPreparedPathTransactions(dir), 1)
    assert.equal(fsSync.readFileSync(path.join(dir, 'final.txt'), 'utf8'), 'replacement')
    const artifacts = fsSync.readdirSync(dir).filter((name) => name.includes('.floatingclock-'))
    assert.deepEqual(artifacts, [])
  })
})

// ── Part C: permissions and directory fsync policy ────────

test('read-only target files never leave a half-committed JSONL transaction', async () => {
  await withTempDir(async (dir) => {
    const { left, right, leftRecord, rightRecord } = await createSeededPair(dir)
    const leftPath = path.join(dir, 'left.jsonl')
    const rightPath = path.join(dir, 'right.jsonl')
    fsSync.chmodSync(leftPath, 0o444)
    fsSync.chmodSync(rightPath, 0o444)
    let committed = false
    let failure = null
    try {
      try {
        await runJsonLinesTransaction(dir, [left, right], () => {
          left.update(leftRecord.id, { value: 'new-left' })
          right.update(rightRecord.id, { value: 'new-right' })
        })
        committed = true
      } catch (error) {
        failure = error
      }
    } finally {
      fsSync.chmodSync(leftPath, 0o666)
      fsSync.chmodSync(rightPath, 0o666)
    }
    const leftText = fsSync.readFileSync(leftPath, 'utf8')
    const rightText = fsSync.readFileSync(rightPath, 'utf8')
    const leftIsNew = leftText.includes('new-left')
    const rightIsNew = rightText.includes('new-right')
    if (committed) {
      // POSIX: rename over a read-only file only needs directory write access.
      assert.ok(leftIsNew && rightIsNew, 'a committed transaction replaces every target')
      assert.equal(fsSync.existsSync(path.join(dir, jsonLinesTransactionFiles.journal)), false)
    } else {
      // Windows: renaming over a read-only file typically fails with EPERM.
      assert.ok(failure, 'a failed transaction must surface an error')
      assert.ok(
        leftText.includes('old-left') && rightText.includes('old-right'),
        'a failed transaction leaves every old target intact',
      )
      assert.equal(fsSync.existsSync(path.join(dir, jsonLinesTransactionFiles.journal)), true)
    }
    // Regardless of the platform outcome, a mixed state is never acceptable.
    assert.equal(leftIsNew, rightIsNew, 'transaction targets must never be half committed')
  })
})

test('JSONL transaction syncs the directory around journal publish, replacement, and cleanup', async () => {
  await withTempDir(async (dir) => {
    const directoryOpens = []
    const originalOpenSync = fsSync.openSync
    fsSync.openSync = function (target, flags, mode) {
      if (flags === 'r' && path.resolve(String(target)) === path.resolve(dir)) {
        directoryOpens.push(String(target))
      }
      return originalOpenSync.call(this, target, flags, mode)
    }
    try {
      const store = new JsonLinesStore('records.jsonl', () => dir)
      const record = store.insert({ value: 'old' })
      await store.flush()
      await runJsonLinesTransaction(dir, [store], () => {
        store.update(record.id, { value: 'new' })
      })
    } finally {
      fsSync.openSync = originalOpenSync
    }
    assert.match(fsSync.readFileSync(path.join(dir, 'records.jsonl'), 'utf8'), /new/)
    // Journal publish, stage replacement, and journal removal each fsync the directory.
    assert.ok(
      directoryOpens.length >= 3,
      `expected at least 3 directory syncs, got ${directoryOpens.length}`,
    )
  })
})

// ── Part D: backup restore power loss ─────────────────────

test('power loss mid-restore is completed by recoverAssetLibraryRestore', async () => {
  await withTempDir(async (dir) => {
    const assetDir = path.join(dir, 'asset-library')
    await fs.mkdir(assetDir, { recursive: true })
    await fs.writeFile(path.join(assetDir, 'assets.jsonl'), '{"id":1,"path":"original.jpg"}\n')
    await fs.writeFile(path.join(assetDir, 'state.json'), '{"nextId":2}')
    const backup = await createAssetLibraryBackupIfDue(assetDir, {
      now: 1_000_000,
      minimumIntervalMs: 0,
    })
    assert.equal(backup.created, true)
    const backupId = backup.backup.id
    const expectedAssetsHash = sha256File(
      path.join(dir, 'asset-library-backups', backupId, 'assets.jsonl'),
    )
    // Drift the live files so the restore has visible work to finish.
    await fs.writeFile(path.join(assetDir, 'assets.jsonl'), '{"id":9,"path":"drifted.jpg"}\n')

    const markerPath = path.join(dir, 'restore-journal.marker')
    const scriptPath = path.join(dir, 'child-restore.cjs')
    await fs.writeFile(
      scriptPath,
      buildChildScript(`
const ASSET_DIR = ${JSON.stringify(assetDir)}
const BACKUP_ID = ${JSON.stringify(backupId)}
const MARKER_PATH = ${JSON.stringify(markerPath)}
const RESTORE_JOURNAL = ${JSON.stringify(assetLibraryRestoreFiles.journal)}
const { restoreAssetLibraryBackup } = loadTsModule('electron/assetLibraryBackup.ts')
const originalRename = fs.promises.rename
fs.promises.rename = async function (source, target) {
  const result = await originalRename.call(fs.promises, source, target)
  if (path.basename(String(target)) === RESTORE_JOURNAL) markAndFreeze(MARKER_PATH)
  return result
}
restoreAssetLibraryBackup(ASSET_DIR, BACKUP_ID).catch((error) => {
  try {
    process.stderr.write(String((error && error.stack) || error))
  } catch {}
  process.exitCode = 1
})
`),
    )
    await runChildUntilMarker(scriptPath, markerPath)
    await sleep(KILL_SETTLE_MS)
    // The restore journal was published before the kill; recovery replays it.
    assert.equal(fsSync.existsSync(path.join(assetDir, assetLibraryRestoreFiles.journal)), true)
    assert.equal(recoverAssetLibraryRestore(assetDir), true)
    assert.equal(sha256File(path.join(assetDir, 'assets.jsonl')), expectedAssetsHash)
    assert.equal(fsSync.existsSync(path.join(assetDir, assetLibraryRestoreFiles.journal)), false)
  })
})

// ── Part E: asset metadata journal validation and recovery faults ─────

function metadataJournalPath(dir) {
  return path.join(dir, assetMetadataTransactionFiles.journal)
}

function validMetadataEntry(target, staged) {
  return { target, staged, bytes: 1, sha256: 'a'.repeat(64) }
}

function writeMetadataJournal(dir, entries) {
  fsSync.writeFileSync(
    metadataJournalPath(dir),
    JSON.stringify({ version: 1, id: 'test-journal-1', entries }),
  )
}

test('malformed asset metadata journals are rejected with specific errors', async () => {
  await withTempDir(async (dir) => {
    const stage = (name) => `${assetMetadataTransactionFiles.stagePrefix}t-${name}`
    const cases = [
      {
        name: 'non-object entry',
        entries: [null, validMetadataEntry('assets.jsonl', stage('a'))],
        pattern: /invalid asset metadata transaction entry/i,
      },
      {
        name: 'target with path separator',
        entries: [
          validMetadataEntry('../evil.jsonl', stage('a')),
          validMetadataEntry('state.json', stage('s')),
        ],
        pattern: /invalid asset metadata transaction filename/i,
      },
      {
        name: 'unknown target filename',
        entries: [
          validMetadataEntry('evil.json', stage('a')),
          validMetadataEntry('state.json', stage('s')),
        ],
        pattern: /invalid asset metadata transaction target/i,
      },
      {
        name: 'staged file without the stage prefix',
        entries: [
          { target: 'assets.jsonl', staged: 'no-prefix', bytes: 1, sha256: 'a'.repeat(64) },
          validMetadataEntry('state.json', stage('s')),
        ],
        pattern: /invalid asset metadata transaction stage/i,
      },
      {
        name: 'malformed integrity metadata',
        entries: [
          { target: 'assets.jsonl', staged: stage('a'), bytes: 1, sha256: 'not-a-hash' },
          validMetadataEntry('state.json', stage('s')),
        ],
        pattern: /invalid asset metadata transaction integrity metadata/i,
      },
      {
        name: 'missing required target',
        entries: [
          validMetadataEntry('assets.jsonl', stage('a')),
          validMetadataEntry('archived-assets.json', stage('r')),
        ],
        pattern: /missing a required target/i,
      },
    ]
    for (const [index, testCase] of cases.entries()) {
      const caseDir = path.join(dir, `case-${index}`)
      await fs.mkdir(caseDir, { recursive: true })
      writeMetadataJournal(caseDir, testCase.entries)
      assert.throws(() => recoverAssetMetadataTransaction(caseDir), testCase.pattern, testCase.name)
    }
  })
})

test('unreadable, oversized, and non-file journals fail before any recovery', async () => {
  await withTempDir(async (dir) => {
    const invalidJsonDir = path.join(dir, 'invalid-json')
    await fs.mkdir(invalidJsonDir, { recursive: true })
    fsSync.writeFileSync(metadataJournalPath(invalidJsonDir), 'not json {')
    assert.throws(
      () => recoverAssetMetadataTransaction(invalidJsonDir),
      /could not read asset metadata transaction journal/i,
    )

    const oversizedDir = path.join(dir, 'oversized')
    await fs.mkdir(oversizedDir, { recursive: true })
    fsSync.writeFileSync(metadataJournalPath(oversizedDir), `{${' '.repeat(70 * 1024)}`)
    assert.throws(
      () => recoverAssetMetadataTransaction(oversizedDir),
      /exceeds its size limit/i,
    )

    const directoryDir = path.join(dir, 'directory-journal')
    await fs.mkdir(directoryDir, { recursive: true })
    await fs.mkdir(metadataJournalPath(directoryDir))
    assert.throws(
      () => recoverAssetMetadataTransaction(directoryDir),
      /not a regular file/i,
    )
  })
})

test('startup recovery removes stale stage and temporary journal orphans', async () => {
  await withTempDir(async (dir) => {
    const orphans = [
      `${assetMetadataTransactionFiles.stagePrefix}orphan-assets`,
      'assets.jsonl.tmp',
      'state.json.tmp',
      'archived-assets.json.tmp',
      `${assetMetadataTransactionFiles.journal}.tmp`,
    ]
    for (const name of orphans) await fs.writeFile(path.join(dir, name), 'stale')
    await fs.writeFile(path.join(dir, 'assets.jsonl'), '{"id":1}\n')
    assert.equal(recoverAssetMetadataTransaction(dir), false)
    for (const name of orphans) {
      assert.equal(fsSync.existsSync(path.join(dir, name)), false, `${name} must be removed`)
    }
    assert.equal(fsSync.readFileSync(path.join(dir, 'assets.jsonl'), 'utf8'), '{"id":1}\n')
  })
})

test('fingerprint mismatch after journal publish requires restart and keeps the journal', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'assets.jsonl'), '{"id":1,"path":"old.jpg"}\n')
    await fs.writeFile(path.join(dir, 'state.json'), '{"nextId":2}')
    // The prepared fingerprints pass the format check but do not match the
    // staged bytes, so the post-publish integrity verification must fail and
    // the journal-driven recovery must fail the same way.
    await assert.rejects(
      runAssetMetadataTransaction(dir, async (stagePaths) => {
        await fs.writeFile(stagePaths.assetsPath, '{"id":2,"path":"new.jpg"}\n')
        await fs.writeFile(stagePaths.statePath, '{"nextId":3}')
        return {
          assets: { bytes: 1, sha256: 'a'.repeat(64) },
          state: { bytes: 1, sha256: 'b'.repeat(64) },
        }
      }),
      /recovery failed; restart is required/i,
    )
    assert.equal(fsSync.existsSync(metadataJournalPath(dir)), true)
    assert.match(fsSync.readFileSync(path.join(dir, 'assets.jsonl'), 'utf8'), /old\.jpg/)
    assert.equal(fsSync.readFileSync(path.join(dir, 'state.json'), 'utf8'), '{"nextId":2}')
    // Startup recovery hits the same integrity failure instead of committing.
    assert.throws(() => recoverAssetMetadataTransaction(dir), /integrity verification/i)
  })
})

test('prepared fingerprints that fail the format check abort before publish', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'assets.jsonl'), '{"id":1,"path":"old.jpg"}\n')
    await fs.writeFile(path.join(dir, 'state.json'), '{"nextId":2}')
    await assert.rejects(
      runAssetMetadataTransaction(dir, async (stagePaths) => {
        await fs.writeFile(stagePaths.assetsPath, '{"id":2,"path":"new.jpg"}\n')
        await fs.writeFile(stagePaths.statePath, '{"nextId":3}')
        return {
          assets: { bytes: -1, sha256: 'not-a-hash' },
          state: { bytes: 1, sha256: 'b'.repeat(64) },
        }
      }),
      /invalid prepared asset metadata fingerprint/i,
    )
    // The journal was never published, so the targets stay old and the
    // staged files are cleaned up.
    assert.equal(fsSync.existsSync(metadataJournalPath(dir)), false)
    assert.match(fsSync.readFileSync(path.join(dir, 'assets.jsonl'), 'utf8'), /old\.jpg/)
    const leftovers = fsSync
      .readdirSync(dir)
      .filter((name) => name.startsWith(assetMetadataTransactionFiles.stagePrefix))
    assert.deepEqual(leftovers, [])
  })
})

test('includeArchive commits the archived-assets target alongside the required pair', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'assets.jsonl'), '{"id":1,"path":"old.jpg"}\n')
    await fs.writeFile(path.join(dir, 'state.json'), '{"nextId":2}')
    await fs.writeFile(path.join(dir, 'archived-assets.json'), '[]')
    await runAssetMetadataTransaction(
      dir,
      async (stagePaths) => {
        await fs.writeFile(stagePaths.assetsPath, '{"id":2,"path":"new.jpg"}\n')
        await fs.writeFile(stagePaths.statePath, '{"nextId":3}')
        await fs.writeFile(stagePaths.archivePath, '[{"id":1}]')
      },
      { includeArchive: true },
    )
    assert.match(fsSync.readFileSync(path.join(dir, 'assets.jsonl'), 'utf8'), /new\.jpg/)
    assert.equal(fsSync.readFileSync(path.join(dir, 'state.json'), 'utf8'), '{"nextId":3}')
    assert.equal(fsSync.readFileSync(path.join(dir, 'archived-assets.json'), 'utf8'), '[{"id":1}]')
    assert.equal(fsSync.existsSync(metadataJournalPath(dir)), false)
  })
})
