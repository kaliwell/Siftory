const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const outbox = loadTsModule('electron/sourceVectorInvalidationOutbox.ts')
const imageSearchData = loadTsModule('electron/imageSearchDataService.ts')

async function withTempVectorDb(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-vector-outbox-'))
  const vectorDbDir = path.join(root, 'vector-db')
  const indexRoot = path.join(root, 'native-index')
  const alternateIndexRoot = path.join(root, 'alternate-native-index')
  try {
    await fs.mkdir(indexRoot, { recursive: true })
    await fs.mkdir(alternateIndexRoot, { recursive: true })
    const indexIdentity = await outbox.resolveSourceVectorInvalidationIndexIdentity(indexRoot)
    const alternateIndexIdentity =
      await outbox.resolveSourceVectorInvalidationIndexIdentity(alternateIndexRoot)
    await run({
      root,
      vectorDbDir,
      indexRoot,
      indexIdentity,
      alternateIndexRoot,
      alternateIndexIdentity,
    })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

function entry(nativePath, ...vectorPaths) {
  return { nativePath, vectorPaths }
}

function legacyFingerprint(layers, entries) {
  const pathKey = (value) => value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  const stable = entries.map((item) => ({
    nativePath: pathKey(item.nativePath),
    vectorPaths: item.vectorPaths.map(pathKey).sort(),
  }))
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ layers: [...layers].sort(), entries: stable }), 'utf8')
    .digest('hex')
}

test('image data service binds recovery to the captured loaded index identity', async () => {
  await withTempVectorDb(async ({ root, vectorDbDir, indexRoot, indexIdentity }) => {
    const addon = {
      getIndexMode: () => ({ manifestPath: indexRoot, segmentPath: indexRoot }),
    }
    const service = imageSearchData.createImageSearchDataService({
      getNativeAddon: () => addon,
      getDefaultSavePath: () => indexRoot,
      getDefaultVectorDatabasePath: () => vectorDbDir,
      getSegmentPath: () => indexRoot,
      invalidateIndexModeCache: () => {},
      setEditPersistRetryPending: () => {},
      recordPersistedIndex: () => {},
    })

    await service.captureLoadedIndexIdentity(indexRoot)
    const detachedRoot = path.join(root, 'detached-native-index')
    await fs.rename(indexRoot, detachedRoot)
    await fs.mkdir(indexRoot)
    const replacementIdentity = await outbox.resolveSourceVectorInvalidationIndexIdentity(indexRoot)
    assert.notEqual(replacementIdentity.ino, indexIdentity.ino)

    await service.prepareImageSearchSourceVectorInvalidation(['D:\\Images\\missing.jpg'])
    const state = JSON.parse(
      await fs.readFile(
        path.join(vectorDbDir, outbox.SOURCE_VECTOR_INVALIDATION_OUTBOX_FILENAME),
        'utf8',
      ),
    )
    assert.deepEqual(state.intents[0].indexIdentity, indexIdentity)

    service.clearLoadedIndexIdentity()
    await assert.rejects(
      service.prepareImageSearchSourceVectorInvalidation(['D:\\Images\\other.jpg']),
      /Loaded image index identity is unavailable/,
    )
  })
})

test('image data service rejects a directory replacement between load snapshot and capture', async () => {
  await withTempVectorDb(async ({ root, vectorDbDir, indexRoot }) => {
    const addon = {
      getIndexMode: () => ({ manifestPath: indexRoot, segmentPath: indexRoot }),
    }
    const service = imageSearchData.createImageSearchDataService({
      getNativeAddon: () => addon,
      getDefaultSavePath: () => indexRoot,
      getDefaultVectorDatabasePath: () => vectorDbDir,
      getSegmentPath: () => indexRoot,
      invalidateIndexModeCache: () => {},
      setEditPersistRetryPending: () => {},
      recordPersistedIndex: () => {},
    })

    const before = await service.resolveIndexIdentity(indexRoot)
    await fs.rename(indexRoot, path.join(root, 'replaced-during-load'))
    await fs.mkdir(indexRoot)
    await assert.rejects(
      service.captureLoadedIndexIdentity(indexRoot, before),
      /directory changed while the Native index was loading or saving/,
    )
    await assert.rejects(
      service.prepareImageSearchSourceVectorInvalidation(['D:\\Images\\missing.jpg']),
      /Loaded image index identity is unavailable/,
    )
  })
})

test('image data service treats intents for another index as deferred diagnostics, not active failure', async () => {
  await withTempVectorDb(async ({ vectorDbDir, indexRoot, indexIdentity }) => {
    const now = Date.now()
    const entries = [entry('D:\\Images\\legacy.jpg', 'D:\\Images\\legacy.jpg')]
    await fs.mkdir(vectorDbDir, { recursive: true })
    await fs.writeFile(
      outbox.sourceVectorInvalidationOutboxPath(vectorDbDir),
      JSON.stringify({
        version: 1,
        revision: 1,
        intents: [
          {
            id: crypto.randomUUID(),
            fingerprint: legacyFingerprint(['clip', 'dino'], entries),
            createdAt: now,
            updatedAt: now,
            attempts: 0,
            layers: ['clip', 'dino'],
            entries,
          },
        ],
      }),
      'utf8',
    )
    const addon = {
      getIndexMode: () => ({ manifestPath: indexRoot, segmentPath: indexRoot }),
      hasIndexPath: () => {
        throw new Error('deferred intents must not probe the active Native index')
      },
    }
    const service = imageSearchData.createImageSearchDataService({
      getNativeAddon: () => addon,
      getDefaultSavePath: () => indexRoot,
      getDefaultVectorDatabasePath: () => vectorDbDir,
      getSegmentPath: () => indexRoot,
      invalidateIndexModeCache: () => {},
      setEditPersistRetryPending: () => {},
      recordPersistedIndex: () => {},
    })
    await service.captureLoadedIndexIdentity(indexRoot, indexIdentity)
    const result = await service.reconcileImageSearchSourceVectorInvalidations()
    assert.equal(result.ok, true)
    assert.equal(result.pendingIntents, 1)
    assert.equal(result.activePendingIntents, 0)
    assert.equal(result.deferredIntents, 1)
  })
})

test('prepare is atomic, bounded and idempotent for an equivalent intent', async () => {
  await withTempVectorDb(async ({ vectorDbDir, indexIdentity }) => {
    const entries = [
      entry('D:\\Images\\A.jpg', 'D:\\Images\\A.jpg'),
      entry('d:/images/a.jpg', 'd:/images/a.jpg'),
      entry('D:\\Images\\B.jpg', 'D:\\Images\\B.jpg', 'D:\\Previews\\B.png'),
    ]
    const [first, duplicate] = await Promise.all([
      outbox.prepareSourceVectorInvalidationIntent({
        vectorDbDir,
        indexIdentity,
        entries,
        now: 100,
      }),
      outbox.prepareSourceVectorInvalidationIntent({
        vectorDbDir,
        indexIdentity,
        entries,
        now: 101,
      }),
    ])
    assert.equal(duplicate.id, first.id)
    assert.equal(first.entries.length, 2)
    assert.deepEqual(first.layers, ['clip', 'dino'])

    const status = await outbox.getSourceVectorInvalidationOutboxStatus(vectorDbDir)
    assert.deepEqual(status, { intents: 1, entries: 2, oldestCreatedAt: 100 })
    const directory = await fs.readdir(vectorDbDir)
    assert.deepEqual(directory, [outbox.SOURCE_VECTOR_INVALIDATION_OUTBOX_FILENAME])

    await assert.rejects(
      outbox.prepareSourceVectorInvalidationIntent({
        vectorDbDir,
        indexIdentity,
        entries: [entry(`D:\\${'x'.repeat(33 * 1024)}`, 'D:\\x.jpg')],
      }),
      /Invalid source-vector invalidation Native path/,
    )
    assert.equal((await outbox.getSourceVectorInvalidationOutboxStatus(vectorDbDir)).intents, 1)
  })
})

test('reconcile invalidates only paths absent from the persisted Native index', async () => {
  await withTempVectorDb(async ({ vectorDbDir, indexIdentity }) => {
    await outbox.prepareSourceVectorInvalidationIntent({
      vectorDbDir,
      indexIdentity,
      entries: [
        entry('D:\\Images\\committed.jpg', 'D:\\Images\\committed.jpg'),
        entry('D:\\Images\\rolled-back.jpg', 'D:\\Images\\rolled-back.jpg'),
      ],
    })
    const calls = []
    const result = await outbox.reconcileSourceVectorInvalidationOutbox({
      vectorDbDir,
      indexIdentity,
      hasIndexPath: (nativePath) => /rolled-back/i.test(nativePath),
      invalidatePaths: async (vectorPaths, layers) => {
        calls.push({ vectorPaths: [...vectorPaths], layers: [...layers] })
      },
    })

    assert.equal(result.completedIntents, 1)
    assert.equal(result.activePendingIntents, 0)
    assert.equal(result.deferredIntents, 0)
    assert.equal(result.pendingIntents, 0)
    assert.equal(result.invalidatedEntries, 1)
    assert.equal(result.invalidatedVectorPaths, 1)
    assert.equal(result.discardedUncommittedEntries, 1)
    assert.deepEqual(calls, [
      {
        vectorPaths: ['D:\\Images\\committed.jpg'],
        layers: ['clip', 'dino'],
      },
    ])
    assert.deepEqual(await outbox.getSourceVectorInvalidationOutboxStatus(vectorDbDir), {
      intents: 0,
      entries: 0,
    })
  })
})

test('probe failures stay pending and replay after Native becomes authoritative', async () => {
  await withTempVectorDb(async ({ vectorDbDir, indexIdentity }) => {
    await outbox.prepareSourceVectorInvalidationIntent({
      vectorDbDir,
      indexIdentity,
      entries: [entry('D:\\Images\\probe.jpg', 'D:\\Images\\probe.jpg')],
      layers: ['dino'],
      now: 200,
    })
    let invalidations = 0
    const first = await outbox.reconcileSourceVectorInvalidationOutbox({
      vectorDbDir,
      indexIdentity,
      hasIndexPath: () => {
        throw new Error('Native index not loaded')
      },
      invalidatePaths: async () => {
        invalidations += 1
      },
      now: 201,
    })
    assert.equal(first.pendingIntents, 1)
    assert.equal(first.activePendingIntents, 1)
    assert.equal(first.deferredIntents, 0)
    assert.equal(first.probeFailures, 1)
    assert.equal(invalidations, 0)
    assert.match(
      (await outbox.getSourceVectorInvalidationOutboxStatus(vectorDbDir)).lastError,
      /Native index not loaded/,
    )

    const second = await outbox.reconcileSourceVectorInvalidationOutbox({
      vectorDbDir,
      indexIdentity,
      hasIndexPath: () => false,
      invalidatePaths: async () => {
        invalidations += 1
      },
      now: 202,
    })
    assert.equal(second.pendingIntents, 0)
    assert.equal(second.invalidatedEntries, 1)
    assert.equal(invalidations, 1)
  })
})

test('partial invalidation failure retains the full committed set for idempotent retry', async () => {
  await withTempVectorDb(async ({ vectorDbDir, indexIdentity }) => {
    await outbox.prepareSourceVectorInvalidationIntent({
      vectorDbDir,
      indexIdentity,
      entries: [
        entry('D:\\Images\\one.jpg', 'D:\\Images\\one.jpg'),
        entry('D:\\Images\\two.jpg', 'D:\\Images\\two.jpg', 'D:\\Preview\\two.png'),
      ],
    })
    const calls = []
    const first = await outbox.reconcileSourceVectorInvalidationOutbox({
      vectorDbDir,
      indexIdentity,
      hasIndexPath: () => false,
      invalidatePaths: async (vectorPaths) => {
        calls.push([...vectorPaths])
        throw new Error('CLIP shard failed after DINO committed')
      },
    })
    assert.equal(first.pendingIntents, 1)
    assert.equal(first.activePendingIntents, 1)
    assert.equal(first.deferredIntents, 0)
    assert.equal(first.invalidatedEntries, 0)
    assert.equal((await outbox.getSourceVectorInvalidationOutboxStatus(vectorDbDir)).entries, 2)

    const second = await outbox.reconcileSourceVectorInvalidationOutbox({
      vectorDbDir,
      indexIdentity,
      hasIndexPath: () => false,
      invalidatePaths: async (vectorPaths) => {
        calls.push([...vectorPaths])
      },
    })
    assert.equal(second.pendingIntents, 0)
    assert.equal(second.invalidatedEntries, 2)
    assert.deepEqual(calls[1], calls[0], 'the complete logical set is safe to replay')
  })
})

test('partial replay persists a smaller authenticated intent and retries only remaining entries', async () => {
  for (const scenario of ['probe-error', 'invalidation-error']) {
    await withTempVectorDb(async ({ vectorDbDir, indexIdentity }) => {
      const firstPath = 'D:\\Images\\first.jpg'
      const pendingPath = 'D:\\Images\\pending.jpg'
      await outbox.prepareSourceVectorInvalidationIntent({
        vectorDbDir,
        indexIdentity,
        entries: [entry(firstPath, firstPath), entry(pendingPath, pendingPath)],
      })
      const first = await outbox.reconcileSourceVectorInvalidationOutbox({
        vectorDbDir,
        indexIdentity,
        hasIndexPath: (nativePath) => {
          if (scenario === 'probe-error' && nativePath === pendingPath)
            throw new Error('probe unavailable')
          return scenario === 'invalidation-error' && nativePath === firstPath
        },
        invalidatePaths: async () => {
          if (scenario === 'invalidation-error') throw new Error('vector write unavailable')
        },
      })
      assert.equal(first.pendingIntents, 1)
      const state = JSON.parse(
        await fs.readFile(outbox.sourceVectorInvalidationOutboxPath(vectorDbDir), 'utf8'),
      )
      assert.equal(state.intents[0].attempts, 1)
      assert.deepEqual(
        state.intents[0].entries.map((item) => item.nativePath),
        [pendingPath],
      )
      assert.match(
        (await outbox.getSourceVectorInvalidationOutboxStatus(vectorDbDir)).lastError,
        /unavailable/,
      )
      const replayed = []
      const second = await outbox.reconcileSourceVectorInvalidationOutbox({
        vectorDbDir,
        indexIdentity,
        hasIndexPath: () => false,
        invalidatePaths: async (paths) => replayed.push(...paths),
      })
      assert.equal(second.pendingIntents, 0)
      assert.deepEqual(replayed, [pendingPath])
    })
  }
})

test('explicit discard removes a proven uncommitted intent', async () => {
  await withTempVectorDb(async ({ vectorDbDir, indexIdentity }) => {
    const intent = await outbox.prepareSourceVectorInvalidationIntent({
      vectorDbDir,
      indexIdentity,
      entries: [entry('D:\\Images\\rollback.jpg', 'D:\\Images\\rollback.jpg')],
    })
    assert.equal(await outbox.discardSourceVectorInvalidationIntent(vectorDbDir, intent.id), true)
    assert.equal(await outbox.discardSourceVectorInvalidationIntent(vectorDbDir, intent.id), false)
    assert.equal((await outbox.getSourceVectorInvalidationOutboxStatus(vectorDbDir)).intents, 0)
  })
})

test('an index directory replacement at the same root is deferred until the original identity returns', async () => {
  await withTempVectorDb(async ({ root, vectorDbDir, indexRoot, indexIdentity }) => {
    await outbox.prepareSourceVectorInvalidationIntent({
      vectorDbDir,
      indexIdentity,
      entries: [entry('D:\\Images\\bound.jpg', 'D:\\Images\\bound.jpg')],
    })

    const originalRoot = path.join(root, 'original-native-index')
    await fs.rename(indexRoot, originalRoot)
    await fs.mkdir(indexRoot)
    const replacementIdentity = await outbox.resolveSourceVectorInvalidationIndexIdentity(indexRoot)
    assert.equal(replacementIdentity.canonicalRoot, indexIdentity.canonicalRoot)
    assert.notEqual(replacementIdentity.ino, indexIdentity.ino)

    let probes = 0
    let invalidations = 0
    const deferred = await outbox.reconcileSourceVectorInvalidationOutbox({
      vectorDbDir,
      indexIdentity: replacementIdentity,
      hasIndexPath: () => {
        probes += 1
        return false
      },
      invalidatePaths: async () => {
        invalidations += 1
      },
    })
    assert.equal(deferred.pendingIntents, 1)
    assert.equal(deferred.processedIntents, 0)
    assert.equal(deferred.activePendingIntents, 0)
    assert.equal(deferred.deferredIntents, 1)
    assert.equal(probes, 0)
    assert.equal(invalidations, 0)

    await fs.rm(indexRoot, { recursive: true })
    await fs.rename(originalRoot, indexRoot)
    const restoredIdentity = await outbox.resolveSourceVectorInvalidationIndexIdentity(indexRoot)
    assert.deepEqual(restoredIdentity, indexIdentity)
    const completed = await outbox.reconcileSourceVectorInvalidationOutbox({
      vectorDbDir,
      indexIdentity: restoredIdentity,
      hasIndexPath: () => false,
      invalidatePaths: async () => {
        invalidations += 1
      },
    })
    assert.equal(completed.pendingIntents, 0)
    assert.equal(completed.completedIntents, 1)
    assert.equal(invalidations, 1)
  })
})

test('a restart on a different default root defers the old intent and identity participates in deduplication', async () => {
  await withTempVectorDb(async ({ vectorDbDir, indexIdentity, alternateIndexIdentity }) => {
    const entries = [entry('D:\\Images\\restart.jpg', 'D:\\Images\\restart.jpg')]
    const first = await outbox.prepareSourceVectorInvalidationIntent({
      vectorDbDir,
      indexIdentity,
      entries,
    })

    let probes = 0
    const afterRestart = await outbox.reconcileSourceVectorInvalidationOutbox({
      vectorDbDir,
      indexIdentity: alternateIndexIdentity,
      hasIndexPath: () => {
        probes += 1
        return false
      },
      invalidatePaths: async () => assert.fail('wrong-root intent must not be invalidated'),
    })
    assert.equal(afterRestart.pendingIntents, 1)
    assert.equal(afterRestart.processedIntents, 0)
    assert.equal(afterRestart.activePendingIntents, 0)
    assert.equal(afterRestart.deferredIntents, 1)
    assert.equal(probes, 0)

    const alternate = await outbox.prepareSourceVectorInvalidationIntent({
      vectorDbDir,
      indexIdentity: alternateIndexIdentity,
      entries,
    })
    assert.notEqual(alternate.id, first.id)
    assert.notEqual(alternate.fingerprint, first.fingerprint)
    assert.equal((await outbox.getSourceVectorInvalidationOutboxStatus(vectorDbDir)).intents, 2)

    const restored = await outbox.reconcileSourceVectorInvalidationOutbox({
      vectorDbDir,
      indexIdentity,
      hasIndexPath: () => false,
      invalidatePaths: async () => {},
    })
    assert.equal(restored.completedIntents, 1)
    assert.equal(restored.pendingIntents, 1)
    assert.equal(restored.deferredIntents, 1)
  })
})

test('malicious or non-canonical identity metadata is rejected before any Native probe', async () => {
  await withTempVectorDb(async ({ vectorDbDir, indexIdentity }) => {
    await assert.rejects(
      outbox.prepareSourceVectorInvalidationIntent({
        vectorDbDir,
        indexIdentity: { ...indexIdentity, dev: '-1' },
        entries: [entry('D:\\Images\\evil.jpg', 'D:\\Images\\evil.jpg')],
      }),
      /index device/,
    )
    await assert.rejects(
      outbox.prepareSourceVectorInvalidationIntent({
        vectorDbDir,
        indexIdentity: { ...indexIdentity, ino: `0${indexIdentity.ino}` },
        entries: [entry('D:\\Images\\evil.jpg', 'D:\\Images\\evil.jpg')],
      }),
      /index inode: value is not canonical/,
    )

    await outbox.prepareSourceVectorInvalidationIntent({
      vectorDbDir,
      indexIdentity,
      entries: [entry('D:\\Images\\evil.jpg', 'D:\\Images\\evil.jpg')],
    })
    const filePath = outbox.sourceVectorInvalidationOutboxPath(vectorDbDir)
    const state = JSON.parse(await fs.readFile(filePath, 'utf8'))
    state.intents[0].indexIdentity.realPath = `${indexIdentity.realPath}\0escape`
    await fs.writeFile(filePath, JSON.stringify(state), 'utf8')

    let probes = 0
    await assert.rejects(
      outbox.reconcileSourceVectorInvalidationOutbox({
        vectorDbDir,
        indexIdentity,
        hasIndexPath: () => {
          probes += 1
          return false
        },
        invalidatePaths: async () => {},
      }),
      /real index root/,
    )
    assert.equal(probes, 0)
  })
})

test('version-1 intents migrate as legacy-unbound and remain fail-closed', async () => {
  await withTempVectorDb(async ({ vectorDbDir, indexIdentity }) => {
    const entries = [entry('D:\\Images\\legacy.jpg', 'D:\\Images\\legacy.jpg')]
    const layers = ['clip', 'dino']
    const now = Date.now()
    const legacyIntent = {
      id: crypto.randomUUID(),
      fingerprint: legacyFingerprint(layers, entries),
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      layers,
      entries,
    }
    await fs.mkdir(vectorDbDir, { recursive: true })
    const filePath = outbox.sourceVectorInvalidationOutboxPath(vectorDbDir)
    await fs.writeFile(
      filePath,
      JSON.stringify({ version: 1, revision: 4, intents: [legacyIntent] }),
      'utf8',
    )

    let probes = 0
    let invalidations = 0
    const deferred = await outbox.reconcileSourceVectorInvalidationOutbox({
      vectorDbDir,
      indexIdentity,
      hasIndexPath: () => {
        probes += 1
        return false
      },
      invalidatePaths: async () => {
        invalidations += 1
      },
    })
    assert.equal(deferred.pendingIntents, 1)
    assert.equal(deferred.processedIntents, 0)
    assert.equal(deferred.activePendingIntents, 0)
    assert.equal(deferred.deferredIntents, 1)
    assert.equal(probes, 0)
    assert.equal(invalidations, 0)

    await outbox.prepareSourceVectorInvalidationIntent({
      vectorDbDir,
      indexIdentity,
      entries: [entry('D:\\Images\\current.jpg', 'D:\\Images\\current.jpg')],
    })
    const migrated = JSON.parse(await fs.readFile(filePath, 'utf8'))
    assert.equal(migrated.version, outbox.SOURCE_VECTOR_INVALIDATION_OUTBOX_VERSION)
    assert.equal(migrated.intents[0].legacyUnbound, true)
    assert.equal(migrated.intents[0].indexIdentity, undefined)

    const currentOnly = await outbox.reconcileSourceVectorInvalidationOutbox({
      vectorDbDir,
      indexIdentity,
      hasIndexPath: () => false,
      invalidatePaths: async () => {
        invalidations += 1
      },
    })
    assert.equal(currentOnly.completedIntents, 1)
    assert.equal(currentOnly.pendingIntents, 1)
    assert.equal(currentOnly.deferredIntents, 1)
    assert.equal(invalidations, 1)
  })
})
