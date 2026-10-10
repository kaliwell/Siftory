const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const { promisify } = require('node:util')
const { performance } = require('node:perf_hooks')

const { loadTsModule } = require('./guard-utils.cjs')
const {
  assertFileSnapshotUnchanged,
  round,
  snapshotFiles,
  startResourceMonitor,
  writeJson,
} = require('./search-library-preparation-benchmark-utils.cjs')

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'])
const execFileAsync = promisify(childProcess.execFile)
const { readNvidiaVideoMemory, selectEmbeddingBatchSize } = loadTsModule(
  'electron/embeddingBatchPolicy.ts',
)
const { batchMetricsFromChildMessage } = loadTsModule('electron/embeddingChildLineFraming.ts')

function option(argv, name, fallback) {
  return argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
}

function parseArgs(argv) {
  const positional = argv.filter((value) => !value.startsWith('--'))
  const appData = process.env.APPDATA || ''
  const batchSize = Math.max(1, Math.min(16, Number(option(argv, 'batch-size', '4')) || 4))
  const batchSizes = option(argv, 'batch-sizes', String(batchSize)).split(',').map(Number)
  if (batchSizes.some((value) => !Number.isInteger(value) || value < 1 || value > 16)) {
    throw new Error('Use --batch-sizes with comma-separated integers from 1 to 16')
  }
  const models = option(argv, 'models', 'dino,clip').split(',')
  if (models.some((value) => !['dino', 'clip'].includes(value))) {
    throw new Error('Use --models=dino,clip, dino, or clip')
  }
  const jobs = Math.max(1, Math.min(2, Number(option(argv, 'jobs', '2')) || 2))
  const jobsList = option(argv, 'jobs-list', String(jobs)).split(',').map(Number)
  if (jobsList.some((value) => !Number.isInteger(value) || value < 1 || value > 2)) {
    throw new Error('Use --jobs-list with comma-separated integers from 1 to 2')
  }
  return {
    dataset: positional[0] ? path.resolve(positional[0]) : '',
    childrenDir: path.resolve(
      option(argv, 'children-dir', path.join(__dirname, '..', 'dist-electron')),
    ),
    modelsRoot: path.resolve(
      option(argv, 'models-root', path.join(appData, 'floating-clock-electron', 'models')),
    ),
    sampleSize: Math.max(4, Math.min(1000, Number(option(argv, 'sample', '32')) || 32)),
    jobs,
    jobsList: [...new Set(jobsList)],
    batchSize,
    batchSizes: [...new Set(batchSizes)],
    models: [...new Set(models)],
    backend: option(argv, 'backend', 'gpu'),
    tensorPrefetch: option(argv, 'tensor-prefetch', '0') === '1',
    timeoutMs: Math.max(60_000, Number(option(argv, 'timeout-ms', '600000')) || 600_000),
    stageMetrics: argv.includes('--stage-metrics'),
    resourceIntervalMs: Math.max(
      50,
      Math.min(1000, Number(option(argv, 'resource-interval-ms', '100')) || 100),
    ),
    jsonOut: option(argv, 'json-out', ''),
    timelineOut: option(argv, 'timeline-out', ''),
  }
}

function createTimeline(filePath) {
  if (!filePath) return { write: () => undefined }
  const resolved = path.resolve(filePath)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, '', 'utf8')
  const startedAt = performance.now()
  return {
    write(event, payload = {}) {
      fs.appendFileSync(
        resolved,
        `${JSON.stringify({
          schemaVersion: 1,
          event,
          atMs: Number((performance.now() - startedAt).toFixed(2)),
          ...payload,
        })}\n`,
        'utf8',
      )
    },
  }
}

function createStageMetrics() {
  return {
    schemaVersion: 1,
    batches: 0,
    items: 0,
    succeeded: 0,
    failed: 0,
    fallbackBatches: 0,
    queueWaitMsTotal: 0,
    queueWaitMsMax: 0,
    batchWallMsTotal: 0,
    batchWallMsMax: 0,
    runtimeLoadMsTotal: 0,
    decodeNormalizeMsTotal: 0,
    preprocessMsTotal: 0,
    inferenceMsTotal: 0,
    postprocessMsTotal: 0,
    fallbackMsTotal: 0,
    tensorPrefetchBatches: 0,
    tensorBytesMax: 0,
    prefetchPrepareMsTotal: 0,
    prefetchWaitMsTotal: 0,
    prefetchOverlapMsTotal: 0,
  }
}

function addStageMetrics(aggregate, metrics) {
  aggregate.batches += 1
  aggregate.items += metrics.batchSize
  aggregate.succeeded += metrics.succeeded
  aggregate.failed += metrics.failed
  aggregate.fallbackBatches += metrics.fallback ? 1 : 0
  aggregate.queueWaitMsTotal += metrics.queueWaitMsTotal
  aggregate.queueWaitMsMax = Math.max(aggregate.queueWaitMsMax, metrics.queueWaitMsMax)
  aggregate.batchWallMsTotal += metrics.batchWallMs
  aggregate.batchWallMsMax = Math.max(aggregate.batchWallMsMax, metrics.batchWallMs)
  aggregate.runtimeLoadMsTotal += metrics.runtimeLoadMs
  aggregate.decodeNormalizeMsTotal += metrics.decodeNormalizeMs
  aggregate.preprocessMsTotal += metrics.preprocessMs
  aggregate.inferenceMsTotal += metrics.inferenceMs
  aggregate.postprocessMsTotal += metrics.postprocessMs
  aggregate.fallbackMsTotal += metrics.fallbackMs
  aggregate.tensorPrefetchBatches += metrics.tensorPrefetch ? 1 : 0
  aggregate.tensorBytesMax = Math.max(aggregate.tensorBytesMax, metrics.tensorBytes)
  aggregate.prefetchPrepareMsTotal += metrics.prefetchPrepareMs
  aggregate.prefetchWaitMsTotal += metrics.prefetchWaitMs
  aggregate.prefetchOverlapMsTotal += metrics.prefetchOverlapMs
}

function candidatePreflight(config, jobs, batchSize, backend) {
  const freeSystemMemoryBytes = os.freemem()
  const totalSystemMemoryBytes = os.totalmem()
  const videoMemory = backend === 'gpu' ? readNvidiaVideoMemory() : null
  const selection = selectEmbeddingBatchSize({
    requestedBatchSize: 0,
    backend,
    modelName: config.modelName,
    maxConcurrency: jobs,
    freeSystemMemoryBytes,
    totalSystemMemoryBytes,
    freeVideoMemoryBytes: videoMemory?.freeVideoMemoryBytes,
    totalVideoMemoryBytes: videoMemory?.totalVideoMemoryBytes,
  })
  const allowed = batchSize <= selection.batchSize
  return {
    allowed,
    reason: allowed ? `within-${selection.reason}` : `exceeds-${selection.reason}`,
    policyMaxBatchSize: selection.batchSize,
    freeSystemMemoryMiB: Number((freeSystemMemoryBytes / 1024 / 1024).toFixed(2)),
    totalSystemMemoryMiB: Number((totalSystemMemoryBytes / 1024 / 1024).toFixed(2)),
    freeVideoMemoryMiB:
      videoMemory === null
        ? null
        : Number((videoMemory.freeVideoMemoryBytes / 1024 / 1024).toFixed(2)),
    totalVideoMemoryMiB:
      videoMemory === null
        ? null
        : Number((videoMemory.totalVideoMemoryBytes / 1024 / 1024).toFixed(2)),
  }
}

async function sampleWorkerWorkingSets(workers) {
  if (process.platform !== 'win32') return { totalMiB: 0, maxMiB: 0 }
  const pids = workers.map((worker) => worker.child.pid).filter(Number.isInteger)
  if (pids.length === 0) return { totalMiB: 0, maxMiB: 0 }
  const script =
    `$ids=@(${pids.join(',')}); ` +
    '@(Get-Process -Id $ids -ErrorAction SilentlyContinue | ForEach-Object { ' +
    '[pscustomobject]@{id=$_.Id;workingSet64=$_.WorkingSet64} }) | ConvertTo-Json -Compress'
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ])
    const parsed = JSON.parse(stdout)
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    const bytes = rows.map((row) => Number(row.workingSet64) || 0)
    return {
      totalMiB: Number((bytes.reduce((sum, value) => sum + value, 0) / 1024 / 1024).toFixed(2)),
      maxMiB: Number((Math.max(0, ...bytes) / 1024 / 1024).toFixed(2)),
    }
  } catch {
    return { totalMiB: 0, maxMiB: 0 }
  }
}

function compareVectors(reference, candidate) {
  assert.equal(reference.length, candidate.length)
  let cosineTotal = 0
  let minCosine = 1
  let maxAbsDiff = 0
  for (let row = 0; row < reference.length; row += 1) {
    let dot = 0
    let leftNorm = 0
    let rightNorm = 0
    for (let column = 0; column < reference[row].length; column += 1) {
      const left = reference[row][column]
      const right = candidate[row][column]
      dot += left * right
      leftNorm += left * left
      rightNorm += right * right
      maxAbsDiff = Math.max(maxAbsDiff, Math.abs(left - right))
    }
    const cosine = dot / Math.sqrt(leftNorm * rightNorm)
    minCosine = Math.min(minCosine, cosine)
    cosineTotal += cosine
  }
  return {
    minCosine: Number(minCosine.toFixed(8)),
    meanCosine: Number((cosineTotal / reference.length).toFixed(8)),
    maxAbsDiff: Number(maxAbsDiff.toFixed(8)),
  }
}

function collectImages(root, limit) {
  const images = []
  const queue = [root]
  while (queue.length > 0 && images.length < limit) {
    const directory = queue.shift()
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) queue.push(target)
      else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        images.push(target)
        if (images.length >= limit) break
      }
    }
  }
  return images
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    const timer = setTimeout(() => {
      child.kill()
      resolve()
    }, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function runModel(config, images, options) {
  assert.equal(fs.existsSync(config.childPath), true, `Missing child: ${config.childPath}`)
  assert.equal(fs.existsSync(config.modelPath), true, `Missing model: ${config.modelPath}`)
  const queue = images.map((imagePath, index) => ({ id: index + 1, imagePath }))
  const completed = []
  const errors = []
  const workers = []
  const stageMetrics = createStageMetrics()
  let resolveDone
  let rejectDone
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  const timeout = setTimeout(
    () => rejectDone(new Error(`${config.name} benchmark timed out`)),
    options.timeoutMs,
  )

  function dispatch(worker, prefetchRequest = false) {
    if (
      worker.pending.size > 0 &&
      (!options.tensorPrefetch || !prefetchRequest || worker.pending.size > options.batchSize)
    ) {
      return
    }
    const batch = queue.splice(0, options.batchSize)
    if (batch.length === 0) {
      if (completed.length + errors.length === images.length) resolveDone()
      return
    }
    let payload = ''
    for (const task of batch) {
      worker.pending.add(task.id)
      payload += `${JSON.stringify({
        id: task.id,
        imageId: task.imagePath,
        imagePath: task.imagePath,
        modelPath: config.modelPath,
        dim: config.dim,
        backend: options.backend,
        batchSize: options.batchSize,
        batchLength: batch.length,
      })}\n`
    }
    worker.child.stdin.write(payload)
  }

  const startedAt = performance.now()
  for (let index = 0; index < options.jobs; index += 1) {
    const child = childProcess.spawn(process.execPath, [config.childPath], {
      cwd: path.dirname(options.childrenDir),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        REASONIX_EMBEDDING_STAGE_METRICS: options.stageMetrics ? '1' : '0',
        REASONIX_EMBEDDING_TENSOR_PREFETCH: options.tensorPrefetch ? '1' : '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const worker = { child, pending: new Set(), stderr: '' }
    workers.push(worker)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      worker.stderr += chunk
    })
    child.once('error', rejectDone)
    child.once('exit', (code) => {
      if (completed.length + errors.length < images.length) {
        rejectDone(
          new Error(`${config.name} child exited early (${code}): ${worker.stderr.trim()}`),
        )
      }
    })
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (message.type === 'ready') {
        dispatch(worker)
        dispatch(worker, true)
        return
      }
      if (message.type === 'prefetch-request') {
        dispatch(worker, true)
        return
      }
      const metrics = batchMetricsFromChildMessage(message)
      if (metrics?.model === config.name) {
        addStageMetrics(stageMetrics, metrics)
        options.onBatchMetrics?.(metrics, stageMetrics.batches)
      }
      if (!worker.pending.delete(message.id)) return
      if (message.ok) {
        assert.equal(message.vector.length, config.dim)
        assert.equal(message.vector.every(Number.isFinite), true)
        completed.push(message)
      } else {
        errors.push({ id: message.id, error: message.error })
      }
      if (worker.pending.size === 0) {
        dispatch(worker)
        dispatch(worker, true)
      } else if (options.tensorPrefetch && worker.pending.size === options.batchSize) {
        dispatch(worker, true)
      }
    })
  }
  let elapsedMs
  let workingSet
  try {
    await done
    elapsedMs = performance.now() - startedAt
    workingSet = await sampleWorkerWorkingSets(workers)
  } finally {
    clearTimeout(timeout)
    for (const worker of workers) worker.child.stdin.end()
    await Promise.all(workers.map((worker) => waitForExit(worker.child, 5_000)))
  }
  assert.deepEqual(errors, [])
  assert.equal(completed.length, images.length)
  if (options.stageMetrics) {
    assert.equal(stageMetrics.items, images.length, 'Stage metrics did not cover every input')
    assert.equal(stageMetrics.succeeded, images.length, 'Stage metrics success count changed')
    assert.equal(stageMetrics.failed, 0, 'Stage metrics reported a failed input')
  }
  const digest = crypto
    .createHash('sha256')
    .update(
      completed
        .sort((a, b) => a.id - b.id)
        .map((item) => item.vector.slice(0, 16).join(','))
        .join('\n'),
    )
    .digest('hex')
  const report = {
    status: 'completed',
    model: config.name,
    images: completed.length,
    jobs: options.jobs,
    batchSize: options.batchSize,
    backend: options.backend,
    tensorPrefetch: options.tensorPrefetch,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    imagesPerSecond: Number(((completed.length * 1000) / elapsedMs).toFixed(2)),
    workerWorkingSetMiB: workingSet.totalMiB,
    maxWorkerWorkingSetMiB: workingSet.maxMiB,
    digest,
  }
  if (options.stageMetrics) {
    const coreMs =
      stageMetrics.runtimeLoadMsTotal +
      stageMetrics.decodeNormalizeMsTotal +
      stageMetrics.preprocessMsTotal +
      stageMetrics.inferenceMsTotal +
      stageMetrics.postprocessMsTotal
    report.stageMetrics = {
      ...Object.fromEntries(
        Object.entries(stageMetrics).map(([key, value]) => [
          key,
          typeof value === 'number' ? round(value, 3) : value,
        ]),
      ),
      preInferenceSharePercent:
        coreMs > 0
          ? round(
              ((stageMetrics.decodeNormalizeMsTotal + stageMetrics.preprocessMsTotal) / coreMs) *
                100,
              3,
            )
          : 0,
      inferenceSharePercent:
        coreMs > 0 ? round((stageMetrics.inferenceMsTotal / coreMs) * 100, 3) : 0,
    }
  }
  return {
    report,
    vectors: completed.sort((a, b) => a.id - b.id).map((item) => item.vector),
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.dataset || !fs.statSync(options.dataset).isDirectory()) {
    throw new Error('Pass an existing image dataset directory')
  }
  if (!['cpu', 'gpu'].includes(options.backend)) throw new Error('Use --backend=cpu or gpu')
  const images = collectImages(options.dataset, options.sampleSize)
  assert.equal(images.length, options.sampleSize, 'Dataset does not contain enough images')
  const configs = [
    {
      name: 'dino',
      modelName: 'dinov2_vitb14',
      childPath: path.join(options.childrenDir, 'dinoEmbeddingChild.js'),
      modelPath: path.join(
        options.modelsRoot,
        'dinov2_vitb14',
        'Xenova',
        'dinov2-base',
        'onnx',
        'model_q4.onnx',
      ),
      dim: 768,
    },
    {
      name: 'clip',
      modelName: 'clip_vit_base_patch32',
      childPath: path.join(options.childrenDir, 'clipEmbeddingChild.js'),
      modelPath: path.join(
        options.modelsRoot,
        'clip_vit_base_patch32',
        'Xenova',
        'clip-vit-base-patch32',
        'onnx',
        'model_q4.onnx',
      ),
      dim: 512,
    },
  ]
  const selectedConfigs = configs.filter((item) => options.models.includes(item.name))
  for (const config of selectedConfigs) {
    assert.equal(fs.existsSync(config.childPath), true, `Missing child for ${config.name}`)
    assert.equal(fs.existsSync(config.modelPath), true, `Missing model for ${config.name}`)
  }
  const sourceBefore = snapshotFiles(images)
  const timeline = createTimeline(options.timelineOut)
  timeline.write('matrix-start', {
    images: images.length,
    models: selectedConfigs.map((config) => config.name),
    jobs: options.jobsList,
    batchSizes: options.batchSizes,
    backend: options.backend,
    tensorPrefetch: options.tensorPrefetch,
    stageMetrics: options.stageMetrics,
  })
  const runs = []
  for (const config of selectedConfigs) {
    let baselineVectors
    let baselineBatchSize
    let baselineJobs
    for (const jobs of options.jobsList) {
      for (const batchSize of options.batchSizes) {
        const preflight = candidatePreflight(config, jobs, batchSize, options.backend)
        const identity = { model: config.name, jobs, batchSize, backend: options.backend }
        if (!preflight.allowed) {
          process.stderr.write(
            `Skipping ${config.name}, jobs ${jobs}, batch ${batchSize}: ${preflight.reason}\n`,
          )
          runs.push({ status: 'skipped', ...identity, preflight })
          timeline.write('candidate-skipped', { ...identity, preflight })
          continue
        }
        process.stderr.write(`Benchmarking ${config.name}, jobs ${jobs}, batch ${batchSize}...\n`)
        timeline.write('candidate-start', { ...identity, preflight })
        const resourceMonitor = await startResourceMonitor({
          intervalMs: options.resourceIntervalMs,
        })
        let resources
        try {
          const result = await runModel(config, images, {
            ...options,
            jobs,
            batchSize,
            onBatchMetrics: (metrics, batch) =>
              timeline.write('batch-metrics', {
                ...identity,
                batch,
                metrics,
              }),
          })
          if (!baselineVectors) {
            baselineVectors = result.vectors
            baselineBatchSize = batchSize
            baselineJobs = jobs
          } else {
            result.report.qualityVsBaseline = {
              baselineJobs,
              baselineBatchSize,
              ...compareVectors(baselineVectors, result.vectors),
            }
          }
          runs.push({ ...result.report, preflight })
        } catch (error) {
          const text = error instanceof Error ? error.message.toLowerCase() : ''
          const failureCode = text.includes('timed out')
            ? 'timeout'
            : text.includes('exited early')
              ? 'child-exit'
              : text.includes('stage metrics')
                ? 'stage-metrics-incomplete'
                : 'validation-or-runtime-error'
          process.stderr.write(
            `Candidate failed: ${config.name}, jobs ${jobs}, batch ${batchSize}, ${failureCode}\n`,
          )
          runs.push({ status: 'failed', ...identity, failureCode, preflight })
        } finally {
          resources = await resourceMonitor.stop()
          const report = runs.at(-1)
          report.resources = resources
          timeline.write('candidate-end', {
            ...identity,
            status: report.status,
            failureCode: report.failureCode || null,
            elapsedMs: report.elapsedMs || null,
            resources,
          })
        }
      }
    }
  }
  const sourceAfter = snapshotFiles(images)
  assertFileSnapshotUnchanged(sourceBefore, sourceAfter)
  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    config: {
      sample: images.length,
      models: selectedConfigs.map((config) => config.name),
      jobs: options.jobsList,
      batchSizes: options.batchSizes,
      backend: options.backend,
      tensorPrefetch: options.tensorPrefetch,
      stageMetrics: options.stageMetrics,
      resourceIntervalMs: options.resourceIntervalMs,
    },
    runs,
    safety: {
      sourceDatasetReadOnly: true,
      sourceUnchanged: true,
      sourceSnapshot: sourceAfter,
      pathsOmitted: true,
    },
    ok: runs.every((run) => run.status !== 'failed'),
  }
  timeline.write('matrix-end', {
    completed: runs.filter((run) => run.status === 'completed').length,
    skipped: runs.filter((run) => run.status === 'skipped').length,
    failed: runs.filter((run) => run.status === 'failed').length,
    sourceUnchanged: true,
  })
  if (options.jsonOut) writeJson(options.jsonOut, report)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
