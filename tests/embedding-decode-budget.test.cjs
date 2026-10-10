const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const sharp = require('sharp')
const { loadTsModule } = require('./guard-utils.cjs')

const budget = loadTsModule('electron/embeddingDecodeBudget.ts')

function header(width, height) {
  const pixels = width * height
  return {
    width,
    height,
    rgbBytes: pixels * 3,
    highRisk:
      pixels >= budget.EMBEDDING_DECODE_HIGH_RISK_PIXELS ||
      Math.max(width, height) / Math.min(width, height) >=
        budget.EMBEDDING_DECODE_HIGH_RISK_ASPECT_RATIO,
  }
}

test('ordinary default batches stay together under the RGB byte budget', () => {
  const headers = Array.from({ length: 4 }, () => header(4000, 3000))
  assert.deepEqual(budget.planEmbeddingDecodeWaves(headers), [[0, 1, 2, 3]])
  assert.equal(budget.embeddingBatchRequiresSerialProcessing(headers), false)
})

test('80 MP, 1:100 panoramas, and aggregate RGB pressure reduce decode concurrency', () => {
  assert.deepEqual(
    budget.planEmbeddingDecodeWaves([
      header(10_240, 8_192),
      header(10_000, 100),
      header(8000, 7500),
      header(8000, 7500),
    ]),
    [[0], [1], [2], [3]],
  )
  assert.deepEqual(budget.planEmbeddingDecodeWaves([header(6000, 5000), header(6000, 5000)]), [
    [0, 1],
  ])
  assert.deepEqual(
    budget.planEmbeddingDecodeWaves([header(6000, 5000), header(6000, 5000)], 128 * 1024 * 1024),
    [[0], [1]],
  )
  assert.equal(
    budget.embeddingBatchRequiresSerialProcessing([header(10_240, 8_192), header(8000, 7500)]),
    true,
  )
  assert.equal(
    budget.peakEmbeddingDecodedRgbBytes([header(10_240, 8_192), header(8000, 7500)]),
    10_240 * 8_192 * 3,
  )
})

test('DINO and CLIP complete over-budget batches as serial decode-inference units', () => {
  for (const child of ['dinoEmbeddingChild.ts', 'clipEmbeddingChild.ts']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'electron', child), 'utf8')
    assert.match(source, /embeddingBatchRequiresSerialProcessing\(preparedHeaders\)/)
    assert.match(source, /peakEmbeddingDecodedRgbBytes\(preparedHeaders\)/)
    assert.match(source, /for \(const task of tasks\)/)
  }
})

test('header-first wave decoding preserves order and corrupt-image rejection', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-decode-budget-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const first = path.join(root, 'first.png')
  const second = path.join(root, 'second.png')
  const corrupt = path.join(root, 'corrupt.png')
  await sharp({ create: { width: 32, height: 16, channels: 3, background: '#123456' } })
    .png()
    .toFile(first)
  await sharp({ create: { width: 20, height: 10, channels: 4, background: '#abcdef' } })
    .png()
    .toFile(second)
  fs.writeFileSync(corrupt, 'not-an-image')

  const decoded = await budget.decodeEmbeddingImagesInWaves(
    [first, corrupt, second],
    async (imagePath) => {
      const metadata = await sharp(imagePath).metadata()
      return `${metadata.width}x${metadata.height}`
    },
  )
  assert.equal(decoded.headers[0].rgbBytes, 32 * 16 * 3)
  assert.equal(decoded.headers[1], null)
  assert.equal(decoded.results[0].status, 'fulfilled')
  assert.equal(decoded.results[0].value, '32x16')
  assert.equal(decoded.results[1].status, 'rejected')
  assert.equal(decoded.results[2].status, 'fulfilled')
  assert.equal(decoded.results[2].value, '20x10')
})

test('fast JPEG header probe applies EXIF orientation without invoking full decode', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-fast-header-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const imagePath = path.join(root, 'oriented.jpg')
  await sharp({ create: { width: 640, height: 320, channels: 3, background: '#123456' } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toFile(imagePath)
  assert.deepEqual(await budget.probeEmbeddingImageHeader(imagePath), {
    width: 320,
    height: 640,
    rgbBytes: 320 * 640 * 3,
    highRisk: false,
  })
})

test('formats outside the fast header parser retain the Sharp metadata fallback', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-header-fallback-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const imagePath = path.join(root, 'fallback.tiff')
  await sharp({ create: { width: 48, height: 24, channels: 3, background: '#123456' } })
    .tiff()
    .toFile(imagePath)
  assert.deepEqual(await budget.probeEmbeddingImageHeader(imagePath), {
    width: 48,
    height: 24,
    rgbBytes: 48 * 24 * 3,
    highRisk: false,
  })
})
