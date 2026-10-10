// Isolation fixtures for the user-model runtime boundary
// (electron/userModelRuntimeHost.ts + userModelRuntimeChild.ts): the unvetted
// ONNX import check runs in a disposable child process, so a crash, hang,
// runaway allocation, or flooded output must surface as a clean error while
// the main process stays alive and the next request gets a fresh child.
// The happy-path E2E drives the real import flow through the isolated
// boundary with a repository fixture model and skips cleanly without it.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')

const root = path.resolve(__dirname, '..')
const childBundle = path.join(root, 'dist-electron', 'userModelRuntimeChild.js')
const fixtureModel = path.join(root, 'models', 'yolov8n-face', 'model.onnx')
const bundlePresent = fs.existsSync(childBundle)
const modelPresent = fs.existsSync(fixtureModel)

const host = loadTsModule('electron/userModelRuntimeHost.ts')
const { getUserModelProfileDefinition, getUserModelSlotDefinition } = loadTsModule(
  'shared/userModelPlatform.ts',
)

function makeTempDir(t, label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `fc-umri-${label}-`))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function writeFixtureChild(directory, name, source) {
  const scriptPath = path.join(directory, name)
  fs.writeFileSync(scriptPath, source)
  return scriptPath
}

function useFixtureChild(t, scriptPath, options = {}) {
  host.setUserModelRuntimeChildOptionsForTests({ scriptPath, ...options })
  t.after(() => {
    host.disposeUserModelRuntimeChild()
    host.setUserModelRuntimeChildOptionsForTests()
  })
}

const faceProfile = getUserModelProfileDefinition(
  'face-detector',
  getUserModelSlotDefinition('face-detector').defaultProfileId,
)
const maxBytes = getUserModelSlotDefinition('face-detector').maxSizeBytes

test('user-model child stderr is bounded and removes embedded absolute paths', () => {
  const diagnostic = host.sanitizeUserModelRuntimeStderr(
    `RangeError at C:\\Users\\person\\AppData\\Local\\Temp\\child.js:3:2\n` +
      `at /tmp/private/model/runtime.js:4:1\n${'x'.repeat(10_000)}`,
  )
  assert.doesNotMatch(diagnostic, /C:\\Users|\/tmp\/private/)
  assert.match(diagnostic, /\[path\]/)
  assert.ok(diagnostic.length <= 4_096)
})

test('a crashing runtime child fails the request and the next one recovers', async (t) => {
  if (!bundlePresent) return t.skip('run npm run build:renderer before the isolation tests')
  const directory = makeTempDir(t, 'crash')
  const crashChild = writeFixtureChild(
    directory,
    'crash-child.js',
    `process.stdin.on('data', () => process.exit(1))\n`,
  )
  useFixtureChild(t, crashChild)

  await assert.rejects(
    host.inspectUserModelInIsolation('C:\\unused\\model.onnx', faceProfile, maxBytes),
    /User model runtime exited/,
  )

  // Recovery: a fresh child answers the next request.
  host.setUserModelRuntimeChildOptionsForTests({ scriptPath: childBundle })
  if (!modelPresent) return t.skip('fixture model is not available')
  const inspection = await host.inspectUserModelInIsolation(fixtureModel, faceProfile, maxBytes)
  assert.equal(inspection.compatible, true)
  assert.ok(inspection.inputs.length > 0)
})

test('a hung runtime child is killed after the timeout and the next request recovers', async (t) => {
  if (!bundlePresent) return t.skip('run npm run build:renderer before the isolation tests')
  const directory = makeTempDir(t, 'timeout')
  const silentChild = writeFixtureChild(
    directory,
    'silent-child.js',
    `process.stdin.resume()\nsetInterval(() => {}, 1000)\n`,
  )
  useFixtureChild(t, silentChild, { timeoutMs: 200 })

  const startedAt = Date.now()
  await assert.rejects(
    host.inspectUserModelInIsolation('C:\\unused\\model.onnx', faceProfile, maxBytes),
    /timed out/,
  )
  assert.ok(Date.now() - startedAt < 10_000, 'the timeout must bound the wait')

  host.setUserModelRuntimeChildOptionsForTests({ scriptPath: childBundle })
  if (!modelPresent) return t.skip('fixture model is not available')
  const inspection = await host.inspectUserModelInIsolation(fixtureModel, faceProfile, maxBytes)
  assert.equal(inspection.compatible, true)
})

test('a runaway runtime child hits the heap cap without taking down main', async (t) => {
  if (!bundlePresent) return t.skip('run npm run build:renderer before the isolation tests')
  const directory = makeTempDir(t, 'oom')
  const greedyChild = writeFixtureChild(
    directory,
    'greedy-child.js',
    `process.stdin.on('data', () => {\n  let balloon = 'x'\n  for (;;) balloon += balloon\n})\n`,
  )
  useFixtureChild(t, greedyChild, { maxOldSpaceMb: 64 })

  await assert.rejects(
    host.inspectUserModelInIsolation('C:\\unused\\model.onnx', faceProfile, maxBytes),
    /User model runtime exited/,
  )

  host.setUserModelRuntimeChildOptionsForTests({ scriptPath: childBundle })
  if (!modelPresent) return t.skip('fixture model is not available')
  const inspection = await host.inspectUserModelInIsolation(fixtureModel, faceProfile, maxBytes)
  assert.equal(inspection.compatible, true)
})

test('a runtime child flooding its output is rejected by the bounded framer', async (t) => {
  const directory = makeTempDir(t, 'flood')
  // The user-model runtime frames carry base64 tensors, so its line cap is
  // 96 MB; the flood must exceed that to trip the bounded framer.
  const floodChild = writeFixtureChild(
    directory,
    'flood-child.js',
    `process.stdin.on('data', () => {\n  process.stdout.write('x'.repeat(100 * 1024 * 1024) + '\\n')\n})\n`,
  )
  useFixtureChild(t, floodChild, { timeoutMs: 15_000 })

  await assert.rejects(
    host.inspectUserModelInIsolation('C:\\unused\\model.onnx', faceProfile, maxBytes),
    /output line exceeded/,
  )
})

test('the host decodes a bounded bit-packed SAM mask response', async (t) => {
  const directory = makeTempDir(t, 'sam-mask')
  const compactChild = writeFixtureChild(
    directory,
    'sam-mask-child.js',
    `let pending = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  pending += chunk
  const newline = pending.indexOf('\\n')
  if (newline < 0) return
  const request = JSON.parse(pending.slice(0, newline))
  process.stdout.write(JSON.stringify({
    id: request.id,
    ok: true,
    mask: { width: 3, height: 2, iou: 0.875, maskBitsB64: 'LQ==' },
  }) + '\\n')
})
`,
  )
  useFixtureChild(t, compactChild)

  const result = await host.runSamDecoderInIsolation(
    'C:\\unused\\model.onnx',
    maxBytes,
    [{ name: 'input', dims: [1], data: new Float32Array([0]) }],
    'masks',
    'iou_predictions',
  )
  assert.equal(result.width, 3)
  assert.equal(result.height, 2)
  assert.equal(result.iou, 0.875)
  assert.deepEqual(Array.from(result.maskBits), [0x2d])
})

test('the host rejects a SAM mask payload whose byte length does not match its shape', async (t) => {
  const directory = makeTempDir(t, 'sam-mask-invalid')
  const malformedChild = writeFixtureChild(
    directory,
    'sam-mask-invalid-child.js',
    `process.stdin.on('data', (chunk) => {
  const request = JSON.parse(String(chunk).trim())
  process.stdout.write(JSON.stringify({
    id: request.id,
    ok: true,
    mask: { width: 9, height: 1, iou: 0.5, maskBitsB64: 'AA==' },
  }) + '\\n')
})
`,
  )
  useFixtureChild(t, malformedChild)

  await assert.rejects(
    host.runSamDecoderInIsolation(
      'C:\\unused\\model.onnx',
      maxBytes,
      [{ name: 'input', dims: [1], data: new Float32Array([0]) }],
      'masks',
      'iou_predictions',
    ),
    /SAM mask payload/,
  )
})

test('memory pressure waits for the active request, reports bytes, and then disposes the child', async (t) => {
  const directory = makeTempDir(t, 'pressure')
  const delayedChild = writeFixtureChild(
    directory,
    'pressure-child.js',
    `process.stdin.on('data', (chunk) => {
  const request = JSON.parse(String(chunk).trim())
  setTimeout(() => process.stdout.write(JSON.stringify({
    id: request.id,
    ok: true,
    session: { inputNames: [], outputNames: [], inputMetadata: [], outputMetadata: [] },
    runtimeMemory: { sessionCount: 2, ownedBytesApprox: 400000000, budgetBytes: 536870912 },
  }) + '\\n'), 80)
})
`,
  )
  useFixtureChild(t, delayedChild)

  const active = host.loadUserModelSessionInIsolation('C:\\unused\\model.onnx', maxBytes)
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.deepEqual(host.requestUserModelRuntimeMemoryPressureRelease(), {
    status: 'deferred',
    activeRequest: true,
  })
  await active
  assert.deepEqual(host.getUserModelRuntimeMemorySnapshot(), {
    childResident: false,
    activeRequest: false,
    sessionCount: 0,
    ownedBytesApprox: 0,
    budgetBytes: 536870912,
  })
})

test('idle user-model child exits at the configured test boundary', async (t) => {
  const directory = makeTempDir(t, 'idle')
  const childScript = writeFixtureChild(
    directory,
    'idle-child.js',
    `process.stdin.on('data', (chunk) => {
  const request = JSON.parse(String(chunk).trim())
  process.stdout.write(JSON.stringify({
    id: request.id,
    ok: true,
    session: { inputNames: [], outputNames: [], inputMetadata: [], outputMetadata: [] },
  }) + '\\n')
})
`,
  )
  useFixtureChild(t, childScript, { idleTimeoutMs: 25 })
  await host.loadUserModelSessionInIsolation('C:\\unused\\model.onnx', maxBytes)
  assert.equal(host.getUserModelRuntimeMemorySnapshot().childResident, true)
  await new Promise((resolve) => setTimeout(resolve, 75))
  assert.equal(host.getUserModelRuntimeMemorySnapshot().childResident, false)
})

test('a malformed ONNX model yields a clean inspection error, not a crash', async (t) => {
  if (!bundlePresent) return t.skip('run npm run build:renderer before the isolation tests')
  const directory = makeTempDir(t, 'garbage')
  const garbageModel = path.join(directory, 'garbage.onnx')
  fs.writeFileSync(garbageModel, Buffer.alloc(8 * 1024, 0xab))
  useFixtureChild(t, childBundle)

  await assert.rejects(host.inspectUserModelInIsolation(garbageModel, faceProfile, maxBytes))

  // The handled error leaves the child usable for the next request.
  if (!modelPresent) return t.skip('fixture model is not available')
  const inspection = await host.inspectUserModelInIsolation(fixtureModel, faceProfile, maxBytes)
  assert.equal(inspection.compatible, true)
})

test('user model import E2E passes through the isolated runtime boundary', async (t) => {
  if (!bundlePresent) return t.skip('run npm run build:renderer before the isolation tests')
  if (!modelPresent) return t.skip('fixture model is not available')
  const userDataDir = makeTempDir(t, 'e2e')

  const electronStub = {
    app: {
      isPackaged: false,
      getPath: () => userDataDir,
      getAppPath: () => root,
    },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [fixtureModel] }) },
    shell: { openPath: async () => '' },
  }
  const Module = require('node:module')
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') return electronStub
    return originalLoad.call(this, request, ...rest)
  }
  t.after(() => {
    Module._load = originalLoad
  })

  host.setUserModelRuntimeChildOptionsForTests({ scriptPath: childBundle })
  t.after(() => {
    host.disposeUserModelRuntimeChild()
    host.setUserModelRuntimeChildOptionsForTests()
  })

  const service = loadTsModule('electron/userModelPlatformService.ts')
  const result = await service.importUserModel('face-detector', true)
  assert.equal(result.ok, true, result.error)
  assert.equal(result.status.installed, true)
  assert.equal(result.status.inspection?.compatible, true)
  assert.ok(result.status.inspection.inputs.length > 0)
  assert.ok(
    fs.existsSync(path.join(userDataDir, 'models', 'face-detector', 'installation.json')),
    'installation metadata must be committed inside the isolated userData root',
  )

  const installedModel = path.join(userDataDir, 'models', 'face-detector', 'model.onnx')
  await host.loadUserModelSessionInIsolation(installedModel, maxBytes)
  const runtimeMemory = host.getUserModelRuntimeMemorySnapshot()
  assert.equal(runtimeMemory.childResident, true)
  assert.equal(runtimeMemory.sessionCount, 1)
  assert.ok(runtimeMemory.ownedBytesApprox > fs.statSync(installedModel).size)
  assert.ok(runtimeMemory.ownedBytesApprox <= runtimeMemory.budgetBytes)
  assert.deepEqual(host.requestUserModelRuntimeMemoryPressureRelease(), {
    status: 'released',
    activeRequest: false,
  })

  const slots = service.listUserModelSlots()
  assert.equal(slots.find((slot) => slot.id === 'face-detector')?.installed, true)
  await service.removeUserModel('face-detector')
  assert.equal(
    service.listUserModelSlots().find((slot) => slot.id === 'face-detector')?.installed,
    false,
  )
})
