const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const dns = require('node:dns/promises')
const https = require('node:https')
const { EventEmitter } = require('node:events')
const { Readable } = require('node:stream')
const sharp = require('sharp')
const { loadTsModule } = require('./guard-utils.cjs')
const api = loadTsModule('electron/browserQueryImage.ts')

function mockNetwork(t, responses) {
  const requests = []
  t.mock.method(dns, 'lookup', async (host) => [
    { address: host === 'private.test' ? '127.0.0.1' : '93.184.216.34', family: 4 },
  ])
  t.mock.method(https, 'request', (url, options, callback) => {
    requests.push({ url: url.href, options })
    assert.equal(options.agent, false)
    assert.equal(options.family, 4)
    options.lookup(url.hostname, {}, (error, address) => {
      assert.equal(error, null)
      assert.equal(address, '93.184.216.34')
    })
    const response = responses.shift()
    assert.ok(response)
    const request = new EventEmitter()
    request.end = () =>
      queueMicrotask(() => {
        const stream = Readable.from(response.chunks || [Buffer.from('fixture')])
        stream.statusCode = response.status || 200
        stream.headers = response.headers || {}
        callback(stream)
      })
    return request
  })
  return requests
}

test('browser image requests reject local/private targets including mapped IPv6', () => {
  for (const address of [
    '127.0.0.1',
    '0.0.0.0',
    '10.1.2.3',
    '192.168.1.1',
    '172.16.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1',
  ])
    assert.equal(api.isPublicImageAddress(address), false, address)
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])
    assert.equal(api.isPublicImageAddress(address), true, address)
})

test('downloads are credential-free, pinned, bounded and each redirect is checked', async (t) => {
  const requests = mockNetwork(t, [
    { status: 302, headers: { location: '/picture.png' } },
    { chunks: [Buffer.from('image bytes')] },
  ])
  assert.equal(
    (await api.downloadBrowserImage('https://public.test/redirect')).toString(),
    'image bytes',
  )
  assert.equal(requests[1].url, 'https://public.test/picture.png')
  assert.equal(requests[0].options.headers.Cookie, undefined)
  assert.equal(requests[0].options.headers.Authorization, undefined)
  await assert.rejects(api.downloadBrowserImage('https://private.test/image.png'), /Only public/)
  await assert.rejects(api.downloadBrowserImage('file:///C:/secret.png'), /Only public/)
  await assert.rejects(
    api.downloadBrowserImage('https://user:password@public.test/image'),
    /Only public/,
  )
})

test('redirects cannot escape to a private network and oversized bodies are rejected', async (t) => {
  const requests = mockNetwork(t, [
    { status: 302, headers: { location: 'https://private.test/image.png' } },
    { headers: { 'content-length': String(api.MAX_BROWSER_IMAGE_BYTES + 1) } },
    { chunks: [Buffer.alloc(api.MAX_BROWSER_IMAGE_BYTES), Buffer.from([1])] },
  ])
  await assert.rejects(api.downloadBrowserImage('https://public.test/redirect'), /Only public/)
  assert.equal(requests.length, 1)
  await assert.rejects(api.downloadBrowserImage('https://public.test/large'), /16 MiB/)
  await assert.rejects(api.downloadBrowserImage('https://public.test/chunked'), /16 MiB/)
  const aborted = AbortSignal.abort()
  await assert.rejects(api.downloadBrowserImage('https://public.test/timeout', aborted))
})

test('browser pixel imports validate content and normalize bounded images without touching original files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'siftory-browser-image-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const dir = path.join(root, 'image-search-queries')
  await fs.mkdir(dir)
  const original = path.join(dir, 'original.png')
  const oldCopy = path.join(dir, 'browser-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png')
  await fs.writeFile(original, 'keep original')
  await fs.writeFile(oldCopy, 'expired copy')
  await fs.utimes(oldCopy, new Date(0), new Date(0))
  const input = await sharp({
    create: { width: 3000, height: 1000, channels: 3, background: 'red' },
  })
    .jpeg()
    .toBuffer()
  const target = await api.importBrowserQueryImage({ kind: 'bytes', bytes: input }, root)
  assert.equal(path.dirname(target), dir)
  assert.match(path.basename(target), /^browser-[a-f0-9-]+\.png$/)
  const metadata = await sharp(target).metadata()
  assert.equal(metadata.format, 'png')
  assert.equal(metadata.width, 2048)
  assert.equal(await fs.readFile(original, 'utf8'), 'keep original')
  await assert.rejects(fs.stat(oldCopy), { code: 'ENOENT' })
  await assert.rejects(
    api.importBrowserQueryImage(
      { kind: 'bytes', bytes: Buffer.from('<html>Not an image</html>') },
      root,
    ),
  )
  await assert.rejects(
    api.importBrowserQueryImage(
      {
        kind: 'bytes',
        bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>'),
      },
      root,
    ),
    /not a supported image/,
  )
  await assert.rejects(
    api.importBrowserQueryImage(
      { kind: 'bytes', bytes: Buffer.alloc(api.MAX_BROWSER_IMAGE_BYTES + 1) },
      root,
    ),
  )
})
