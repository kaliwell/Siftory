const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const ts = require('typescript')

function fixture() {
  const file = path.resolve(__dirname, '../electron/ffmpegService.ts')
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  const jobs = [],
    children = [],
    exports = {}
  const context = {
    module: { exports },
    exports,
    __dirname: path.dirname(file),
    Buffer,
    setTimeout,
    clearTimeout,
    setImmediate: (callback) => jobs.push(callback),
    process: { platform: process.platform, env: {}, cwd: () => path.dirname(file), once() {} },
    require(id) {
      if (id === 'fs') return { existsSync: () => true }
      if (id === 'path') return path
      if (id === 'child_process')
        return {
          spawn(command) {
            const child = new EventEmitter()
            child.stdout = new EventEmitter()
            child.stderr = new EventEmitter()
            child.command = command
            child.kill = () => child.emit('exit', null)
            children.push(child)
            return child
          },
          spawnSync() {
            throw new Error('Synchronous probe must not run in warmup')
          },
        }
      throw new Error('Unexpected dependency ' + id)
    },
  }
  vm.runInNewContext(code, context, { filename: file })
  return {
    api: exports,
    children,
    async yield() {
      for (const job of jobs.splice(0)) job()
      await new Promise(setImmediate)
    },
    finish(child, version = 'version test') {
      child.stdout.emit('data', Buffer.from(version))
      child.emit('exit', 0)
    },
  }
}

test('warmup yields before probing and deduplicates concurrent readiness requests', async () => {
  const f = fixture()
  const first = f.api.warmFfmpegStatusCache()
  assert.equal(f.api.warmFfmpegStatusCache(), first)
  assert.equal(f.children.length, 0)
  await f.yield()
  assert.equal(f.children.length, 2)
  for (const child of f.children) f.finish(child)
  const result = await first
  assert.equal(result.ffmpeg.available, true)
  assert.equal(result.ffprobe.available, true)
  assert.equal((await f.api.warmFfmpegStatusCache()).ffmpeg.version, 'version test')
  assert.equal(f.children.length, 2)
})

test('cancellation before deferred probing cannot launch new media children', async () => {
  const f = fixture()
  const first = f.api.warmFfmpegStatusCache()
  f.api.cancelRunningMediaTools()
  await f.yield()
  await first
  assert.equal(f.children.length, 0)
  const retry = f.api.warmFfmpegStatusCache()
  await f.yield()
  for (const child of f.children) f.finish(child)
  assert.equal((await retry).ffmpeg.available, true)
})

test('an old configuration probe cannot overwrite a newer generation', async () => {
  const f = fixture()
  const first = f.api.warmFfmpegStatusCache()
  await f.yield()
  f.api.setConfiguredFfmpegDir('new-tools')
  const second = f.api.warmFfmpegStatusCache()
  await f.yield()
  for (const child of f.children.slice(2)) f.finish(child, 'version new')
  await second
  for (const child of f.children.slice(0, 2)) f.finish(child, 'version old')
  await first
  assert.equal(f.api.getCachedFfmpegStatus().ffmpeg.version, 'version new')
})

test('cancelling active probes does not cache their cancelled result', async () => {
  const f = fixture()
  const first = f.api.warmFfmpegStatusCache()
  await f.yield()
  f.api.cancelRunningMediaTools()
  await first
  assert.equal(f.api.getCachedFfmpegStatus().ffmpeg.error, 'status pending')
  const retry = f.api.warmFfmpegStatusCache()
  await f.yield()
  assert.equal(f.children.length, 4)
  for (const child of f.children.slice(2)) f.finish(child)
  assert.equal((await retry).ffmpeg.available, true)
})
