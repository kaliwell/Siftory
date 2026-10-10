const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const Module = require('node:module')
const { PassThrough } = require('node:stream')
const ts = require('typescript')
const { loadTsModule } = require('./guard-utils.cjs')

test('simultaneous action bodies respect one slot, preserve replay and release after failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-api-slot-test-'))
  const policy = loadTsModule('electron/aiControlPolicy.ts')
  const pending = []
  let running = 0,
    peak = 0,
    shouldFail = false
  const scan = () => {
    if (shouldFail) throw new Error('fixture failure')
    running += 1
    peak = Math.max(peak, running)
    return new Promise((resolve) =>
      pending.push(() => {
        running -= 1
        resolve({ done: true })
      }),
    )
  }
  const filename = path.resolve(__dirname, '../electron/aiControlApi.ts')
  const source =
    fs.readFileSync(filename, 'utf8') +
    `
    export const testHandle = handleRequest;
    export function testSetup(dir: string) {
      options = {userDataPath: dir} as any;
      config = {version: 1, enabled: true, port: 32145, tokenScopes: ['search']};
      plaintextToken = 'fixture-only-token';
    }`
  const mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = Module._nodeModulePaths(path.dirname(filename))
  const originalRequire = mod.require.bind(mod)
  mod.require = (id) =>
    id === 'electron'
      ? { app: { getVersion: () => 'test' }, safeStorage: {} }
      : id === './aiControlPolicy'
        ? policy
        : id === './largeFileInventoryService'
          ? { scanStorageLargeFiles: scan }
          : id.startsWith('.')
            ? {}
            : originalRequire(id)
  mod._compile(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  )
  mod.exports.testSetup(dir)
  function pair(key) {
    const request = new PassThrough()
    request.headers = {
      host: '127.0.0.1:32145',
      authorization: 'Bearer fixture-only-token',
      'content-type': 'application/json',
      ...(key ? { 'idempotency-key': key } : {}),
    }
    request.socket = { remoteAddress: '127.0.0.1' }
    request.url = '/v1/actions/storage.largeFiles'
    request.method = 'POST'
    const response = {
      headersSent: false,
      writeHead(status) {
        this.status = status
        this.headersSent = true
      },
      end(body) {
        this.body = JSON.parse(body)
      },
    }
    const completed = mod.exports.testHandle(request, response)
    return { request, response, completed }
  }
  const tick = () => new Promise((resolve) => setImmediate(resolve))
  const finish = () => pending.splice(0).forEach((resolve) => resolve())
  try {
    const first = pair('same-request'),
      second = pair('another-request')
    first.request.end(JSON.stringify({ scope: 'temporary' }))
    await tick()
    second.request.end(JSON.stringify({ scope: 'temporary' }))
    await Promise.all([first.completed, second.completed])
    assert.equal(first.response.status, 202)
    assert.equal(second.response.status, 409)
    assert.equal(second.response.body.error.code, 'concurrency_limit')
    assert.equal(peak, 1)
    const replay = pair('same-request')
    replay.request.end(JSON.stringify({ scope: 'temporary' }))
    await replay.completed
    assert.equal(replay.response.status, 202)
    assert.equal(replay.response.body.replayed, true)
    assert.equal(replay.response.body.jobId, first.response.body.jobId)
    assert.equal(running, 1)
    finish()
    await tick()

    const malformed = pair()
    malformed.request.end('{')
    await malformed.completed
    assert.equal(malformed.response.status, 400)
    shouldFail = true
    const failed = pair()
    failed.request.end(JSON.stringify({ scope: 'temporary' }))
    await failed.completed
    await tick()
    assert.equal(failed.response.status, 202)
    shouldFail = false
    const next = pair()
    next.request.end(JSON.stringify({ scope: 'temporary' }))
    await next.completed
    assert.equal(next.response.status, 202, 'failed execution must release its slot')
    assert.equal(running, 1)
    assert.equal(peak, 1)
  } finally {
    finish()
    await mod.exports.shutdownAiControlApi()
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(dir).startsWith('siftory-api-slot-test-'))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
