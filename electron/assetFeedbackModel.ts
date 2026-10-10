import type { AssetFeedbackMode } from '../shared/ipc/asset-feedback'

export type AssetFeedbackTargetKind = 'category' | 'tag'

export interface AssetFeedbackWeightedVector {
  path: string
  vector: Float32Array
  weight: number
}

export interface AssetFeedbackPrototype {
  path: string
  vector: Float32Array
}

export interface AssetFeedbackTargetModel {
  key: string
  kind: AssetFeedbackTargetKind
  id: number
  name: string
  positiveSampleCount: number
  negativeSampleCount: number
  positivePrototypes: AssetFeedbackPrototype[]
  negativePrototypes: AssetFeedbackPrototype[]
}

export interface AssetFeedbackModelSnapshot {
  version: 1
  algorithmVersion: 2
  revision: number
  modelName: 'clip_vit_base_patch32'
  dim: number
  builtAt: number
  sourceSampleCount: number
  embeddedSampleCount: number
  skippedSampleCount: number
  targets: AssetFeedbackTargetModel[]
}

export interface ActivatedAssetFeedbackTarget {
  target: AssetFeedbackTargetModel
  gate: number
  reason: string
}

export interface SemanticFeedbackContext {
  mode: AssetFeedbackMode
  revision: number
  builtRevision: number
  stale: boolean
  targets: ActivatedAssetFeedbackTarget[]
}

export interface AssetFeedbackScore {
  boost: number
  positiveScore: number
  negativeScore: number
  reasons: string[]
}

export interface AssetFeedbackTargetScore {
  score: number
  positiveScore: number
  negativeScore: number
}

const MAX_POSITIVE_PROTOTYPES = 128
const MAX_NEGATIVE_PROTOTYPES = 128
const MAX_ACTIVE_TARGETS = 3
const MAX_ABSOLUTE_BOOST = 0.12
const NEGATIVE_WEIGHT = 0.6
const FEEDBACK_WEIGHT = 0.3
const SIGNAL_DEAD_ZONE = 0.08

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

export function normalizeFeedbackVector(values: ArrayLike<number>): Float32Array {
  let normSquared = 0
  for (let index = 0; index < values.length; index++) {
    const value = Number(values[index] || 0)
    normSquared += value * value
  }
  const norm = Math.sqrt(normSquared)
  const result = new Float32Array(values.length)
  if (norm <= 0) return result
  for (let index = 0; index < values.length; index++) {
    result[index] = Number(values[index] || 0) / norm
  }
  return result
}

export function feedbackCosine(left: ArrayLike<number>, right: ArrayLike<number>): number {
  const length = Math.min(left.length, right.length)
  let dot = 0
  for (let index = 0; index < length; index++) dot += Number(left[index]) * Number(right[index])
  return clamp(dot, -1, 1)
}

function stableSampleOrder(
  left: AssetFeedbackWeightedVector,
  right: AssetFeedbackWeightedVector,
): number {
  return right.weight - left.weight || left.path.localeCompare(right.path)
}

export function buildFeedbackPrototypes(
  samples: AssetFeedbackWeightedVector[],
  maximum = MAX_POSITIVE_PROTOTYPES,
): AssetFeedbackPrototype[] {
  const firstDimension = samples.find((sample) => sample.vector.length > 0)?.vector.length || 0
  if (firstDimension === 0) return []

  const unique = new Map<string, AssetFeedbackWeightedVector>()
  for (const sample of samples) {
    if (sample.vector.length !== firstDimension) continue
    const key = sample.path.replace(/\//g, '\\').toLowerCase()
    const normalized = {
      path: sample.path,
      vector: normalizeFeedbackVector(sample.vector),
      weight: clamp(Number(sample.weight) || 0, 0.01, 10),
    }
    const previous = unique.get(key)
    if (!previous || normalized.weight > previous.weight) unique.set(key, normalized)
  }

  const candidates = [...unique.values()].sort(stableSampleOrder)
  const targetCount = Math.min(candidates.length, Math.max(1, maximum))
  if (targetCount === 0) return []
  if (candidates.length <= targetCount) {
    return candidates.map((sample) => ({ path: sample.path, vector: sample.vector }))
  }

  const selected: AssetFeedbackWeightedVector[] = [candidates[0]]
  const selectedPaths = new Set([candidates[0].path.toLowerCase()])
  const highestWeight = Math.max(...candidates.map((sample) => sample.weight), 0.01)

  while (selected.length < targetCount) {
    let best: AssetFeedbackWeightedVector | null = null
    let bestScore = Number.NEGATIVE_INFINITY
    for (const candidate of candidates) {
      if (selectedPaths.has(candidate.path.toLowerCase())) continue
      let nearestDistance = 2
      for (const prototype of selected) {
        nearestDistance = Math.min(
          nearestDistance,
          1 - feedbackCosine(candidate.vector, prototype.vector),
        )
      }
      const weightFactor = 0.75 + 0.25 * (candidate.weight / highestWeight)
      const score = nearestDistance * weightFactor
      if (
        score > bestScore ||
        (score === bestScore && best && candidate.path.localeCompare(best.path) < 0)
      ) {
        best = candidate
        bestScore = score
      }
    }
    if (!best) break
    selected.push(best)
    selectedPaths.add(best.path.toLowerCase())
  }

  return selected.map((sample) => ({ path: sample.path, vector: sample.vector }))
}

export function buildFeedbackTargetModel(input: {
  key: string
  kind: AssetFeedbackTargetKind
  id: number
  name: string
  positiveSampleCount: number
  negativeSampleCount: number
  positiveVectors: AssetFeedbackWeightedVector[]
  negativeVectors: AssetFeedbackWeightedVector[]
}): AssetFeedbackTargetModel | null {
  const positivePrototypes = buildFeedbackPrototypes(input.positiveVectors, MAX_POSITIVE_PROTOTYPES)
  if (positivePrototypes.length === 0) return null
  return {
    key: input.key,
    kind: input.kind,
    id: input.id,
    name: input.name,
    positiveSampleCount: input.positiveSampleCount,
    negativeSampleCount: input.negativeSampleCount,
    positivePrototypes,
    negativePrototypes: buildFeedbackPrototypes(input.negativeVectors, MAX_NEGATIVE_PROTOTYPES),
  }
}

export function normalizeFeedbackLabel(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function labelTokens(value: string): string[] {
  return normalizeFeedbackLabel(value).split(' ').filter(Boolean)
}

function activationForLabel(
  normalizedQuery: string,
  queryTokens: string[],
  targetName: string,
): { gate: number; reason: string } | null {
  const normalizedTarget = normalizeFeedbackLabel(targetName)
  if (!normalizedTarget) return null
  if (normalizedQuery === normalizedTarget) return { gate: 1, reason: 'exact label match' }
  if (
    normalizedTarget.length >= 2 &&
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(normalizedTarget) &&
    normalizedQuery.includes(normalizedTarget)
  ) {
    return { gate: 0.95, reason: 'query contains label' }
  }

  const targetTokens = labelTokens(normalizedTarget)
  if (targetTokens.length === 0 || queryTokens.length === 0) return null
  const querySet = new Set(queryTokens)
  const targetSet = new Set(targetTokens)
  if (targetTokens.every((token) => querySet.has(token))) {
    return { gate: 0.92, reason: 'all label tokens matched' }
  }
  if (
    queryTokens.length > 1 &&
    queryTokens.every((token) => targetSet.has(token)) &&
    normalizedQuery.length >= 3
  ) {
    return { gate: 0.84, reason: 'query tokens matched label' }
  }
  return null
}

export function activateFeedbackTargets(
  query: string,
  targets: AssetFeedbackTargetModel[],
  maximum = MAX_ACTIVE_TARGETS,
): ActivatedAssetFeedbackTarget[] {
  const normalizedQuery = normalizeFeedbackLabel(query)
  if (!normalizedQuery) return []
  const queryTokens = labelTokens(normalizedQuery)
  return targets
    .map((target) => {
      const activation = activationForLabel(normalizedQuery, queryTokens, target.name)
      return activation ? { target, ...activation } : null
    })
    .filter((value): value is ActivatedAssetFeedbackTarget => value !== null)
    .sort(
      (left, right) =>
        right.gate - left.gate ||
        right.target.positiveSampleCount - left.target.positiveSampleCount ||
        left.target.name.localeCompare(right.target.name),
    )
    .slice(0, Math.max(1, maximum))
}

function maximumPrototypeCosine(
  vector: ArrayLike<number>,
  prototypes: AssetFeedbackPrototype[],
): number {
  let maximum = -1
  for (const prototype of prototypes) {
    maximum = Math.max(maximum, feedbackCosine(vector, prototype.vector))
  }
  return maximum
}

function averageTopPrototypeCosine(
  vector: ArrayLike<number>,
  prototypes: AssetFeedbackPrototype[],
  count: number,
): number {
  if (prototypes.length === 0 || count <= 0) return -1
  const scores = prototypes
    .map((prototype) => feedbackCosine(vector, prototype.vector))
    .sort((left, right) => right - left)
    .slice(0, Math.min(count, prototypes.length))
  return scores.reduce((sum, score) => sum + score, 0) / scores.length
}

function supportedPositiveCosine(
  vector: ArrayLike<number>,
  prototypes: AssetFeedbackPrototype[],
): number {
  return averageTopPrototypeCosine(vector, prototypes, prototypes.length >= 8 ? 2 : 1)
}

export function buildFeedbackSearchCenters(
  target: AssetFeedbackTargetModel,
  maximum = 4,
): Float32Array[] {
  const prototypes = target.positivePrototypes.filter((item) => item.vector.length > 0)
  if (prototypes.length === 0 || maximum <= 0) return []
  const dim = prototypes[0].vector.length
  const compatible = prototypes
    .filter((item) => item.vector.length === dim)
    .sort((left, right) => left.path.localeCompare(right.path))
  if (compatible.length === 0) return []

  const centerCount = Math.min(maximum, compatible.length)
  if (centerCount === 1) {
    const pooled = new Float32Array(dim)
    for (const prototype of compatible) {
      for (let index = 0; index < dim; index++) pooled[index] += prototype.vector[index]
    }
    return [normalizeFeedbackVector(pooled)]
  }

  const pooled = new Float32Array(dim)
  for (const prototype of compatible) {
    for (let index = 0; index < dim; index++) pooled[index] += prototype.vector[index]
  }
  const normalizedPooled = normalizeFeedbackVector(pooled)
  const first = compatible.reduce((best, candidate) =>
    feedbackCosine(candidate.vector, normalizedPooled) >
    feedbackCosine(best.vector, normalizedPooled)
      ? candidate
      : best,
  )
  let centers: Float32Array[] = [first.vector]
  const selectedPaths = new Set([first.path])
  while (centers.length < centerCount) {
    let best: AssetFeedbackPrototype | null = null
    let bestDistance = Number.NEGATIVE_INFINITY
    for (const prototype of compatible) {
      if (selectedPaths.has(prototype.path)) continue
      const nearestDistance = Math.min(
        ...centers.map((center) => 1 - feedbackCosine(prototype.vector, center)),
      )
      if (
        nearestDistance > bestDistance ||
        (nearestDistance === bestDistance && best && prototype.path.localeCompare(best.path) < 0)
      ) {
        best = prototype
        bestDistance = nearestDistance
      }
    }
    if (!best) break
    selectedPaths.add(best.path)
    centers.push(best.vector)
  }

  let clusterCounts = new Array(centers.length).fill(0)
  for (let iteration = 0; iteration < 6; iteration++) {
    const sums = centers.map(() => new Float32Array(dim))
    clusterCounts = new Array(centers.length).fill(0)
    for (const prototype of compatible) {
      let bestIndex = 0
      let bestSimilarity = Number.NEGATIVE_INFINITY
      for (let centerIndex = 0; centerIndex < centers.length; centerIndex++) {
        const similarity = feedbackCosine(prototype.vector, centers[centerIndex])
        if (similarity > bestSimilarity) {
          bestIndex = centerIndex
          bestSimilarity = similarity
        }
      }
      clusterCounts[bestIndex] += 1
      const sum = sums[bestIndex]
      for (let index = 0; index < dim; index++) sum[index] += prototype.vector[index]
    }
    centers = centers.map((center, index) =>
      clusterCounts[index] > 0 ? normalizeFeedbackVector(sums[index]) : center,
    )
  }

  const minimumSupport = compatible.length >= 16 ? Math.max(2, compatible.length * 0.03) : 1
  const supported = centers
    .map((center, index) => ({ center, count: clusterCounts[index], index }))
    .filter((item) => item.count >= minimumSupport)
    .sort((left, right) => right.count - left.count || left.index - right.index)
    .map((item) => item.center)
  return (supported.length > 0 ? supported : centers).slice(0, maximum)
}

export function scoreAssetFeedbackTarget(
  vector: ArrayLike<number>,
  target: AssetFeedbackTargetModel,
): AssetFeedbackTargetScore {
  if (vector.length === 0 || target.positivePrototypes.length === 0) {
    return { score: 0, positiveScore: 0, negativeScore: 0 }
  }
  const positiveCosine = supportedPositiveCosine(vector, target.positivePrototypes)
  const positiveScore = clamp((positiveCosine + 1) / 2, 0, 1)
  if (target.negativePrototypes.length === 0) {
    return { score: positiveScore, positiveScore, negativeScore: 0 }
  }

  const negativeCosine = maximumPrototypeCosine(vector, target.negativePrototypes)
  const negativeScore = clamp((negativeCosine + 1) / 2, 0, 1)
  const discriminativeSignal = positiveCosine - negativeCosine * 0.65
  return {
    score: clamp(0.3 + discriminativeSignal, 0, 1),
    positiveScore,
    negativeScore,
  }
}

function calibrateSignal(signal: number): number {
  const magnitude = Math.abs(signal)
  if (magnitude <= SIGNAL_DEAD_ZONE) return 0
  return Math.sign(signal) * ((magnitude - SIGNAL_DEAD_ZONE) / (1 - SIGNAL_DEAD_ZONE))
}

export function scoreAssetFeedback(
  vector: ArrayLike<number>,
  context: SemanticFeedbackContext,
  baseScore: number,
): AssetFeedbackScore {
  if (context.mode === 'off' || context.targets.length === 0 || vector.length === 0) {
    return { boost: 0, positiveScore: 0, negativeScore: 0, reasons: [] }
  }

  let weightedBoost = 0
  let gateTotal = 0
  let highestPositive = -1
  let highestNegative = -1
  const reasons: string[] = []

  for (const activation of context.targets) {
    const positive = supportedPositiveCosine(vector, activation.target.positivePrototypes)
    const negative = maximumPrototypeCosine(vector, activation.target.negativePrototypes)
    const signal = positive - NEGATIVE_WEIGHT * Math.max(0, negative) - 0.05
    const targetBoost = activation.gate * FEEDBACK_WEIGHT * calibrateSignal(signal)
    weightedBoost += targetBoost
    gateTotal += activation.gate
    highestPositive = Math.max(highestPositive, positive)
    highestNegative = Math.max(highestNegative, negative)
    if (Math.abs(targetBoost) >= 0.005) {
      reasons.push(
        `${activation.target.kind} ${activation.target.name} feedback ${targetBoost >= 0 ? '+' : ''}${targetBoost.toFixed(3)}`,
      )
    }
  }

  let boost = gateTotal > 0 ? weightedBoost / gateTotal : 0
  boost = clamp(boost, -MAX_ABSOLUTE_BOOST, MAX_ABSOLUTE_BOOST)
  if (baseScore < 0.5 && boost > 0) boost = 0
  return {
    boost,
    positiveScore: highestPositive,
    negativeScore: highestNegative,
    reasons: reasons.slice(0, 3),
  }
}
