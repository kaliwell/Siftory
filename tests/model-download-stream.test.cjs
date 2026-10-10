const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')

const { streamModelBodyToFile } = loadTsModule('electron/modelDownloadStream.ts')

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'floating-clock-model-stream-'))
  try {
    await run(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

async function* chunksOf(buffer, chunkSize) {
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    yield buffer.subarray(offset, Math.min(buffer.length, offset + chunkSize))
  }
}

test('streamModelBodyToFile writes bytes and computes SHA256 incrementally', async () => {
  await withTempDir(async (dir) => {
    const data = crypto.randomBytes(2 * 1024 * 1024 + 137)
    const destPath = path.join(dir, 'model.part')
    const progress = []
    const result = await streamModelBodyToFile(chunksOf(data, 64 * 1024), destPath, {
      signal: new AbortController().signal,
      totalBytes: data.length,
      progressIntervalMs: 100_000,
      progressByteInterval: 1024 * 1024,
      onProgress: (entry) => progress.push(entry),
    })

    assert.equal(result.bytesDownloaded, data.length)
    assert.equal(result.sha256, crypto.createHash('sha256').update(data).digest('hex'))
    assert.deepEqual(await fs.readFile(destPath), data)
    assert.ok(progress.length <= 3, `expected throttled progress, got ${progress.length}`)
    assert.equal(progress.at(-1).bytesDownloaded, data.length)
  })
})

test('streamModelBodyToFile aborts without consuming the remaining source', async () => {
  await withTempDir(async (dir) => {
    const controller = new AbortController()
    let produced = 0
    async function* source() {
      for (let i = 0; i < 100; i++) {
        produced += 1
        if (i === 2) controller.abort()
        yield Buffer.alloc(64 * 1024, i)
      }
    }

    await assert.rejects(
      streamModelBodyToFile(source(), path.join(dir, 'model.part'), {
        signal: controller.signal,
        totalBytes: 100 * 64 * 1024,
      }),
      (error) => error && error.name === 'AbortError',
    )
    assert.ok(produced < 100)
  })
})
