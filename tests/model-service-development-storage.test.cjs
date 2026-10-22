const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const parent = fs.realpathSync.native(os.tmpdir())
const fixtureRoot = fs.mkdtempSync(path.join(parent, 'siftory-dev-models-'))
const appRoot = path.join(fixtureRoot, 'app')
const defaultProfile = path.join(fixtureRoot, 'default-profile')
const isolatedProfile = path.join(fixtureRoot, 'isolated-profile')
const projectModels = path.join(appRoot, 'ai-models')
const userModels = path.join(defaultProfile, 'models')
const mainBytes = Buffer.from('pinned image model')
const textBytes = Buffer.from('pinned text model')
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const createModel = (name) => ({
  name,
  displayName: name,
  version: 'fixture-v1',
  filename: 'onnx/image.bin',
  sha256: digest(mainBytes),
  sizeBytes: mainBytes.length,
  url: 'https://example.invalid/image.bin',
  requiredFiles: [
    {
      filename: 'onnx/text.bin',
      sha256: digest(textBytes),
      sizeBytes: textBytes.length,
      url: 'https://example.invalid/text.bin',
    },
  ],
  license: 'MIT',
  commercialFriendly: true,
  dim: 2,
  inputSize: 1,
  framework: 'onnx',
  description: 'Development fallback fixture',
})
const complete = createModel('complete')
const split = createModel('split')
const corrupt = createModel('corrupt')
fs.mkdirSync(path.join(appRoot, 'models'), { recursive: true })
fs.writeFileSync(
  path.join(appRoot, 'models/manifest.json'),
  JSON.stringify({ models: [complete, split, corrupt] }),
)
function write(root, model, file, bytes) {
  const target = path.join(root, model.name, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, bytes)
  return target
}
const sharedMain = write(userModels, complete, complete.filename, mainBytes)
const sharedText = write(userModels, complete, complete.requiredFiles[0].filename, textBytes)
write(userModels, split, split.filename, mainBytes)
write(projectModels, split, split.requiredFiles[0].filename, textBytes)
write(userModels, corrupt, corrupt.filename, Buffer.alloc(mainBytes.length, 1))
write(userModels, corrupt, corrupt.requiredFiles[0].filename, textBytes)

const originalLoad = Module._load
let modelService
try {
  Module._load = function patchedLoad(request, parentModule, isMain) {
    if (request === 'electron')
      return {
        app: { isPackaged: false, getAppPath: () => appRoot, getPath: () => defaultProfile },
      }
    return originalLoad.call(this, request, parentModule, isMain)
  }
  modelService = require('./guard-utils.cjs').loadTsModule('electron/modelService.ts')
} finally {
  Module._load = originalLoad
}

test('development discovers verified user models without copying, downloading, or changing profiles', async (t) => {
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync.native(fixtureRoot)), parent)
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  })
  const before = [sharedMain, sharedText].map((file) => ({
    file,
    hash: digest(fs.readFileSync(file)),
    mtime: fs.statSync(file).mtimeMs,
  }))
  // Recognition also works before vector IPC explicitly initializes the service.
  assert.deepEqual(modelService.getModelReadStorageDirs(), [projectModels, userModels])
  assert.equal(
    modelService.getInstalledModelDir(complete.name),
    path.join(userModels, complete.name),
  )
  modelService.initModelService(defaultProfile)
  assert.equal(modelService.getModelStorageDir(), projectModels)
  assert.equal(modelService.getModelStatus(complete.name).state, 'downloaded')

  const originalFetch = global.fetch
  global.fetch = async () => {
    throw new Error('Existing verified models must not need the network')
  }
  try {
    assert.deepEqual(await modelService.downloadModel(complete.name), { ok: true })
  } finally {
    global.fetch = originalFetch
  }
  assert.equal(
    fs.existsSync(path.join(projectModels, complete.name)),
    false,
    'reuse must not copy model payloads',
  )
  const localMain = write(projectModels, complete, complete.filename, mainBytes)
  assert.equal(
    modelService.getInstalledModelDir(complete.name),
    path.join(userModels, complete.name),
    'a partial project copy must not mask a complete user copy',
  )
  fs.writeFileSync(localMain, Buffer.alloc(mainBytes.length, 1))
  modelService.initModelService(defaultProfile)
  assert.equal(
    modelService.getModelStatus(complete.name).state,
    'downloaded',
    'a corrupt project copy must not mask a complete user copy',
  )
  write(projectModels, complete, complete.filename, mainBytes)
  const localText = write(projectModels, complete, complete.requiredFiles[0].filename, textBytes)
  modelService.initModelService(defaultProfile)
  assert.equal(
    modelService.getInstalledModelDir(complete.name),
    path.join(projectModels, complete.name),
    'a verified project copy keeps priority',
  )
  assert.equal(
    modelService.getInstalledModelDir(split.name),
    null,
    'companions from different roots must not be combined',
  )
  assert.equal(modelService.getModelStatus(split.name).state, 'not-installed')
  assert.equal(
    modelService.getInstalledModelDir(corrupt.name),
    null,
    'corrupt user files must not become usable',
  )
  assert.notEqual(modelService.getModelStatus(corrupt.name).state, 'downloaded')

  fs.unlinkSync(localMain)
  fs.unlinkSync(localText)
  modelService.initModelService(isolatedProfile)
  assert.deepEqual(modelService.getModelReadStorageDirs(), [
    projectModels,
    path.join(isolatedProfile, 'models'),
  ])
  assert.equal(
    modelService.getInstalledModelDir(complete.name),
    null,
    'an explicit profile must not leak into the default profile',
  )
  for (const item of before) {
    assert.equal(digest(fs.readFileSync(item.file)), item.hash)
    assert.equal(fs.statSync(item.file).mtimeMs, item.mtime)
    assert.equal(
      fs.existsSync(item.file + '.verified.json'),
      false,
      'shared fallback verification must be read-only',
    )
  }
})
