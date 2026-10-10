const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { SftpVideoRetrievalService } = loadTsModule('electron/sftpVideoRetrievalService.ts')
const { SftpVideoProjectionStore } = loadTsModule('electron/sftpVideoProjection.ts')

const profile = {
  id: 'nas',
  name: 'NAS',
  host: 'nas.example.test',
  port: 22,
  username: 'reader',
  authType: 'agent',
  hostFingerprint: `SHA256:${'A'.repeat(43)}`,
  tags: [],
  createdAt: 1,
  updatedAt: 1,
}

function claim(remotePath = '/media/movie.mp4', totalBytes = 5) {
  return {
    fileEntryId: remotePath,
    sourceId: 'source-sftp',
    profileId: profile.id,
    hostFingerprint: profile.hostFingerprint,
    remotePath,
    totalBytes,
  }
}

test('SFTP video retrieval validates media type and both file/cache bounds', async () => {
  const service = new SftpVideoRetrievalService('unused', { maxFileBytes: 10, maxCacheBytes: 8 })
  assert.match((await service.retrieve(claim('/media/readme.txt'), profile, {})).error, /video/i)
  assert.match((await service.retrieve(claim('/media/large.mp4', 11), profile, {})).error, /limit/i)
  assert.match((await service.retrieve(claim('/media/cache.mp4', 9), profile, {})).error, /cache/i)
})

test('SFTP video retrieval is atomic, coalesced, cached, and reports bounded throughput', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-video-'))
  let calls = 0
  const downloader = async (_profile, request) => {
    calls += 1
    await fs.promises.writeFile(request.destinationPath, Buffer.alloc(5, 7), { mode: 0o600 })
    return { transferredBytes: 5, elapsedMs: 25 }
  }
  try {
    const service = new SftpVideoRetrievalService(root, { maxCacheBytes: 20, downloader })
    const first = service.retrieve(claim(), profile, {})
    const joined = service.retrieve(claim(), profile, {})
    assert.strictEqual(first, joined)
    const result = await first
    assert.equal(result.ok, true)
    assert.equal(result.cached, false)
    assert.equal(result.speedBytesPerSecond, 200)
    assert.equal(fs.statSync(result.localPath).size, 5)
    assert.equal(fs.readdirSync(root).some((name) => name.endsWith('.part')), false)
    const cached = await service.retrieve(claim(), profile, {})
    assert.equal(cached.cached, true)
    assert.equal(calls, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('SFTP video retrieval removes partial files and evicts least-recent cache entries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-video-lru-'))
  const downloader = async (_profile, request) => {
    const size = request.remotePath.includes('broken') ? 3 : 5
    await fs.promises.writeFile(request.destinationPath, Buffer.alloc(size), { mode: 0o600 })
    return { transferredBytes: size, elapsedMs: 10 }
  }
  try {
    const service = new SftpVideoRetrievalService(root, { maxCacheBytes: 8, downloader })
    const first = await service.retrieve(claim('/media/one.mp4'), profile, {})
    assert.equal(first.ok, true)
    const second = await service.retrieve(claim('/media/two.mp4'), profile, {})
    assert.equal(second.ok, true)
    assert.equal(fs.existsSync(first.localPath), false)
    assert.equal(fs.existsSync(second.localPath), true)
    const broken = await service.retrieve(claim('/media/broken.mp4'), profile, {})
    assert.equal(broken.ok, false)
    assert.match(broken.error, /changed/i)
    assert.equal(fs.readdirSync(root).some((name) => name.endsWith('.part')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('SFTP video projection joins local cache recall to the authoritative catalog item', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-video-projection-'))
  const localPath = path.join(root, 'cached.mp4')
  fs.writeFileSync(localPath, Buffer.alloc(1))
  const store = new SftpVideoProjectionStore(path.join(root, 'manifests', 'projection.json'))
  try {
    store.upsert({ fileEntryId: '41', localPath, videoId: 'video-1', updatedAt: 1 })
    const [item] = store.hydrate([localPath], {
      getFileEntryForAction: () => ({
        fileEntryId: '41',
        displayName: 'movie.mp4',
        displayPath: 'sftp://nas/media/movie.mp4',
        sizeBytes: 1,
        modifiedAt: 2,
        source: {
          id: 'source-sftp',
          type: 'sftp',
          displayName: 'NAS',
          rootLocator: 'sftp-source://nas/media',
          readOnly: true,
          availability: 'online',
          scanCapability: 'remote-list',
        },
      }),
    })
    assert.equal(item.displayPath, 'sftp://nas/media/movie.mp4')
    assert.equal(item.recallPath, localPath)
    assert.equal(item.fileEntryId, '41')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
