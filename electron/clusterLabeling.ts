export type ClusterLabelKind = 'medium' | 'subject' | 'role' | 'scene' | 'style' | 'genre'

export interface ClusterLabelCandidate {
  label: string
  prompt: string
  kind: ClusterLabelKind
}

export const CLUSTER_LABEL_CANDIDATES: ClusterLabelCandidate[] = [
  { label: 'photo', prompt: 'photograph', kind: 'medium' },
  { label: 'screenshot', prompt: 'software or social media screenshot', kind: 'medium' },
  { label: 'document', prompt: 'document with text', kind: 'medium' },
  { label: 'meme', prompt: 'internet meme', kind: 'medium' },
  { label: 'illustration', prompt: 'digital illustration', kind: 'medium' },
  { label: 'anime', prompt: 'anime artwork', kind: 'medium' },
  { label: '3D render', prompt: '3D rendered image', kind: 'medium' },
  { label: 'icon', prompt: 'application icon', kind: 'medium' },
  { label: 'logo', prompt: 'brand logo', kind: 'medium' },
  {
    label: 'real-person photo',
    prompt: 'a real-life photograph of a human person, not a drawing',
    kind: 'medium',
  },
  {
    label: 'portrait photo',
    prompt: 'a portrait photograph of a real person',
    kind: 'medium',
  },
  {
    label: 'studio photo',
    prompt: 'a professional photograph taken in a photography studio',
    kind: 'medium',
  },
  {
    label: 'fashion photo',
    prompt: 'a professional fashion photography image',
    kind: 'medium',
  },
  { label: 'person', prompt: 'person', kind: 'subject' },
  { label: 'woman', prompt: 'woman', kind: 'subject' },
  { label: 'man', prompt: 'man', kind: 'subject' },
  { label: 'child', prompt: 'child', kind: 'subject' },
  { label: 'people', prompt: 'group of people', kind: 'subject' },
  { label: 'cat', prompt: 'cat', kind: 'subject' },
  { label: 'dog', prompt: 'dog', kind: 'subject' },
  { label: 'animal', prompt: 'animal', kind: 'subject' },
  { label: 'food', prompt: 'food or meal', kind: 'subject' },
  { label: 'product', prompt: 'consumer product', kind: 'subject' },
  { label: 'phone', prompt: 'smartphone', kind: 'subject' },
  { label: 'computer', prompt: 'computer or laptop', kind: 'subject' },
  { label: 'car', prompt: 'car or vehicle', kind: 'subject' },
  { label: 'building', prompt: 'building or architecture', kind: 'subject' },
  { label: 'clothing', prompt: 'clothing or fashion', kind: 'subject' },
  { label: 'game', prompt: 'video game scene', kind: 'subject' },
  {
    label: 'fashion model',
    prompt: 'a professional fashion model posing for a photograph',
    kind: 'role',
  },
  {
    label: 'female model',
    prompt: 'a female model posing for a professional photograph',
    kind: 'role',
  },
  {
    label: 'male model',
    prompt: 'a male model posing for a professional photograph',
    kind: 'role',
  },
  { label: 'couple', prompt: 'a portrait photograph of a couple', kind: 'subject' },
  { label: 'performer', prompt: 'a performer or celebrity posing for a photo', kind: 'role' },
  { label: 'indoor', prompt: 'indoor scene', kind: 'scene' },
  { label: 'outdoor', prompt: 'outdoor scene', kind: 'scene' },
  { label: 'nature', prompt: 'natural landscape', kind: 'scene' },
  { label: 'city', prompt: 'city street', kind: 'scene' },
  { label: 'beach', prompt: 'beach or ocean', kind: 'scene' },
  { label: 'night', prompt: 'night scene', kind: 'scene' },
  { label: 'workspace', prompt: 'desk or office workspace', kind: 'scene' },
  { label: 'shopping', prompt: 'online shopping page', kind: 'scene' },
  { label: 'photo studio', prompt: 'a model posing inside a photography studio', kind: 'scene' },
  { label: 'runway', prompt: 'a fashion model walking on a runway', kind: 'scene' },
  { label: 'street portrait', prompt: 'a person posing for a street portrait', kind: 'scene' },
  { label: 'stage', prompt: 'a performer photographed on a stage', kind: 'scene' },
  { label: 'event portrait', prompt: 'a person posing at a public event', kind: 'scene' },
  { label: 'portrait', prompt: 'portrait composition', kind: 'style' },
  { label: 'close-up', prompt: 'close-up composition', kind: 'style' },
  { label: 'full body', prompt: 'full body composition', kind: 'style' },
  { label: 'white background', prompt: 'object on a white background', kind: 'style' },
  { label: 'text-heavy', prompt: 'image containing a lot of text', kind: 'style' },
  { label: 'colorful', prompt: 'colorful image', kind: 'style' },
  { label: 'dark', prompt: 'dark low-light image', kind: 'style' },
  {
    label: 'beauty portrait',
    prompt: 'a polished beauty portrait photograph of a real person',
    kind: 'style',
  },
  {
    label: 'fashion editorial',
    prompt: 'a high-quality fashion editorial photograph with a model',
    kind: 'style',
  },
  {
    label: 'glamour portrait',
    prompt: 'a glamour portrait photography session with a model',
    kind: 'style',
  },
  { label: 'headshot', prompt: 'a professional headshot portrait photograph', kind: 'style' },
  { label: 'candid portrait', prompt: 'a natural candid photograph of a person', kind: 'style' },
  { label: 'selfie', prompt: 'a selfie photograph taken by a real person', kind: 'genre' },
  { label: 'cosplay', prompt: 'a cosplay model posing in costume', kind: 'genre' },
  { label: 'swimwear', prompt: 'a fashion model wearing swimwear in a photo shoot', kind: 'genre' },
  {
    label: 'wedding portrait',
    prompt: 'a professional wedding portrait photograph',
    kind: 'genre',
  },
  {
    label: 'lifestyle portrait',
    prompt: 'a lifestyle portrait photograph of a real person',
    kind: 'genre',
  },
  {
    label: 'commercial model',
    prompt: 'a commercial advertising photograph featuring a human model',
    kind: 'role',
  },
  {
    label: 'fitness portrait',
    prompt: 'a fitness portrait photograph of an athlete or model',
    kind: 'genre',
  },
]

const HUMAN_ANCHOR_LABELS = new Set(['person', 'woman', 'man', 'child', 'people', 'couple'])

const HUMAN_DETAIL_LABELS = new Set([
  'real-person photo',
  'portrait photo',
  'studio photo',
  'fashion photo',
  'fashion model',
  'female model',
  'male model',
  'couple',
  'performer',
  'photo studio',
  'runway',
  'street portrait',
  'stage',
  'event portrait',
  'beauty portrait',
  'fashion editorial',
  'glamour portrait',
  'headshot',
  'candid portrait',
  'selfie',
  'cosplay',
  'swimwear',
  'wedding portrait',
  'lifestyle portrait',
  'commercial model',
  'fitness portrait',
])

function normalizedMean(vectors: Float32Array[]): Float32Array {
  const dim = vectors[0]?.length || 0
  const mean = new Float32Array(dim)
  for (const vector of vectors) {
    for (let index = 0; index < dim; index++) mean[index] += vector[index] || 0
  }
  let normSquared = 0
  for (const value of mean) normSquared += value * value
  const norm = Math.sqrt(normSquared)
  if (norm > 0) for (let index = 0; index < dim; index++) mean[index] /= norm
  return mean
}

function cosine(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length)
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < length; index++) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  const denominator = Math.sqrt(leftNorm * rightNorm)
  return denominator > 0 ? dot / denominator : -1
}

export function rankClusterLabels(
  imageVectors: Float32Array[],
  textVectors: ReadonlyMap<string, Float32Array>,
  maxLabels = 4,
): string[] {
  if (imageVectors.length === 0 || textVectors.size === 0) return []
  const imageCenter = normalizedMean(imageVectors)
  const scored = CLUSTER_LABEL_CANDIDATES.map((candidate) => ({
    ...candidate,
    score: cosine(imageCenter, textVectors.get(candidate.prompt) || new Float32Array()),
  })).sort((left, right) => right.score - left.score)
  const bestScore = scored[0]?.score ?? -1
  const humanScore = scored.reduce(
    (best, candidate) =>
      HUMAN_ANCHOR_LABELS.has(candidate.label) ? Math.max(best, candidate.score) : best,
    -1,
  )
  const humanDetected = humanScore >= Math.max(0.12, bestScore - 0.04)
  const selected: string[] = []
  const usedKinds = new Set<ClusterLabelKind>()
  for (const candidate of scored) {
    const detailedHumanLabel = HUMAN_DETAIL_LABELS.has(candidate.label)
    const inclusionFloor = Math.max(0.12, bestScore - (detailedHumanLabel ? 0.075 : 0.045))
    if (candidate.score < inclusionFloor) continue
    if (detailedHumanLabel && !humanDetected) continue
    if (usedKinds.has(candidate.kind)) continue
    selected.push(candidate.label)
    usedKinds.add(candidate.kind)
    if (selected.length >= maxLabels) break
  }
  const roleIndex = selected.findIndex(
    (label) =>
      CLUSTER_LABEL_CANDIDATES.find((candidate) => candidate.label === label)?.kind === 'role',
  )
  if (roleIndex > 0) selected.unshift(selected.splice(roleIndex, 1)[0])
  return selected
}
