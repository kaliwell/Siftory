const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')
const { recheckEmbeddingInputFailure, reviewEmbeddingInputFailures } = loadTsModule(
  'electron/embeddingInputFailureReview.ts',
)

function jpeg({ depth = 8, marker = 0xc0, width = 640, height = 480 } = {}) {
  const b = Buffer.alloc(23)
  b.set([255, 216, 255, marker])
  b.writeUInt16BE(17, 4)
  b[6] = depth
  b.writeUInt16BE(height, 7)
  b.writeUInt16BE(width, 9)
  b[11] = 3
  b.set([1, 17, 0, 2, 17, 1, 3, 17, 1, 255, 217], 12)
  return b
}

function png(width = 640, height = 480) {
  const b = Buffer.alloc(33)
  b.set([137, 80, 78, 71, 13, 10, 26, 10])
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12)
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  b[24] = 8
  b[25] = 2
  return b
}

async function fixture(t, bytes, error, suffix = '.jpg') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'embedding-input-review-'))
  t.after(() => fs.rm(root, { force: true, recursive: true }))
  const inputPath = path.join(root, `input${suffix}`)
  await fs.writeFile(inputPath, bytes)
  return { inputPath, error, inputFailure: true, modelName: 'dinov2_vitb14' }
}

test('12-bit and arithmetic JPEG headers independently explain an unknown decode failure', async (t) => {
  for (const options of [
    { depth: 12 },
    { marker: 0xc9 },
    { marker: 0xca },
    { depth: 12, marker: 0xca },
  ]) {
    const result = await recheckEmbeddingInputFailure(
      await fixture(t, jpeg(options), 'Unknown error'),
    )
    assert.equal(result.code, 'INPUT_NOT_SUPPORTED')
    assert.equal(result.format, 'jpeg')
    assert.equal(result.depth, options.depth || 8)
  }
})

test('a baseline JPEG with an unknown error remains a real failure', async (t) => {
  assert.equal(await recheckEmbeddingInputFailure(await fixture(t, jpeg(), 'Unknown error')), null)
})

test('an unmarked runtime unknown error stays fatal even for an unsupported header', async (t) => {
  const input = await fixture(t, jpeg({ depth: 12 }), 'Unknown error')
  assert.equal(await recheckEmbeddingInputFailure({ ...input, inputFailure: false }), null)
  const { decodeEmbeddingInput, embeddingWorkerFailure } = loadTsModule(
    'shared/embeddingInputFailure.ts',
  )
  let failure
  try {
    await decodeEmbeddingInput(async () => {
      throw Error('Unknown error')
    })
  } catch (error) {
    failure = embeddingWorkerFailure(error)
  }
  assert.deepEqual(failure, { error: 'Unknown error', inputFailure: true })
  assert.deepEqual(embeddingWorkerFailure(Error('Unknown error')), { error: 'Unknown error' })
  const { workerResultFromChildMessage } = loadTsModule('electron/embeddingChildLineFraming.ts')
  const task = { imageId: 'a.jpg', modelName: 'dinov2_vitb14', dim: 2 }
  assert.equal(
    workerResultFromChildMessage(task, { ok: false, ...failure }, 'DINO').inputFailure,
    true,
  )
  assert.equal(
    workerResultFromChildMessage(
      task,
      { ok: false, error: 'Unknown error', inputFailure: 'true' },
      'DINO',
    ).inputFailure,
    undefined,
  )
  assert.equal(
    workerResultFromChildMessage(task, { ok: true, vector: [NaN, 1], inputFailure: true }, 'DINO')
      .inputFailure,
    undefined,
  )
})

test('decoder failures remain distinct from invalid signatures and invalid headers', async (t) => {
  const empty = await recheckEmbeddingInputFailure(
    await fixture(t, Buffer.alloc(0), 'Input Buffer is empty'),
  )
  assert.equal(empty.code, 'INPUT_INVALID_HEADER')
  const payload = await recheckEmbeddingInputFailure(
    await fixture(t, png(), 'vipspng: libpng read error', '.png'),
  )
  assert.equal(payload.code, 'INPUT_DECODE_REJECTED')
  const spoofed = await recheckEmbeddingInputFailure(
    await fixture(
      t,
      Buffer.from('not an image'),
      'Input buffer contains unsupported image format',
      '.png',
    ),
  )
  assert.equal(spoofed.code, 'INPUT_NOT_SUPPORTED')
  const truncated = await recheckEmbeddingInputFailure(
    await fixture(t, png().subarray(0, 20), 'vipspng: libpng read error', '.png'),
  )
  assert.equal(truncated.code, 'INPUT_INVALID_HEADER')
})

test('large-image rejection requires actual header dimensions over the model limit', async (t) => {
  const large = await recheckEmbeddingInputFailure(
    await fixture(t, png(10000, 10000), 'Input image exceeds pixel limit', '.png'),
  )
  assert.equal(large.code, 'INPUT_PIXEL_LIMIT')
  assert.equal(large.width, 10000)
  assert.equal(
    await recheckEmbeddingInputFailure(
      await fixture(t, png(), 'Input image exceeds pixel limit', '.png'),
    ),
    null,
  )
})

test('unsupported BMP and AppleDouble sources are skipped using content rather than extension', async (t) => {
  const b = Buffer.alloc(54)
  b.write('BM')
  b.writeUInt32LE(40, 14)
  b.writeInt32LE(100, 18)
  b.writeInt32LE(100, 22)
  b.writeUInt16LE(24, 28)
  const bmp = await recheckEmbeddingInputFailure(
    await fixture(t, b, 'Input buffer contains unsupported image format', '.png'),
  )
  assert.equal(bmp.format, 'bmp')
  assert.equal(bmp.code, 'INPUT_DECODE_REJECTED')
  const apple = await recheckEmbeddingInputFailure(
    await fixture(t, Buffer.from([0, 5, 22, 7, 0, 2, 0, 0]), 'Unknown error', '.jpg'),
  )
  assert.equal(apple.format, 'appledouble')
})

test('GPU, model, provider, tensor, worker and storage failures cannot be hidden by bad input', async (t) => {
  for (const error of [
    'CUDA out of memory',
    'ONNX model session failed',
    'DirectML execution provider failed',
    'Invalid inference tensor',
    'DINO child crashed',
    'Vector persistence failed: ENOSPC',
    'EACCES: file denied',
    'jpegload_buffer: load error\nCUDA allocation failed',
  ]) {
    assert.equal(
      await recheckEmbeddingInputFailure(await fixture(t, jpeg({ depth: 12 }), error)),
      null,
      error,
    )
  }
})

test('missing files remain errors; JPEG dimensions are reachable past large APP blocks', async (t) => {
  const missing = await fixture(t, jpeg(), 'Unknown error')
  await fs.unlink(missing.inputPath)
  assert.equal(await recheckEmbeddingInputFailure(missing), null)
  const app = Buffer.alloc(65539)
  app.set([255, 216, 255, 225, 255, 255])
  const longHeader = await fixture(
    t,
    Buffer.concat([app, jpeg({ depth: 12 }).subarray(2)]),
    'Unknown error',
  )
  assert.equal((await recheckEmbeddingInputFailure(longHeader)).code, 'INPUT_NOT_SUPPORTED')
  const largeImage = await fixture(
    t,
    Buffer.concat([app, app.subarray(2), jpeg({ width: 10000, height: 10000 }).subarray(2)]),
    'Input image exceeds pixel limit',
  )
  const result = await recheckEmbeddingInputFailure(largeImage)
  assert.equal(result.code, 'INPUT_PIXEL_LIMIT')
  assert.equal(result.width, 10000)
  assert.equal(result.height, 10000)
})

test('review is cancellable and preserves input association', async (t) => {
  const inputs = [
    await fixture(t, jpeg({ depth: 12 }), 'Unknown error'),
    await fixture(t, jpeg(), 'Unknown error'),
  ]
  assert.deepEqual(await reviewEmbeddingInputFailures(inputs, () => true), [])
  const reviewed = await reviewEmbeddingInputFailures(inputs, () => false)
  assert.equal(reviewed[0].input, inputs[0])
  assert.equal(reviewed[0].rejection.code, 'INPUT_NOT_SUPPORTED')
  assert.equal(reviewed[1].input, inputs[1])
  assert.equal(reviewed[1].rejection, null)
})

test('JPEG inspection seeks metadata with bounded byte reads and yields on hostile headers', async () => {
  const { readEmbeddingImageHeader } = loadTsModule('electron/embeddingImageHeader.ts')
  const app = Buffer.alloc(65537)
  app.set([255, 225, 255, 255])
  const source = Buffer.concat([
    Buffer.from([255, 216]),
    ...Array(20).fill(app),
    jpeg({ depth: 12 }).subarray(2),
  ])
  let bytesRead = 0
  const fakeHandle = {
    async read(target, offset, length, position) {
      const copied = source.copy(target, offset, position, position + length)
      bytesRead += copied
      return { bytesRead: copied }
    },
  }
  const result = await readEmbeddingImageHeader(fakeHandle, source.length)
  assert.equal(result.unsupported, true)
  assert.equal(result.depth, 12)
  assert.ok(bytesRead <= 64 * 1024, `read ${bytesRead} bytes`)
  const fill = Buffer.alloc(100000, 255)
  fill[0] = 255
  fill[1] = 216
  bytesRead = 0
  const incomplete = await readEmbeddingImageHeader(
    {
      async read(target, offset, length, position) {
        const copied = fill.copy(target, offset, position, position + length)
        bytesRead += copied
        return { bytesRead: copied }
      },
    },
    fill.length,
  )
  assert.equal(incomplete, null)
  assert.ok(bytesRead <= 64 * 1024)
})

test('unsupported JPEG never enters the decoder; runtime failures and baseline JPEG still do', async (t) => {
  const { decodeEmbeddingImageInput } = loadTsModule('electron/embeddingImageDecodeGuard.ts')
  const { embeddingWorkerFailure } = loadTsModule('shared/embeddingInputFailure.ts')
  let calls = 0
  for (const options of [{ marker: 0xc9 }, { marker: 0xca }, { depth: 12 }, { marker: 0xc3 }]) {
    const input = await fixture(t, jpeg(options), 'Unknown error')
    let failure
    try {
      await decodeEmbeddingImageInput(input.inputPath, async () => {
        calls++
        return 'decoded'
      })
    } catch (error) {
      failure = embeddingWorkerFailure(error)
    }
    assert.equal(failure.inputFailure, true)
    const rejection = await recheckEmbeddingInputFailure({ ...input, ...failure })
    assert.equal(rejection.code, 'INPUT_NOT_SUPPORTED')
  }
  assert.equal(calls, 0)
  const baseline = await fixture(t, jpeg(), 'Unknown error')
  assert.equal(
    await decodeEmbeddingImageInput(baseline.inputPath, async () => {
      calls++
      return 'decoded'
    }),
    'decoded',
  )
  assert.equal(calls, 1)
  let runtimeFailure
  try {
    await decodeEmbeddingImageInput(baseline.inputPath, async () => {
      throw Error('CUDA execution provider failed')
    })
  } catch (error) {
    runtimeFailure = embeddingWorkerFailure(error)
  }
  assert.equal(await recheckEmbeddingInputFailure({ ...baseline, ...runtimeFailure }), null)
})
