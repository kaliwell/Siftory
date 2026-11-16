const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { Worker } = require('node:worker_threads')
test('built worker reads one stable completed increment and settles cancellation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'compiled-prepared-'))
  try {
    const file = path.join(root, 'vectors.jsonl')
    const row = (id) =>
      JSON.stringify({
        imageId: id,
        modelName: 'test',
        embeddingType: 'global',
        dim: 2,
        vector: [1, 0],
      }) + '\n'
    await fs.writeFile(file, row('first'))
    const stat = await fs.stat(file)
    const sources = [{ path: file, size: stat.size, ino: stat.ino, dev: stat.dev }]
    await fs.appendFile(file, row('later'))
    const run = async (stop) => {
      const worker = new Worker(path.resolve('dist-electron/preparationVectorWorker.js'), {
        workerData: { sources, model: 'test', dim: 2, query: [1, 0], topK: 10, stop },
      })
      try {
        return await new Promise((resolve, reject) => {
          worker.once('message', resolve)
          worker.once('error', reject)
          worker.once('exit', (code) => reject(Error('premature worker exit ' + code)))
        })
      } finally {
        await worker.terminate()
      }
    }
    const result = await run()
    assert.deepEqual(
      result.result.candidates.map((c) => c.path),
      ['first'],
    )
    const stop = new SharedArrayBuffer(4)
    new Int32Array(stop)[0] = 1
    assert.match((await run(stop)).error, /cancelled/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
