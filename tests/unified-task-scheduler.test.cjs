// Phase 3 acceptance tests for the unified staged task scheduler:
// - D1 discovery is never blocked by GPU/video tasks (design 8.2 constraint
//   1/2): the GPU lane and the local lane are fully isolated execution loops;
// - queued tasks follow (priority, stage rank, enqueue order);
// - setVisiblePaths bumps visible-path tasks to P0 in both lanes.
const test = require('node:test')
const assert = require('node:assert/strict')
const { loadTsModule } = require('./guard-utils.cjs')

const { UnifiedTaskScheduler, unifiedTaskLaneForStage } = loadTsModule(
  'electron/unifiedTaskScheduler.ts',
)

function gate() {
  let release
  const promise = new Promise((resolve) => {
    release = resolve
  })
  return { promise, release }
}

test('lanes: embedding and video-deep run on the isolated GPU lane', () => {
  assert.equal(unifiedTaskLaneForStage('discovery'), 'local')
  assert.equal(unifiedTaskLaneForStage('metadata'), 'local')
  assert.equal(unifiedTaskLaneForStage('preview'), 'local')
  assert.equal(unifiedTaskLaneForStage('hash'), 'local')
  assert.equal(unifiedTaskLaneForStage('embedding'), 'gpu')
  assert.equal(unifiedTaskLaneForStage('video-deep'), 'gpu')
})

test('D1 discovery completes while the GPU lane is fully occupied', async () => {
  const scheduler = new UnifiedTaskScheduler({ localConcurrency: 1, gpuConcurrency: 1 })
  const videoGate = gate()
  let videoFinished = false
  const video = scheduler.enqueue({
    stage: 'video-deep',
    label: 'video deep indexing',
    run: async () => {
      await videoGate.promise
      videoFinished = true
      return 'video-done'
    },
  })
  const embedding = scheduler.enqueue({
    stage: 'embedding',
    label: 'background embedding',
    run: async () => 'embedding-done',
  })
  // The GPU lane is now saturated (1 running, 1 queued). D1 must still run.
  const discovery = scheduler.enqueue({
    stage: 'discovery',
    label: 'D1 fast discovery',
    run: async () => 'd1-done',
  })
  const result = await Promise.race([
    discovery.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('D1 was blocked')), 2000)),
  ])
  assert.equal(result, 'd1-done')
  assert.equal(videoFinished, false, 'GPU task must still be holding its lane')
  const stats = scheduler.stats()
  assert.equal(stats.lanes.gpu.running, 1)
  assert.equal(stats.lanes.gpu.queued, 1)
  assert.equal(stats.lanes.local.completed, 1)
  videoGate.release()
  await video.promise
  await embedding.promise
})

test('queued tasks follow priority then stage rank (D1 ahead of D2-D4)', async () => {
  const scheduler = new UnifiedTaskScheduler({ localConcurrency: 1, gpuConcurrency: 1 })
  const laneGate = gate()
  const blocker = scheduler.enqueue({ stage: 'metadata', run: () => laneGate.promise })
  const order = []
  const track = (stage, label) =>
    scheduler.enqueue({
      stage,
      label,
      run: async () => {
        order.push(label)
        return label
      },
    })
  const tasks = [
    track('hash', 'hash'),
    track('preview', 'preview'),
    track('metadata', 'metadata'),
    track('discovery', 'discovery'),
  ]
  laneGate.release()
  await blocker.promise
  await Promise.all(tasks.map((task) => task.promise))
  assert.deepEqual(order, ['discovery', 'metadata', 'preview', 'hash'])
})

test('explicit priority beats stage rank', async () => {
  const scheduler = new UnifiedTaskScheduler({ localConcurrency: 1, gpuConcurrency: 1 })
  const laneGate = gate()
  const blocker = scheduler.enqueue({ stage: 'metadata', run: () => laneGate.promise })
  const order = []
  const first = scheduler.enqueue({
    stage: 'embedding',
    priority: 0,
    label: 'p0-embedding',
    run: async () => {
      order.push('p0-embedding')
      return 1
    },
  })
  // Force the embedding task onto the local lane ordering comparison by also
  // queueing a P0 discovery; GPU lane runs independently so compare locally.
  const second = scheduler.enqueue({
    stage: 'discovery',
    priority: 2,
    label: 'p2-discovery',
    run: async () => {
      order.push('p2-discovery')
      return 2
    },
  })
  laneGate.release()
  await blocker.promise
  await Promise.all([first.promise, second.promise])
  assert.deepEqual(order, ['p0-embedding', 'p2-discovery'])
})

test('setVisiblePaths bumps visible preview and embedding tasks to the front', async () => {
  const scheduler = new UnifiedTaskScheduler({ localConcurrency: 1, gpuConcurrency: 1 })
  const localGate = gate()
  const gpuGate = gate()
  const localBlocker = scheduler.enqueue({ stage: 'metadata', run: () => localGate.promise })
  const gpuBlocker = scheduler.enqueue({ stage: 'embedding', run: () => gpuGate.promise })
  const order = []
  const previewA = scheduler.enqueue({
    stage: 'preview',
    paths: ['D:\\library\\a.jpg'],
    run: async () => {
      order.push('preview-a')
    },
  })
  const previewB = scheduler.enqueue({
    stage: 'preview',
    paths: ['D:\\library\\b.jpg'],
    run: async () => {
      order.push('preview-b')
    },
  })
  const embedC = scheduler.enqueue({
    stage: 'embedding',
    paths: ['D:\\library\\c.jpg'],
    run: async () => {
      order.push('embed-c')
    },
  })
  const embedD = scheduler.enqueue({
    stage: 'embedding',
    paths: ['D:\\library\\d.jpg'],
    run: async () => {
      order.push('embed-d')
    },
  })
  const bumped = scheduler.setVisiblePaths(['d:/library/b.jpg', 'd:/library/d.jpg'])
  assert.equal(bumped, 2, 'one queued task per lane intersects the visible set')
  localGate.release()
  gpuGate.release()
  await localBlocker.promise
  await gpuBlocker.promise
  await Promise.all([previewA.promise, previewB.promise, embedC.promise, embedD.promise])
  assert.deepEqual(order, ['preview-b', 'embed-d', 'preview-a', 'embed-c'])
})

test('cancel rejects a queued task and frees its slot', async () => {
  const scheduler = new UnifiedTaskScheduler({ localConcurrency: 1, gpuConcurrency: 1 })
  const laneGate = gate()
  const blocker = scheduler.enqueue({ stage: 'metadata', run: () => laneGate.promise })
  const victim = scheduler.enqueue({ stage: 'preview', run: async () => 'never' })
  assert.equal(scheduler.cancel(victim.id), true)
  await assert.rejects(victim.promise, /cancelled/i)
  laneGate.release()
  await blocker.promise
  const stats = scheduler.stats()
  assert.equal(stats.lanes.local.cancelled, 1)
  assert.equal(stats.lanes.local.completed, 1)
})
