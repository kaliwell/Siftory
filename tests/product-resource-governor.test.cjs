const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { UnifiedResourceGovernor, normalizeUnifiedResourceProfile, unifiedResourcePolicy } =
  loadTsModule('electron/resourceGovernor.ts')
const { loadResourceGovernorProfile, resourceGovernorSettingsPath, saveResourceGovernorProfile } =
  loadTsModule('electron/resourceGovernorStore.ts')
const { UnifiedTaskScheduler } = loadTsModule('electron/unifiedTaskScheduler.ts')

function gate() {
  let release
  const promise = new Promise((resolve) => {
    release = resolve
  })
  return { promise, release }
}

test('resource profiles bound CPU, GPU, memory, VRAM, disk, queue, and I/O budgets', () => {
  assert.equal(normalizeUnifiedResourceProfile('power-saver'), 'power-saver')
  assert.equal(normalizeUnifiedResourceProfile('quality'), 'quality')
  assert.equal(normalizeUnifiedResourceProfile('unbounded'), undefined)
  const saver = unifiedResourcePolicy('power-saver')
  const balanced = unifiedResourcePolicy('balanced')
  const quality = unifiedResourcePolicy('quality')
  assert.ok(saver.localConcurrency < balanced.localConcurrency)
  assert.ok(balanced.localConcurrency < quality.localConcurrency)
  assert.ok(saver.gpuConcurrency <= balanced.gpuConcurrency)
  assert.ok(balanced.gpuConcurrency <= quality.gpuConcurrency)
  assert.ok(saver.ioConcurrency < quality.ioConcurrency)
  assert.ok(saver.maxQueued < balanced.maxQueued)
  assert.ok(saver.cpuTargetPercent < quality.cpuTargetPercent)
  for (const policy of [saver, balanced, quality]) {
    assert.ok(policy.maxWorkingSetBytes > 0)
    assert.ok(policy.minFreeMemoryBytes > 0)
    assert.ok(policy.minFreeVideoMemoryBytes > 0)
    assert.ok(policy.minFreeDiskBytes > 0)
  }
})

test('pressure pauses background work but keeps explicit foreground work responsive', async () => {
  const scheduler = new UnifiedTaskScheduler({ resourceProfile: 'quality' })
  scheduler.updateResourcePressure({
    cpuLoadPercent: 99,
    processWorkingSetBytes: 20 * 1024 ** 3,
    freeSystemMemoryBytes: 128 * 1024 ** 2,
    totalSystemMemoryBytes: 16 * 1024 ** 3,
    freeVideoMemoryBytes: 128 * 1024 ** 2,
    freeDiskBytes: 256 * 1024 ** 2,
  })
  let backgroundRan = false
  const background = scheduler.enqueue({
    stage: 'embedding',
    priority: 3,
    run: async () => {
      backgroundRan = true
      return 'background'
    },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(backgroundRan, false)
  assert.equal(scheduler.stats().resource.backgroundPaused, true)
  assert.deepEqual(scheduler.stats().resource.pressureReasons, ['cpu', 'memory', 'vram', 'disk'])

  const foreground = scheduler.enqueue({
    stage: 'embedding',
    priority: 0,
    run: async () => 'foreground',
  })
  assert.equal(await foreground.promise, 'foreground')
  assert.equal(backgroundRan, false)
  scheduler.updateResourcePressure({
    cpuLoadPercent: 5,
    processWorkingSetBytes: 256 * 1024 ** 2,
    freeSystemMemoryBytes: 12 * 1024 ** 3,
    totalSystemMemoryBytes: 16 * 1024 ** 3,
    freeVideoMemoryBytes: 6 * 1024 ** 3,
    freeDiskBytes: 100 * 1024 ** 3,
  })
  assert.equal(await background.promise, 'background')
  assert.equal(backgroundRan, true)
})

test('profile concurrency is dynamic and queued background cancellation is explicit', async () => {
  const scheduler = new UnifiedTaskScheduler({ resourceProfile: 'power-saver' })
  const blockerGate = gate()
  const blocker = scheduler.enqueue({
    stage: 'embedding',
    priority: 0,
    run: () => blockerGate.promise,
  })
  const first = scheduler.enqueue({ stage: 'video-deep', run: async () => 'first' })
  const second = scheduler.enqueue({ stage: 'embedding', run: async () => 'second' })
  const rejected = [first.promise.catch((error) => error), second.promise.catch((error) => error)]
  assert.equal(scheduler.stats().resource.effectiveGpuConcurrency, 1)
  assert.equal(scheduler.stats().lanes.gpu.queued, 2)
  assert.equal(scheduler.cancelBackgroundTasks(), 2)
  const errors = await Promise.all(rejected)
  assert.ok(errors.every((error) => /cancelled/i.test(error.message)))
  assert.equal(scheduler.stats().resource.cancelledForPolicy, 2)
  blockerGate.release()
  await blocker.promise

  scheduler.setResourceProfile('quality')
  assert.equal(scheduler.stats().resource.effectiveLocalConcurrency, 6)
  assert.equal(scheduler.stats().resource.effectiveGpuConcurrency, 2)
})

test('power saver responds to battery state without blocking interactive tasks', () => {
  const governor = new UnifiedResourceGovernor('power-saver')
  governor.updatePressure({ onBattery: true })
  assert.deepEqual(governor.pressureReasons(), ['battery'])
  assert.equal(governor.canRun(3), false)
  assert.equal(governor.canRun(0), true)
  governor.setProfile('balanced')
  assert.deepEqual(governor.pressureReasons(), [])
})

test('resource profile persistence is bounded and corrupt settings fall back safely', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-resource-governor-'))
  try {
    assert.equal(loadResourceGovernorProfile(root), 'balanced')
    saveResourceGovernorProfile(root, 'quality')
    assert.equal(loadResourceGovernorProfile(root), 'quality')
    const settingsPath = resourceGovernorSettingsPath(root)
    const stored = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    assert.deepEqual(stored, {
      schema: 'siftory-resource-governor/v1',
      profile: 'quality',
    })
    assert.equal(fs.existsSync(`${settingsPath}.${process.pid}.tmp`), false)
    fs.writeFileSync(settingsPath, '{broken', 'utf8')
    assert.equal(loadResourceGovernorProfile(root), 'balanced')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('task center exposes guarded profile selection, pressure state, and cancellation', () => {
  const root = path.resolve(__dirname, '..')
  const ui = fs.readFileSync(path.join(root, 'src', 'components', 'WorkspaceNavigator.tsx'), 'utf8')
  const ipc = fs.readFileSync(path.join(root, 'electron', 'unifiedSearchIpc.ts'), 'utf8')
  const runtime = fs.readFileSync(path.join(root, 'electron', 'unifiedSearchRuntime.ts'), 'utf8')
  assert.match(ui, /data-testid="resource-governor-profile"/)
  assert.match(ui, /setResourceProfile\(profile\)/)
  assert.match(ui, /data-testid="resource-governor-pressure"/)
  assert.match(ui, /cancelBackgroundTasks\(\)/)
  assert.match(ipc, /RESOURCE_PROFILE_SET/)
  assert.match(ipc, /RESOURCE_BACKGROUND_CANCEL/)
  assert.match(runtime, /statfsSync/)
  assert.match(runtime, /process\.memoryUsage\(\)\.rss/)
})
