export interface SemanticPersonClassDefinition {
  key: string
  label: string
  prompts: string[]
}

export interface SemanticPersonClassifier {
  humanGate: Float32Array[]
  nonHumanGate: Float32Array[]
  classes: Array<SemanticPersonClassDefinition & { vectors: Float32Array[] }>
}

export interface SemanticPersonMatch {
  key: string
  label: string
  confidence: number
  humanScore: number
  nonHumanScore: number
  margin: number
  subtypeScore: number
}

export const SEMANTIC_PERSON_HUMAN_PROMPTS = [
  'a real-life photograph of a human person',
  'a portrait photograph of a real woman',
  'a portrait photograph of a real man',
  'a group photograph of real people',
  'a professional photograph of a human model',
]

export const SEMANTIC_PERSON_NON_HUMAN_PROMPTS = [
  'application icon',
  'software user interface screenshot',
  'document containing text',
  'anime illustration',
  'cartoon drawing',
  'video game screenshot',
  'consumer product photograph',
  'animal photograph',
  'landscape photograph',
  'brand logo graphic',
  'abstract texture or repeating pattern',
  '3D rendered character',
]

export const SEMANTIC_PERSON_CLASSES: SemanticPersonClassDefinition[] = [
  {
    key: 'model_portraits',
    label: 'Real model photos',
    prompts: [
      'a professional fashion model posing for a photograph',
      'a glamour photography portrait of a real human model',
      'a studio fashion photo shoot with a real person',
    ],
  },
  {
    key: 'portrait_photos',
    label: 'Portrait photography',
    prompts: [
      'a portrait photograph of a real person',
      'a professional headshot photograph of a real person',
      'a beauty portrait photograph of a real person',
    ],
  },
  {
    key: 'selfies',
    label: 'Selfies',
    prompts: ['a selfie photograph taken by a real person', 'a real person taking a phone selfie'],
  },
  {
    key: 'cosplay_photos',
    label: 'Cosplay photos',
    prompts: [
      'a real cosplay model posing in costume for a photograph',
      'a photograph of a real person wearing a character costume',
    ],
  },
  {
    key: 'stage_performers',
    label: 'Stage performers',
    prompts: [
      'a real singer or performer photographed on a stage',
      'a real celebrity performing at a live event',
    ],
  },
  {
    key: 'wedding_portraits',
    label: 'Wedding portraits',
    prompts: [
      'a professional wedding portrait photograph of real people',
      'a real bride and groom posing for a wedding photograph',
    ],
  },
  {
    key: 'group_photos',
    label: 'Group photos',
    prompts: [
      'a group photograph of real people posing together',
      'a real-life photograph containing several people',
    ],
  },
  {
    key: 'lifestyle_people',
    label: 'People and lifestyle',
    prompts: [
      'a candid lifestyle photograph of a real person',
      'a real person photographed in an everyday indoor or outdoor scene',
    ],
  },
]

function normalizedVector(values: readonly number[] | Float32Array): Float32Array {
  const result = Float32Array.from(values)
  let normSquared = 0
  for (const value of result) normSquared += value * value
  const norm = Math.sqrt(normSquared)
  if (norm > 0) for (let index = 0; index < result.length; index++) result[index] /= norm
  return result
}

function maxDot(vector: Float32Array, candidates: Float32Array[]): number {
  let best = -1
  for (const candidate of candidates) {
    const length = Math.min(vector.length, candidate.length)
    let dot = 0
    for (let index = 0; index < length; index++) dot += vector[index] * candidate[index]
    best = Math.max(best, dot)
  }
  return best
}

function normalizedMean(vectors: Float32Array[]): Float32Array {
  if (vectors.length === 0) return new Float32Array()
  const mean = new Float32Array(vectors[0].length)
  for (const vector of vectors) {
    for (let index = 0; index < mean.length; index++) mean[index] += vector[index] || 0
  }
  return normalizedVector(mean)
}

export function buildSemanticPersonClassifier(
  embeddings: ReadonlyMap<string, readonly number[] | Float32Array>,
): SemanticPersonClassifier {
  const vectorsFor = (prompts: string[]) =>
    prompts
      .map((prompt) => embeddings.get(prompt))
      .filter((values): values is readonly number[] | Float32Array => !!values?.length)
      .map(normalizedVector)
  const humanVectors = vectorsFor(SEMANTIC_PERSON_HUMAN_PROMPTS)
  const nonHumanVectors = vectorsFor(SEMANTIC_PERSON_NON_HUMAN_PROMPTS)
  const centers = (vectors: Float32Array[], groups: number[][]) =>
    groups
      .map((indexes) => normalizedMean(indexes.map((index) => vectors[index]).filter(Boolean)))
      .filter((vector) => vector.length > 0)
  return {
    humanGate: centers(humanVectors, [
      [0, 1, 2],
      [3, 4],
    ]),
    nonHumanGate: centers(nonHumanVectors, [
      [0, 1, 2, 9, 10],
      [3, 4, 5, 11],
      [6, 7, 8],
    ]),
    classes: SEMANTIC_PERSON_CLASSES.map((definition) => ({
      ...definition,
      vectors: [normalizedMean(vectorsFor(definition.prompts))].filter(
        (vector) => vector.length > 0,
      ),
    })).filter((definition) => definition.vectors.length > 0),
  }
}

export function classifySemanticPerson(
  sourceVector: Float32Array,
  classifier: SemanticPersonClassifier,
  options: { minimumHumanScore?: number; minimumMargin?: number } = {},
): SemanticPersonMatch | null {
  if (
    sourceVector.length === 0 ||
    classifier.humanGate.length === 0 ||
    classifier.nonHumanGate.length === 0 ||
    classifier.classes.length === 0
  ) {
    return null
  }
  // CLIP cache rows are normalized when written; keep this hot path allocation-free.
  const vector = sourceVector
  const humanScore = maxDot(vector, classifier.humanGate)
  const nonHumanScore = maxDot(vector, classifier.nonHumanGate)
  const margin = humanScore - nonHumanScore
  if (humanScore < (options.minimumHumanScore ?? 0.16)) return null
  if (margin < (options.minimumMargin ?? 0.015)) return null

  let bestClass = classifier.classes[0]
  let subtypeScore = maxDot(vector, bestClass.vectors)
  for (let index = 1; index < classifier.classes.length; index++) {
    const candidate = classifier.classes[index]
    const score = maxDot(vector, candidate.vectors)
    if (score > subtypeScore) {
      bestClass = candidate
      subtypeScore = score
    }
  }
  return {
    key: bestClass.key,
    label: bestClass.label,
    confidence: Math.max(0, Math.min(1, (subtypeScore + 1) / 2)),
    humanScore,
    nonHumanScore,
    margin,
    subtypeScore,
  }
}
