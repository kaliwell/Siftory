const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const test = require('node:test')
const { Worker } = require('node:worker_threads')
const { loadTsModule } = require('./guard-utils.cjs')
const { makePdf } = require('./fixtures/project-preview-assets.cjs')
const { projectPreviewWorkerPaths } = loadTsModule('electron/projectPreviewWorkerPaths.ts')
const { runPdfPreviewCompute, getPdfPreviewRuntimeStats, stopPdfPreviewCompute } = loadTsModule(
  'electron/projectPreviewPdfRuntime.ts',
)
test.after(async () => {
  await stopPdfPreviewCompute()
  assert.deepEqual(getPdfPreviewRuntimeStats().activePids, [])
  assert.equal(getPdfPreviewRuntimeStats().idlePid, undefined)
})
const { ProjectPreviewService } = loadTsModule('electron/projectPreviewService.ts')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-runtime-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sourcePath = path.join(root, 'sample.pdf')
  fs.writeFileSync(sourcePath, makePdf())
  return {
    root,
    sourcePath,
    input: { kind: 'extractImage', providerId: 'pdfjs-first-page', sourceExt: 'pdf', sourcePath },
  }
}
function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

test('isolated PDF process preserves preview bytes and reuses one bounded idle process', async (t) => {
  const f = fixture(t),
    setup = projectPreviewWorkerPaths()
  const worker = new Worker(setup.workerPath, { workerData: setup.workerData })
  let baseline
  try {
    baseline = await new Promise((resolve, reject) => {
      worker.once('error', reject)
      worker.once('message', (message) =>
        message.error ? reject(Error(message.error)) : resolve(message.result),
      )
      worker.postMessage(f.input)
    })
  } finally {
    await worker.terminate()
  }
  const result = await runPdfPreviewCompute(f.input)
  assert.ok(result?.data.length)
  assert.equal(digest(result.data), digest(baseline.data))
  assert.equal(result.width, baseline.width)
  assert.equal(result.height, baseline.height)
  assert.deepEqual(getPdfPreviewRuntimeStats().activePids, [])
  const idlePid = getPdfPreviewRuntimeStats().idlePid
  assert.ok(idlePid)
  const repeated = await runPdfPreviewCompute(f.input)
  assert.equal(digest(repeated.data), digest(result.data))
  assert.equal(getPdfPreviewRuntimeStats().idlePid, idlePid)
})

test('PDF timeout and cancellation release the owned child before a following request', async (t) => {
  const f = fixture(t)
  await assert.rejects(runPdfPreviewCompute(f.input, { timeoutMs: 1 }), {
    code: 'PDF_PREVIEW_TIMEOUT',
  })
  assert.deepEqual(getPdfPreviewRuntimeStats().activePids, [])
  let cancelled = false
  const timer = setTimeout(() => {
    cancelled = true
  }, 20)
  try {
    await assert.rejects(runPdfPreviewCompute(f.input, { isCancelled: () => cancelled }), {
      code: 'PROJECT_PREVIEW_CANCELLED',
    })
  } finally {
    clearTimeout(timer)
  }
  assert.deepEqual(getPdfPreviewRuntimeStats().activePids, [])
  const result = await runPdfPreviewCompute(f.input)
  assert.ok(result?.data.length)
})

test('PDF RSS budget is enforced independently of V8 heap and leaves no child', async (t) => {
  const f = fixture(t)
  // This threshold is deliberately below normal process overhead.
  await assert.rejects(runPdfPreviewCompute(f.input, { maxRssBytes: 1 }), {
    code: 'PDF_PREVIEW_MEMORY_BUDGET',
  })
  assert.deepEqual(getPdfPreviewRuntimeStats().activePids, [])
})

test('transient preview failures preserve the previous preview and retry backoff can be explicitly bypassed', async (t) => {
  const f = fixture(t)
  let attempts = 0,
    fail = false
  const provider = {
    id: 'pdfjs-first-page',
    version: '1',
    extensions: ['pdf'],
    extract: async () => {
      attempts++
      if (fail) throw Object.assign(Error('resource'), { code: 'PDF_PREVIEW_MEMORY_BUDGET' })
      return require('sharp')({ create: { width: 16, height: 16, channels: 3, background: 'red' } })
        .png()
        .toBuffer()
    },
  }
  const service = new ProjectPreviewService(path.join(f.root, 'data'), [provider])
  const good = await service.getOrCreate(f.sourcePath)
  assert.equal(good.status, 'ready')
  fs.appendFileSync(f.sourcePath, '\n%changed')
  fail = true
  const failed = await service.getOrCreate(f.sourcePath)
  assert.equal(failed.errorCode, 'PDF_PREVIEW_MEMORY_BUDGET')
  assert.equal(failed.previewPath, good.previewPath)
  assert.ok(fs.existsSync(good.previewPath))
  const before = attempts
  await service.getOrCreate(f.sourcePath)
  assert.equal(attempts, before)
  fail = false
  assert.equal((await service.getOrCreate(f.sourcePath, { forceRetry: true })).status, 'ready')
  assert.equal(attempts, before + 1)
})

test('shutdown cancels active and queued PDF jobs and releases an idle process', async (t) => {
  const f = fixture(t)
  const first = runPdfPreviewCompute(f.input)
  const second = runPdfPreviewCompute(f.input)
  const results = Promise.allSettled([first, second])
  const deadline = Date.now() + 3000
  while (!getPdfPreviewRuntimeStats().activePids.length && Date.now() < deadline)
    await new Promise((r) => setImmediate(r))
  assert.ok(getPdfPreviewRuntimeStats().activePids.length)
  await stopPdfPreviewCompute()
  for (const result of await results) {
    assert.equal(result.status, 'rejected')
    assert.equal(result.reason.code, 'PROJECT_PREVIEW_CANCELLED')
  }
  assert.deepEqual(getPdfPreviewRuntimeStats().activePids, [])
  assert.equal(getPdfPreviewRuntimeStats().idlePid, undefined)
})
