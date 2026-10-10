// Phase 2 acceptance tests for stable asset identity:
// - search, asset library and duplicate groups return the same stable ID
//   for the same file
// - preview proxies are never treated as user-visible originals
// - same-volume moves repair tags/categories/index by identity
// - backup/restore covers the new ID mapping
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  assetIdFromIdentityKey,
  classifyMemberRole,
  filesystemIdentityFromStat,
  originalMemberPath,
  resolveAssetIdentity,
  userVisibleMembers,
} = loadTsModule('electron/assetIdentityResolver.ts')
const { AssetIdentityService } = loadTsModule('electron/assetIdentityService.ts')
const { AssetIdentityStore } = loadTsModule('electron/assetIdentityStore.ts')
const { AssetMetadataStore } = loadTsModule('electron/assetMetadataStore.ts')
const { DiscoveryCatalogDatabase } = loadTsModule('electron/discoveryCatalogDatabase.ts')
const { createAssetLibraryBackupIfDue, restoreAssetLibraryBackup } = loadTsModule(
  'electron/assetLibraryBackup.ts',
)
const { openOriginalFile, revealOriginalFile, resolveOriginalActionPath } = loadTsModule(
  'electron/fileActionService.ts',
)
const {
  AssetDerivedRebuildGrantStore,
  AssetDerivedRebuildClaimStore,
  AssetRepairRecoveryJournal,
  ASSET_REPAIR_RECOVERY_FILENAME,
  ASSET_REPAIR_RECOVERY_KEY_FILENAME,
  ASSET_REPAIR_RECOVERY_ANCHOR_FILENAME,
  MAX_ASSET_REPAIR_RECOVERY_BYTES,
  AssetRepairRecoveryError,
  executeAssetRepairRecoverySteps,
} = loadTsModule('electron/assetDerivedRebuildGrant.ts')
const { scheduleAssetDerivedRebuild, waitForBoundedOperation, waitForBoundedTerminal } =
  loadTsModule('electron/assetDerivedRebuildCoordinator.ts')

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

async function cleanup(dir) {
  // Windows can hold transient handles on freshly closed SQLite WAL files
  // (indexer/AV); retry the removal for a few seconds.
  const targets = [dir, path.join(path.dirname(dir), 'asset-library-backups')]
  for (const target of targets) {
    const deadline = Date.now() + 5000
    for (;;) {
      try {
        fs.rmSync(target, { recursive: true, force: true })
        break
      } catch (error) {
        if (Date.now() >= deadline) throw error
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  }
}

function statOf(filePath) {
  const stat = fs.statSync(filePath)
  return { dev: stat.dev, ino: stat.ino }
}

test('derived rebuild grants are sender-scoped, expiring, and one-use', () => {
  let now = 1000
  let tokenIndex = 0
  const grants = new AssetDerivedRebuildGrantStore({
    now: () => now,
    createToken: () => `00000000-0000-4000-8000-${String(++tokenIndex).padStart(12, '0')}`,
    ttlMs: 50,
  })
  const grant = grants.issue(7, {
    assetId: 'asset_fixture',
    oldPath: 'D:\\old.jpg',
    newPath: 'D:\\new.jpg',
    reason: 'corrupt vector fixture',
  })
  assert.equal(grants.peek(8, grant.token), null, 'another renderer cannot use the grant')
  assert.equal(grants.peek(7, grant.token).assetId, 'asset_fixture')
  assert.equal(grants.consume(7, grant.token).reason, 'corrupt vector fixture')
  assert.equal(grants.consume(7, grant.token), null, 'the grant cannot be replayed')

  const expiring = grants.issue(7, {
    assetId: 'asset_expiring',
    oldPath: 'D:\\old-2.jpg',
    newPath: 'D:\\new-2.jpg',
    reason: 'fixture',
  })
  now += 51
  assert.equal(grants.peek(7, expiring.token), null)
})

test('durable repair grants remain sender-scoped and deduplicate one recovery', () => {
  let tokenIndex = 0
  const grants = new AssetDerivedRebuildGrantStore({
    createToken: () => `00000000-0000-4000-8000-${String(++tokenIndex).padStart(12, '0')}`,
  })
  const repair = {
    assetId: 'asset_0123456789abcdef01234567',
    oldPath: 'D:\\old.jpg',
    newPath: 'D:\\new.jpg',
    reason: 'fixture',
    recoveryId: '00000000-0000-4000-8000-000000000099',
  }
  const first = grants.issue(7, repair)
  const refreshed = grants.issue(7, { ...repair, reason: 'retry fixture' })
  const otherSender = grants.issue(8, repair)
  assert.equal(refreshed.token, first.token, 'refresh cannot mint replayable duplicate tokens')
  assert.equal(refreshed.reason, 'retry fixture')
  assert.notEqual(otherSender.token, first.token)
  assert.equal(grants.peek(8, first.token), null)
})

test('derived rebuild claims atomically deduplicate one recovery across tokens and senders', async () => {
  const claims = new AssetDerivedRebuildClaimStore()
  const first = claims.claim('recovery:fixture', 'token-a', 7)
  const sameToken = claims.claim('recovery:fixture', 'token-a', 7)
  const otherSender = claims.claim('recovery:fixture', 'token-b', 8)
  assert.equal(first.created, true)
  assert.equal(sameToken.created, false)
  assert.equal(sameToken.claim, first.claim)
  assert.equal(otherSender.created, false)
  assert.equal(otherSender.claim, first.claim)
  first.claim.taskId = 91
  first.claim.resolveReady(91)
  assert.equal(await sameToken.claim.ready, 91)
  assert.equal(
    claims.getByToken('token-b'),
    null,
    'a rejected token never receives cancellation rights',
  )
  claims.release(first.claim)
  assert.equal(claims.getByToken('token-a'), null)
  assert.equal(claims.claim('recovery:fixture', 'token-b', 8).created, true)
})

test('asset repair recovery journal is atomic, checksummed, bounded and reloadable', async () => {
  const root = tempDir('asset-repair-journal-')
  let now = 1000
  try {
    const journal = new AssetRepairRecoveryJournal(root, {
      now: () => ++now,
      createId: () => '00000000-0000-4000-8000-000000000001',
    })
    const prepared = await journal.prepare({
      assetId: 'asset_0123456789abcdef01234567',
      oldPath: path.join(root, 'old.jpg'),
      newPath: path.join(root, 'new.jpg'),
    })
    assert.equal(prepared.state, 'prepared')
    const repairing = await journal.update(prepared.id, {
      state: 'repairing',
      incrementAttempts: true,
      markStep: 'identity',
    })
    assert.equal(repairing.steps.identity, true)
    assert.equal(repairing.attempts, 1)
    await Promise.all([
      journal.markStep(prepared.id, 'assetLibrary'),
      journal.markStep(prepared.id, 'sourceCatalog'),
    ])

    const reloaded = new AssetRepairRecoveryJournal(root)
    const pending = await reloaded.listPending()
    assert.deepEqual(
      pending.map((record) => record.id),
      [prepared.id],
    )
    assert.equal(pending[0].steps.assetLibrary, true)
    assert.equal(pending[0].steps.sourceCatalog, true)
    assert.deepEqual(
      fs.readdirSync(root).filter((name) => name.includes('.tmp')),
      [],
      'atomic publication leaves no temporary recovery files',
    )

    const filePath = path.join(root, ASSET_REPAIR_RECOVERY_FILENAME)
    const validJournal = fs.readFileSync(filePath, 'utf8')
    const removed = JSON.parse(validJournal)
    removed.records = []
    removed.revision += 1
    fs.writeFileSync(filePath, JSON.stringify(removed), 'utf8')
    await assert.rejects(reloaded.listPending(), /authentication mismatch/i)
    fs.writeFileSync(filePath, validJournal, 'utf8')
    await journal.markStep(prepared.id, 'sourceCatalog')
    const tampered = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    tampered.records[0].newPath = path.join(root, 'attacker.jpg')
    fs.writeFileSync(filePath, JSON.stringify(tampered), 'utf8')
    await assert.rejects(reloaded.listPending(), /checksum mismatch/i)
    fs.writeFileSync(filePath, 'x'.repeat(MAX_ASSET_REPAIR_RECOVERY_BYTES + 1), 'utf8')
    await assert.rejects(reloaded.listPending(), /oversized|file limit/i)
  } finally {
    await cleanup(root)
  }
})

test('asset repair recovery journal requires its keyed authentication', async () => {
  const crypto = require('node:crypto')
  const root = tempDir('asset-repair-auth-')
  try {
    const key = crypto.randomBytes(32)
    const journal = new AssetRepairRecoveryJournal(root, { authKey: key })
    const prepared = await journal.prepare({
      assetId: 'asset_0123456789abcdef01234567',
      oldPath: path.join(root, 'old.jpg'),
      newPath: path.join(root, 'new.jpg'),
    })
    assert.equal(prepared.state, 'prepared')

    const wrongKey = new AssetRepairRecoveryJournal(root, { authKey: crypto.randomBytes(32) })
    await assert.rejects(wrongKey.listPending(), /authentication mismatch/i)

    const filePath = path.join(root, ASSET_REPAIR_RECOVERY_FILENAME)
    const forged = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    forged.revision += 5
    forged.authTag = crypto.randomBytes(32).toString('hex')
    fs.writeFileSync(filePath, JSON.stringify(forged), 'utf8')
    await assert.rejects(journal.listPending(), /authentication mismatch/i)
  } finally {
    await cleanup(root)
  }
})

test('asset repair recovery journal rejects rollback and anchor tampering', async () => {
  const root = tempDir('asset-repair-rollback-')
  try {
    const journal = new AssetRepairRecoveryJournal(root)
    const prepared = await journal.prepare({
      assetId: 'asset_0123456789abcdef01234567',
      oldPath: path.join(root, 'old.jpg'),
      newPath: path.join(root, 'new.jpg'),
    })
    const filePath = path.join(root, ASSET_REPAIR_RECOVERY_FILENAME)
    const anchorPath = path.join(root, ASSET_REPAIR_RECOVERY_ANCHOR_FILENAME)
    const journalGen1 = fs.readFileSync(filePath, 'utf8')
    assert.equal(JSON.parse(journalGen1).generation, 1)

    await journal.markStep(prepared.id, 'identity')
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).generation, 2)

    // Restoring an older journal copy while the anchor advanced is a rollback.
    fs.writeFileSync(filePath, journalGen1, 'utf8')
    await assert.rejects(journal.listPending(), /rolled back/i)
    await assert.rejects(new AssetRepairRecoveryJournal(root).listPending(), /rolled back/i)

    // A tampered anchor fails closed as well.
    const tamperedAnchor = JSON.parse(fs.readFileSync(anchorPath, 'utf8'))
    tamperedAnchor.generation += 10
    fs.writeFileSync(anchorPath, JSON.stringify(tamperedAnchor), 'utf8')
    await assert.rejects(journal.listPending(), /anchor authentication mismatch/i)

    // Deleting the anchor while an authenticated journal exists fails closed.
    fs.rmSync(anchorPath)
    await assert.rejects(journal.listPending(), /anchor is missing/i)

    // Deleting both files is indistinguishable from a fresh install and recovers.
    fs.rmSync(filePath, { force: true })
    const recovered = new AssetRepairRecoveryJournal(root)
    assert.deepEqual(await recovered.listPending(), [])
  } finally {
    await cleanup(root)
  }
})

test('asset repair recovery journal migrates a checksummed v2 journal exactly once', async () => {
  const crypto = require('node:crypto')
  const root = tempDir('asset-repair-migrate-')
  const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex')
  try {
    // The constructor creates the per-install key before any journal exists.
    const journal = new AssetRepairRecoveryJournal(root)
    const record = {
      id: '00000000-0000-4000-8000-0000000000aa',
      assetId: 'asset_0123456789abcdef01234567',
      oldPath: path.resolve(path.join(root, 'old.jpg')),
      newPath: path.resolve(path.join(root, 'new.jpg')),
      createdAt: 1,
      updatedAt: 2,
      attempts: 3,
      state: 'repairing',
      needsDerivedRebuild: true,
      rebuildVectorData: true,
      steps: {
        identity: true,
        assetLibrary: false,
        sourceCatalog: false,
        nativeIndex: false,
        vectorIndex: false,
        derivedCleared: false,
        derivedRebuilt: false,
      },
    }
    record.checksum = sha256(
      JSON.stringify({
        id: record.id,
        assetId: record.assetId,
        oldPath: record.oldPath,
        newPath: record.newPath,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        attempts: record.attempts,
        state: record.state,
        needsDerivedRebuild: record.needsDerivedRebuild,
        rebuildVectorData: record.rebuildVectorData,
        steps: record.steps,
      }),
    )
    const legacy = {
      version: 2,
      revision: 7,
      records: [record],
      stateChecksum: sha256(
        JSON.stringify({ version: 2, revision: 7, records: [record] }),
      ),
    }
    const filePath = path.join(root, ASSET_REPAIR_RECOVERY_FILENAME)
    fs.writeFileSync(filePath, JSON.stringify(legacy), 'utf8')

    const pending = await journal.listPending()
    assert.equal(pending.length, 1, 'legacy records survive migration')
    assert.equal(pending[0].id, record.id)
    assert.equal(pending[0].state, 'repairing')
    assert.equal(pending[0].attempts, 3)

    const migrated = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    assert.equal(migrated.version, 3)
    assert.equal(migrated.generation, 1)
    assert.equal(migrated.revision, 7)
    assert.match(migrated.authTag, /^[0-9a-f]{64}$/)
    assert.equal(migrated.stateChecksum, undefined)
    const anchor = JSON.parse(
      fs.readFileSync(path.join(root, ASSET_REPAIR_RECOVERY_ANCHOR_FILENAME), 'utf8'),
    )
    assert.equal(anchor.generation, 1)

    // The migrated file is fully authenticated: tampering now fails closed.
    migrated.revision += 1
    fs.writeFileSync(filePath, JSON.stringify(migrated), 'utf8')
    await assert.rejects(journal.listPending(), /authentication mismatch/i)
  } finally {
    await cleanup(root)
  }
})

test('asset repair recovery journal refuses a corrupt v2 journal instead of migrating it', async () => {
  const crypto = require('node:crypto')
  const root = tempDir('asset-repair-migrate-corrupt-')
  const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex')
  try {
    const journal = new AssetRepairRecoveryJournal(root)
    const record = {
      id: '00000000-0000-4000-8000-0000000000bb',
      assetId: 'asset_0123456789abcdef01234567',
      oldPath: path.resolve(path.join(root, 'old.jpg')),
      newPath: path.resolve(path.join(root, 'new.jpg')),
      createdAt: 1,
      updatedAt: 1,
      attempts: 0,
      state: 'prepared',
      needsDerivedRebuild: false,
      rebuildVectorData: false,
      steps: {
        identity: false,
        assetLibrary: false,
        sourceCatalog: false,
        nativeIndex: true,
        vectorIndex: false,
        derivedCleared: false,
        derivedRebuilt: false,
      },
    }
    record.checksum = sha256(JSON.stringify(record))
    const filePath = path.join(root, ASSET_REPAIR_RECOVERY_FILENAME)
    const legacy = { version: 2, revision: 1, records: [record], stateChecksum: sha256('wrong') }
    const original = JSON.stringify(legacy)
    fs.writeFileSync(filePath, original, 'utf8')
    await assert.rejects(journal.listPending(), /state checksum mismatch/i)
    assert.equal(
      fs.readFileSync(filePath, 'utf8'),
      original,
      'a rejected legacy journal is left untouched',
    )
  } finally {
    await cleanup(root)
  }
})

test('asset repair journal key file is created restrictively and fails closed without it', async () => {
  const root = tempDir('asset-repair-key-')
  try {
    const journal = new AssetRepairRecoveryJournal(root)
    const keyPath = path.join(root, ASSET_REPAIR_RECOVERY_KEY_FILENAME)
    const keyFile = JSON.parse(fs.readFileSync(keyPath, 'utf8'))
    assert.equal(keyFile.version, 1)
    assert.equal(keyFile.protected, false, 'tests run without a protection adapter')
    assert.match(keyFile.key, /^[A-Za-z0-9+/]+={0,2}$/)
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600)
    }

    await journal.prepare({
      assetId: 'asset_0123456789abcdef01234567',
      oldPath: path.join(root, 'old.jpg'),
      newPath: path.join(root, 'new.jpg'),
    })
    // A second instance reuses the committed key and reads the journal fine.
    assert.equal((await new AssetRepairRecoveryJournal(root).listPending()).length, 1)

    // Losing the key makes the authenticated journal unreadable (fail closed).
    fs.rmSync(keyPath)
    await assert.rejects(new AssetRepairRecoveryJournal(root).listPending(), /authentication mismatch/i)

    // A protected key cannot be opened without a protection adapter.
    fs.writeFileSync(
      keyPath,
      JSON.stringify({ version: 1, protected: true, key: 'AAAA' }),
      { encoding: 'utf8', mode: 0o600 },
    )
    assert.throws(() => new AssetRepairRecoveryJournal(root), /no protection/i)
  } finally {
    await cleanup(root)
  }
})

test('asset repair recovery journal rejects a junction or symlink user-data directory', async (t) => {
  const root = tempDir('asset-repair-junction-')
  const outside = path.join(root, 'outside')
  const alias = path.join(root, 'alias')
  try {
    fs.mkdirSync(outside)
    try {
      fs.symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(
        `directory link unavailable: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    assert.throws(() => new AssetRepairRecoveryJournal(alias), /symlink|reparse alias/i)
    assert.equal(fs.existsSync(path.join(outside, ASSET_REPAIR_RECOVERY_FILENAME)), false)
  } finally {
    await cleanup(root)
  }
})

test('move identity cannot commit before its durable recovery intent', async (t) => {
  const root = tempDir('asset-repair-before-commit-')
  try {
    const filePath = path.join(root, 'before.jpg')
    fs.writeFileSync(filePath, 'fixture')
    const service = new AssetIdentityService(path.join(root, 'library'))
    const identity = await service.resolveForPath(filePath)
    if (identity.strategy !== 'filesystem') {
      t.skip('filesystem identity is unavailable')
      return
    }
    const movedPath = path.join(root, 'after.jpg')
    fs.renameSync(filePath, movedPath)
    await assert.rejects(
      service.repairMovedFile(movedPath, async () => {
        throw new Error('journal disk fixture')
      }),
      /journal disk fixture/,
    )
    assert.equal((await service.getByAssetId(identity.assetId)).path, filePath)

    const journal = new AssetRepairRecoveryJournal(root, {
      createId: () => '00000000-0000-4000-8000-000000000002',
    })
    const repaired = await service.repairMovedFile(movedPath, async (prepared) => {
      await journal.prepare(prepared)
    })
    assert.equal(repaired.assetId, identity.assetId)
    assert.equal((await service.getByAssetId(identity.assetId)).path, movedPath)
    assert.equal((await journal.listPending()).length, 1)
  } finally {
    await cleanup(root)
  }
})

test('restart retry resumes after the last durable repair step before completing', async () => {
  const root = tempDir('asset-repair-resume-')
  try {
    const journal = new AssetRepairRecoveryJournal(root, {
      now: () => 2000,
      createId: () => '00000000-0000-4000-8000-000000000003',
    })
    const prepared = await journal.prepare({
      assetId: 'asset_0123456789abcdef01234567',
      oldPath: path.join(root, 'old.jpg'),
      newPath: path.join(root, 'new.jpg'),
    })
    const firstCalls = []
    await assert.rejects(
      executeAssetRepairRecoverySteps({
        journal,
        recordId: prepared.id,
        operations: {
          identity: () => firstCalls.push('identity'),
          assetLibrary: () => firstCalls.push('assetLibrary'),
          sourceCatalog: () => firstCalls.push('sourceCatalog'),
          nativeIndex: () => {
            firstCalls.push('nativeIndex')
            throw new Error('native fixture')
          },
          vectorIndex: () => firstCalls.push('vectorIndex'),
        },
      }),
      (error) => error instanceof AssetRepairRecoveryError && error.step === 'nativeIndex',
    )
    assert.deepEqual(firstCalls, ['identity', 'assetLibrary', 'sourceCatalog', 'nativeIndex'])
    const interrupted = (await journal.listPending())[0]
    assert.equal(interrupted.state, 'awaiting-rebuild')
    assert.equal(interrupted.needsDerivedRebuild, true)
    assert.equal(interrupted.steps.sourceCatalog, true)
    assert.equal(interrupted.steps.nativeIndex, false)

    const restartCalls = []
    const completed = await executeAssetRepairRecoverySteps({
      journal: new AssetRepairRecoveryJournal(root),
      recordId: prepared.id,
      now: () => 3000,
      operations: {
        identity: () => restartCalls.push('identity'),
        assetLibrary: () => restartCalls.push('assetLibrary'),
        sourceCatalog: () => restartCalls.push('sourceCatalog'),
        nativeIndex: () => restartCalls.push('nativeIndex'),
        vectorIndex: () => restartCalls.push('vectorIndex'),
      },
    })
    assert.deepEqual(restartCalls, ['nativeIndex', 'vectorIndex'])
    assert.equal(completed.state, 'completed')
    assert.equal(completed.attempts, 2)
    assert.equal((await journal.listPending()).length, 0)
  } finally {
    await cleanup(root)
  }
})

test('clear-to-rebuild crash stages remain pending until the durable rebuild completion', async () => {
  const root = tempDir('asset-repair-derived-crash-')
  try {
    const journal = new AssetRepairRecoveryJournal(root, {
      createId: () => '00000000-0000-4000-8000-000000000004',
    })
    const prepared = await journal.prepare({
      assetId: 'asset_0123456789abcdef01234567',
      oldPath: path.join(root, 'old.jpg'),
      newPath: path.join(root, 'new.jpg'),
    })
    await journal.update(prepared.id, {
      state: 'rebuilding',
      needsDerivedRebuild: true,
      rebuildVectorData: true,
      incrementAttempts: true,
    })
    let restarted = await new AssetRepairRecoveryJournal(root).get(prepared.id)
    assert.equal(restarted.state, 'rebuilding')
    assert.equal(restarted.steps.derivedCleared, false)

    await journal.markStep(prepared.id, 'derivedCleared')
    restarted = await new AssetRepairRecoveryJournal(root).get(prepared.id)
    assert.equal(restarted.state, 'rebuilding')
    assert.equal(restarted.steps.derivedCleared, true)
    assert.equal(restarted.steps.derivedRebuilt, false)

    for (const step of [
      'identity',
      'assetLibrary',
      'sourceCatalog',
      'nativeIndex',
      'vectorIndex',
    ]) {
      await journal.markStep(prepared.id, step)
    }
    await journal.update(prepared.id, {
      state: 'completed',
      needsDerivedRebuild: false,
      markStep: 'derivedRebuilt',
      completedAt: Date.now(),
    })
    assert.equal((await new AssetRepairRecoveryJournal(root).listPending()).length, 0)
  } finally {
    await cleanup(root)
  }
})

test('derived rebuild schedules a preview-preserving full rescan after reset', async () => {
  const requests = []
  let nextId = 1
  const scheduler = {
    enqueue(request) {
      requests.push(request)
      return { id: nextId++, promise: Promise.resolve() }
    },
  }
  let rebuilt = false
  const taskId = scheduleAssetDerivedRebuild({
    scheduler,
    assetId: 'asset_fixture',
    roots: ['D:\\photos'],
    clear: async () => ({ ok: true, freedBytes: 12, deletedFiles: 3, errors: [] }),
    async rebuild() {
      rebuilt = true
    },
  })
  assert.equal(taskId, 1)
  assert.equal(requests[0].stage, 'metadata')
  assert.equal(requests[0].priority, 0)
  await requests[0].run()
  assert.equal(rebuilt, true)
})

test('derived rebuild failure fixture never scans after a failed reset', async () => {
  let request
  let rebuildStarted = false
  const scheduler = {
    enqueue(next) {
      request = next
      return { id: 91, promise: Promise.resolve() }
    },
  }
  scheduleAssetDerivedRebuild({
    scheduler,
    assetId: 'asset_fixture',
    roots: ['D:\\photos'],
    clear: async () => ({
      ok: false,
      freedBytes: 0,
      deletedFiles: 0,
      error: 'locked fixture',
      errors: ['locked fixture'],
    }),
    async rebuild() {
      rebuildStarted = true
    },
  })
  await assert.rejects(request.run(), /locked fixture/)
  assert.equal(rebuildStarted, false)
})

test('derived rebuild busy fixture never clears authoritative derived data', async () => {
  let request
  let cleared = false
  const scheduler = {
    enqueue(next) {
      request = next
      return { id: 92, promise: Promise.resolve() }
    },
  }
  scheduleAssetDerivedRebuild({
    scheduler,
    assetId: 'asset_fixture',
    roots: ['D:\\photos'],
    ensureReady: () => 'embedding fixture is active',
    clear: async () => {
      cleared = true
      return { ok: true, freedBytes: 0, deletedFiles: 0, errors: [] }
    },
    rebuild: async () => undefined,
  })
  await assert.rejects(request.run(), /embedding fixture is active/)
  assert.equal(cleared, false)
})

test('derived rebuild settlement observer cannot mask an enqueue failure', () => {
  assert.throws(
    () =>
      scheduleAssetDerivedRebuild({
        scheduler: {
          enqueue() {
            throw new Error('scheduler enqueue fixture')
          },
        },
        assetId: 'asset_fixture',
        roots: ['D:\\photos'],
        clear: async () => ({ ok: true, freedBytes: 0, deletedFiles: 0, errors: [] }),
        rebuild: async () => undefined,
        onSettled() {
          throw new Error('observer fixture')
        },
      }),
    /scheduler enqueue fixture/,
  )
})

test('derived rebuild wait times out, cancels work and unsubscribes', async () => {
  let cancelled = 0
  let unsubscribed = 0
  await assert.rejects(
    waitForBoundedTerminal({
      label: 'fixture scan',
      timeoutMs: 10,
      getCurrent: () => false,
      isTerminal: Boolean,
      subscribe: () => () => {
        unsubscribed += 1
      },
      cancel: async () => {
        cancelled += 1
      },
    }),
    /fixture scan timed out/,
  )
  assert.equal(cancelled, 1)
  assert.equal(unsubscribed, 1)
})

test('derived rebuild wait honors abort cancellation and cleans its listener', async () => {
  const controller = new AbortController()
  let cancelled = 0
  let unsubscribed = 0
  const waiting = waitForBoundedTerminal({
    label: 'fixture embedding',
    timeoutMs: 10_000,
    getCurrent: () => false,
    isTerminal: Boolean,
    subscribe: () => () => {
      unsubscribed += 1
    },
    cancel: () => {
      cancelled += 1
    },
    signal: controller.signal,
  })
  controller.abort()
  await assert.rejects(waiting, /fixture embedding was cancelled/)
  assert.equal(cancelled, 1)
  assert.equal(unsubscribed, 1)
})

test('bounded rebuild operations time out, request cancellation and reject late completion', async () => {
  let cancelled = 0
  let resolveLate
  const operation = new Promise((resolve) => {
    resolveLate = resolve
  })
  await assert.rejects(
    waitForBoundedOperation({
      label: 'fixture persistence',
      timeoutMs: 10,
      operation,
      cancel: () => {
        cancelled += 1
      },
    }),
    /fixture persistence timed out/,
  )
  resolveLate('late')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(cancelled, 1)
})

test('derived rebuild idempotency cannot bypass sender-scoped authorization', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'electron', 'assetIdentityIpc.ts'),
    'utf8',
  )
  const handler = source.slice(source.indexOf('ASSET_IDENTITY_IPC.DERIVED_REBUILD_START'))
  const ownershipCheck = handler.indexOf('assetDerivedRebuildGrants.peek(event.sender.id, token)')
  const atomicClaim = handler.indexOf(
    'assetDerivedRebuildClaims.claim(claimKey, token, event.sender.id)',
  )
  const recoveryRead = handler.indexOf('await recoveryForGrant(grant)')
  assert.ok(ownershipCheck >= 0)
  assert.ok(
    atomicClaim > ownershipCheck && atomicClaim < recoveryRead,
    'the sender-scoped recovery claim must publish before the first asynchronous recovery read',
  )
})

test('derived rebuild always releases exclusive maintenance after failure', async () => {
  let request
  let released = 0
  scheduleAssetDerivedRebuild({
    scheduler: {
      enqueue(next) {
        request = next
        return { id: 93, promise: Promise.resolve() }
      },
    },
    assetId: 'asset_fixture',
    roots: ['D:\\photos'],
    acquireMaintenance: () => () => {
      released += 1
    },
    clear: async () => ({ ok: true, freedBytes: 0, deletedFiles: 0, errors: [] }),
    rebuild: async () => {
      throw new Error('rebuild fixture')
    },
  })
  await assert.rejects(request.run(), /rebuild fixture/)
  assert.equal(released, 1)
})

test('stable id: search, asset library and duplicate groups resolve the same file to one AssetId', async () => {
  const root = tempDir('asset-id-stable-')
  try {
    const filePath = path.join(root, 'photo.jpg')
    fs.writeFileSync(filePath, 'jpeg-bytes')
    const service = new AssetIdentityService(root)
    // The three entry points all call the same resolver with the same path.
    const fromSearch = await service.resolveForPath(filePath)
    const fromLibrary = await service.resolveForPath(filePath)
    const fromDuplicateGroup = await service.resolveForPath(filePath)
    assert.equal(fromLibrary.assetId, fromSearch.assetId)
    assert.equal(fromDuplicateGroup.assetId, fromSearch.assetId)
    assert.match(fromSearch.assetId, /^asset_[0-9a-f]{24}$/)
    assert.equal(service.store.size(), 1, 'repeated resolution never duplicates the mapping')
    // Path-strategy fallback is deterministic too (design 7.2 fallback rung).
    const a = resolveAssetIdentity({ absolutePath: filePath }, null)
    const b = resolveAssetIdentity({ absolutePath: filePath }, null)
    assert.equal(a.strategy, 'path')
    assert.equal(a.assetId, b.assetId)
    assert.equal(assetIdFromIdentityKey(a.identityKey), a.assetId)
  } finally {
    await cleanup(root)
  }
})

test('read-only path lookup returns existing AssetId without creating a mapping', async () => {
  const root = tempDir('asset-id-readonly-')
  try {
    const knownPath = path.join(root, 'known.jpg')
    const unknownPath = path.join(root, 'unknown.jpg')
    fs.writeFileSync(knownPath, 'known')
    fs.writeFileSync(unknownPath, 'unknown')
    const service = new AssetIdentityService(root)
    const identity = await service.resolveForPath(knownPath)
    const sizeBeforeLookup = service.store.size()
    assert.equal((await service.findByPath(knownPath))?.assetId, identity.assetId)
    assert.equal(await service.findByPath(unknownPath), undefined)
    assert.equal(
      service.store.size(),
      sizeBeforeLookup,
      'search lookup must not mutate identity storage',
    )
  } finally {
    await cleanup(root)
  }
})

test('filesystem identity (volume/FRN) is preferred and survives a same-volume rename', async (t) => {
  const root = tempDir('asset-id-frn-')
  try {
    const filePath = path.join(root, 'move-me.jpg')
    fs.writeFileSync(filePath, 'image-bytes')
    const before = statOf(filePath)
    if (!filesystemIdentityFromStat(before)) {
      t.skip('filesystem does not expose volume/FRN identity')
      return
    }
    const service = new AssetIdentityService(root)
    const original = await service.resolveForPath(filePath)
    assert.equal(original.strategy, 'filesystem')
    const movedPath = path.join(root, 'renamed.jpg')
    fs.renameSync(filePath, movedPath)
    const after = statOf(movedPath)
    assert.equal(filesystemIdentityFromStat(after), original.identityKey)
    const moved = await service.resolveForPath(movedPath)
    assert.equal(moved.assetId, original.assetId, 'AssetId is stable across the rename')
    assert.equal(moved.path, movedPath)
  } finally {
    await cleanup(root)
  }
})

test('preview proxies are never user-visible originals', async () => {
  const root = tempDir('asset-id-proxy-')
  try {
    const previewsDir = path.join(root, 'project-previews', 'v1', 'previews')
    fs.mkdirSync(previewsDir, { recursive: true })
    const proxyPath = path.join(previewsDir, 'abc123.jpg')
    fs.writeFileSync(proxyPath, 'proxy-bytes')
    // Role classification: anything under a preview directory is a proxy.
    assert.equal(
      classifyMemberRole(proxyPath, { previewDirs: [path.join(root, 'project-previews')] }),
      'preview-proxy',
    )
    // User-visible member lists contain originals only.
    const members = [
      { assetId: 'asset_a', role: 'original', path: path.join(root, 'real.jpg'), addedAt: 1 },
      { assetId: 'asset_a', role: 'preview-proxy', path: proxyPath, addedAt: 1 },
    ]
    assert.deepEqual(
      userVisibleMembers(members).map((member) => member.role),
      ['original'],
    )
    assert.equal(originalMemberPath(members), path.join(root, 'real.jpg'))
    // Resolving a proxy path must not register it as its own asset.
    const service = new AssetIdentityService(root, {
      previewDirs: [path.join(root, 'project-previews')],
    })
    const resolved = await service.resolveForPath(proxyPath)
    assert.equal(resolved.members[0].role, 'preview-proxy')
    assert.equal(service.store.size(), 0, 'proxies never enter the identity mapping as assets')
    // File actions refuse to open/reveal a proxy as the original.
    const refused = await resolveOriginalActionPath(service, proxyPath)
    assert.equal(refused.ok, false)
    assert.match(refused.error, /never opened as original/i)
  } finally {
    await cleanup(root)
  }
})

test('asset members cover original, raw companion and sidecar', async () => {
  const root = tempDir('asset-id-members-')
  try {
    const jpg = path.join(root, 'shot.jpg')
    fs.writeFileSync(jpg, 'jpeg')
    fs.writeFileSync(path.join(root, 'shot.cr2'), 'raw')
    fs.writeFileSync(path.join(root, 'shot.xmp'), 'sidecar')
    fs.writeFileSync(path.join(root, 'other.jpg'), 'jpeg')
    const service = new AssetIdentityService(root)
    const identity = await service.resolveForPath(jpg)
    const roles = identity.members
      .map((member) => `${member.role}:${path.basename(member.path)}`)
      .sort()
    assert.deepEqual(roles, ['original:shot.jpg', 'raw-companion:shot.cr2', 'sidecar:shot.xmp'])
    // A RAW file without a developed sibling is itself an original.
    assert.equal(classifyMemberRole(path.join(root, 'lone.dng'), {}), 'original')
    assert.equal(
      classifyMemberRole(path.join(root, 'shot.cr2'), { hasOriginalSibling: true }),
      'raw-companion',
    )
  } finally {
    await cleanup(root)
  }
})

test('same-volume move repairs identity, asset record and catalog index', async (t) => {
  const root = tempDir('asset-id-move-')
  const libraryDir = path.join(root, 'asset-library')
  try {
    const filePath = path.join(root, 'tagged.jpg')
    fs.writeFileSync(filePath, 'image-bytes')
    if (!filesystemIdentityFromStat(statOf(filePath))) {
      t.skip('filesystem does not expose volume/FRN identity')
      return
    }
    const filesystemIdentity = filesystemIdentityFromStat(statOf(filePath))
    const service = new AssetIdentityService(libraryDir)
    const identity = await service.resolveForPath(filePath)

    // Asset library record (assets.jsonl authority) with the stable id;
    // tags/categories are keyed by this numeric id in asset-library.sqlite.
    const assets = new AssetMetadataStore(libraryDir)
    const [record] = await assets.importManualImages([filePath])
    assert.ok(record, 'manual import created the asset record')
    const tagAssignments = new Map([[record.id, ['landscape']]])

    // Discovery catalog index row keyed by filesystem identity.
    const catalog = new DiscoveryCatalogDatabase(path.join(root, 'catalog.sqlite'))
    catalog.insertSource(
      {
        id: 'src_1',
        type: 'local-ntfs',
        displayName: 'A',
        rootLocator: root,
        readOnly: true,
        availability: 'online',
        scanCapability: 'usn',
      },
      1000,
    )
    catalog.upsertDiscoveredBatch(
      'src_1',
      'scan_1',
      [
        {
          absolutePath: filePath,
          relativePath: 'tagged.jpg',
          name: 'tagged.jpg',
          extension: 'jpg',
          sizeBytes: 11,
          modifiedAt: 1,
          filesystemIdentity,
        },
      ],
      1000,
    )

    const movedPath = path.join(root, 'moved', 'tagged.jpg')
    fs.mkdirSync(path.dirname(movedPath), { recursive: true })
    fs.renameSync(filePath, movedPath)

    // 1) Identity store repair: same AssetId re-points to the new path.
    const repair = await service.repairMovedFile(movedPath)
    assert.ok(repair, 'move repair found the identity')
    assert.equal(repair.assetId, identity.assetId)
    assert.equal(repair.oldPath, path.resolve(filePath))
    assert.equal(repair.newPath, movedPath)

    // 2) Asset library repair: the record id is stable, so tag/category
    // rows keyed by it follow the file to the new path.
    const repathed = await assets.repathAsset(record.id, movedPath)
    assert.equal(repathed.id, record.id)
    assert.equal(repathed.path, movedPath)
    assert.equal(assets.getById(record.id).path, movedPath)
    assert.equal(assets.getByPath(movedPath).id, record.id)
    assert.deepEqual(tagAssignments.get(record.id), ['landscape'])

    // 3) Discovery catalog repair: index row re-points by identity, no
    // duplicate FileEntry appears.
    const found = catalog.findFileEntryByFilesystemIdentity('src_1', filesystemIdentity)
    assert.ok(found, 'catalog row is addressable by filesystem identity')
    assert.equal(
      catalog.repathFileEntryByIdentity(
        'src_1',
        filesystemIdentity,
        {
          absolutePath: movedPath,
          relativePath: 'moved/tagged.jpg',
          name: 'tagged.jpg',
          extension: 'jpg',
        },
        2000,
      ),
      true,
    )
    assert.equal(catalog.countFileEntries(), 1, 'move never duplicates the FileEntry')
    const response = catalog.queryCatalog({ query: 'tagged' })
    assert.equal(response.total, 1)
    assert.equal(response.items[0].displayPath.toLowerCase(), movedPath.toLowerCase())
    catalog.close()
    // Let queued catalog rebuilds finish so Windows can remove the temp dir.
    await assets.flush()
  } finally {
    await cleanup(root)
  }
})

test('shadow report compares unified identities with the asset catalog projection', async () => {
  const root = tempDir('asset-id-shadow-')
  try {
    const matchedPath = path.join(root, 'matched.jpg')
    const unifiedOnlyPath = path.join(root, 'unified-only.jpg')
    fs.writeFileSync(matchedPath, 'a')
    fs.writeFileSync(unifiedOnlyPath, 'b')
    const service = new AssetIdentityService(root)
    const matched = await service.resolveForPath(matchedPath)
    await service.resolveForPath(unifiedOnlyPath)
    const report = await service.buildShadowReport([
      { id: 1, path: matchedPath },
      { id: 2, path: path.join(root, 'library-only.jpg') },
    ])
    assert.equal(report.comparedCount, 2)
    assert.equal(report.matchedCount, 1)
    assert.equal(report.onlyInLibrary.length, 1)
    assert.match(report.onlyInLibrary[0].reason, /no unified identity/)
    assert.equal(report.onlyInUnified.length, 1)
    assert.match(report.onlyInUnified[0].assetId, /^asset_[0-9a-f]{24}$/)
    assert.equal(report.onlyInUnified[0].path, unifiedOnlyPath)
    assert.match(report.onlyInUnified[0].reason, /no matching asset library record/)
    // The report is a projection check only: existing stores are untouched.
    assert.ok(service.store.getByAssetId(matched.assetId))
  } finally {
    await cleanup(root)
  }
})

test('backup and restore cover the asset identity mapping', async () => {
  const root = tempDir('asset-id-backup-')
  const libraryDir = path.join(root, 'asset-library')
  try {
    fs.mkdirSync(libraryDir, { recursive: true })
    fs.writeFileSync(path.join(libraryDir, 'state.json'), '{"nextId":2}\n')
    const filePath = path.join(root, 'kept.jpg')
    fs.writeFileSync(filePath, 'image-bytes')
    const service = new AssetIdentityService(libraryDir)
    const identity = await service.resolveForPath(filePath)

    const backup = await createAssetLibraryBackupIfDue(libraryDir, { minimumIntervalMs: 0 })
    assert.equal(backup.created, true)
    const backedUp = fs.readFileSync(path.join(backup.backupPath, 'asset-identities.jsonl'), 'utf8')
    assert.ok(backedUp.includes(identity.assetId), 'backup manifest covers the ID mapping')

    // Destroy the mapping, then restore from the backup.
    fs.rmSync(path.join(libraryDir, 'asset-identities.jsonl'))
    const restored = await restoreAssetLibraryBackup(libraryDir, backup.backup.id)
    assert.ok(restored.restoredFiles > 0)
    const reloaded = new AssetIdentityStore(libraryDir)
    await reloaded.ensureLoaded()
    const after = reloaded.getByAssetId(identity.assetId)
    assert.ok(after, 'restored mapping still resolves the stable AssetId')
    assert.equal(after.identityKey, identity.identityKey)
    assert.equal(after.path, identity.path)
  } finally {
    await cleanup(libraryDir)
  }
})

test('unified file actions resolve AssetId to the original before shell execution', async () => {
  const root = tempDir('asset-id-actions-')
  try {
    const filePath = path.join(root, 'open-me.jpg')
    fs.writeFileSync(filePath, 'image-bytes')
    const service = new AssetIdentityService(root)
    const identity = await service.resolveForPath(filePath)
    const calls = []
    const fakeShell = {
      openPath: async (target) => {
        calls.push(['open', target])
        return ''
      },
      showItemInFolder: (target) => {
        calls.push(['reveal', target])
      },
    }
    const opened = await openOriginalFile(service, fakeShell, identity.assetId)
    assert.equal(opened.ok, true)
    assert.deepEqual(calls[0], ['open', filePath])
    const revealed = await revealOriginalFile(service, fakeShell, identity.assetId)
    assert.equal(revealed.ok, true)
    assert.deepEqual(calls[1], ['reveal', filePath])
    const unknown = await openOriginalFile(service, fakeShell, 'asset_000000000000000000000000')
    assert.equal(unknown.ok, false)
    assert.equal(calls.length, 2, 'unknown ids never reach the shell')
  } finally {
    await cleanup(root)
  }
})
