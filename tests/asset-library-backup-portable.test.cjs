const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  createAssetLibraryBackupIfDue,
  deleteAssetLibraryBackup,
  exportEncryptedAssetLibraryBackup,
  exportAssetLibraryBackup,
  getAssetLibraryBackupRoot,
  importAssetLibraryBackup,
  importEncryptedAssetLibraryBackup,
  listAssetLibraryBackups,
  normalizeAssetLibraryBackupId,
  redactAssetLibraryBackupSources,
  recoverAssetLibraryRestore,
  restoreAssetLibraryBackup,
  verifyAssetLibraryBackup,
} = loadTsModule('electron/assetLibraryBackup.ts')

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `asset-library-portable-${label}-`))
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function createLibraryFixture(root) {
  const assetLibraryDir = path.join(root, 'asset-library')
  fs.mkdirSync(assetLibraryDir, { recursive: true })
  fs.writeFileSync(path.join(assetLibraryDir, 'assets.jsonl'), '{"id":1,"name":"a.png"}\n')
  fs.writeFileSync(path.join(assetLibraryDir, 'state.json'), '{"version":1}')
  // Backup manifest v2 stores relation JSONL under their post-migration names.
  fs.writeFileSync(path.join(assetLibraryDir, 'tags.jsonl.migrated'), '{"id":1,"name":"tag"}\n')
  return assetLibraryDir
}

async function createBackup(assetLibraryDir) {
  const result = await createAssetLibraryBackupIfDue(assetLibraryDir, {
    minimumIntervalMs: 0,
    reason: 'manual',
  })
  assert.equal(result.created, true)
  return result.backup.id
}

test('JSONL mode backs up and restores all relation stores and cluster lineage', async () => {
  const root = makeTempDir('jsonl-complete')
  try {
    const library = createLibraryFixture(root)
    const relations = [
      'categories',
      'tags',
      'asset_categories',
      'asset_tags',
      'category_references',
      'suggestions',
      'cluster_groups',
      'cluster_group_assets',
      'metadata_deletion_trash',
      'cluster_lineage',
    ]
    const originals = new Map(
      relations.map((name, index) => [
        name + '.jsonl',
        JSON.stringify({ id: index + 1, name, marker: 'before-backup' }) + '\n',
      ]),
    )
    for (const [name, contents] of originals) fs.writeFileSync(path.join(library, name), contents)
    const id = await createBackup(library)
    const manifest = JSON.parse(
      fs.readFileSync(path.join(getAssetLibraryBackupRoot(library), id, 'manifest.json'), 'utf8'),
    )
    for (const [name] of originals) {
      assert.ok(
        manifest.files.some((file) => file.path === name),
        name,
      )
      fs.writeFileSync(path.join(library, name), '{"marker":"after-backup"}\n')
    }
    fs.writeFileSync(path.join(library, 'suggestions.jsonl.migrated'), 'new-after-backup')
    await restoreAssetLibraryBackup(library, id)
    for (const [name, contents] of originals)
      assert.equal(fs.readFileSync(path.join(library, name), 'utf8'), contents, name)
    assert.equal(fs.existsSync(path.join(library, 'suggestions.jsonl.migrated')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('backup refuses directory junctions at the source root and feedback tree', async () => {
  const root = makeTempDir('linked-backup')
  try {
    const library = createLibraryFixture(root)
    const external = path.join(root, 'external')
    fs.mkdirSync(external)
    fs.writeFileSync(path.join(external, 'private.jsonl'), 'private sentinel')
    const linkedLibrary = path.join(root, 'linked-library')
    fs.symlinkSync(library, linkedLibrary, 'junction')
    await assert.rejects(createBackup(linkedLibrary), /symbolic link or junction/)
    for (const nested of [false, true]) {
      const feedback = path.join(library, 'search-feedback')
      if (nested) fs.mkdirSync(feedback)
      const link = nested ? path.join(feedback, 'nested') : feedback
      fs.symlinkSync(external, link, 'junction')
      await assert.rejects(createBackup(library), /symbolic link or junction/)
      assert.equal(
        fs.readFileSync(path.join(external, 'private.jsonl'), 'utf8'),
        'private sentinel',
      )
      fs.unlinkSync(link)
      if (nested) fs.rmdirSync(feedback)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('restore rejects outside and inside feedback junctions before changing metadata', async () => {
  const root = makeTempDir('linked-restore')
  try {
    const library = createLibraryFixture(root)
    const feedback = path.join(library, 'search-feedback')
    fs.mkdirSync(feedback)
    fs.writeFileSync(path.join(feedback, 'victim.jsonl'), 'backup value')
    const id = await createBackup(library)
    fs.rmSync(feedback, { recursive: true })
    fs.writeFileSync(path.join(library, 'assets.jsonl'), 'live metadata')
    for (const target of [path.join(root, 'external'), path.join(library, 'inside')]) {
      fs.mkdirSync(target)
      fs.writeFileSync(path.join(target, 'victim.jsonl'), 'live sentinel')
      fs.writeFileSync(path.join(target, 'extra.jsonl'), 'must not delete')
      fs.symlinkSync(target, feedback, 'junction')
      await assert.rejects(restoreAssetLibraryBackup(library, id), /symbolic link or junction/)
      assert.equal(fs.readFileSync(path.join(library, 'assets.jsonl'), 'utf8'), 'live metadata')
      assert.equal(fs.readFileSync(path.join(target, 'victim.jsonl'), 'utf8'), 'live sentinel')
      assert.equal(fs.readFileSync(path.join(target, 'extra.jsonl'), 'utf8'), 'must not delete')
      assert.equal(fs.existsSync(path.join(library, '.asset-library-restore.json')), false)
      fs.unlinkSync(feedback)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('journal recovery preflights all targets and stage hashes before any mutation', () => {
  const root = makeTempDir('journal-preflight')
  try {
    const library = createLibraryFixture(root)
    const external = path.join(root, 'external')
    fs.mkdirSync(external)
    fs.writeFileSync(path.join(external, 'victim.jsonl'), 'untouched')
    const staged = '.asset-library-restore-stage-0123456789abcdef-0'
    fs.writeFileSync(path.join(library, staged), 'replacement')
    const journal = {
      version: 1,
      id: '0123456789abcdef',
      backupId: 'backup-fixture',
      createdAt: Date.now(),
      entries: [
        {
          operation: 'replace',
          target: 'assets.jsonl',
          staged,
          bytes: 11,
          sha256: sha256(path.join(library, staged)),
        },
        { operation: 'delete', target: 'search-feedback/victim.jsonl' },
      ],
    }
    const journalPath = path.join(library, '.asset-library-restore.json')
    fs.writeFileSync(journalPath, JSON.stringify(journal))
    fs.symlinkSync(external, path.join(library, 'search-feedback'), 'junction')
    const before = fs.readFileSync(path.join(library, 'assets.jsonl'), 'utf8')
    assert.throws(() => recoverAssetLibraryRestore(library), /symbolic link or junction/)
    assert.equal(fs.readFileSync(path.join(library, 'assets.jsonl'), 'utf8'), before)
    assert.equal(fs.readFileSync(path.join(external, 'victim.jsonl'), 'utf8'), 'untouched')
    assert.ok(fs.existsSync(journalPath))
    assert.ok(fs.existsSync(path.join(library, staged)))
    fs.unlinkSync(path.join(library, 'search-feedback'))
    // A later corrupt stage also prevents an earlier valid replacement.
    const badStage = staged + '-bad'
    fs.writeFileSync(path.join(library, badStage), 'tampered')
    journal.entries[1] = {
      operation: 'replace',
      target: 'state.json',
      staged: badStage,
      bytes: 11,
      sha256: journal.entries[0].sha256,
    }
    fs.writeFileSync(journalPath, JSON.stringify(journal))
    assert.throws(() => recoverAssetLibraryRestore(library), /failed verification/)
    assert.equal(fs.readFileSync(path.join(library, 'assets.jsonl'), 'utf8'), before)
    // Correcting the stage permits recovery, including a subsequent crash retry.
    fs.writeFileSync(path.join(library, badStage), 'replacement')
    assert.equal(recoverAssetLibraryRestore(library), true)
    assert.equal(fs.readFileSync(path.join(library, 'assets.jsonl'), 'utf8'), 'replacement')
    assert.equal(recoverAssetLibraryRestore(library), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('backup verification refuses junctions in the backed-up file tree', async () => {
  const root = makeTempDir('verify-junction')
  try {
    const library = createLibraryFixture(root)
    fs.mkdirSync(path.join(library, 'search-feedback'))
    fs.writeFileSync(path.join(library, 'search-feedback', 'events.jsonl'), 'events')
    const id = await createBackup(library)
    const backup = path.join(getAssetLibraryBackupRoot(library), id)
    fs.renameSync(path.join(backup, 'search-feedback'), path.join(root, 'moved-feedback'))
    fs.symlinkSync(
      path.join(root, 'moved-feedback'),
      path.join(backup, 'search-feedback'),
      'junction',
    )
    const verification = await verifyAssetLibraryBackup(backup)
    assert.equal(verification.ok, false)
    assert.match(verification.error, /symbolic link or junction/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('export and import round trip preserves every file sha256', async () => {
  const root = makeTempDir('roundtrip')
  try {
    const assetLibraryDir = createLibraryFixture(root)
    const backupRoot = getAssetLibraryBackupRoot(assetLibraryDir)
    const backupId = await createBackup(assetLibraryDir)
    const exportParent = path.join(root, 'export-target')
    fs.mkdirSync(exportParent, { recursive: true })

    const exported = await exportAssetLibraryBackup(backupRoot, backupId, exportParent)
    assert.equal(exported.path, path.join(exportParent, `floating-clock-backup-${backupId}`))
    const exportedVerification = await verifyAssetLibraryBackup(exported.path)
    assert.equal(exportedVerification.ok, true)

    const sourceDirectory = path.join(backupRoot, backupId)
    for (const name of ['assets.jsonl', 'state.json', 'tags.jsonl.migrated']) {
      assert.equal(
        sha256(path.join(exported.path, name)),
        sha256(path.join(sourceDirectory, name)),
        `exported ${name} must match the source backup`,
      )
    }

    // Importing back into the same root collides with the existing id.
    const imported = await importAssetLibraryBackup(backupRoot, exported.path, 1720000000000)
    assert.equal(imported.backupId, `${backupId}-imported-1720000000000`)
    const importedVerification = await verifyAssetLibraryBackup(imported.path)
    assert.equal(importedVerification.ok, true)
    for (const name of ['assets.jsonl', 'state.json', 'tags.jsonl.migrated']) {
      assert.equal(
        sha256(path.join(imported.path, name)),
        sha256(path.join(sourceDirectory, name)),
        `imported ${name} must match the source backup`,
      )
    }

    const summaries = await listAssetLibraryBackups(assetLibraryDir)
    const ids = summaries.map((summary) => summary.id)
    assert.ok(ids.includes(backupId))
    assert.ok(ids.includes(imported.backupId))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('new, exported and migrated manifests never expose an absolute source directory', async () => {
  const root = makeTempDir('redacted-source')
  try {
    const assetLibraryDir = createLibraryFixture(root)
    const backupRoot = getAssetLibraryBackupRoot(assetLibraryDir)
    const backupId = await createBackup(assetLibraryDir)
    const sourceManifestPath = path.join(backupRoot, backupId, 'manifest.json')
    const sourceManifest = JSON.parse(fs.readFileSync(sourceManifestPath, 'utf8'))
    assert.equal(sourceManifest.sourceDirectory, 'asset-library')
    assert.equal(path.isAbsolute(sourceManifest.sourceDirectory), false)

    sourceManifest.sourceDirectory = path.resolve(assetLibraryDir)
    fs.writeFileSync(sourceManifestPath, JSON.stringify(sourceManifest, null, 2))
    assert.equal(await redactAssetLibraryBackupSources(assetLibraryDir), 1)
    const migratedManifest = JSON.parse(fs.readFileSync(sourceManifestPath, 'utf8'))
    assert.equal(migratedManifest.sourceDirectory, 'asset-library')

    const exportParent = path.join(root, 'export-target')
    fs.mkdirSync(exportParent)
    const exported = await exportAssetLibraryBackup(backupRoot, backupId, exportParent)
    const exportedManifest = JSON.parse(
      fs.readFileSync(path.join(exported.path, 'manifest.json'), 'utf8'),
    )
    assert.equal(exportedManifest.sourceDirectory, 'asset-library')
    assert.equal(JSON.stringify(exportedManifest).includes(path.resolve(assetLibraryDir)), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('password-encrypted export hides metadata and rejects tampering or a wrong password', async () => {
  const root = makeTempDir('encrypted')
  try {
    const assetLibraryDir = createLibraryFixture(root)
    const privateMarker = 'customer-private-path-marker'
    fs.writeFileSync(
      path.join(assetLibraryDir, 'assets.jsonl'),
      `${JSON.stringify({ id: 1, path: `C:\\Users\\customer\\${privateMarker}.png` })}\n`,
    )
    const backupRoot = getAssetLibraryBackupRoot(assetLibraryDir)
    const backupId = await createBackup(assetLibraryDir)
    const exportParent = path.join(root, 'encrypted-export')
    fs.mkdirSync(exportParent)
    const passphrase = 'correct horse battery staple'
    const exported = await exportEncryptedAssetLibraryBackup(
      backupRoot,
      backupId,
      exportParent,
      passphrase,
    )
    const exportedFiles = fs.readdirSync(exported.path)
    assert.ok(exportedFiles.includes('siftory-secure-backup.json'))
    assert.equal(exportedFiles.includes('assets.jsonl'), false)
    for (const filename of exportedFiles) {
      const contents = fs.readFileSync(path.join(exported.path, filename))
      assert.equal(contents.includes(Buffer.from(privateMarker)), false)
      assert.equal(contents.includes(Buffer.from('C:\\Users\\customer')), false)
    }

    await assert.rejects(
      () => importEncryptedAssetLibraryBackup(backupRoot, exported.path, 'wrong password value'),
      /authentication failed/i,
    )
    const imported = await importEncryptedAssetLibraryBackup(
      backupRoot,
      exported.path,
      passphrase,
      1720000000001,
    )
    assert.equal(imported.backupId, `${backupId}-imported-1720000000001`)
    assert.equal((await verifyAssetLibraryBackup(imported.path)).ok, true)

    const encryptedFile = exportedFiles.find((name) => name.endsWith('.enc'))
    assert.ok(encryptedFile)
    const encryptedPath = path.join(exported.path, encryptedFile)
    const bytes = fs.readFileSync(encryptedPath)
    bytes[Math.floor(bytes.length / 2)] ^= 0xff
    fs.writeFileSync(encryptedPath, bytes)
    await assert.rejects(
      () => importEncryptedAssetLibraryBackup(backupRoot, exported.path, passphrase),
      /authentication failed/i,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('encrypted import rejects manifest tampering without publishing or retaining plaintext', async () => {
  const root = makeTempDir('manifest-tamper')
  try {
    const assetLibraryDir = createLibraryFixture(root)
    const backupRoot = getAssetLibraryBackupRoot(assetLibraryDir)
    const backupId = await createBackup(assetLibraryDir)
    const exportParent = path.join(root, 'export-target')
    fs.mkdirSync(exportParent)
    const passphrase = 'fixture password for manifest tampering'
    const exported = await exportEncryptedAssetLibraryBackup(
      backupRoot,
      backupId,
      exportParent,
      passphrase,
    )
    const manifestPath = path.join(exported.path, 'siftory-secure-backup.json')
    const original = fs.readFileSync(manifestPath, 'utf8')
    const originalBackups = fs.readdirSync(backupRoot).sort()
    const cases = [
      {
        change: (value) => {
          value.kdf.N = 2 ** 30
        },
        error: /invalid encrypted backup manifest/i,
      },
      {
        change: (value) => {
          value.files[1] = value.files[0]
        },
        error: /invalid encrypted backup file inventory/i,
      },
      {
        change: (value) => {
          value.files[1].path = '../outside.json'
        },
        error: /invalid encrypted backup manifest/i,
      },
      {
        change: (value) => {
          value.totalBytes += 1
        },
        error: /invalid encrypted backup file inventory/i,
      },
      {
        change: (value) => {
          value.backupId += '-tampered'
        },
        error: /authentication failed/i,
      },
    ]
    for (const { change, error } of cases) {
      const altered = JSON.parse(original)
      change(altered)
      fs.writeFileSync(manifestPath, JSON.stringify(altered))
      await assert.rejects(
        () => importEncryptedAssetLibraryBackup(backupRoot, exported.path, passphrase),
        error,
      )
      assert.deepEqual(fs.readdirSync(backupRoot).sort(), originalBackups)
      assert.equal(
        fs
          .readdirSync(path.dirname(backupRoot))
          .some((name) => name.startsWith('.siftory-secure-import-')),
        false,
      )
      assert.equal((await verifyAssetLibraryBackup(path.join(backupRoot, backupId))).ok, true)
    }
    fs.writeFileSync(manifestPath, original)
    const restored = await importEncryptedAssetLibraryBackup(
      backupRoot,
      exported.path,
      passphrase,
      1720000000002,
    )
    assert.equal((await verifyAssetLibraryBackup(restored.path)).ok, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('export refuses a corrupted backup', async () => {
  const root = makeTempDir('corrupt')
  try {
    const assetLibraryDir = createLibraryFixture(root)
    const backupRoot = getAssetLibraryBackupRoot(assetLibraryDir)
    const backupId = await createBackup(assetLibraryDir)
    fs.appendFileSync(path.join(backupRoot, backupId, 'assets.jsonl'), 'tampered')
    const exportParent = path.join(root, 'export-target')
    fs.mkdirSync(exportParent, { recursive: true })
    await assert.rejects(
      () => exportAssetLibraryBackup(backupRoot, backupId, exportParent),
      /invalid backup|verification/i,
    )
    assert.equal(fs.existsSync(path.join(exportParent, `floating-clock-backup-${backupId}`)), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('export refuses to overwrite an existing destination', async () => {
  const root = makeTempDir('overwrite')
  try {
    const assetLibraryDir = createLibraryFixture(root)
    const backupRoot = getAssetLibraryBackupRoot(assetLibraryDir)
    const backupId = await createBackup(assetLibraryDir)
    const exportParent = path.join(root, 'export-target')
    fs.mkdirSync(path.join(exportParent, `floating-clock-backup-${backupId}`), { recursive: true })
    await assert.rejects(
      () => exportAssetLibraryBackup(backupRoot, backupId, exportParent),
      /already exists/i,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('import rejects a directory that is not a valid backup', async () => {
  const root = makeTempDir('invalid-import')
  try {
    const assetLibraryDir = createLibraryFixture(root)
    const backupRoot = getAssetLibraryBackupRoot(assetLibraryDir)
    const fake = path.join(root, 'floating-clock-backup-backup-fake')
    fs.mkdirSync(fake, { recursive: true })
    fs.writeFileSync(path.join(fake, 'assets.jsonl'), '{}\n')
    await assert.rejects(() => importAssetLibraryBackup(backupRoot, fake), /not a valid backup/i)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('import rejects a directory already inside the backup root', async () => {
  const root = makeTempDir('self-import')
  try {
    const assetLibraryDir = createLibraryFixture(root)
    const backupRoot = getAssetLibraryBackupRoot(assetLibraryDir)
    const backupId = await createBackup(assetLibraryDir)
    await assert.rejects(
      () => importAssetLibraryBackup(backupRoot, path.join(backupRoot, backupId)),
      /already in the asset library backup folder/i,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('backupId validation rejects path traversal and unsafe names', async () => {
  const root = makeTempDir('traversal')
  try {
    const assetLibraryDir = createLibraryFixture(root)
    const backupRoot = getAssetLibraryBackupRoot(assetLibraryDir)
    await createBackup(assetLibraryDir)
    const exportParent = path.join(root, 'export-target')
    fs.mkdirSync(exportParent, { recursive: true })
    for (const badId of [
      '../backup-evil',
      'backup-../evil',
      'backup-a/b',
      'backup-a\\b',
      'evil-backup',
      '',
    ]) {
      assert.throws(() => normalizeAssetLibraryBackupId(badId), /Invalid asset library backup id/)
      await assert.rejects(
        () => exportAssetLibraryBackup(backupRoot, badId, exportParent),
        /Invalid asset library backup id/,
      )
      await assert.rejects(
        () => deleteAssetLibraryBackup(backupRoot, badId),
        /Invalid asset library backup id/,
      )
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('deleteBackup removes an existing backup and fails for a missing one', async () => {
  const root = makeTempDir('delete')
  try {
    const assetLibraryDir = createLibraryFixture(root)
    const backupRoot = getAssetLibraryBackupRoot(assetLibraryDir)
    const backupId = await createBackup(assetLibraryDir)
    assert.equal(fs.existsSync(path.join(backupRoot, backupId)), true)

    await deleteAssetLibraryBackup(backupRoot, backupId)
    assert.equal(fs.existsSync(path.join(backupRoot, backupId)), false)
    const summaries = await listAssetLibraryBackups(assetLibraryDir)
    assert.equal(
      summaries.some((summary) => summary.id === backupId),
      false,
    )

    await assert.rejects(() => deleteAssetLibraryBackup(backupRoot, backupId), /backup not found/i)
    await assert.rejects(
      () => deleteAssetLibraryBackup(backupRoot, 'backup-never-existed'),
      /backup not found/i,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('empty library backup seeds the core asset files and restores cleanly', async () => {
  const root = makeTempDir('empty-library')
  try {
    // A library that never held assets: no assets.jsonl / state.json on disk.
    const assetLibraryDir = path.join(root, 'asset-library')
    fs.mkdirSync(path.join(assetLibraryDir, 'search-feedback'), { recursive: true })
    fs.writeFileSync(
      path.join(assetLibraryDir, 'search-feedback', 'state.json'),
      '{"revision":1}',
      'utf8',
    )

    const backupId = await createBackup(assetLibraryDir)
    const backupDir = path.join(getAssetLibraryBackupRoot(assetLibraryDir), backupId)

    // The seeded core files made it into the manifest.
    const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'))
    const entries = new Map(manifest.files.map((file) => [file.path, file.bytes]))
    assert.equal(entries.get('assets.jsonl'), 0, 'assets.jsonl must be seeded as an empty file')
    assert.ok(entries.has('state.json'), 'state.json must be seeded')
    assert.equal((await verifyAssetLibraryBackup(backupDir)).ok, true)

    // Prove restore replaces post-backup core state instead of merely succeeding.
    fs.writeFileSync(path.join(assetLibraryDir, 'assets.jsonl'), '{"id":99}\n', 'utf8')
    fs.writeFileSync(path.join(assetLibraryDir, 'state.json'), '{"nextId":100}\n', 'utf8')
    fs.writeFileSync(
      path.join(assetLibraryDir, 'search-feedback', 'state.json'),
      '{"revision":2}',
      'utf8',
    )

    // Restore no longer fails on the missing asset index and materializes both.
    const restored = await restoreAssetLibraryBackup(assetLibraryDir, backupId)
    assert.equal(restored.restoredFiles, 3)
    assert.equal(fs.existsSync(path.join(assetLibraryDir, 'assets.jsonl')), true)
    assert.equal(fs.existsSync(path.join(assetLibraryDir, 'state.json')), true)
    assert.equal(fs.readFileSync(path.join(assetLibraryDir, 'assets.jsonl'), 'utf8'), '')
    assert.equal(
      fs.readFileSync(path.join(assetLibraryDir, 'state.json'), 'utf8'),
      '{"nextId":1}\n',
    )
    assert.equal(
      fs.readFileSync(path.join(assetLibraryDir, 'search-feedback', 'state.json'), 'utf8'),
      '{"revision":1}',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
