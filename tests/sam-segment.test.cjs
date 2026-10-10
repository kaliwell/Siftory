// Integration tests for MobileSAM click segmentation
// (electron/samSegmentService.ts). The service resolves models from user
// Model Platform slots; the fixture installer copies
// models/mobilesam/{encoder,decoder}.onnx into an isolated temporary
// userData root and skips cleanly when the fixture sources are not
// available.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const sharp = require('sharp')
const { loadTsModule } = require('./guard-utils.cjs')
const { installModelPlatformFixtures } = require('./model-fixture-utils.cjs')

const modelFixture = installModelPlatformFixtures([
  { slotId: 'segment-encoder', source: 'models/mobilesam/encoder.onnx' },
  { slotId: 'segment-decoder', source: 'models/mobilesam/decoder.onnx' },
])

const sam = loadTsModule('electron/samSegmentService.ts')
const maskCodec = loadTsModule('electron/embeddingChildLineFraming.ts')

const fixture = (name) => path.resolve(__dirname, 'fixtures/faces', name)

test('SAM mask transport selects the best IoU plane without changing its threshold', () => {
  const packed = maskCodec.packBestSamMask(
    [1, 3, 2, 4],
    new Float32Array([
      -1, -1, -1, -1, -1, -1, -1, -1, -1, 0.1, -1, 2, 0, -3, 4, -1, 1, 1, 1, 1, 1, 1, 1, 1,
    ]),
    new Float32Array([0.2, 0.9, 0.4]),
  )
  assert.equal(packed.width, 4)
  assert.equal(packed.height, 2)
  assert.ok(Math.abs(packed.iou - 0.9) < 1e-6)
  assert.deepEqual(
    Array.from({ length: 8 }, (_, index) =>
      maskCodec.packedSamMaskHasPixel(packed.maskBits, index),
    ),
    [false, true, false, true, false, false, true, false],
  )
})

test('a 4K multi-mask decoder result is compact enough for the bounded runtime frame', () => {
  const width = 3840
  const height = 2160
  const masks = 4
  const legacyBase64Bytes = Math.ceil((width * height * masks * 4) / 3) * 4
  const packedBytes = maskCodec.packedSamMaskByteLength(width, height)
  assert.ok(legacyBase64Bytes > 96 * 1024 * 1024)
  assert.ok(packedBytes < 2 * 1024 * 1024)
  assert.ok(legacyBase64Bytes / packedBytes > 100)
})

test('SAM mask transport rejects malformed model output', () => {
  assert.throws(
    () => maskCodec.packBestSamMask([1, 2, 2, 2], new Float32Array(8), new Float32Array([0.5])),
    /too few IoU/,
  )
  assert.throws(
    () =>
      maskCodec.packBestSamMask(
        [1, 1, 1, 2],
        new Float32Array([Number.NaN, 1]),
        new Float32Array([0.5]),
      ),
    /non-finite mask/,
  )
})

test('sam segmentation requires models', { skip: !modelFixture.present }, async (t) => {
  await t.test('status reports ready with models installed', async () => {
    const status = await sam.getSamStatus()
    assert.equal(status.ready, true, status.error)
  })

  await t.test('foreground prompt maps into the original-size output mask', async () => {
    const result = await sam.segmentAtPoint(fixture('obama.jpg'), [{ x: 460, y: 180 }])
    assert.equal(result.ok, true, result.error)
    assert.ok(result.iou > 0.5, `iou too low: ${result.iou}`)
    const b = result.bbox
    // The corrected coordinate transform may select the full connected
    // person rather than only the head, but it must contain the prompt.
    assert.ok(b.y < 200)
    assert.ok(b.h > 100 && b.h < 1100)
    assert.ok(b.x > 100 && b.x < 700)
    assert.ok(b.x <= 460 && b.x + b.w > 460)
    assert.ok(b.y <= 180 && b.y + b.h > 180)
    assert.ok(result.maskPngDataUrl.startsWith('data:image/png;base64,'))
    assert.ok(result.sourceSize > 0)
    assert.ok(result.sourceMtimeMs > 0)
    const maskPng = Buffer.from(result.maskPngDataUrl.split(',')[1], 'base64')
    const { data: mask, info } = await sharp(maskPng).raw().toBuffer({ resolveWithObject: true })
    assert.equal(info.width, 960)
    assert.equal(info.height, 1199)
    const promptPixel = (180 * info.width + 460) * info.channels
    assert.ok(mask[promptPixel] > 0, 'foreground prompt must land inside the mask')
  })

  await t.test('4K source mask stays below the runtime line limit', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sam-4k-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const imagePath = path.join(directory, 'obama-4k.jpg')
    await sharp(fixture('obama.jpg'))
      .resize(3840, 2160, { fit: 'fill' })
      .jpeg({ quality: 85 })
      .toFile(imagePath)

    const result = await sam.segmentAtPoint(imagePath, [{ x: 1840, y: 324 }])
    assert.equal(result.ok, true, result.error)
    assert.equal(result.width, 3840)
    assert.equal(result.height, 2160)
    assert.ok(result.bbox.x <= 1840 && result.bbox.x + result.bbox.w > 1840)
    assert.ok(result.bbox.y <= 324 && result.bbox.y + result.bbox.h > 324)
  })

  await t.test('second call on the same image reuses the cached embedding', async () => {
    const a = await sam.segmentAtPoint(fixture('obama.jpg'), [{ x: 460, y: 180 }])
    const b = await sam.segmentAtPoint(fixture('obama.jpg'), [{ x: 460, y: 700 }])
    assert.ok(a.ok && b.ok)
    // different point → different mask bbox (body vs head)
    assert.notDeepEqual(a.bbox, b.bbox)
  })

  await t.test('box prompt segments an original-image region', async () => {
    const result = await sam.segmentAtPoint(fixture('obama.jpg'), [
      { x: 280, y: 40, label: 2 },
      { x: 680, y: 480, label: 3 },
    ])
    assert.equal(result.ok, true, result.error)
    assert.ok(result.bbox.w > 100)
    assert.ok(result.bbox.h > 100)
    assert.ok(result.bbox.x < 680 && result.bbox.x + result.bbox.w > 280)
    assert.ok(result.bbox.y < 480 && result.bbox.y + result.bbox.h > 40)
  })

  await t.test('missing image degrades to ok:false', async () => {
    const result = await sam.segmentAtPoint(fixture('does-not-exist.jpg'), [{ x: 1, y: 1 }])
    assert.equal(result.ok, false)
  })
})

test.after(() => modelFixture.cleanup())
