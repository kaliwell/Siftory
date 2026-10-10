const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const sharp = require('sharp')
const { loadTsModule } = require('./guard-utils.cjs')

const { SubjectMaskSessionStore } = loadTsModule('electron/subjectMaskSession.ts')
const { createSubjectMaskQueryFiles } = loadTsModule('electron/subjectMaskQuery.ts')

function sessionData(overrides = {}) {
  return {
    imagePath: path.resolve('query.png'),
    size: 123,
    mtimeMs: 456,
    width: 20,
    height: 10,
    bbox: { x: 2, y: 1, w: 8, h: 7 },
    maskPng: Buffer.from('mask'),
    ...overrides,
  }
}

test('subject mask sessions are sender, source fingerprint, and TTL scoped', () => {
  let now = 1000
  let sequence = 0
  const store = new SubjectMaskSessionStore(
    () => now,
    () => `token-${++sequence}`,
    100,
    2,
  )
  const data = sessionData()
  const token = store.issue(7, data)
  assert.equal(token, 'token-1')
  assert.deepEqual(
    store.resolve(7, token, {
      imagePath: data.imagePath,
      size: data.size,
      mtimeMs: data.mtimeMs,
    })?.bbox,
    data.bbox,
  )
  assert.equal(
    store.resolve(8, token, {
      imagePath: data.imagePath,
      size: data.size,
      mtimeMs: data.mtimeMs,
    }),
    null,
  )
  assert.equal(
    store.resolve(7, token, {
      imagePath: data.imagePath,
      size: data.size + 1,
      mtimeMs: data.mtimeMs,
    }),
    null,
  )
  now = 1100
  assert.equal(
    store.resolve(7, token, {
      imagePath: data.imagePath,
      size: data.size,
      mtimeMs: data.mtimeMs,
    }),
    null,
  )
})

test('subject mask session copies buffers and evicts oldest capabilities', () => {
  let sequence = 0
  const store = new SubjectMaskSessionStore(
    () => 0,
    () => `token-${++sequence}`,
    1000,
    2,
  )
  const first = sessionData()
  const firstToken = store.issue(1, first)
  first.maskPng[0] = 0
  const secondToken = store.issue(1, sessionData({ imagePath: path.resolve('second.png') }))
  store.issue(1, sessionData({ imagePath: path.resolve('third.png') }))
  assert.equal(
    store.resolve(1, firstToken, {
      imagePath: first.imagePath,
      size: first.size,
      mtimeMs: first.mtimeMs,
    }),
    null,
  )
  const second = store.resolve(1, secondToken, {
    imagePath: path.resolve('second.png'),
    size: 123,
    mtimeMs: 456,
  })
  assert.equal(second.maskPng.toString(), 'mask')
})

test('masked query removes original background pixels while preserving the subject', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subject-mask-query-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const width = 8
  const height = 8
  const rgb = Buffer.alloc(width * height * 3)
  const mask = Buffer.alloc(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3
      const subject = x >= 2 && x < 6 && y >= 2 && y < 6
      rgb[offset] = subject ? 240 : 10
      rgb[offset + 1] = subject ? 30 : 80
      rgb[offset + 2] = subject ? 20 : 220
      mask[y * width + x] = subject ? 255 : 0
    }
  }
  const imagePath = path.join(tmpDir, 'source.png')
  const maskPng = await sharp(mask, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer()
  await sharp(rgb, { raw: { width, height, channels: 3 } })
    .png()
    .toFile(imagePath)

  const files = await createSubjectMaskQueryFiles(
    imagePath,
    maskPng,
    { x: 0, y: 0, w: width, h: height },
    tmpDir,
  )
  const { data, info } = await sharp(files.maskedCropPath)
    .raw()
    .toBuffer({ resolveWithObject: true })
  assert.equal(info.channels, 3)
  assert.deepEqual([...data.subarray(0, 3)], [127, 127, 127])
  const center = (3 * width + 3) * 3
  assert.deepEqual([...data.subarray(center, center + 3)], [240, 30, 20])
  assert.match(files.maskHash, /^[a-f0-9]{64}$/)
  assert.equal(fs.existsSync(files.contextCropPath), true)
})

test('masked query rejects a mask from another image size', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subject-mask-invalid-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const imagePath = path.join(tmpDir, 'source.png')
  await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } })
    .png()
    .toFile(imagePath)
  const badMask = await sharp({
    create: { width: 7, height: 8, channels: 3, background: 'white' },
  })
    .greyscale()
    .png()
    .toBuffer()
  await assert.rejects(
    createSubjectMaskQueryFiles(imagePath, badMask, { x: 0, y: 0, w: 8, h: 8 }, tmpDir),
    /dimensions do not match/,
  )
})

test('renderer submits only an opaque session id, never a mask payload', () => {
  const root = path.resolve(__dirname, '..')
  const picker = fs.readFileSync(path.join(root, 'src/components/SubjectPickerModal.tsx'), 'utf8')
  const preload = fs.readFileSync(path.join(root, 'electron/preload.ts'), 'utf8')
  const ipc = fs.readFileSync(path.join(root, 'electron/subjectSearchIpc.ts'), 'utf8')
  assert.match(picker, /segmentationSessionId/)
  assert.match(preload, /subject:search.*segmentationSessionId/s)
  assert.match(ipc, /subjectMaskSessions\.resolve\(event\.sender\.id/)
  assert.doesNotMatch(preload, /subject:search.*maskPngDataUrl/s)
})
