const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { SftpSourceAdapter } = loadTsModule('electron/sftpSourceAdapter.ts')
const { SourceCatalogService } = loadTsModule('electron/sourceCatalogService.ts')
const { createSftpSourceLocator, parseSftpSourceLocator } = loadTsModule(
  'electron/sftpSourceLocator.ts',
)

const profile = {
  id: 'nas:primary',
  name: 'NAS',
  host: 'nas.example.test',
  port: 22,
  username: 'reader',
  authType: 'password',
  hostFingerprint: `SHA256:${'A'.repeat(43)}`,
  tags: [],
  createdAt: 1,
  updatedAt: 1,
  credentialMode: 'os',
}

function source(locator) {
  return {
    id: 'src_sftp',
    type: 'sftp',
    displayName: 'NAS',
    rootLocator: locator,
    readOnly: true,
    availability: 'unknown',
    scanCapability: 'remote-list',
  }
}

async function collect(adapter, registeredSource) {
  const batches = []
  for await (const batch of adapter.enumerate({
    source: registeredSource,
    signal: new AbortController().signal,
  })) {
    batches.push(batch)
  }
  return batches
}

async function collectWithSignal(adapter, registeredSource, signal) {
  const batches = []
  for await (const batch of adapter.enumerate({ source: registeredSource, signal })) {
    batches.push(batch)
  }
  return batches
}

test('SFTP locator pins profile, host fingerprint and root without credentials', () => {
  const locator = createSftpSourceLocator(profile, '/media/library')
  assert.ok(locator)
  assert.deepEqual(parseSftpSourceLocator(locator), {
    profileId: profile.id,
    hostFingerprint: profile.hostFingerprint,
    remoteRoot: '/media/library',
  })
  assert.doesNotMatch(locator, /password|reader|example/)
  assert.equal(createSftpSourceLocator({ ...profile, hostFingerprint: undefined }, '/media'), null)
})

test('SFTP adapter recursively consumes paged listings and emits metadata-only locators', async () => {
  const locator = createSftpSourceLocator(profile, '/media')
  const requests = []
  const adapter = new SftpSourceAdapter({
    userDataPath: 'unused',
    batchSize: 2,
    getProfiles: () => [profile],
    resolveCredential: async (_userData, _profile, request) => ({
      ...request,
      password: 'secret-from-safe-storage',
    }),
    listDirectory: async (_profile, request) => {
      requests.push(request)
      if (request.remotePath === '/media' && !request.cursor) {
        return {
          ok: true,
          profileId: profile.id,
          path: '/media',
          entries: [
            { name: 'photos', path: '/media/photos', type: 'directory', size: 0 },
            { name: 'one.png', path: '/media/one.png', type: 'file', size: 10, modifiedAt: 20 },
          ],
          total: 3,
          hasMore: true,
          cursor: '2',
        }
      }
      if (request.remotePath === '/media') {
        return {
          ok: true,
          profileId: profile.id,
          path: '/media',
          entries: [{ name: 'two.mp4', path: '/media/two.mp4', type: 'file', size: 30 }],
          total: 3,
          hasMore: false,
        }
      }
      return {
        ok: true,
        profileId: profile.id,
        path: '/media/photos',
        entries: [{ name: 'three.jpg', path: '/media/photos/three.jpg', type: 'file', size: 40 }],
        total: 1,
        hasMore: false,
      }
    },
  })
  const batches = await collect(adapter, source(locator))
  const entries = batches.flatMap((batch) => batch.entries)
  assert.deepEqual(
    entries.map((entry) => entry.relativePath).sort(),
    ['one.png', 'photos/three.jpg', 'two.mp4'],
  )
  assert.ok(entries.every((entry) => entry.absolutePath.startsWith('sftp://nas%3Aprimary/')))
  assert.equal(batches.at(-1).progress.backend, 'remote-list')
  assert.equal(batches.at(-1).final, true)
  assert.deepEqual(
    requests.map((request) => [request.remotePath, request.cursor]),
    [
      ['/media', undefined],
      ['/media', '2'],
      ['/media/photos', undefined],
    ],
  )
})

test('SFTP source blocks a changed saved fingerprint before resolving credentials or listing', async () => {
  const locator = createSftpSourceLocator(profile, '/media')
  let touchedNetwork = false
  const adapter = new SftpSourceAdapter({
    userDataPath: 'unused',
    getProfiles: () => [{ ...profile, hostFingerprint: `SHA256:${'B'.repeat(43)}` }],
    resolveCredential: async () => {
      touchedNetwork = true
      throw new Error('must not resolve')
    },
    listDirectory: async () => {
      touchedNetwork = true
      throw new Error('must not list')
    },
  })
  await assert.rejects(collect(adapter, source(locator)), (error) => {
    assert.equal(error.code, 'HOST_KEY_CHANGED')
    return true
  })
  assert.equal(touchedNetwork, false)
  const probe = await adapter.probe(source(locator))
  assert.equal(probe.availability, 'degraded')
  assert.match(probe.detail, /fingerprint changed/i)
})

test('SFTP listing preserves existing host-key mismatch errors as degraded security state', async () => {
  const locator = createSftpSourceLocator(profile, '/media')
  const adapter = new SftpSourceAdapter({
    userDataPath: 'unused',
    getProfiles: () => [profile],
    resolveCredential: async (_userData, _profile, request) => request,
    listDirectory: async () => ({
      ok: false,
      profileId: profile.id,
      path: '/media',
      entries: [],
      total: 0,
      hasMore: false,
      error: 'SSH host key changed. Connection blocked.',
    }),
  })
  const probe = await adapter.probe(source(locator))
  assert.equal(probe.availability, 'degraded')
  assert.match(probe.detail, /host key changed/i)
})

test('SFTP listing timeout becomes offline instead of holding the remote budget forever', async () => {
  const locator = createSftpSourceLocator(profile, '/media')
  const adapter = new SftpSourceAdapter({
    userDataPath: 'unused',
    operationTimeoutMs: 10,
    getProfiles: () => [profile],
    resolveCredential: async (_userData, _profile, request) => request,
    listDirectory: () => new Promise(() => {}),
  })
  const probe = await adapter.probe(source(locator))
  assert.equal(probe.availability, 'offline')
  assert.match(probe.detail, /timed out/i)
})

test('SFTP cancellation releases a pending listing without waiting for its timeout', async () => {
  const locator = createSftpSourceLocator(profile, '/media')
  const controller = new AbortController()
  const adapter = new SftpSourceAdapter({
    userDataPath: 'unused',
    operationTimeoutMs: 1000,
    getProfiles: () => [profile],
    resolveCredential: async (_userData, _profile, request) => request,
    listDirectory: () => new Promise(() => {}),
  })
  const startedAt = Date.now()
  const collecting = collectWithSignal(adapter, source(locator), controller.signal)
  controller.abort()
  const batches = await collecting
  assert.ok(Date.now() - startedAt < 500)
  assert.equal(batches.at(-1).final, true)
})

test('SFTP source UI uses a profile id and remote root instead of accepting a credential locator', () => {
  const fs = require('node:fs')
  const ui = fs.readFileSync('src/components/DiscoverySourcesSection.tsx', 'utf8')
  const ipc = fs.readFileSync('electron/discoveryCatalogIpc.ts', 'utf8')
  assert.match(ui, /option value="sftp"/)
  assert.match(ui, /sftpProfileId, sftpRemoteRoot/)
  assert.match(ipc, /createSftpSourceLocator\(profile, request\.sftpRemoteRoot/)
})

test('catalog source listing exposes only the profile id and remote root display locator', () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-catalog-'))
  const service = new SourceCatalogService({ databasePath: path.join(root, 'catalog.sqlite') })
  try {
    const locator = createSftpSourceLocator(profile, '/media')
    const added = service.addSource({
      type: 'sftp',
      displayName: 'NAS',
      rootLocator: locator,
      readOnly: false,
    })
    assert.equal(added.ok, true, added.error)
    assert.equal(added.source.readOnly, true)
    assert.equal(added.source.scanCapability, 'remote-list')
    assert.equal(service.listSources()[0].displayLocator, 'nas:primary:/media')
    assert.equal(service.listSources()[0].rootLocator, 'nas:primary:/media')
    assert.doesNotMatch(added.source.rootLocator, /sftp-source:v1:/)
  } finally {
    service.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
