const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const sharp = require('sharp')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { RemotePreviewService } = loadTsModule('electron/remotePreviewService.ts')
const { DiscoveryCatalogDatabase } = loadTsModule('electron/discoveryCatalogDatabase.ts')
const { createSftpSourceLocator, sftpEntryLocator } = loadTsModule(
  'electron/sftpSourceLocator.ts',
)

const fingerprint = `SHA256:${'A'.repeat(43)}`
const profile = {
  id: 'nas:primary',
  name: 'NAS',
  host: 'nas.example.test',
  port: 22,
  username: 'reader',
  authType: 'agent',
  hostFingerprint: fingerprint,
  tags: [],
  createdAt: 1,
  updatedAt: 1,
}

function record(fileEntryId = '41', sizeBytes = 1024) {
  return {
    fileEntryId,
    displayName: `${fileEntryId}.png`,
    displayPath: sftpEntryLocator(profile.id, `/media/${fileEntryId}.png`),
    sizeBytes,
    modifiedAt: 2000,
    source: {
      id: 'src_sftp',
      type: 'sftp',
      displayName: 'NAS',
      rootLocator: createSftpSourceLocator(profile, '/media'),
      readOnly: true,
      availability: 'online',
      scanCapability: 'remote-list',
    },
  }
}

test('visible SFTP image preview is bounded, cached, deduplicated, and marks D3 ready', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-preview-'))
  const source = await sharp({
    create: { width: 32, height: 24, channels: 3, background: '#4488cc' },
  })
    .png()
    .toBuffer()
  let reads = 0
  const states = []
  const service = new RemotePreviewService({
    userDataPath: root,
    getRecord: () => record(),
    setPreviewState: (fileEntryId, state) => states.push([fileEntryId, state]),
    getProfiles: () => [profile],
    resolveCredential: async (_root, _profile, request) => request,
    readRemote: async (_profile, request) => {
      reads += 1
      assert.equal(request.maxBytes, 32 * 1024 * 1024)
      assert.equal(request.timeoutMs, 30_000)
      return source
    },
  })
  try {
    const firstPromise = service.get('41', 160)
    const duplicatePromise = service.get('41', 160)
    assert.equal(firstPromise, duplicatePromise)
    const first = await firstPromise
    assert.equal(first.ok, true)
    assert.equal(first.status, 'preview-ready')
    assert.equal(first.cached, false)
    assert.match(first.dataUrl, /^data:image\/webp;base64,/)
    const cached = await service.get('41', 160)
    assert.equal(cached.ok, true)
    assert.equal(cached.cached, true)
    assert.equal(reads, 1)
    assert.deepEqual(states, [
      ['41', 'ready'],
      ['41', 'ready'],
    ])
    const offlineCache = new RemotePreviewService({
      userDataPath: root,
      getRecord: () => record(),
      setPreviewState: () => {},
      getProfiles: () => [],
      readRemote: async () => {
        throw new Error('cached preview must not reconnect')
      },
    })
    assert.equal((await offlineCache.get('41', 160)).cached, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('remote preview rejects oversized metadata and changed fingerprints before reading', async () => {
  let touched = false
  const changed = { ...profile, hostFingerprint: `SHA256:${'B'.repeat(43)}` }
  const makeService = (entry, profiles) =>
    new RemotePreviewService({
      userDataPath: os.tmpdir(),
      getRecord: () => entry,
      setPreviewState: () => {},
      getProfiles: () => profiles,
      resolveCredential: async () => {
        touched = true
        throw new Error('must not resolve credentials')
      },
      readRemote: async () => {
        touched = true
        throw new Error('must not read')
      },
    })
  const oversized = await makeService(record('42', 32 * 1024 * 1024 + 1), [profile]).get('42', 160)
  assert.equal(oversized.ok, false)
  assert.match(oversized.error, /read limit/i)
  const mismatched = await makeService(record('43'), [changed]).get('43', 160)
  assert.equal(mismatched.ok, false)
  assert.match(mismatched.error, /fingerprint changed/i)
  assert.equal(touched, false)
})

test('a changed remote file marks its persisted D3 preview state stale', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-preview-state-'))
  const database = new DiscoveryCatalogDatabase(path.join(root, 'catalog.sqlite'))
  try {
    const registeredSource = record().source
    database.insertSource(registeredSource, 1)
    const entry = {
      absolutePath: record().displayPath,
      relativePath: '41.png',
      name: '41.png',
      extension: 'png',
      sizeBytes: 1024,
      modifiedAt: 2000,
    }
    database.upsertDiscoveredBatch(registeredSource.id, 'scan_1', [entry], 2)
    const item = database.queryCatalog({ query: '41.png' }).items[0]
    assert.equal(database.setFileEntryIndexState(item.fileEntryId, 'preview-ready', 'ready', 3), true)
    database.upsertDiscoveredBatch(
      registeredSource.id,
      'scan_2',
      [{ ...entry, sizeBytes: 2048, modifiedAt: 3000 }],
      4,
    )
    assert.ok(
      database
        .queryCatalog({ query: '41.png' })
        .items[0].indexState.includes('preview-ready:stale'),
    )
  } finally {
    database.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('visible-result UI caps automatic remote previews and labels index depth', () => {
  const ui = fs.readFileSync('src/components/DiscoverySourcesSection.tsx', 'utf8')
  assert.match(ui, /const REMOTE_PREVIEW_LIMIT = 12/)
  assert.match(ui, /item\.source\.type === 'sftp' && item\.mediaType === 'image'/)
  assert.match(ui, /\.slice\(0, REMOTE_PREVIEW_LIMIT\)/)
  assert.match(ui, /getRemotePreview\(item\.fileEntryId, 160\)/)
  assert.match(ui, /preview-ready:ready/)
  assert.match(ui, /Full AI index/)
  assert.match(ui, /Metadata only/)
})
