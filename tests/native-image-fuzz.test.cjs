'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const WORKER = path.join(__dirname, 'native-image-fuzz-worker.cjs')
const CASE_TIMEOUT_MS = 1_500
const TOTAL_BUDGET_MS = 25_000
const MAX_CASE_BYTES = 4 * 1024
const EXPECTED_CORPUS_SHA256 = 'a37af86f5da880cbaf610bef44f809a6cc83296a799c57c4e31cd2893c73c042'
const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
const VALID_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYI1KiQzQ1NjdTVFVHV2h1dnd4eXqCg4SFhoeIiYqLjI1Oj4KTlJWWl5iZmpucnZ6fkqOkpaanqKmqq6usra6u/9oADAMBAAIRAxEAPwD/2Q==',
  'base64',
)

function seededBytes(length, initialState) {
  let state = initialState >>> 0
  const bytes = Buffer.alloc(length)
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    bytes[index] = state & 0xff
  }
  return bytes
}

function pngHeader(width, height) {
  const bytes = Buffer.alloc(33)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width >>> 0, 16)
  bytes.writeUInt32BE(height >>> 0, 20)
  bytes[24] = 8
  bytes[25] = 6
  return bytes
}

function bmpHeader(width, height, bitsPerPixel = 24) {
  const bytes = Buffer.alloc(54)
  bytes.write('BM', 0, 'ascii')
  bytes.writeUInt32LE(bytes.length, 2)
  bytes.writeUInt32LE(54, 10)
  bytes.writeUInt32LE(40, 14)
  bytes.writeInt32LE(width, 18)
  bytes.writeInt32LE(height, 22)
  bytes.writeUInt16LE(1, 26)
  bytes.writeUInt16LE(bitsPerPixel, 28)
  return bytes
}

function jpegSof(width, height) {
  const bytes = Buffer.alloc(23)
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]).copy(bytes)
  bytes.writeUInt16BE(height, 7)
  bytes.writeUInt16BE(width, 9)
  Buffer.from([0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9]).copy(
    bytes,
    11,
  )
  return bytes
}

function gifHeader(width, height) {
  const bytes = Buffer.alloc(13)
  bytes.write('GIF89a', 0, 'ascii')
  bytes.writeUInt16LE(width, 6)
  bytes.writeUInt16LE(height, 8)
  bytes[10] = 0x80
  return bytes
}

function webpVp8x(widthMinusOne, heightMinusOne) {
  const bytes = Buffer.alloc(30)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(22, 4)
  bytes.write('WEBPVP8X', 8, 'ascii')
  bytes.writeUInt32LE(10, 16)
  bytes.writeUIntLE(widthMinusOne, 24, 3)
  bytes.writeUIntLE(heightMinusOne, 27, 3)
  return bytes
}

function buildCorpus() {
  const cases = [
    { name: 'control-valid.png', bytes: VALID_PNG, expectation: 'accept' },
    { name: 'empty.png', bytes: Buffer.alloc(0), expectation: 'reject' },
    { name: 'png-signature-only.png', bytes: VALID_PNG.subarray(0, 8), expectation: 'reject' },
    { name: 'png-truncated-ihdr.png', bytes: VALID_PNG.subarray(0, 24), expectation: 'reject' },
    { name: 'png-truncated-body.png', bytes: VALID_PNG.subarray(0, 48), expectation: 'reject' },
    { name: 'png-dimension-overflow.png', bytes: pngHeader(0xffffffff, 1), expectation: 'reject' },
    { name: 'png-pixel-budget.png', bytes: pngHeader(20_000, 20_000), expectation: 'reject' },
    { name: 'jpeg-soi-only.jpg', bytes: VALID_JPEG.subarray(0, 2), expectation: 'reject' },
    { name: 'jpeg-truncated-table.jpg', bytes: VALID_JPEG.subarray(0, 64), expectation: 'reject' },
    {
      name: 'jpeg-truncated-before-sof.jpg',
      bytes: VALID_JPEG.subarray(0, 120),
      expectation: 'reject',
    },
    { name: 'jpeg-dimension-limit.jpg', bytes: jpegSof(40_000, 1), expectation: 'reject' },
    { name: 'jpeg-pixel-budget.jpg', bytes: jpegSof(20_000, 20_000), expectation: 'reject' },
    { name: 'bmp-zero-width.bmp', bytes: bmpHeader(0, 1), expectation: 'reject' },
    { name: 'bmp-negative-width.bmp', bytes: bmpHeader(-1, 1), expectation: 'reject' },
    { name: 'bmp-dimension-limit.bmp', bytes: bmpHeader(40_000, 1), expectation: 'reject' },
    { name: 'bmp-pixel-budget.bmp', bytes: bmpHeader(20_000, 20_000), expectation: 'reject' },
    { name: 'bmp-memory-budget.bmp', bytes: bmpHeader(10_000, 8_000, 32), expectation: 'reject' },
    { name: 'gif-truncated.gif', bytes: gifHeader(1, 1), expectation: 'reject' },
    { name: 'gif-pixel-budget.gif', bytes: gifHeader(0xffff, 0xffff), expectation: 'reject' },
    {
      name: 'webp-dimension-overflow.webp',
      bytes: webpVp8x(0xffffff, 0xffffff),
      expectation: 'reject',
    },
  ]

  const randomExtensions = ['png', 'jpg', 'gif', 'bmp', 'webp', 'bin']
  const randomLengths = [1, 7, 16, 31, 64, 255, 1024, 4096]
  randomLengths.forEach((length, index) => {
    const bytes = seededBytes(length, 0xc0ffee ^ (index * 0x9e3779b9))
    bytes[0] ^= 0x5a
    cases.push({
      name: `random-${String(index).padStart(2, '0')}.${randomExtensions[index % randomExtensions.length]}`,
      bytes,
      expectation: 'reject',
    })
  })
  return cases
}

function corpusDigest(cases) {
  const digest = crypto.createHash('sha256')
  for (const item of cases) {
    digest.update(item.name)
    digest.update('\0')
    digest.update(item.expectation)
    digest.update('\0')
    digest.update(item.bytes)
  }
  return digest.digest('hex')
}

test(
  'native image decoder rejects deterministic hostile corpus without crash or hang',
  { timeout: 30_000 },
  (context) => {
    const cases = buildCorpus()
    assert.equal(cases.length, 28)
    assert.ok(cases.every((item) => item.bytes.length <= MAX_CASE_BYTES))
    assert.equal(corpusDigest(cases), EXPECTED_CORPUS_SHA256)

    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-native-fuzz-'))
    const startedAt = Date.now()
    try {
      for (const item of cases) {
        const filePath = path.join(temporaryRoot, item.name)
        fs.writeFileSync(filePath, item.bytes, { flag: 'wx' })
        const child = spawnSync(
          process.execPath,
          [WORKER, temporaryRoot, filePath, item.expectation],
          {
            cwd: path.join(__dirname, '..'),
            encoding: 'utf8',
            env: { ...process.env, REASONIX_NATIVE_FUZZ_WORKER: '1' },
            maxBuffer: 64 * 1024,
            shell: false,
            timeout: CASE_TIMEOUT_MS,
            windowsHide: true,
          },
        )

        const details = [child.stdout, child.stderr].filter(Boolean).join('\n').slice(0, 2_000)
        assert.notEqual(child.error?.code, 'ETIMEDOUT', `${item.name} exceeded ${CASE_TIMEOUT_MS} ms`)
        assert.equal(child.signal, null, `${item.name} terminated by ${child.signal}: ${details}`)
        assert.equal(child.status, 0, `${item.name} crashed or failed closed incorrectly: ${details}`)
        assert.ok(
          Date.now() - startedAt < TOTAL_BUDGET_MS,
          `native fuzz corpus exceeded the ${TOTAL_BUDGET_MS} ms total budget`,
        )
      }

      context.diagnostic(
        `native fuzz corpus: ${cases.length} cases, seed=0x00c0ffee, sha256=${corpusDigest(cases)}, elapsed=${Date.now() - startedAt}ms`,
      )
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true })
    }
  },
)
