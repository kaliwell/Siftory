const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  aggregateElectronProcessMemory,
  collectRuntimeResourceMetrics,
  parseNvidiaGpuMemory,
  parseProcessTreeMemory,
} = loadTsModule('electron/runtimeResourcePressure.ts')
const { UnifiedResourceGovernor } = loadTsModule('electron/resourceGovernor.ts')

test('runtime resource pressure aggregates the complete Electron process group', () => {
  assert.deepEqual(
    aggregateElectronProcessMemory([
      {
        pid: 1,
        type: 'Browser',
        cpu: { percentCPUUsage: 3 },
        memory: { workingSetSize: 100, privateBytes: 80 },
      },
      {
        pid: 2,
        type: 'Tab',
        cpu: { percentCPUUsage: 4 },
        memory: { workingSetSize: 50, privateBytes: 40 },
      },
      { pid: 3, type: 'GPU', memory: { workingSetSize: 25 } },
    ]),
    {
      processCount: 3,
      cpuPercent: 7,
      workingSetBytes: 175 * 1024,
      privateBytes: 120 * 1024,
      privateMetricCount: 2,
      gpuProcessCount: 1,
    },
  )
})

test('runtime resource pressure parsers fail closed and aggregate real GPU memory', () => {
  assert.deepEqual(
    parseProcessTreeMemory('{"processCount":4,"workingSetBytes":4096,"privateBytes":3072}'),
    { processCount: 4, workingSetBytes: 4096, privateBytes: 3072 },
  )
  assert.equal(parseProcessTreeMemory('{"processCount":0}'), undefined)
  assert.deepEqual(parseNvidiaGpuMemory('100, 1000, 4\n200, 2000, 7\n'), {
    deviceCount: 2,
    usedBytes: 300 * 1024 * 1024,
    totalBytes: 3000 * 1024 * 1024,
    utilizationPercent: 7,
  })
  assert.equal(parseNvidiaGpuMemory('broken'), undefined)
})

test('cross-platform missing probes preserve Electron metrics without inventing values', async () => {
  const result = await collectRuntimeResourceMetrics(
    [{ pid: 1, type: 'Browser', memory: { workingSetSize: 10 } }],
    {
      processTreeProbe: async () => undefined,
      gpuProbe: async () => undefined,
    },
  )
  assert.equal(result.electron.workingSetBytes, 10 * 1024)
  assert.equal(result.processTree, undefined)
  assert.equal(result.gpu, undefined)
})

test('governor prioritizes process-tree Private Bytes and applies live-sample hysteresis', () => {
  const governor = new UnifiedResourceGovernor('balanced')
  const pressured = {
    processWorkingSetBytes: 100,
    processTreePrivateBytes: 5 * 1024 ** 3,
    freeSystemMemoryBytes: 8 * 1024 ** 3,
    totalSystemMemoryBytes: 16 * 1024 ** 3,
  }
  governor.updatePressure(pressured, { hysteresis: true, enterSamples: 2, exitSamples: 3 })
  assert.deepEqual(governor.pressureReasons(), [])
  governor.updatePressure(pressured, { hysteresis: true, enterSamples: 2, exitSamples: 3 })
  assert.deepEqual(governor.pressureReasons(), ['memory'])

  const clear = {
    processTreePrivateBytes: 512 * 1024 ** 2,
    freeSystemMemoryBytes: 8 * 1024 ** 3,
    totalSystemMemoryBytes: 16 * 1024 ** 3,
  }
  governor.updatePressure(clear, { hysteresis: true, enterSamples: 2, exitSamples: 3 })
  governor.updatePressure(clear, { hysteresis: true, enterSamples: 2, exitSamples: 3 })
  assert.deepEqual(governor.pressureReasons(), ['memory'])
  governor.updatePressure(clear, { hysteresis: true, enterSamples: 2, exitSamples: 3 })
  assert.deepEqual(governor.pressureReasons(), [])

  governor.updatePressure(pressured)
  assert.deepEqual(governor.pressureReasons(), ['memory'])
})
