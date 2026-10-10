import fs from 'fs'
import path from 'path'

const STATE_SCHEMA_VERSION = 1 as const
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,255}$/i
const SPEAKER_DIMENSIONS = 192
const MAX_SPEAKERS = 32
const MAX_ASSIGNMENTS = 100_000
export const DEFAULT_SPEAKER_COSINE_THRESHOLD = 0.3

interface SpeakerCluster {
  speakerId: string
  count: number
  centroid: number[]
}

interface SpeakerClusteringState {
  schemaVersion: typeof STATE_SCHEMA_VERSION
  jobId: string
  videoId: string
  modelId: string
  modelRevision: string
  clusters: SpeakerCluster[]
  assignments: Record<string, string>
  updatedAt: number
}

function normalizedEmbedding(value: readonly number[]): number[] {
  if (value.length !== SPEAKER_DIMENSIONS || !value.every(Number.isFinite)) {
    throw new Error('Invalid CAM++ speaker embedding')
  }
  const norm = Math.hypot(...value)
  if (!Number.isFinite(norm) || norm < 1e-8) throw new Error('Invalid CAM++ speaker embedding')
  return value.map((component) => component / norm)
}

function cosine(left: readonly number[], right: readonly number[]): number {
  let score = 0
  for (let index = 0; index < SPEAKER_DIMENSIONS; index += 1) {
    score += left[index] * right[index]
  }
  return score
}

function atomicWrite(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, JSON.stringify(value), 'utf8')
  fs.renameSync(temporaryPath, filePath)
}

function validateState(raw: unknown, jobId: string, videoId: string): SpeakerClusteringState {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid speaker clustering state')
  const state = raw as SpeakerClusteringState
  if (
    state.schemaVersion !== STATE_SCHEMA_VERSION ||
    state.jobId !== jobId ||
    state.videoId !== videoId ||
    !IDENTIFIER_PATTERN.test(state.modelId) ||
    !IDENTIFIER_PATTERN.test(state.modelRevision) ||
    !Array.isArray(state.clusters) ||
    state.clusters.length > MAX_SPEAKERS ||
    !state.assignments ||
    typeof state.assignments !== 'object' ||
    Object.keys(state.assignments).length > MAX_ASSIGNMENTS
  ) {
    throw new Error('Invalid speaker clustering state')
  }
  for (let index = 0; index < state.clusters.length; index += 1) {
    const cluster = state.clusters[index]
    if (
      cluster.speakerId !== `speaker-${index + 1}` ||
      !Number.isSafeInteger(cluster.count) ||
      cluster.count < 1
    ) {
      throw new Error('Invalid speaker clustering state')
    }
    cluster.centroid = normalizedEmbedding(cluster.centroid)
  }
  for (const [observationId, speakerId] of Object.entries(state.assignments)) {
    if (
      !IDENTIFIER_PATTERN.test(observationId) ||
      !state.clusters.some((cluster) => cluster.speakerId === speakerId)
    ) {
      throw new Error('Invalid speaker clustering state')
    }
  }
  return state
}

export class PersistentAudioSpeakerClusterer {
  private readonly statePath: string
  private readonly threshold: number
  private state: SpeakerClusteringState

  constructor(
    root: string,
    jobId: string,
    videoId: string,
    model: { modelId: string; modelRevision: string },
    threshold = DEFAULT_SPEAKER_COSINE_THRESHOLD,
  ) {
    if (
      !IDENTIFIER_PATTERN.test(jobId) ||
      !IDENTIFIER_PATTERN.test(videoId) ||
      !IDENTIFIER_PATTERN.test(model.modelId) ||
      !IDENTIFIER_PATTERN.test(model.modelRevision) ||
      !Number.isFinite(threshold) ||
      threshold < -1 ||
      threshold > 1
    ) {
      throw new Error('Invalid speaker clustering authority')
    }
    this.threshold = threshold
    this.statePath = path.join(path.resolve(root), `${jobId}.${videoId}.json`)
    if (fs.existsSync(this.statePath)) {
      this.state = validateState(
        JSON.parse(fs.readFileSync(this.statePath, 'utf8')),
        jobId,
        videoId,
      )
      if (
        this.state.modelId !== model.modelId ||
        this.state.modelRevision !== model.modelRevision
      ) {
        throw new Error('Speaker clustering model identity mismatch')
      }
    } else {
      this.state = {
        schemaVersion: STATE_SCHEMA_VERSION,
        jobId,
        videoId,
        modelId: model.modelId,
        modelRevision: model.modelRevision,
        clusters: [],
        assignments: {},
        updatedAt: Date.now(),
      }
    }
  }

  assign(observationId: string, rawEmbedding: readonly number[]): string {
    if (!IDENTIFIER_PATTERN.test(observationId)) throw new Error('Invalid speaker observation id')
    const embedding = normalizedEmbedding(rawEmbedding)
    const existing = this.state.assignments[observationId]
    if (existing) return existing
    if (Object.keys(this.state.assignments).length >= MAX_ASSIGNMENTS) {
      throw new Error('Speaker clustering assignment limit exceeded')
    }

    let bestIndex = -1
    let bestScore = -Infinity
    for (let index = 0; index < this.state.clusters.length; index += 1) {
      const score = cosine(embedding, this.state.clusters[index].centroid)
      if (score > bestScore) {
        bestIndex = index
        bestScore = score
      }
    }
    if (
      bestIndex < 0 ||
      (bestScore < this.threshold && this.state.clusters.length < MAX_SPEAKERS)
    ) {
      bestIndex = this.state.clusters.length
      this.state.clusters.push({
        speakerId: `speaker-${bestIndex + 1}`,
        count: 1,
        centroid: embedding,
      })
    } else {
      const cluster = this.state.clusters[bestIndex]
      const count = cluster.count + 1
      cluster.centroid = normalizedEmbedding(
        cluster.centroid.map(
          (component, index) => (component * cluster.count + embedding[index]) / count,
        ),
      )
      cluster.count = count
    }
    const speakerId = this.state.clusters[bestIndex].speakerId
    this.state.assignments[observationId] = speakerId
    this.state.updatedAt = Date.now()
    atomicWrite(this.statePath, this.state)
    return speakerId
  }

  get speakerCount(): number {
    return this.state.clusters.length
  }
}
