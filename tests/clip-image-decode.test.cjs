const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const sharp = require('sharp')
const { loadTsModule } = require('./guard-utils.cjs')

const decode = loadTsModule('electron/clipImageDecode.ts')

async function withTempDir(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-clip-alpha-'))
  try {
    await callback(directory)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

async function transformersRawImage() {
  return (await import('@huggingface/transformers')).RawImage
}

test('gray-alpha PNG falls back to a bounded three-channel RawImage', async () => {
  await withTempDir(async (directory) => {
    const imagePath = path.join(directory, 'gray-alpha.png')
    const grayscale = Buffer.from([10, 40, 80, 120])
    const alpha = Buffer.from([255, 128, 64, 0])
    await sharp(grayscale, { raw: { width: 2, height: 2, channels: 1 } })
      .joinChannel(alpha, { raw: { width: 2, height: 2, channels: 1 } })
      .png()
      .toFile(imagePath)
    const RawImage = await transformersRawImage()

    await assert.rejects(() => RawImage.read(imagePath), /channels?|conversion/i)
    const image = await decode.readClipImage(imagePath, RawImage)
    assert.deepEqual(image.size, [2, 2])
    assert.equal(image.channels, 3)
    assert.equal(image.data.length, 12)
  })
})

test('RGB and RGBA images retain the native decoder fast path', async () => {
  await withTempDir(async (directory) => {
    const RawImage = await transformersRawImage()
    for (const channels of [3, 4]) {
      const imagePath = path.join(directory, `native-${channels}.png`)
      const pixel = channels === 3 ? [20, 40, 60] : [20, 40, 60, 128]
      await sharp(Buffer.from(pixel), { raw: { width: 1, height: 1, channels } })
        .png()
        .toFile(imagePath)
      let reads = 0
      const TrackingRawImage = class extends RawImage {
        static async read(filePath) {
          reads += 1
          return RawImage.read(filePath)
        }
      }
      const image = await decode.readClipImage(imagePath, TrackingRawImage)
      assert.equal(reads, 1)
      assert.equal(image.channels, channels)
    }
  })
})

test('non-channel decode errors are not retried through Sharp', async () => {
  await withTempDir(async (directory) => {
    const imagePath = path.join(directory, 'corrupt.png')
    fs.writeFileSync(imagePath, Buffer.from('not an image'))
    let reads = 0
    class FailingRawImage {
      static async read() {
        reads += 1
        throw new Error('corrupt fixture')
      }
    }
    await assert.rejects(() => decode.readClipImage(imagePath, FailingRawImage), /corrupt fixture/)
    assert.equal(reads, 1)
  })
})

test('fallback rejects oversized files before image decoding', async () => {
  await withTempDir(async (directory) => {
    const imagePath = path.join(directory, 'oversized.png')
    fs.writeFileSync(imagePath, Buffer.from([0]))
    fs.truncateSync(imagePath, decode.MAX_CLIP_FALLBACK_FILE_BYTES + 1)
    class ChannelFailingRawImage {
      static async read() {
        throw new Error('unsupported number of channels: 4')
      }
    }
    await assert.rejects(
      () => decode.readClipImage(imagePath, ChannelFailingRawImage),
      /exceeds .* bytes/,
    )
  })
})

test('channel error classifier is narrow and deterministic', () => {
  assert.equal(
    decode.isClipChannelConversionError(new Error('unsupported number of channels: 4')),
    true,
  )
  assert.equal(
    decode.isClipChannelConversionError(new Error('Conversion failed from 2 channels')),
    true,
  )
  assert.equal(decode.isClipChannelConversionError(new Error('Input file is missing')), false)
})

test('tensor prefetch decoder is pixel-identical to native decode plus CLIP affine resize', async () => {
  await withTempDir(async (directory) => {
    const width = 480
    const height = 320
    const pixels = Buffer.alloc(width * height * 3)
    for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * 17) % 251
    const imagePath = path.join(directory, 'oriented-rgb.jpg')
    await sharp(pixels, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 91 })
      .withMetadata({ orientation: 6 })
      .toFile(imagePath)
    const RawImage = await transformersRawImage()
    let baseline = await RawImage.read(imagePath)
    baseline = baseline.rgb()
    const factor = Math.max(
      decode.CLIP_PREFETCH_SHORTEST_EDGE / baseline.width,
      decode.CLIP_PREFETCH_SHORTEST_EDGE / baseline.height,
    )
    const resizedWidth = Math.floor(Number((baseline.width * factor).toFixed(2)))
    const resizedHeight = Math.floor(Number((baseline.height * factor).toFixed(2)))
    baseline = await baseline.resize(resizedWidth, resizedHeight, { resample: 3 })

    let candidate = await decode.readClipTensorPrefetchImage(imagePath, RawImage)
    candidate = candidate.rgb()
    assert.deepEqual(candidate.size, baseline.size)
    assert.deepEqual(candidate.data, baseline.data)
  })
})

test('tensor prefetch decoder preserves the native path for alpha images', async () => {
  await withTempDir(async (directory) => {
    const width = 48
    const height = 32
    const pixels = Buffer.alloc(width * height * 4)
    for (let index = 0; index < pixels.length; index += 4) {
      pixels[index] = (index * 7) % 251
      pixels[index + 1] = (index * 11) % 253
      pixels[index + 2] = (index * 13) % 255
      pixels[index + 3] = index % 256
    }
    const imagePath = path.join(directory, 'rgba.png')
    await sharp(pixels, { raw: { width, height, channels: 4 } })
      .png()
      .toFile(imagePath)
    const RawImage = await transformersRawImage()
    const baseline = await RawImage.read(imagePath)
    const candidate = await decode.readClipTensorPrefetchImage(imagePath, RawImage)
    assert.equal(candidate.channels, 4)
    assert.deepEqual(candidate.size, baseline.size)
    assert.deepEqual(candidate.data, baseline.data)
  })
})

test('CLIP child routes single, CUDA, and batch image reads through the bounded decoder', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'clipEmbeddingChild.ts'),
    'utf8',
  )
  assert.match(source, /readClipTensorPrefetchImage/)
  assert.equal([...source.matchAll(/readClipImage\(/g)].length, 3)
  assert.equal([...source.matchAll(/readClipTensorPrefetchImage\(/g)].length, 1)
  assert.doesNotMatch(source, /RawImage\.read\(/)
})
