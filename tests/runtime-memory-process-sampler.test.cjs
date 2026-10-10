const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  normalizeIntervalMs,
  readRuntimeMemorySamples,
  startRuntimeMemorySampler,
  validateRuntimeMemorySample,
} = require('../scripts/runtime-memory-process-sampler.cjs')

function temporaryDirectory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-runtime-memory-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('runtime memory interval is bounded to 100-500 ms', () => {
  assert.equal(normalizeIntervalMs(undefined), 250)
  assert.equal(normalizeIntervalMs(20), 100)
  assert.equal(normalizeIntervalMs(175.4), 175)
  assert.equal(normalizeIntervalMs(900), 500)
})

test('runtime memory sample validation rejects identities, leaks, and missing metrics', () => {
  const valid = {
    schema: 'siftory-runtime-memory-sample/v1',
    sequence: 0,
    sampledAt: '2026-08-28T00:00:00.000Z',
    intervalMs: 250,
    rootIdentity: '42@100',
    system: { freePhysicalMemoryBytes: 1, totalPhysicalMemoryBytes: 2 },
    aggregate: { processCount: 1, workingSetBytes: 1, privateBytes: 1, commitBytes: 1 },
    processes: [
      {
        identity: '42@100',
        pid: 42,
        ppid: 1,
        createdAt: '2026-08-28T00:00:00.000Z',
        name: 'node.exe',
        role: 'main',
        workingSetBytes: 1,
        privateBytes: 1,
        commitBytes: 1,
        pageFaults: 1,
        threadCount: 1,
        handleCount: 1,
        cpuKernelMs: 0,
        cpuUserMs: 0,
      },
    ],
  }
  assert.deepEqual(validateRuntimeMemorySample(structuredClone(valid)), valid)
  const leaked = structuredClone(valid)
  leaked.processes[0].commandLine = 'C:\\Users\\private\\model.onnx'
  assert.throws(() => validateRuntimeMemorySample(leaked), /leaked commandLine/)
  const reused = structuredClone(valid)
  reused.processes.push({ ...reused.processes[0], role: 'worker' })
  reused.aggregate.processCount = 2
  assert.throws(() => validateRuntimeMemorySample(reused), /duplicate process identity/)
})

test('runtime memory JSONL reader fails closed on malformed samples', (t) => {
  const root = temporaryDirectory(t)
  const output = path.join(root, 'samples.jsonl')
  fs.writeFileSync(output, '{"schema":"wrong"}\n', 'utf8')
  assert.throws(() => readRuntimeMemorySamples(output), /schema is invalid/)
})

test(
  'Windows sampler records a PID-reuse-safe recursive process snapshot without paths',
  { skip: process.platform !== 'win32', timeout: 30_000 },
  async (t) => {
    const root = temporaryDirectory(t)
    const outputFile = path.join(root, 'samples.jsonl')
    const stopFile = path.join(root, 'stop')
    const readyFile = path.join(root, 'ready')
    const sampler = await startRuntimeMemorySampler({
      rootPid: process.pid,
      outputFile,
      stopFile,
      readyFile,
      intervalMs: 100,
      maximumSamples: 100,
    })
    await new Promise((resolve) => setTimeout(resolve, 450))
    const samples = await sampler.stop()
    assert.ok(samples.length >= 1)
    assert.ok(samples.every((sample) => sample.rootIdentity === sampler.rootIdentity))
    assert.ok(samples.every((sample) => sample.processes.some((item) => item.role === 'main')))
    assert.ok(samples.every((sample) => sample.system.freePhysicalMemoryBytes > 0))
    const raw = fs.readFileSync(outputFile, 'utf8')
    assert.doesNotMatch(raw, /commandLine|executablePath|(?:[A-Z]:\\\\Users\\\\)/i)
  },
)
