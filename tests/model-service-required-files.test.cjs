const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-model-service-'))
const mainBytes = Buffer.from('verified image model')
const textBytes = Buffer.from('verified text model')
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const model = {
  name: 'fixture_clip',
  displayName: 'Fixture CLIP',
  version: 'fixture-v1',
  url: 'https://example.invalid/main.bin',
  filename: 'weights/main.bin',
  sha256: digest(mainBytes),
  sizeBytes: mainBytes.length,
  requiredFiles: [
    {
      url: 'https://example.invalid/text.bin',
      filename: 'weights/text.bin',
      sha256: digest(textBytes),
      sizeBytes: textBytes.length,
    },
  ],
  license: 'MIT',
  commercialFriendly: true,
  dim: 2,
  inputSize: 1,
  framework: 'onnx',
  description: 'Required-file model service fixture',
}

fs.mkdirSync(path.join(fixtureRoot, 'models'), { recursive: true })
fs.writeFileSync(
  path.join(fixtureRoot, 'models', 'manifest.json'),
  JSON.stringify({ models: [model] }),
)
const mainPath = path.join(fixtureRoot, 'ai-models', model.name, model.filename)
const textPath = path.join(fixtureRoot, 'ai-models', model.name, model.requiredFiles[0].filename)
fs.mkdirSync(path.dirname(mainPath), { recursive: true })
fs.writeFileSync(mainPath, mainBytes)

const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => fixtureRoot,
        getPath: () => fixtureRoot,
      },
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}
const { loadTsModule } = require('./guard-utils.cjs')
const modelService = loadTsModule('electron/modelService.ts')
const companionIntegrity = loadTsModule('electron/modelServiceCompanions.ts')
Module._load = originalLoad

test('model service requires and selectively repairs every hash-pinned model file', async (t) => {
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))
  modelService.initModelService()

  const incomplete = modelService.getModelStatus(model.name)
  assert.equal(incomplete.state, 'not-installed')
  assert.equal(incomplete.error, 'Required model files are missing')

  const mainBefore = fs.statSync(mainPath)
  const originalFetch = global.fetch
  const requested = []
  global.fetch = async (url) => {
    requested.push(String(url))
    return new Response(textBytes, {
      status: 200,
      headers: { 'content-length': String(textBytes.length) },
    })
  }
  try {
    assert.deepEqual(await modelService.downloadModel(model.name), { ok: true })
  } finally {
    global.fetch = originalFetch
  }

  assert.deepEqual(requested, [model.requiredFiles[0].url])
  assert.deepEqual(fs.readFileSync(textPath), textBytes)
  assert.equal(fs.statSync(mainPath).mtimeMs, mainBefore.mtimeMs)
  assert.equal(modelService.getModelStatus(model.name).state, 'downloaded')
  assert.equal(fs.existsSync(`${textPath}.verified.json`), true)

  assert.deepEqual(
    companionIntegrity.getRequiredModelFiles(model).map((file) => file.filename),
    [model.filename, model.requiredFiles[0].filename],
  )
  assert.throws(
    () =>
      companionIntegrity.getRequiredModelFiles({
        ...model,
        requiredFiles: [{ ...model.requiredFiles[0], filename: model.filename }],
      }),
    /repeats required file/i,
  )
  assert.throws(
    () =>
      companionIntegrity.getRequiredModelFiles({
        ...model,
        requiredFiles: [{ ...model.requiredFiles[0], url: 'http://example.invalid/text.bin' }],
      }),
    /must use HTTPS/i,
  )

  // A persisted verification sidecar is advisory only. Re-initializing the
  // service must hash the existing companion again even when size and mtime
  // are preserved.
  const verifiedStat = fs.statSync(textPath)
  const corruptedBytes = Buffer.alloc(textBytes.length, 0x78)
  fs.writeFileSync(textPath, corruptedBytes)
  fs.utimesSync(textPath, verifiedStat.atime, verifiedStat.mtime)
  modelService.initModelService()
  const corrupted = modelService.getModelStatus(model.name)
  assert.equal(corrupted.state, 'error')
  assert.equal(corrupted.error, 'SHA-256 verification failed')

  // An unbounded response must fail before it can replace the existing file.
  // The prepared sibling is discarded, leaving the prior invalid file intact.
  global.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(textBytes)
          controller.enqueue(Buffer.from('overflow'))
          controller.close()
        },
      }),
      { status: 200 },
    )
  try {
    const oversized = await modelService.downloadModel(model.name)
    assert.equal(oversized.ok, false)
    assert.match(oversized.error, /exceeded pinned size/i)
  } finally {
    global.fetch = originalFetch
  }
  assert.deepEqual(fs.readFileSync(textPath), corruptedBytes)
  assert.deepEqual(
    fs
      .readdirSync(path.dirname(textPath))
      .filter((name) => name.includes('.floatingclock-') || name.endsWith('.tmp')),
    [],
  )

  global.fetch = async () => new Response(textBytes, { status: 200 })
  try {
    assert.deepEqual(await modelService.downloadModel(model.name), { ok: true })
  } finally {
    global.fetch = originalFetch
  }
  assert.deepEqual(fs.readFileSync(textPath), textBytes)
  assert.equal(modelService.getModelStatus(model.name).state, 'downloaded')
})
