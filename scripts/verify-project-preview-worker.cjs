const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const assert = require('node:assert/strict')
const { Worker } = require('node:worker_threads')
const { builtinModules } = require('node:module')
async function main() {
  const { build } = await import('vite')
  const outDir = 'artifacts/verification/worker-build'
  for (const [entry, fileName] of [
    ['electron/projectPreviewImageWorker.cjs', 'projectPreviewImageWorker.cjs'],
    ['electron/projectPreviewProviders.ts', 'projectPreviewProvidersWorker.js'],
  ])
    await build({
      configFile: false,
      logLevel: 'error',
      build: {
        outDir,
        emptyOutDir: false,
        lib: { entry, formats: ['cjs'], fileName: () => fileName },
        rollupOptions: {
          external: [
            ...builtinModules,
            ...builtinModules.map((name) => `node:${name}`),
            'sharp',
            'worker_threads',
            'node:worker_threads',
            'node:module',
            '@napi-rs/canvas',
            'pdfjs-dist/legacy/build/pdf.mjs',
            'electron',
          ],
        },
      },
    })
  const worker = new Worker(path.resolve(outDir, 'projectPreviewImageWorker.cjs'), {
    workerData: {
      sharpPath: require.resolve('sharp'),
      moduleRoots: require.resolve.paths('@napi-rs/canvas'),
      pdfModuleUrl: pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href,
      providersPath: path.resolve(outDir, 'projectPreviewProvidersWorker.js'),
    },
  })
  function ask(input) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Worker smoke timeout')), 10000)
      function finish(error, value) {
        clearTimeout(timer)
        worker.removeListener('message', message)
        worker.removeListener('error', fail)
        worker.removeListener('exit', exit)
        error ? reject(error) : resolve(value)
      }
      const message = (m) => finish(m.error ? new Error(m.error) : null, m.result),
        fail = (e) => finish(e),
        exit = (code) => finish(new Error(`Early worker exit ${code}`))
      worker.once('message', message)
      worker.once('error', fail)
      worker.once('exit', exit)
      worker.postMessage(input)
    })
  }
  try {
    worker.postMessage({ kind: 'manifestStart' })
    worker.postMessage({
      kind: 'manifestChunk',
      entries: [{ sourcePath: 'z' }, { sourcePath: 'a' }],
    })
    const manifest = await ask({ kind: 'manifestFinish' })
    assert.deepEqual(
      JSON.parse(manifest).entries.map((x) => x.sourcePath),
      ['a', 'z'],
    )
    const source = path.resolve(outDir, 'synthetic.svg')
    fs.writeFileSync(
      source,
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>',
    )
    const image = await ask({
      kind: 'extractImage',
      providerId: 'svg-safe-raster',
      sourcePath: source,
      sourceExt: 'svg',
    })
    assert.ok(image.width > 0 && image.width === image.height)
    assert.ok(image.data.length > 0)
    const { makePdf } = require('../tests/fixtures/project-preview-assets.cjs')
    const pdfPath = path.resolve(outDir, 'synthetic.pdf')
    fs.writeFileSync(pdfPath, makePdf())
    const pdf = await ask({
      kind: 'extractImage',
      providerId: 'pdfjs-first-page',
      sourcePath: pdfPath,
      sourceExt: 'pdf',
    })
    assert.ok(pdf?.data.length > 0 && pdf.width > 0)
    const temporaryPath = path.resolve(outDir, 'snapshot.tmp')
    worker.postMessage({ kind: 'manifestStart' })
    worker.postMessage({ kind: 'manifestChunk', entries: [{ sourcePath: 'a' }] })
    await ask({ kind: 'manifestFinish', temporaryPath })
    assert.equal(JSON.parse(fs.readFileSync(temporaryPath)).entries.length, 1)
    console.log(
      'Built preview worker: manifest chunks + bundled provider extraction + image decode PASS',
    )
  } finally {
    await worker.terminate()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
