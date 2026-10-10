const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-packaged-models-'))
const resourcesRoot = path.join(fixtureRoot, 'resources')
const userDataRoot = path.join(fixtureRoot, 'user-data')
const appRoot = path.join(fixtureRoot, 'app')
const mainBytes = Buffer.from('verified packaged image model')
const textBytes = Buffer.from('verified packaged text model')
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

function fixtureModel(name) {
  return {
    name,
    displayName: name,
    version: 'fixture-v1',
    url: `https://example.invalid/${name}/main.bin`,
    filename: 'weights/main.bin',
    sha256: digest(mainBytes),
    sizeBytes: mainBytes.length,
    requiredFiles: [
      {
        url: `https://example.invalid/${name}/text.bin`,
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
    description: 'Packaged storage fixture',
  }
}

const bundledModel = fixtureModel('fixture_bundled')
const downloadableModel = fixtureModel('fixture_downloadable')
fs.mkdirSync(path.join(resourcesRoot, 'models'), { recursive: true })
fs.writeFileSync(
  path.join(resourcesRoot, 'models', 'manifest.json'),
  JSON.stringify({ distributionProfile: 'online', models: [bundledModel, downloadableModel] }),
)

function modelFile(root, model, filename) {
  return path.join(root, model.name, filename)
}

const bundledMain = modelFile(
  path.join(resourcesRoot, 'ai-models'),
  bundledModel,
  bundledModel.filename,
)
const bundledText = modelFile(
  path.join(resourcesRoot, 'ai-models'),
  bundledModel,
  bundledModel.requiredFiles[0].filename,
)
fs.mkdirSync(path.dirname(bundledMain), { recursive: true })
fs.writeFileSync(bundledMain, mainBytes)
fs.writeFileSync(bundledText, textBytes)

const writableRoot = path.join(userDataRoot, 'models')
const downloadableMain = modelFile(writableRoot, downloadableModel, downloadableModel.filename)
const downloadableText = modelFile(
  writableRoot,
  downloadableModel,
  downloadableModel.requiredFiles[0].filename,
)
fs.mkdirSync(path.dirname(downloadableMain), { recursive: true })
fs.writeFileSync(downloadableMain, mainBytes)

const originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
Object.defineProperty(process, 'resourcesPath', {
  configurable: true,
  value: resourcesRoot,
})
const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getAppPath: () => appRoot,
        getPath: () => userDataRoot,
      },
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}
const { loadTsModule } = require('./guard-utils.cjs')
const modelService = loadTsModule('electron/modelService.ts')
Module._load = originalLoad

test('packaged models use writable userData storage with a read-only bundled fallback', async (t) => {
  t.after(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
    if (originalResourcesPath) {
      Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
    } else {
      delete process.resourcesPath
    }
  })

  assert.equal(
    modelService.getInstalledModelDir(bundledModel.name),
    path.join(resourcesRoot, 'ai-models', bundledModel.name),
    'packaged API callers can resolve models before vector IPC explicitly initializes the service',
  )
  modelService.initModelService(userDataRoot)
  assert.equal(modelService.getModelStorageDir(), writableRoot)
  assert.deepEqual(modelService.getModelReadStorageDirs(), [
    writableRoot,
    path.join(resourcesRoot, 'ai-models'),
  ])

  const bundledStatus = modelService.getModelStatus(bundledModel.name)
  assert.equal(bundledStatus.state, 'downloaded')
  assert.equal(bundledStatus.installedPath, bundledMain)
  assert.equal(
    modelService.getInstalledModelDir(bundledModel.name),
    path.join(resourcesRoot, 'ai-models', bundledModel.name),
  )
  assert.equal(fs.existsSync(`${bundledMain}.verified.json`), false)

  const incomplete = modelService.getModelStatus(downloadableModel.name)
  assert.equal(incomplete.state, 'not-installed')
  assert.equal(incomplete.error, 'Required model files are missing')

  const requested = []
  const originalFetch = global.fetch
  global.fetch = async (url) => {
    requested.push(String(url))
    return new Response(textBytes, {
      status: 200,
      headers: { 'content-length': String(textBytes.length) },
    })
  }
  try {
    assert.deepEqual(await modelService.downloadModel(downloadableModel.name), { ok: true })
  } finally {
    global.fetch = originalFetch
  }

  assert.deepEqual(requested, [downloadableModel.requiredFiles[0].url])
  assert.deepEqual(fs.readFileSync(downloadableText), textBytes)
  assert.equal(modelService.getModelStatus(downloadableModel.name).state, 'downloaded')
  assert.equal(
    modelService.getInstalledModelDir(downloadableModel.name),
    path.join(writableRoot, downloadableModel.name),
  )
  assert.equal(
    fs.existsSync(
      modelFile(
        path.join(resourcesRoot, 'ai-models'),
        downloadableModel,
        downloadableModel.requiredFiles[0].filename,
      ),
    ),
    false,
  )
})
