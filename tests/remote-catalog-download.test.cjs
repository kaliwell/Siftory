const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  RemoteCatalogDownloadTokens,
  resolveRemoteCatalogDownloadClaim,
  sameRemoteCatalogDownloadClaim,
} = loadTsModule('electron/remoteCatalogDownload.ts')
const {
  createSftpSourceLocator,
  parseSftpEntryLocator,
  sftpEntryLocator,
} = loadTsModule('electron/sftpSourceLocator.ts')
const { DiscoveryCatalogDatabase } = loadTsModule('electron/discoveryCatalogDatabase.ts')

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

function record(remotePath = '/media/photos/one.jpg') {
  return {
    fileEntryId: '41',
    displayName: 'one.jpg',
    displayPath: sftpEntryLocator(profile.id, remotePath),
    sizeBytes: 123,
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

test('SFTP entry locators decode profile identity and require absolute paths', () => {
  assert.deepEqual(parseSftpEntryLocator('sftp://nas%3Aprimary/media/one.jpg'), {
    profileId: 'nas:primary',
    remotePath: '/media/one.jpg',
  })
  assert.equal(parseSftpEntryLocator('sftp://nas%2Fprimary/media/one.jpg'), null)
  assert.equal(createSftpSourceLocator(profile, 'relative/path'), null)
})

test('catalog download claim is derived from authoritative source and entry metadata', () => {
  const result = resolveRemoteCatalogDownloadClaim(record(), [profile])
  assert.equal(result.ok, true)
  assert.deepEqual(result.claim, {
    fileEntryId: '41',
    sourceId: 'src_sftp',
    profileId: profile.id,
    hostFingerprint: fingerprint,
    remotePath: '/media/photos/one.jpg',
    totalBytes: 123,
  })
})

test('catalog action lookup returns the opaque source locator from SQLite authority', () => {
  const os = require('node:os')
  const path = require('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-download-'))
  const database = new DiscoveryCatalogDatabase(path.join(root, 'catalog.sqlite'))
  try {
    const source = record().source
    database.insertSource(source, 1)
    database.upsertDiscoveredBatch(
      source.id,
      'scan_1',
      [
        {
          absolutePath: sftpEntryLocator(profile.id, '/media/photos/one.jpg'),
          relativePath: 'photos/one.jpg',
          name: 'one.jpg',
          extension: 'jpg',
          sizeBytes: 123,
          modifiedAt: 2,
        },
      ],
      3,
    )
    const item = database.queryCatalog({ query: 'one.jpg' }).items[0]
    const action = database.getFileEntryForAction(item.fileEntryId)
    assert.equal(action.source.rootLocator, source.rootLocator)
    assert.equal(action.displayPath, sftpEntryLocator(profile.id, '/media/photos/one.jpg'))
    assert.equal(resolveRemoteCatalogDownloadClaim(action, [profile]).ok, true)
  } finally {
    database.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('catalog download rejects source escape, profile mismatch, and changed fingerprint', () => {
  assert.match(resolveRemoteCatalogDownloadClaim(record('/other/one.jpg'), [profile]).error, /outside/i)
  const mismatched = record()
  mismatched.displayPath = sftpEntryLocator('nas:secondary', '/media/photos/one.jpg')
  assert.match(resolveRemoteCatalogDownloadClaim(mismatched, [profile]).error, /outside/i)
  const changed = { ...profile, hostFingerprint: `SHA256:${'B'.repeat(43)}` }
  assert.match(resolveRemoteCatalogDownloadClaim(record(), [changed]).error, /fingerprint changed/i)
})

test('catalog download tokens are sender-bound, one-time, and expiring', () => {
  let now = 100
  const tokens = new RemoteCatalogDownloadTokens(() => now, 50)
  const claim = resolveRemoteCatalogDownloadClaim(record(), [profile]).claim
  const stolen = tokens.issue(7, claim)
  assert.equal(tokens.consume(stolen, 8), null)
  assert.equal(tokens.consume(stolen, 7), null)
  const valid = tokens.issue(7, claim)
  assert.ok(sameRemoteCatalogDownloadClaim(tokens.consume(valid, 7), claim))
  assert.equal(tokens.consume(valid, 7), null)
  const expired = tokens.issue(7, claim)
  now = 151
  assert.equal(tokens.consume(expired, 7), null)
})

test('search result download wiring never sends renderer-provided profile or remote path', () => {
  const ui = fs.readFileSync('src/components/DiscoverySourcesSection.tsx', 'utf8')
  const ipc = fs.readFileSync('electron/remoteTerminalTransferIpc.ts', 'utf8')
  assert.match(ui, /createRemoteDownloadGrant\(\s*item\.fileEntryId/)
  assert.match(ui, /enqueueCatalogDownload\(\s*grant\.token,\s*selection\.token/)
  assert.doesNotMatch(ui, /enqueueCatalogDownload\([^)]*item\.displayPath/s)
  assert.match(ipc, /remoteCatalogDownloadTokens\.consume\(actionToken, event\.sender\.id\)/)
  assert.match(ipc, /getFileEntryForAction\(claim\.fileEntryId\)/)
  assert.match(ipc, /sameRemoteCatalogDownloadClaim\(claim, current\.claim\)/)
})

test('remote video preparation reuses the sender-bound grant without renderer paths', () => {
  const ui = fs.readFileSync('src/components/UnifiedSearchPanel.tsx', 'utf8')
  const ipc = fs.readFileSync('electron/discoveryCatalogIpc.ts', 'utf8')
  assert.match(ui, /prepareRemoteVideo\(\s*grant\.token,\s*timestampMs/)
  assert.doesNotMatch(ui, /prepareRemoteVideo\([^)]*item\.displayPath/s)
  assert.match(ipc, /remoteCatalogDownloadTokens\.consume\(rawToken, event\.sender\.id\)/)
  assert.match(ipc, /sameRemoteCatalogDownloadClaim\(claim, current\.claim\)/)
})
