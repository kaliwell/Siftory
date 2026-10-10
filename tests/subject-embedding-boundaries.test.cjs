// Boundary fixtures for subject/face/person embeddings (VAL-037):
//   - child framing violations are bounded on both ends of the protocol
//   - hostile run outputs (NaN / shape-mismatch / oversized tensors) crossing
//     the isolated boundary degrade to the explicit 'output-invalid' negative
//     state instead of poisoning results or crashing main
//   - corrupt subject-embedding store entries are skipped (tombstoned) and
//     surfaced, while valid entries and negative markers survive

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// Stub electron before loading any service: all userData access (model slots,
// embedding store) must land in an isolated temp root.
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-seb-userdata-'))
const Module = require('node:module')
const originalLoad = Module._load
const electronStub = {
  app: {
    isPackaged: false,
    getPath: () => userDataDir,
    getAppPath: () => path.resolve(__dirname, '..'),
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '' },
}
Module._load = function patchedLoad(request, ...rest) {
  if (request === 'electron') return electronStub
  return originalLoad.call(this, request, ...rest)
}

const { loadTsModule } = require('./guard-utils.cjs')

const host = loadTsModule('electron/userModelRuntimeHost.ts')
const sessions = loadTsModule('electron/userModelSessionService.ts')
const framing = loadTsModule('electron/embeddingChildLineFraming.ts')
const binaryProtocol = loadTsModule('electron/userModelBinaryProtocol.ts')
const reid = loadTsModule('electron/personReidService.ts')
const store = loadTsModule('electron/subjectEmbeddingStore.ts')

const fixtureImage = path.resolve(__dirname, 'fixtures', 'faces', 'obama.jpg')
const imagePresent = fs.existsSync(fixtureImage)
const reidModelDir = path.join(userDataDir, 'models', 'person-reid')
fs.mkdirSync(reidModelDir, { recursive: true })
fs.writeFileSync(path.join(reidModelDir, 'model.onnx'), Buffer.alloc(2048, 7))

function useFakeChild(t, scriptSource) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-seb-child-'))
  const scriptPath = path.join(directory, 'fake-child.js')
  fs.writeFileSync(scriptPath, scriptSource)
  host.setUserModelRuntimeChildOptionsForTests({ scriptPath })
  t.after(() => {
    host.disposeUserModelRuntimeChild()
    host.setUserModelRuntimeChildOptionsForTests()
    sessions.resetUserModelSessionsForTests()
    fs.rmSync(directory, { recursive: true, force: true })
  })
}

const REID_SESSION_INFO = {
  inputNames: ['input'],
  outputNames: ['embedding'],
  inputMetadata: [
    { name: 'input', type: 'tensor(float)', isTensor: true, shape: [1, 3, 256, 128] },
  ],
  outputMetadata: [{ name: 'embedding', type: 'tensor(float)', isTensor: true, shape: [1, 512] }],
}

function fakeChildSource(outputs) {
  return `const SESSION = ${JSON.stringify(REID_SESSION_INFO)}
const OUTPUTS = ${JSON.stringify(outputs)}
let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffered += chunk
  for (;;) {
    const newline = buffered.indexOf('\\n')
    if (newline < 0) return
    const line = buffered.slice(0, newline)
    buffered = buffered.slice(newline + 1)
    if (!line.trim()) continue
    const request = JSON.parse(line)
    if (request.op === 'load') {
      process.stdout.write(JSON.stringify({ id: request.id, ok: true, session: SESSION }) + '\\n')
    } else if (request.op === 'run') {
      process.stdout.write(JSON.stringify({ id: request.id, ok: true, outputs: OUTPUTS }) + '\\n')
    }
  }
})
`
}

function embeddingPayload(floats) {
  const buffer = Buffer.alloc(floats.length * 4)
  floats.forEach((value, index) => buffer.writeFloatLE(value, index * 4))
  return buffer.toString('base64')
}

test('runtime line framing stays bounded at the tensor-sized cap', () => {
  const framer = new framing.BoundedEmbeddingChildLineFramer(
    framing.MAX_USER_MODEL_RUNTIME_LINE_BYTES,
  )
  assert.ok(framing.MAX_USER_MODEL_RUNTIME_LINE_BYTES > framing.MAX_EMBEDDING_CHILD_LINE_BYTES)
  assert.deepEqual(framer.push('{"id":1,"ok":true}\n'), {
    lines: ['{"id":1,"ok":true}'],
    overflow: false,
  })
  const overflow = framer.push('x'.repeat(framing.MAX_USER_MODEL_RUNTIME_LINE_BYTES + 1))
  assert.equal(overflow.overflow, true)
})

test('user-model binary framing preserves tensor bytes across fragmented chunks', () => {
  const tensor = new Float32Array([1.25, -2.5, 3.75])
  const frame = binaryProtocol.encodeUserModelBinaryFrame(
    { id: 7, op: 'run', feeds: [{ dataOffset: 0, dataBytes: tensor.byteLength }] },
    [tensor],
  )
  const decoder = new binaryProtocol.UserModelBinaryFrameDecoder()
  const split = Math.floor(frame.length / 2)
  assert.deepEqual(decoder.push(frame.subarray(0, split)), { frames: [], overflow: false })
  const decoded = decoder.push(frame.subarray(split))
  assert.equal(decoded.overflow, false)
  assert.equal(decoded.frames.length, 1)
  assert.equal(decoded.frames[0].header.op, 'run')
  const tensorBytes = decoded.frames[0].body
  assert.deepEqual(
    Array.from(
      new Float32Array(
        tensorBytes.buffer.slice(tensorBytes.byteOffset, tensorBytes.byteOffset + tensorBytes.length),
      ),
    ),
    Array.from(tensor),
  )
  assert.equal(frame.includes(Buffer.from(tensor.buffer).toString('base64')), false)
})

test('user-model binary framing rejects oversized declared bodies before allocation', () => {
  const prefix = Buffer.alloc(8)
  prefix.writeUInt32LE(2, 0)
  prefix.writeUInt32LE(binaryProtocol.MAX_USER_MODEL_RUNTIME_BINARY_BYTES + 1, 4)
  const decoder = new binaryProtocol.UserModelBinaryFrameDecoder()
  assert.deepEqual(decoder.push(prefix), { frames: [], overflow: true })
})

test('a NaN embedding from the runtime degrades to output-invalid, never a result', async (t) => {
  if (!imagePresent) return t.skip('fixture image is not available')
  const vector = new Array(512).fill(0.25)
  vector[7] = Number.NaN
  useFakeChild(
    t,
    fakeChildSource([{ name: 'embedding', dims: [1, 512], dataB64: embeddingPayload(vector) }]),
  )
  const result = await reid.getPersonEmbedding(fixtureImage)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'output-invalid')
  assert.ok(result.error)
})

test('a shape-mismatched tensor payload is rejected at the host boundary', async (t) => {
  if (!imagePresent) return t.skip('fixture image is not available')
  useFakeChild(
    t,
    fakeChildSource([{ name: 'embedding', dims: [1, 512], dataB64: embeddingPayload([0.1, 0.2]) }]),
  )
  const result = await reid.getPersonEmbedding(fixtureImage)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'output-invalid')
  assert.match(result.error, /declared shape/)
})

test('an oversized tensor declaration is rejected at the host boundary', async (t) => {
  if (!imagePresent) return t.skip('fixture image is not available')
  useFakeChild(
    t,
    fakeChildSource([
      { name: 'embedding', dims: [1, 70_000_000], dataB64: embeddingPayload([0.1]) },
    ]),
  )
  const result = await reid.getPersonEmbedding(fixtureImage)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'output-invalid')
  assert.match(result.error, /oversized tensor/)
})

test('a missing model and a crashing runtime report explicit negative states', async (t) => {
  if (!imagePresent) return t.skip('fixture image is not available')
  // model-missing: no signature in a fresh slot view
  sessions.resetUserModelSessionsForTests()
  const modelPath = path.join(reidModelDir, 'model.onnx')
  fs.rmSync(modelPath)
  const missing = await reid.getPersonEmbedding(fixtureImage)
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'model-missing')

  // model-invalid: the model file exists but the runtime dies on load
  fs.writeFileSync(modelPath, Buffer.alloc(2048, 7))
  useFakeChild(t, `process.stdin.on('data', () => process.exit(1))\n`)
  const crashed = await reid.getPersonEmbedding(fixtureImage)
  assert.equal(crashed.ok, false)
  assert.equal(crashed.reason, 'model-invalid')
  assert.match(crashed.error, /User model runtime exited/)
})

test('corrupt store entries are skipped and surfaced while valid ones survive', () => {
  const storeDir = path.join(userDataDir, 'subject-embeddings')
  fs.mkdirSync(storeDir, { recursive: true })
  const hugeVector = new Array(20_000).fill(0.5)
  const lines = [
    JSON.stringify({ key: 'face|/t/good.jpg|1', vector: [0.5, 0.5], createdAt: 1 }),
    JSON.stringify({ key: 'face|/t/negative.jpg|1', vector: [], createdAt: 2 }),
    JSON.stringify({ key: 'face|/t/nulls.jpg|1', vector: [null, null], createdAt: 3 }),
    JSON.stringify({ key: 'face|/t/strings.jpg|1', vector: ['x'], createdAt: 4 }),
    JSON.stringify({ key: 'face|/t/huge.jpg|1', vector: hugeVector, createdAt: 5 }),
    JSON.stringify({ key: 'face|/t/zero.jpg|1', vector: [0, 0], createdAt: 6 }),
    'this is not json',
  ]
  fs.writeFileSync(path.join(storeDir, 'embeddings.jsonl'), `${lines.join('\n')}\n`, 'utf8')

  store.resetSubjectEmbeddingStoreForTests()
  assert.deepEqual(store.getSubjectEmbedding('face|/t/good.jpg|1'), [0.5, 0.5])
  assert.deepEqual(store.getSubjectEmbedding('face|/t/negative.jpg|1'), [])
  for (const key of ['nulls', 'strings', 'huge', 'zero']) {
    assert.equal(store.getSubjectEmbedding(`face|/t/${key}.jpg|1`), null, key)
  }
  assert.equal(store.subjectEmbeddingCorruptCount(), 5)

  // Invalid vectors are rejected on write and never enter the cache.
  store.putSubjectEmbedding('face|/t/hostile.jpg|1', [Number.NaN, 1])
  assert.equal(store.getSubjectEmbedding('face|/t/hostile.jpg|1'), null)
})
