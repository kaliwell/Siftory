const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')
const childMemory = loadTsModule('electron/embeddingChildMemoryTelemetry.ts')

const validation = loadTsModule('electron/embeddingVectorValidation.ts')
const framing = loadTsModule('electron/embeddingChildLineFraming.ts')

test('embedding vectors reject coercible, non-finite, wrong-size, and exact-zero inputs', () => {
  const cases = [
    { value: null, issue: 'invalid-container' },
    { value: [1, '2'], issue: 'non-finite' },
    { value: [1, null], issue: 'non-finite' },
    { value: [1, Number.POSITIVE_INFINITY], issue: 'non-finite' },
    { value: [1], issue: 'dimension-mismatch' },
    { value: [1, 2, 3], issue: 'dimension-mismatch' },
    { value: [0, -0], issue: 'zero-norm' },
  ]
  for (const item of cases) {
    const result = validation.classifyEmbeddingVector(item.value, 2)
    assert.equal(result.ok, false)
    assert.equal(result.issue, item.issue)
  }

  const serializedNan = JSON.parse(JSON.stringify({ vector: [1, Number.NaN] }))
  assert.deepEqual(serializedNan.vector, [1, null])
  assert.equal(validation.classifyEmbeddingVector(serializedNan.vector, 2).issue, 'non-finite')
  assert.throws(
    () => validation.requireNormalizedEmbeddingVector(serializedNan.vector, 2),
    /not a finite number/,
  )
})

test('stable normalization accepts tiny and huge finite vectors without overflow or underflow', () => {
  for (const vector of [
    [Number.MIN_VALUE, 0],
    [1e308, 1e308],
  ]) {
    const classified = validation.validateEmbeddingVector(vector, 2)
    assert.equal(classified.ok, true)
    assert.equal(Object.hasOwn(classified, 'normalized'), false, 'classification must not allocate')
    const normalized = validation.requireNormalizedEmbeddingVector(vector, 2)
    assert.equal(normalized.every(Number.isFinite), true)
    assert.ok(Math.abs(Math.hypot(...normalized) - 1) < 1e-12)
  }
  assert.throws(
    () => validation.validateEmbeddingVector([1], validation.MAX_EMBEDDING_VECTOR_DIM + 1),
    /dimension must be/,
  )
})

test('bounded child framing handles split lines and rejects oversized newline-free output', () => {
  const framer = new framing.BoundedEmbeddingChildLineFramer(16)
  assert.deepEqual(framer.push('{"ok":'), { lines: [], overflow: false })
  assert.deepEqual(framer.push('true}\nnext'), {
    lines: ['{"ok":true}'],
    overflow: false,
  })
  assert.deepEqual(framer.push('-line\n'), { lines: ['next-line'], overflow: false })

  assert.deepEqual(new framing.BoundedEmbeddingChildLineFramer(4).push('1234\n'), {
    lines: ['1234'],
    overflow: false,
  })
  const splitOverflow = new framing.BoundedEmbeddingChildLineFramer(4)
  assert.equal(splitOverflow.push('12').overflow, false)
  assert.equal(splitOverflow.push('345').overflow, true)
  assert.equal(new framing.BoundedEmbeddingChildLineFramer(3).push('你好').overflow, true)
  assert.deepEqual(new framing.BoundedEmbeddingChildLineFramer(8).push('a\nb\nc\n'), {
    lines: ['a', 'b', 'c'],
    overflow: false,
  })

  const hostile = new framing.BoundedEmbeddingChildLineFramer(32)
  assert.equal(hostile.push('x'.repeat(33)).overflow, true)
  assert.deepEqual(hostile.push('recovered\n'), { lines: ['recovered'], overflow: false })

  const hugeVectorLine = JSON.stringify({ ok: true, vector: Array(100).fill(1) })
  assert.equal(new framing.BoundedEmbeddingChildLineFramer(64).push(hugeVectorLine).overflow, true)
})

test('embedding child stage metrics are bounded, internally consistent, and de-identified', () => {
  const message = {
    type: 'batch-metrics',
    metrics: {
      model: 'dino',
      batchSize: 4,
      succeeded: 3,
      failed: 1,
      fallback: false,
      queueWaitMsTotal: 12,
      queueWaitMsMax: 5,
      batchWallMs: 40,
      runtimeLoadMs: 2,
      decodeNormalizeMs: 8,
      preprocessMs: 0,
      inferenceMs: 25,
      postprocessMs: 1,
      fallbackMs: 0,
      imagePath: 'must-not-propagate',
    },
  }
  const parsed = framing.batchMetricsFromChildMessage(message)
  assert.deepEqual(parsed, {
    model: 'dino',
    batchSize: 4,
    succeeded: 3,
    failed: 1,
    fallback: false,
    queueWaitMsTotal: 12,
    queueWaitMsMax: 5,
    batchWallMs: 40,
    runtimeLoadMs: 2,
    decodeNormalizeMs: 8,
    preprocessMs: 0,
    inferenceMs: 25,
    postprocessMs: 1,
    fallbackMs: 0,
    tensorPrefetch: false,
    tensorBytes: 0,
    prefetchPrepareMs: 0,
    prefetchWaitMs: 0,
    prefetchOverlapMs: 0,
    rssBytes: 0,
    privateBytes: null,
    externalBytes: 0,
    arrayBuffersBytes: 0,
    decodedPixelBytes: 0,
    temporaryTensorBytes: 0,
  })
  assert.equal(Object.hasOwn(parsed, 'imagePath'), false)
  assert.deepEqual(
    framing.batchMetricsFromChildMessage({ id: 7, ok: true, metrics: message.metrics }),
    parsed,
  )
  assert.equal(
    framing.batchMetricsFromChildMessage({ type: 'ready', metrics: message.metrics }),
    null,
  )

  assert.equal(
    framing.batchMetricsFromChildMessage({
      ...message,
      metrics: { ...message.metrics, succeeded: 4 },
    }),
    null,
  )
  assert.equal(
    framing.batchMetricsFromChildMessage({
      ...message,
      metrics: { ...message.metrics, inferenceMs: -1 },
    }),
    null,
  )
  assert.equal(
    framing.batchMetricsFromChildMessage({
      ...message,
      metrics: { ...message.metrics, queueWaitMsTotal: Number.POSITIVE_INFINITY },
    }),
    null,
  )

  const withMemory = framing.batchMetricsFromChildMessage({
    ...message,
    metrics: {
      ...message.metrics,
      rssBytes: 500_000_000,
      privateBytes: 450_000_000,
      externalBytes: 80_000_000,
      arrayBuffersBytes: 64_000_000,
      decodedPixelBytes: 12_000_000,
      temporaryTensorBytes: 8_000_000,
    },
  })
  assert.deepEqual(
    {
      rssBytes: withMemory?.rssBytes,
      privateBytes: withMemory?.privateBytes,
      externalBytes: withMemory?.externalBytes,
      arrayBuffersBytes: withMemory?.arrayBuffersBytes,
      decodedPixelBytes: withMemory?.decodedPixelBytes,
      temporaryTensorBytes: withMemory?.temporaryTensorBytes,
    },
    {
      rssBytes: 500_000_000,
      privateBytes: 450_000_000,
      externalBytes: 80_000_000,
      arrayBuffersBytes: 64_000_000,
      decodedPixelBytes: 12_000_000,
      temporaryTensorBytes: 8_000_000,
    },
  )
})

test('embedding child memory sampling reports native private bytes and decoded ownership', async () => {
  const sampled = await childMemory.captureEmbeddingChildMemory({
    memoryUsage: () => ({
      rss: 1000,
      heapTotal: 900,
      heapUsed: 800,
      external: 700,
      arrayBuffers: 600,
    }),
    getProcessMemoryInfo: async () => ({ private: 5, residentSet: 4 }),
  })
  assert.deepEqual(sampled, {
    rssBytes: 1000,
    privateBytes: 5 * 1024,
    externalBytes: 700,
    arrayBuffersBytes: 600,
  })
  assert.equal(
    childMemory.estimateDecodedImageBytes([
      { data: new Uint8Array(120), width: 10, height: 4, channels: 3 },
      { width: 5, height: 2, channels: 4 },
    ]),
    160,
  )
  assert.deepEqual(
    childMemory.peakEmbeddingChildMemory(sampled, {
      rssBytes: 900,
      privateBytes: null,
      externalBytes: 800,
      arrayBuffersBytes: 500,
    }),
    {
      rssBytes: 1000,
      privateBytes: 5 * 1024,
      externalBytes: 800,
      arrayBuffersBytes: 600,
    },
  )
})

test('DINO and CLIP emit detailed memory ownership only through bounded batch metrics', () => {
  for (const fileName of ['electron/dinoEmbeddingChild.ts', 'electron/clipEmbeddingChild.ts']) {
    const source = fs.readFileSync(fileName, 'utf8')
    assert.match(source, /captureEmbeddingChildMemory/)
    assert.match(source, /estimateDecodedImageBytes/)
    assert.match(source, /temporaryTensorBytes/)
    assert.match(source, /privateBytes/)
  }
})

test('embedding child provider telemetry is bounded, explicit, and path-free', () => {
  const message = {
    type: 'provider-selected',
    model: 'dino',
    requestedBackend: 'gpu',
    selectedProvider: 'dml',
    fallback: false,
    reason: 'session-created',
    imagePath: 'must-not-propagate',
  }
  assert.deepEqual(framing.providerTelemetryFromChildMessage(message), {
    model: 'dino',
    requestedBackend: 'gpu',
    selectedProvider: 'dml',
    fallback: false,
    reason: 'session-created',
  })
  for (const invalid of [
    { ...message, type: 'ready' },
    { ...message, model: 'unknown' },
    { ...message, requestedBackend: 'auto' },
    { ...message, selectedProvider: 'directml-path' },
    { ...message, fallback: 'false' },
    { ...message, reason: 'C:\\private\\provider.dll' },
    { ...message, reason: 'x'.repeat(129) },
  ]) {
    assert.equal(framing.providerTelemetryFromChildMessage(invalid), null)
  }
})

test('embedding provider telemetry aggregation preserves progress and bounds evidence', () => {
  let progress = {
    total: 4,
    completed: 1,
    failed: 0,
    skipped: 0,
    running: 2,
    pending: 1,
    state: 'running',
  }
  progress = framing.withEmbeddingProviderTelemetry(progress, {
    model: 'dino',
    requestedBackend: 'gpu',
    selectedProvider: 'dml',
    fallback: false,
    reason: 'session-created',
  })
  progress = framing.withEmbeddingProviderTelemetry(progress, {
    model: 'dino',
    requestedBackend: 'gpu',
    selectedProvider: 'cpu',
    fallback: true,
    reason: 'dml-session-initialization-failed',
  })
  assert.equal(progress.total, 4)
  assert.deepEqual(progress.providerTelemetry, {
    schemaVersion: 1,
    model: 'dino',
    requestedBackends: ['gpu'],
    selectedProviders: ['cpu', 'dml'],
    fallbackDetected: true,
    reports: 2,
    reasons: ['dml-session-initialization-failed', 'session-created'],
  })
})
