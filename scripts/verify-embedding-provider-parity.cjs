#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_THRESHOLDS = Object.freeze({
  minCosine: 0.999,
  maxAbsError: 0.01,
  maxUnitNormError: 0.01,
  minMeanTopKOverlap: 0.99,
  topK: 10,
})

function parseNumberOption(value, name) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`)
  return parsed
}

function parseArgs(argv) {
  const options = { ...DEFAULT_THRESHOLDS }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const [inlineName, inlineValue] = argument.split('=', 2)
    const name = inlineName
    const value = inlineValue ?? argv[index + 1]
    if (!name.startsWith('--')) throw new Error(`unexpected argument: ${argument}`)
    if (inlineValue === undefined) index += 1
    if (value === undefined) throw new Error(`${name} requires a value`)
    if (name === '--reference') options.referencePath = value
    else if (name === '--candidate') options.candidatePath = value
    else if (name === '--min-cosine') options.minCosine = parseNumberOption(value, name)
    else if (name === '--max-abs-error') options.maxAbsError = parseNumberOption(value, name)
    else if (name === '--max-unit-norm-error') {
      options.maxUnitNormError = parseNumberOption(value, name)
    } else if (name === '--min-mean-top-k-overlap') {
      options.minMeanTopKOverlap = parseNumberOption(value, name)
    } else if (name === '--top-k') options.topK = parseNumberOption(value, name)
    else throw new Error(`unknown option: ${name}`)
  }
  if (!options.referencePath || !options.candidatePath) {
    throw new Error('--reference and --candidate are required')
  }
  if (!Number.isInteger(options.topK) || options.topK < 1) {
    throw new Error('--top-k must be a positive integer')
  }
  return options
}

function normalizeSnapshot(snapshot, sourceName) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error(`${sourceName}: root must be an object`)
  }
  if (snapshot.schemaVersion !== 1) {
    throw new Error(`${sourceName}: schemaVersion must be 1`)
  }
  if (typeof snapshot.model !== 'string' || snapshot.model.length === 0) {
    throw new Error(`${sourceName}: model is required`)
  }
  if (typeof snapshot.provider !== 'string' || snapshot.provider.length === 0) {
    throw new Error(`${sourceName}: provider is required`)
  }
  if (!Array.isArray(snapshot.samples) || snapshot.samples.length < 2) {
    throw new Error(`${sourceName}: at least two samples are required`)
  }

  const samples = new Map()
  let dimension = null
  for (const sample of snapshot.samples) {
    if (!sample || typeof sample.id !== 'string' || sample.id.length === 0) {
      throw new Error(`${sourceName}: every sample requires a non-empty id`)
    }
    if (samples.has(sample.id)) throw new Error(`${sourceName}: duplicate sample id ${sample.id}`)
    if (!Array.isArray(sample.vector) || sample.vector.length === 0) {
      throw new Error(`${sourceName}: ${sample.id} has no vector`)
    }
    if (dimension === null) dimension = sample.vector.length
    if (sample.vector.length !== dimension) {
      throw new Error(`${sourceName}: ${sample.id} dimension mismatch`)
    }
    const vector = sample.vector.map(Number)
    if (vector.some((value) => !Number.isFinite(value))) {
      throw new Error(`${sourceName}: ${sample.id} contains a non-finite value`)
    }
    samples.set(sample.id, vector)
  }

  if (snapshot.dimension !== undefined && snapshot.dimension !== dimension) {
    throw new Error(`${sourceName}: declared dimension does not match vectors`)
  }
  return { ...snapshot, dimension, samples }
}

function vectorNorm(vector) {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
}

function cosineSimilarity(left, right) {
  const leftNorm = vectorNorm(left)
  const rightNorm = vectorNorm(right)
  if (leftNorm === 0 || rightNorm === 0) return Number.NEGATIVE_INFINITY
  let dot = 0
  for (let index = 0; index < left.length; index += 1) dot += left[index] * right[index]
  return dot / (leftNorm * rightNorm)
}

function rankedNeighbours(samples, queryId, topK) {
  const query = samples.get(queryId)
  return [...samples.entries()]
    .filter(([id]) => id !== queryId)
    .map(([id, vector]) => ({ id, score: cosineSimilarity(query, vector) }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, topK)
    .map(({ id }) => id)
}

function compareEmbeddingSnapshots(referenceInput, candidateInput, thresholdOverrides = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...thresholdOverrides }
  const reference = normalizeSnapshot(referenceInput, 'reference')
  const candidate = normalizeSnapshot(candidateInput, 'candidate')
  const failures = []

  if (reference.model !== candidate.model) failures.push('model mismatch')
  if (reference.dimension !== candidate.dimension) failures.push('dimension mismatch')
  const referenceIds = [...reference.samples.keys()].sort()
  const candidateIds = [...candidate.samples.keys()].sort()
  if (referenceIds.join('\0') !== candidateIds.join('\0')) failures.push('sample id set mismatch')

  const comparableIds = referenceIds.filter(
    (id) => candidate.samples.has(id) && reference.dimension === candidate.dimension,
  )
  const sampleMetrics = []
  for (const id of comparableIds) {
    const referenceVector = reference.samples.get(id)
    const candidateVector = candidate.samples.get(id)
    let maxAbsError = 0
    for (let index = 0; index < referenceVector.length; index += 1) {
      maxAbsError = Math.max(maxAbsError, Math.abs(referenceVector[index] - candidateVector[index]))
    }
    sampleMetrics.push({
      id,
      cosine: cosineSimilarity(referenceVector, candidateVector),
      maxAbsError,
      unitNormError: Math.abs(vectorNorm(candidateVector) - 1),
    })
  }

  const effectiveTopK = Math.min(thresholds.topK, Math.max(1, comparableIds.length - 1))
  const topKOverlaps = comparableIds.map((id) => {
    const expected = new Set(rankedNeighbours(reference.samples, id, effectiveTopK))
    const actual = rankedNeighbours(candidate.samples, id, effectiveTopK)
    return actual.filter((candidateId) => expected.has(candidateId)).length / effectiveTopK
  })
  const minimumCosine = Math.min(...sampleMetrics.map(({ cosine }) => cosine))
  const maximumAbsError = Math.max(...sampleMetrics.map(({ maxAbsError }) => maxAbsError))
  const maximumUnitNormError = Math.max(
    ...sampleMetrics.map(({ unitNormError }) => unitNormError),
  )
  const meanTopKOverlap =
    topKOverlaps.reduce((sum, overlap) => sum + overlap, 0) / topKOverlaps.length

  if (minimumCosine < thresholds.minCosine) {
    failures.push(`minimum cosine ${minimumCosine} is below ${thresholds.minCosine}`)
  }
  if (maximumAbsError > thresholds.maxAbsError) {
    failures.push(`maximum absolute error ${maximumAbsError} exceeds ${thresholds.maxAbsError}`)
  }
  if (maximumUnitNormError > thresholds.maxUnitNormError) {
    failures.push(
      `maximum unit-norm error ${maximumUnitNormError} exceeds ${thresholds.maxUnitNormError}`,
    )
  }
  if (meanTopKOverlap < thresholds.minMeanTopKOverlap) {
    failures.push(
      `mean top-${effectiveTopK} overlap ${meanTopKOverlap} is below ${thresholds.minMeanTopKOverlap}`,
    )
  }

  return {
    ok: failures.length === 0,
    model: reference.model,
    referenceProvider: reference.provider,
    candidateProvider: candidate.provider,
    samples: comparableIds.length,
    dimension: reference.dimension,
    thresholds,
    metrics: {
      minimumCosine,
      maximumAbsError,
      maximumUnitNormError,
      effectiveTopK,
      meanTopKOverlap,
    },
    failures,
  }
}

function loadSnapshot(filePath) {
  const resolvedPath = path.resolve(filePath)
  return JSON.parse(fs.readFileSync(resolvedPath, 'utf8'))
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv)
    const result = compareEmbeddingSnapshots(
      loadSnapshot(options.referencePath),
      loadSnapshot(options.candidatePath),
      {
        minCosine: options.minCosine,
        maxAbsError: options.maxAbsError,
        maxUnitNormError: options.maxUnitNormError,
        minMeanTopKOverlap: options.minMeanTopKOverlap,
        topK: options.topK,
      },
    )
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!result.ok) process.exitCode = 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}

if (require.main === module) main()

module.exports = {
  DEFAULT_THRESHOLDS,
  compareEmbeddingSnapshots,
  normalizeSnapshot,
  parseArgs,
}
