const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const sharp = require('sharp')
const { extractPsdCompositePreview } = require('../electron/psdCompositePreview.cjs')
const { loadTsModule } = require('./guard-utils.cjs')

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'siftory-psd-composite-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const {
    depth = 16,
    width = 3,
    height = 1,
    channels = 1,
    mode = 1,
    version = 1,
    compression = 0,
    bytes = Buffer.from('00008000ffff', 'hex'),
    encoded,
    layerSize = 0,
  } = options
  const header = Buffer.alloc(26)
  header.write('8BPS')
  header.writeUInt16BE(version, 4)
  header.writeUInt16BE(channels, 12)
  header.writeUInt32BE(height, 14)
  header.writeUInt32BE(width, 18)
  header.writeUInt16BE(depth, 22)
  header.writeUInt16BE(mode, 24)
  const layerLength = Buffer.alloc(version === 2 ? 8 : 4)
  if (version === 2) layerLength.writeBigUInt64BE(BigInt(layerSize))
  else layerLength.writeUInt32BE(layerSize)
  const prefix = Buffer.concat([header, Buffer.alloc(8), layerLength])
  const method = Buffer.alloc(2)
  method.writeUInt16BE(compression)
  let body = encoded || bytes
  if (compression === 1 && !encoded) {
    const counts = Buffer.alloc(channels * height * (version === 2 ? 4 : 2))
    const rows = []
    const rowBytes = (width * depth) / 8
    for (let i = 0; i < height * channels; i++) {
      assert.ok(rowBytes <= 128)
      const row = Buffer.concat([
        Buffer.from([rowBytes - 1]),
        bytes.subarray(i * rowBytes, (i + 1) * rowBytes),
      ])
      if (version === 2) counts.writeUInt32BE(row.length, i * 4)
      else counts.writeUInt16BE(row.length, i * 2)
      rows.push(row)
    }
    body = Buffer.concat([counts, ...rows])
  } else if (compression >= 2 && !encoded) body = zlib.deflateSync(bytes)
  const source = path.join(root, version === 2 ? 'brush.psb' : 'brush.psd')
  const handle = await fs.open(source, 'w')
  await handle.write(prefix)
  await handle.write(
    Buffer.concat([method, body]),
    0,
    method.length + body.length,
    prefix.length + layerSize,
  )
  await handle.close()
  return source
}

async function pixels(source) {
  const preview = await extractPsdCompositePreview(source)
  assert.ok(preview, 'composite should produce a PNG without embedded thumbnail or Shell')
  return sharp(preview).removeAlpha().raw().toBuffer({ resolveWithObject: true })
}

for (const version of [1, 2]) {
  for (const compression of [0, 1, 2]) {
    test(`16-bit grayscale PSD v${version} compression ${compression} preserves brush values`, async (t) => {
      const source = await fixture(t, { version, compression })
      const { data, info } = await pixels(source)
      assert.equal(info.width, 3)
      assert.deepEqual([...data], [0, 0, 0, 128, 128, 128, 255, 255, 255])
    })
  }
}

test('ZIP prediction restores 16-bit samples with wraparound', async (t) => {
  const source = await fixture(t, { compression: 3, bytes: Buffer.from('000080007fff', 'hex') })
  assert.deepEqual([...(await pixels(source)).data], [0, 0, 0, 128, 128, 128, 255, 255, 255])
})

for (const compression of [0, 1, 2, 3]) {
  test(`32-bit float grayscale compression ${compression} converts linear light to display values`, async (t) => {
    // Original samples: 0, 0.5, 1. Predicted data has byte planes then byte deltas.
    const bytes = Buffer.from(
      compression === 3 ? '003f00c10080800000000000' : '000000003f0000003f800000',
      'hex',
    )
    const source = await fixture(t, { depth: 32, compression, bytes })
    assert.deepEqual([...(await pixels(source)).data], [0, 0, 0, 188, 188, 188, 255, 255, 255])
  })
}

test('RGB planes and alpha render correct colors against white', async (t) => {
  const source = await fixture(t, {
    depth: 8,
    width: 2,
    channels: 4,
    mode: 3,
    bytes: Buffer.from([255, 0, 0, 255, 0, 0, 255, 0]),
  })
  assert.deepEqual([...(await pixels(source)).data], [255, 0, 0, 255, 255, 255])
})

for (const depth of [8, 16, 32]) {
  for (const compression of [1, 2]) {
    test(`${depth}-bit RGB multi-row composite compression ${compression} keeps plane order`, async (t) => {
      // Red, green / blue, white, written as three independent source planes.
      const samples = [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]
      const bytes = Buffer.alloc((samples.length * depth) / 8)
      samples.forEach((value, i) => {
        if (depth === 32) bytes.writeFloatBE(value, i * 4)
        else if (depth === 16) bytes.writeUInt16BE(value * 65535, i * 2)
        else bytes[i] = value * 255
      })
      const source = await fixture(t, {
        version: 2,
        depth,
        width: 2,
        height: 2,
        mode: 3,
        channels: 3,
        compression,
        bytes,
      })
      assert.deepEqual(
        [...(await pixels(source)).data],
        [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255],
      )
    })
  }
}

test('ZIP prediction resets at each 16-bit scanline', async (t) => {
  const source = await fixture(t, {
    width: 3,
    height: 2,
    compression: 3,
    bytes: Buffer.from('000080007fffffff80018000', 'hex'),
  })
  assert.deepEqual(
    [...(await pixels(source)).data],
    [0, 0, 0, 128, 128, 128, 255, 255, 255, 255, 255, 255, 128, 128, 128, 0, 0, 0],
  )
})

test('ZIP extraction in a Worker keeps file handle ownership intact', async (t) => {
  const sourcePath = await fixture(t, { compression: 2 })
  const { Worker } = require('node:worker_threads')
  const { projectPreviewWorkerPaths } = loadTsModule('electron/projectPreviewWorkerPaths.ts')
  const setup = projectPreviewWorkerPaths()
  const worker = new Worker(setup.workerPath, { workerData: setup.workerData, stderr: true })
  let stderr = ''
  worker.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  t.after(() => worker.terminate())
  for (let i = 0; i < 8; i++) {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('ZIP Worker timed out')), 10000)
      worker.once('message', (message) => {
        clearTimeout(timer)
        resolve(message.result)
      })
      worker.postMessage({
        kind: 'extractImage',
        sourcePath,
        sourceExt: 'psd',
        providerId: 'psd-composite-raster',
      })
    })
    assert.ok(result?.data.length)
  }
  await worker.terminate()
  assert.doesNotMatch(stderr, /File descriptor.*closed|EBADF|unmanaged mode/)
})

test('PackBits repeated runs are decoded without treating no-op bytes as pixels', async (t) => {
  const source = await fixture(t, {
    depth: 8,
    compression: 1,
    encoded: Buffer.from([0, 3, 128, 254, 123]),
  })
  assert.deepEqual([...(await pixels(source)).data], Array(9).fill(123))
})

test('large 16-bit grayscale brush produces a bounded preview in the actual source Worker', async (t) => {
  const bytes = Buffer.alloc(2048 * 2048 * 2)
  bytes.fill(255, bytes.length / 2)
  const sourcePath = await fixture(t, { width: 2048, height: 2048, bytes })
  const { runProjectPreviewCompute } = loadTsModule('electron/projectPreviewCompute.ts')
  let ticks = 0
  const timer = setInterval(() => ticks++, 2)
  t.after(() => clearInterval(timer))
  const result = await runProjectPreviewCompute({
    kind: 'extractImage',
    providerId: 'psd-composite-raster',
    sourceExt: 'psd',
    sourcePath,
  })
  assert.ok(result)
  assert.equal(result.width, 1024)
  assert.equal(result.height, 1024)
  const { data, info } = await sharp(Buffer.from(result.data))
    .raw()
    .toBuffer({ resolveWithObject: true })
  assert.ok(data[0] < 3)
  assert.ok(data[(info.height - 1) * info.width * info.channels] > 252)
  assert.ok(ticks >= 3, 'main event loop must remain available during extraction')
})

test(
  'PSB skips a sparse layer section over 4 GiB without loading it',
  {
    skip:
      process.platform === 'win32' ? 'Node cannot mark the large fixture sparse on Windows' : false,
  },
  async (t) => {
    const source = await fixture(t, { version: 2, layerSize: 2 ** 32 + 1024 })
    assert.deepEqual([...(await pixels(source)).data], [0, 0, 0, 128, 128, 128, 255, 255, 255])
  },
)

test('malformed RLE, truncated raw data, unsafe dimensions and ZIP expansion are rejected', async (t) => {
  for (const options of [
    { compression: 1, encoded: Buffer.from([0, 2, 250, 7]) },
    { bytes: Buffer.from([0]) },
    { width: 32769 },
    { width: 16384, height: 16384 },
    { mode: 4 },
    { depth: 32, width: 32768, height: 1000, channels: 4, mode: 3 },
    { compression: 2, bytes: Buffer.alloc(1024 * 1024) },
    { compression: 2, encoded: Buffer.from([1, 2, 3]) },
  ])
    assert.equal(await extractPsdCompositePreview(await fixture(t, options)), null)
})

test('new provider retries failed cache entries without requiring a full rebuild', async (t) => {
  const source = await fixture(t)
  const { ProjectPreviewService } = loadTsModule('electron/projectPreviewService.ts')
  const { BUILTIN_PROJECT_PREVIEW_PROVIDERS } = loadTsModule('electron/projectPreviewProviders.ts')
  const oldProviders = BUILTIN_PROJECT_PREVIEW_PROVIDERS.filter((p) => p.id === 'psd-embedded-jpeg')
  const root = path.dirname(source)
  const before = new ProjectPreviewService(root, oldProviders)
  assert.notEqual((await before.getOrCreate(source)).status, 'ready')
  const after = new ProjectPreviewService(
    root,
    BUILTIN_PROJECT_PREVIEW_PROVIDERS.filter((p) => p.id !== 'windows-shell-thumbnail'),
  )
  const entry = await after.getOrCreate(source)
  assert.equal(entry.status, 'ready')
  assert.equal(entry.provider, 'psd-composite-raster')
})
