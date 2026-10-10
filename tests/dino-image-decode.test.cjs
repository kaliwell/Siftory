const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const sharp = require('sharp')
const { loadTsModule } = require('./guard-utils.cjs')

const decode = loadTsModule('electron/dinoImageDecode.ts')

test('DINO fused resize remains an explicit default-off diagnostic child path', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'dinoEmbeddingChild.ts'),
    'utf8',
  )
  assert.match(source, /REASONIX_DINO_FUSED_SHADOW === '1'/)
  assert.match(source, /dinoFusedShadowEnabled\s*\?\s*readDinoTensorPrefetchImage/)
  assert.match(source, /:\s*readDinoImageBounded/)
})

function localModelRoot() {
  return path.join(process.env.APPDATA || '', 'floating-clock-electron', 'models', 'dinov2_vitb14')
}

async function loadRuntime() {
  const transformers = await import('@huggingface/transformers')
  const root = localModelRoot()
  const config = path.join(root, 'Xenova', 'dinov2-base', 'preprocessor_config.json')
  if (!fs.existsSync(config)) return null
  transformers.env.localModelPath = root
  transformers.env.cacheDir = path.join(root, '.transformers-cache')
  transformers.env.allowLocalModels = true
  transformers.env.allowRemoteModels = false
  return {
    RawImage: transformers.RawImage,
    processor: await transformers.AutoProcessor.from_pretrained('Xenova/dinov2-base'),
  }
}

function tensor(result) {
  const value = result?.pixel_values
  assert.ok(value)
  assert.ok(value.data instanceof Float32Array)
  return value
}

async function assertTensorParity(runtime, imagePath) {
  const baselineImage = await decode.readDinoImage(imagePath, runtime.RawImage)
  const candidateImage = await decode.readDinoTensorPrefetchImage(imagePath, runtime.RawImage)
  const baseline = tensor(await runtime.processor(baselineImage))
  const candidate = tensor(await runtime.processor(candidateImage))
  assert.deepEqual(candidate.dims, baseline.dims)
  assert.deepEqual(candidate.data, baseline.data)
}

test('DINO fused-resize shadow preserves EXIF, alpha, grayscale, and recoverable JPEG tensors', async (t) => {
  const runtime = await loadRuntime()
  if (!runtime) return t.skip('local DINO processor is not installed')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dino-fused-shadow-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const width = 480
  const height = 320
  const rgb = Buffer.alloc(width * height * 3)
  for (let index = 0; index < rgb.length; index += 1) rgb[index] = (index * 17) % 251
  const oriented = path.join(root, 'oriented-rgb.jpg')
  await sharp(rgb, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 91 })
    .withMetadata({ orientation: 6 })
    .toFile(oriented)

  const alpha = path.join(root, 'alpha.png')
  const rgba = Buffer.alloc(96 * 64 * 4)
  for (let index = 0; index < rgba.length; index += 4) {
    rgba[index] = (index * 7) % 251
    rgba[index + 1] = (index * 11) % 253
    rgba[index + 2] = (index * 13) % 255
    rgba[index + 3] = index % 256
  }
  await sharp(rgba, { raw: { width: 96, height: 64, channels: 4 } })
    .png()
    .toFile(alpha)

  const grayscale = path.join(root, 'grayscale.png')
  const gray = Buffer.alloc(71 * 53)
  for (let index = 0; index < gray.length; index += 1) gray[index] = (index * 19) % 256
  await sharp(gray, { raw: { width: 71, height: 53, channels: 1 } })
    .png()
    .toFile(grayscale)

  const truncated = path.join(root, 'truncated.jpg')
  const complete = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 })
    .toBuffer()
  fs.writeFileSync(truncated, complete.subarray(0, complete.length - 32))

  for (const imagePath of [oriented, alpha, grayscale, truncated]) {
    await assertTensorParity(runtime, imagePath)
  }
})

test('DINO baseline and fused-resize shadow both reject oversized dimensions', async (t) => {
  const runtime = await loadRuntime()
  if (!runtime) return t.skip('local DINO processor is not installed')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dino-oversized-shadow-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const imagePath = path.join(root, 'oversized.svg')
  fs.writeFileSync(
    imagePath,
    '<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="100000"></svg>',
  )
  await assert.rejects(() => decode.readDinoImage(imagePath, runtime.RawImage), /pixel|limit/i)
  await assert.rejects(
    () => decode.readDinoTensorPrefetchImage(imagePath, runtime.RawImage),
    /pixel|limit|dimension/i,
  )
})
