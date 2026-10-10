#!/usr/bin/env node

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const ort = require('onnxruntime-node')
const { compareEmbeddingSnapshots } = require('./verify-embedding-provider-parity.cjs')

const MODEL_CONFIGS = Object.freeze({
  dino: {
    model: 'dinov2_vitb14',
    sha256: '19f697cf7cddfbbaa4b146b813e726a1e4ed89aa5fd363cdc38d689a3b5f6018',
    outputName: 'last_hidden_state',
    dimension: 768,
    tokens: 257,
  },
  'clip-image': {
    model: 'clip_vit_base_patch32_image',
    sha256: '1f518bedb1851294737a141e06149883cb289160760224f2da5498886e49d5cb',
    outputName: 'image_embeds',
    dimension: 512,
  },
  'clip-text': {
    model: 'clip_vit_base_patch32_text',
    sha256: 'e4ccd15d806b8af841a036884b42034535d58e04c52df00f56e73f72d3c166d5',
    outputName: 'text_embeds',
    dimension: 512,
  },
})

const PERFORMANCE_CRITICAL_OPERATIONS = new Set([
  'Attention',
  'BiasGelu',
  'Conv',
  'FusedMatMul',
  'Gemm',
  'LayerNormalization',
  'MatMul',
  'MatMulNBits',
  'QuickGelu',
  'SkipLayerNormalization',
  'Softmax',
])

function parseArgs(argv) {
  const options = { batchSize: 4, iterations: 5 }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const [inlineName, inlineValue] = argument.split('=', 2)
    const value = inlineValue ?? argv[index + 1]
    if (!inlineName.startsWith('--')) throw new Error(`unexpected argument: ${argument}`)
    if (inlineValue === undefined) index += 1
    if (value === undefined) throw new Error(`${inlineName} requires a value`)
    if (inlineName === '--model') options.modelKey = value
    else if (inlineName === '--model-path') options.modelPath = value
    else if (inlineName === '--cuda-python') options.cudaPython = value
    else if (inlineName === '--output-dir') options.outputDir = value
    else if (inlineName === '--batch-size') options.batchSize = Number(value)
    else if (inlineName === '--iterations') options.iterations = Number(value)
    else throw new Error(`unknown option: ${inlineName}`)
  }
  if (!MODEL_CONFIGS[options.modelKey])
    throw new Error('--model must be dino, clip-image, or clip-text')
  for (const required of ['modelPath', 'cudaPython', 'outputDir']) {
    if (!options[required])
      throw new Error(`--${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`)
  }
  if (!Number.isInteger(options.batchSize) || options.batchSize < 2 || options.batchSize > 16) {
    throw new Error('--batch-size must be an integer between 2 and 16')
  }
  if (!Number.isInteger(options.iterations) || options.iterations < 1 || options.iterations > 100) {
    throw new Error('--iterations must be an integer between 1 and 100')
  }
  return options
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  const descriptor = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let bytesRead
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

function createDeterministicFloatTensor(size, seed = 0x20260807) {
  const values = new Float32Array(size)
  let state = seed >>> 0
  for (let index = 0; index < size; index += 1) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    values[index] = ((state >>> 0) / 0xffffffff) * 2 - 1
  }
  return values
}

function createClipTokenTensors(batchSize) {
  const sequenceLength = 77
  const inputIds = new BigInt64Array(batchSize * sequenceLength)
  const attentionMask = new BigInt64Array(batchSize * sequenceLength)
  inputIds.fill(49407n)
  for (let batchIndex = 0; batchIndex < batchSize; batchIndex += 1) {
    const offset = batchIndex * sequenceLength
    inputIds[offset] = 49406n
    inputIds[offset + 1] = 320n
    inputIds[offset + 2] = BigInt(1125 + batchIndex)
    inputIds[offset + 3] = 49407n
    for (let tokenIndex = 0; tokenIndex < 4; tokenIndex += 1) {
      attentionMask[offset + tokenIndex] = 1n
    }
  }
  return { inputIds, attentionMask, sequenceLength }
}

function writeTensor(outputDir, name, dtype, dimensions, values) {
  const file = `${name}.bin`
  fs.writeFileSync(path.join(outputDir, file), Buffer.from(values.buffer))
  return { name, dtype, dimensions, file }
}

function prepareInputs(modelKey, batchSize, outputDir) {
  const tensors = []
  const feeds = {}
  if (modelKey !== 'clip-text') {
    const dimensions = [batchSize, 3, 224, 224]
    const values = createDeterministicFloatTensor(dimensions.reduce((a, b) => a * b))
    tensors.push(writeTensor(outputDir, 'pixel_values', 'float32', dimensions, values))
    feeds.pixel_values = new ort.Tensor('float32', values, dimensions)
  }
  if (modelKey.startsWith('clip')) {
    const { inputIds, attentionMask, sequenceLength } = createClipTokenTensors(batchSize)
    const dimensions = [batchSize, sequenceLength]
    tensors.push(writeTensor(outputDir, 'input_ids', 'int64', dimensions, inputIds))
    feeds.input_ids = new ort.Tensor('int64', inputIds, dimensions)
    if (modelKey === 'clip-image') {
      tensors.push(writeTensor(outputDir, 'attention_mask', 'int64', dimensions, attentionMask))
      feeds.attention_mask = new ort.Tensor('int64', attentionMask, dimensions)
    }
  }
  return { tensors, feeds }
}

function normalizeVector(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  return norm > 0 ? vector.map((value) => value / norm) : vector
}

function outputToSnapshot(config, provider, output, batchSize) {
  const data = Array.from(output.data, Number)
  const samples = []
  for (let batchIndex = 0; batchIndex < batchSize; batchIndex += 1) {
    let vector
    if (config.tokens) {
      vector = new Array(config.dimension).fill(0)
      const batchOffset = batchIndex * config.tokens * config.dimension
      for (let tokenIndex = 1; tokenIndex < config.tokens; tokenIndex += 1) {
        const tokenOffset = batchOffset + tokenIndex * config.dimension
        for (let dimIndex = 0; dimIndex < config.dimension; dimIndex += 1) {
          vector[dimIndex] += data[tokenOffset + dimIndex]
        }
      }
      const tokenCount = config.tokens - 1
      vector = vector.map((value) => value / tokenCount)
    } else {
      const offset = batchIndex * config.dimension
      vector = data.slice(offset, offset + config.dimension)
    }
    samples.push({
      id: `sample-${String(batchIndex).padStart(3, '0')}`,
      vector: normalizeVector(vector),
    })
  }
  return {
    schemaVersion: 1,
    model: config.model,
    provider,
    dimension: config.dimension,
    samples,
  }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

async function runDirectMl(modelPath, outputName, feeds, iterations) {
  const loadStarted = performance.now()
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['dml'],
    graphOptimizationLevel: 'all',
  })
  const loadMs = performance.now() - loadStarted
  await session.run(feeds, [outputName])
  const durationsMs = []
  let output
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now()
    output = (await session.run(feeds, [outputName]))[outputName]
    durationsMs.push(performance.now() - started)
  }
  return { output, loadMs, durationsMs, medianMs: median(durationsMs) }
}

function readCudaOutput(report, rawPath) {
  const dimensions = report.output.dimensions
  const expectedValues = dimensions.reduce((left, right) => left * right)
  const raw = fs.readFileSync(rawPath)
  if (raw.byteLength !== expectedValues * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error('CUDA output byte length does not match its report')
  }
  const copied = Uint8Array.from(raw)
  return {
    data: new Float32Array(copied.buffer),
    dims: dimensions,
  }
}

async function runPoc(options) {
  const config = MODEL_CONFIGS[options.modelKey]
  const modelPath = path.resolve(options.modelPath)
  const cudaPython = path.resolve(options.cudaPython)
  const outputDir = path.resolve(options.outputDir)
  if (!fs.statSync(modelPath).isFile()) throw new Error('model path is not a file')
  if (!fs.statSync(cudaPython).isFile()) throw new Error('CUDA Python path is not a file')
  const actualHash = sha256File(modelPath)
  if (actualHash !== config.sha256) throw new Error(`model SHA-256 mismatch: ${actualHash}`)
  fs.mkdirSync(outputDir, { recursive: true })

  const { tensors, feeds } = prepareInputs(options.modelKey, options.batchSize, outputDir)
  const manifest = {
    schemaVersion: 1,
    model: config.model,
    batchSize: options.batchSize,
    outputName: config.outputName,
    tensors,
  }
  const manifestPath = path.join(outputDir, 'inputs.json')
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const directml = await runDirectMl(modelPath, config.outputName, feeds, options.iterations)
  const directmlSnapshot = outputToSnapshot(config, 'directml', directml.output, options.batchSize)
  const directmlSnapshotPath = path.join(outputDir, 'directml.json')
  fs.writeFileSync(directmlSnapshotPath, `${JSON.stringify(directmlSnapshot)}\n`)

  const cudaRawPath = path.join(outputDir, 'cuda-output.f32')
  const cudaReportPath = path.join(outputDir, 'cuda-report.json')
  const pythonScript = path.resolve(__dirname, 'run-embedding-cuda-poc.py')
  const cuda = spawnSync(
    cudaPython,
    [
      pythonScript,
      '--model-path',
      modelPath,
      '--input-manifest',
      manifestPath,
      '--output-raw',
      cudaRawPath,
      '--report',
      cudaReportPath,
      '--iterations',
      String(options.iterations),
    ],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  )
  if (cuda.status !== 0) {
    throw new Error(`CUDA runner failed (${cuda.status}): ${cuda.stderr || cuda.stdout}`)
  }
  const cudaReport = JSON.parse(fs.readFileSync(cudaReportPath, 'utf8'))
  const cudaOutput = readCudaOutput(cudaReport, cudaRawPath)
  const cudaSnapshot = outputToSnapshot(config, 'cuda', cudaOutput, options.batchSize)
  const cudaSnapshotPath = path.join(outputDir, 'cuda.json')
  fs.writeFileSync(cudaSnapshotPath, `${JSON.stringify(cudaSnapshot)}\n`)

  const parity = compareEmbeddingSnapshots(directmlSnapshot, cudaSnapshot)
  const speedup = directml.medianMs / cudaReport.performance.medianMs
  const cpuFallbackNodes = cudaReport.providerNodeCounts.CPUExecutionProvider || 0
  const cpuFallbackOperations = Object.keys(
    cudaReport.providerOperationCounts.CPUExecutionProvider || {},
  )
  const performanceCriticalCpuOperations = cpuFallbackOperations.filter((operation) =>
    PERFORMANCE_CRITICAL_OPERATIONS.has(operation),
  )
  const report = {
    schemaVersion: 1,
    model: config.model,
    modelSha256: actualHash,
    batchSize: options.batchSize,
    performanceGate: {
      requiredSpeedup: 1.5,
      directmlMedianMs: directml.medianMs,
      cudaMedianMs: cudaReport.performance.medianMs,
      speedup,
      passed: speedup >= 1.5,
    },
    parity,
    cudaProviderNodeCounts: cudaReport.providerNodeCounts,
    cudaProviderOperationCounts: cudaReport.providerOperationCounts,
    cpuFallbackNodes,
    cpuFallbackOperations,
    performanceCriticalCpuOperations,
    passed:
      parity.ok &&
      speedup >= 1.5 &&
      cudaReport.cudaAssigned === true &&
      performanceCriticalCpuOperations.length === 0,
  }
  fs.writeFileSync(path.join(outputDir, 'poc-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  return report
}

async function main(argv = process.argv.slice(2)) {
  try {
    const report = await runPoc(parseArgs(argv))
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (!report.passed) process.exitCode = 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}

if (require.main === module) void main()

module.exports = {
  MODEL_CONFIGS,
  PERFORMANCE_CRITICAL_OPERATIONS,
  createClipTokenTensors,
  createDeterministicFloatTensor,
  outputToSnapshot,
  parseArgs,
  runPoc,
}
