import fs from 'fs'
import path from 'path'
import type {
  AssetFeedbackMode,
  AssetFeedbackModelState,
  AssetFeedbackModelStatus,
} from '../shared/ipc/asset-feedback'
import {
  activateFeedbackTargets,
  type AssetFeedbackModelSnapshot,
  type AssetFeedbackTargetKind,
  type SemanticFeedbackContext,
} from './assetFeedbackModel'
import { runAssetTaskWorker } from './assetTaskWorkerHost'
import type {
  AssetCategoryFeedbackWorkerProgress,
  AssetFeedbackBuildWorkerInput,
  AssetFeedbackBuildWorkerResult,
} from './assetCategoryFeedbackWorker'
import { requireNormalizedEmbeddingVectorFloat32 } from './embeddingVectorValidation'
import { getVisionModelCapability } from './modelRegistry'
import type { PreparedClipEmbeddingCache } from './semanticSearchService'

const MODEL_NAME = 'clip_vit_base_patch32' as const
const MODEL_DIM = getVisionModelCapability(MODEL_NAME).dim
const MODEL_VERSION = 1 as const
const MODEL_ALGORITHM_VERSION = 2 as const

export interface AssetFeedbackSourceSample {
  path: string
  weight: number
}

export interface AssetFeedbackSourceTarget {
  key: string
  kind: AssetFeedbackTargetKind
  id: number
  name: string
  positiveSampleCount: number
  negativeSampleCount: number
  positiveSamples: AssetFeedbackSourceSample[]
  negativeSamples: AssetFeedbackSourceSample[]
}

export interface AssetFeedbackSourceSnapshot {
  targets: AssetFeedbackSourceTarget[]
}

export interface AssetFeedbackBuildOptions {
  isCancelled?: () => boolean
  onProgress?: (progress: {
    current: number
    total: number
    percent: number
    message: string
  }) => void
}

interface FeedbackStateFile {
  version: 1
  enabled: boolean
  revision: number
  builtRevision: number
  updatedAt: number
  dirtyReason?: string
  error?: string
}

interface PersistedPrototype {
  path: string
  vector: string
}

interface PersistedTarget {
  key: string
  kind: AssetFeedbackTargetKind
  id: number
  name: string
  positiveSampleCount: number
  negativeSampleCount: number
  positivePrototypes: PersistedPrototype[]
  negativePrototypes: PersistedPrototype[]
}

interface PersistedModel {
  version: 1
  algorithmVersion: 2
  revision: number
  modelName: typeof MODEL_NAME
  dim: number
  builtAt: number
  sourceSampleCount: number
  embeddedSampleCount: number
  skippedSampleCount: number
  targets: PersistedTarget[]
}

type FeedbackSourceProvider = () => Promise<AssetFeedbackSourceSnapshot>
type FeedbackClipCacheProvider = (
  onProgress?: AssetFeedbackBuildOptions['onProgress'],
) => Promise<PreparedClipEmbeddingCache>

let feedbackDir = ''
let statePath = ''
let manifestPath = ''
let sourceProvider: FeedbackSourceProvider | null = null
let clipCacheProvider: FeedbackClipCacheProvider | null = null
let state: FeedbackStateFile = defaultState()
let model: AssetFeedbackModelSnapshot | null = null
let loadPromise: Promise<void> | null = null
let buildPromise: Promise<AssetFeedbackModelStatus> | null = null
let stateWriteMutex: Promise<void> = Promise.resolve()

function defaultState(): FeedbackStateFile {
  return {
    version: MODEL_VERSION,
    enabled: false,
    revision: 1,
    builtRevision: 0,
    updatedAt: Date.now(),
    dirtyReason: 'Feedback model has not been built',
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function pathKey(filePath: string): string {
  return filePath.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function encodeVector(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64')
}

function decodeVector(encoded: string, dim: number): Float32Array {
  const buffer = Buffer.from(encoded, 'base64')
  if (buffer.byteLength !== dim * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error('Feedback prototype has an invalid dimension')
  }
  const copy = new Uint8Array(buffer.byteLength)
  copy.set(buffer)
  return requireNormalizedEmbeddingVectorFloat32(new Float32Array(copy.buffer), dim)
}

function serializeModel(snapshot: AssetFeedbackModelSnapshot): PersistedModel {
  return {
    version: MODEL_VERSION,
    algorithmVersion: MODEL_ALGORITHM_VERSION,
    revision: snapshot.revision,
    modelName: snapshot.modelName,
    dim: snapshot.dim,
    builtAt: snapshot.builtAt,
    sourceSampleCount: snapshot.sourceSampleCount,
    embeddedSampleCount: snapshot.embeddedSampleCount,
    skippedSampleCount: snapshot.skippedSampleCount,
    targets: snapshot.targets.map((target) => ({
      key: target.key,
      kind: target.kind,
      id: target.id,
      name: target.name,
      positiveSampleCount: target.positiveSampleCount,
      negativeSampleCount: target.negativeSampleCount,
      positivePrototypes: target.positivePrototypes.map((prototype) => ({
        path: prototype.path,
        vector: encodeVector(prototype.vector),
      })),
      negativePrototypes: target.negativePrototypes.map((prototype) => ({
        path: prototype.path,
        vector: encodeVector(prototype.vector),
      })),
    })),
  }
}

function deserializeModel(raw: PersistedModel): AssetFeedbackModelSnapshot {
  if (
    raw.version !== MODEL_VERSION ||
    raw.algorithmVersion !== MODEL_ALGORITHM_VERSION ||
    raw.modelName !== MODEL_NAME ||
    raw.dim !== MODEL_DIM ||
    !Array.isArray(raw.targets)
  ) {
    throw new Error('Feedback model manifest is incompatible')
  }
  return {
    version: MODEL_VERSION,
    algorithmVersion: MODEL_ALGORITHM_VERSION,
    revision: Math.max(0, Math.floor(raw.revision || 0)),
    modelName: MODEL_NAME,
    dim: raw.dim,
    builtAt: Number(raw.builtAt) || 0,
    sourceSampleCount: Math.max(0, Math.floor(raw.sourceSampleCount || 0)),
    embeddedSampleCount: Math.max(0, Math.floor(raw.embeddedSampleCount || 0)),
    skippedSampleCount: Math.max(0, Math.floor(raw.skippedSampleCount || 0)),
    targets: raw.targets.map((target) => ({
      key: String(target.key),
      kind: target.kind === 'tag' ? 'tag' : 'category',
      id: Math.max(1, Math.floor(target.id)),
      name: String(target.name),
      positiveSampleCount: Math.max(0, Math.floor(target.positiveSampleCount || 0)),
      negativeSampleCount: Math.max(0, Math.floor(target.negativeSampleCount || 0)),
      positivePrototypes: target.positivePrototypes.map((prototype) => ({
        path: String(prototype.path),
        vector: decodeVector(prototype.vector, raw.dim),
      })),
      negativePrototypes: target.negativePrototypes.map((prototype) => ({
        path: String(prototype.path),
        vector: decodeVector(prototype.vector, raw.dim),
      })),
    })),
  }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.promises.writeFile(temporaryPath, JSON.stringify(value), 'utf8')
  try {
    await fs.promises.rename(temporaryPath, filePath)
  } catch (error) {
    await fs.promises.unlink(temporaryPath).catch(() => {})
    throw error
  }
}

async function persistState(): Promise<void> {
  const snapshot = { ...state }
  const pending = stateWriteMutex.catch(() => {}).then(() => atomicWriteJson(statePath, snapshot))
  stateWriteMutex = pending
  await pending
}

async function loadFromDisk(): Promise<void> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(statePath, 'utf8')) as FeedbackStateFile
    if (parsed.version === MODEL_VERSION) {
      state = {
        version: MODEL_VERSION,
        enabled: parsed.enabled === true,
        revision: Math.max(1, Math.floor(parsed.revision || 1)),
        builtRevision: Math.max(0, Math.floor(parsed.builtRevision || 0)),
        updatedAt: Number(parsed.updatedAt) || Date.now(),
        ...(parsed.dirtyReason ? { dirtyReason: String(parsed.dirtyReason) } : {}),
        ...(parsed.error ? { error: String(parsed.error) } : {}),
      }
    }
  } catch {
    state = defaultState()
  }

  try {
    const parsed = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) as PersistedModel
    model = deserializeModel(parsed)
    state.builtRevision = model.revision
  } catch (error) {
    model = null
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') state.error = errorMessage(error)
  }
}

async function ensureLoaded(): Promise<void> {
  if (!loadPromise) loadPromise = loadFromDisk()
  await loadPromise
}

function lifecycleState(ignoreActiveBuild = false): AssetFeedbackModelState {
  if (buildPromise && !ignoreActiveBuild) return 'building'
  if (state.error && !model) return 'error'
  if (!model) return 'missing'
  if (state.revision !== model.revision) return 'dirty'
  return 'ready'
}

function statusFromState(ignoreActiveBuild = false): AssetFeedbackModelStatus {
  const targets = model?.targets || []
  return {
    enabled: state.enabled,
    state: lifecycleState(ignoreActiveBuild),
    modelName: MODEL_NAME,
    revision: state.revision,
    builtRevision: model?.revision || state.builtRevision,
    targetCount: targets.length,
    positiveSampleCount: targets.reduce((sum, target) => sum + target.positiveSampleCount, 0),
    negativeSampleCount: targets.reduce((sum, target) => sum + target.negativeSampleCount, 0),
    positivePrototypeCount: targets.reduce(
      (sum, target) => sum + target.positivePrototypes.length,
      0,
    ),
    negativePrototypeCount: targets.reduce(
      (sum, target) => sum + target.negativePrototypes.length,
      0,
    ),
    embeddedSampleCount: model?.embeddedSampleCount || 0,
    skippedSampleCount: model?.skippedSampleCount || 0,
    ...(model?.builtAt ? { builtAt: model.builtAt } : {}),
    updatedAt: state.updatedAt,
    ...(state.dirtyReason ? { dirtyReason: state.dirtyReason } : {}),
    ...(state.error ? { error: state.error } : {}),
  }
}

export function initAssetFeedbackModelService(assetLibraryDir: string): void {
  feedbackDir = path.join(assetLibraryDir, 'search-feedback')
  statePath = path.join(feedbackDir, 'state.json')
  manifestPath = path.join(feedbackDir, 'manifest.json')
  state = defaultState()
  model = null
  loadPromise = null
  buildPromise = null
  stateWriteMutex = Promise.resolve()
  void ensureLoaded()
}

export function setAssetFeedbackSourceProvider(provider: FeedbackSourceProvider | null): void {
  sourceProvider = provider
}

export function setAssetFeedbackClipCacheProvider(
  provider: FeedbackClipCacheProvider | null,
): void {
  clipCacheProvider = provider
}

export async function getAssetFeedbackModelStatus(): Promise<AssetFeedbackModelStatus> {
  await ensureLoaded()
  return statusFromState()
}

export async function setAssetFeedbackEnabled(enabled: boolean): Promise<AssetFeedbackModelStatus> {
  await ensureLoaded()
  state = { ...state, enabled, updatedAt: Date.now() }
  await persistState()
  return statusFromState()
}

export async function markAssetFeedbackDirty(reason: string): Promise<void> {
  await ensureLoaded()
  state = {
    ...state,
    revision: state.revision + 1,
    updatedAt: Date.now(),
    dirtyReason: reason.slice(0, 240),
  }
  delete state.error
  await persistState()
}

export async function rebuildAssetFeedbackModel(
  options: AssetFeedbackBuildOptions = {},
): Promise<AssetFeedbackModelStatus> {
  await ensureLoaded()
  if (buildPromise) return buildPromise

  const capturedRevision = state.revision
  const previousModel = model
  const run = async (): Promise<AssetFeedbackModelStatus> => {
    if (!sourceProvider) throw new Error('Asset feedback source is not available')
    options.onProgress?.({
      current: 0,
      total: 1,
      percent: 1,
      message: 'Reading reviewed samples...',
    })
    const source = await sourceProvider()
    if (options.isCancelled?.()) throw new Error('Asset feedback build cancelled')

    const allPaths = new Set<string>()
    for (const target of source.targets) {
      for (const sample of target.positiveSamples) allPaths.add(sample.path)
      for (const sample of target.negativeSamples) allPaths.add(sample.path)
    }

    let built: AssetFeedbackBuildWorkerResult
    if (allPaths.size === 0) {
      built = {
        dim: 512,
        sourceSampleCount: 0,
        embeddedSampleCount: 0,
        skippedSampleCount: 0,
        targets: [],
      }
    } else {
      if (!clipCacheProvider) throw new Error('Asset feedback CLIP cache is not available')
      const cache = await clipCacheProvider((progress) => {
        options.onProgress?.({
          ...progress,
          percent: Math.round(5 + progress.percent * 0.15),
        })
      })
      if (options.isCancelled?.()) throw new Error('Asset feedback build cancelled')
      built = await runAssetTaskWorker<
        AssetCategoryFeedbackWorkerProgress,
        AssetFeedbackBuildWorkerResult
      >({
        workerFile: 'assetCategoryFeedbackWorker.js',
        input: { kind: 'feedback_build', source, cache } satisfies AssetFeedbackBuildWorkerInput,
        onProgress: (progress) => {
          options.onProgress?.({
            current: progress.current,
            total: progress.total,
            percent: Math.round(20 + progress.percent * 0.74),
            message: progress.message,
          })
        },
      })
      if (built.embeddedSampleCount === 0) {
        throw new Error('No reviewed samples have CLIP embeddings. Build CLIP embeddings first.')
      }
    }

    const snapshot: AssetFeedbackModelSnapshot = {
      version: MODEL_VERSION,
      algorithmVersion: MODEL_ALGORITHM_VERSION,
      revision: capturedRevision,
      modelName: MODEL_NAME,
      dim: built.dim,
      builtAt: Date.now(),
      sourceSampleCount: built.sourceSampleCount,
      embeddedSampleCount: built.embeddedSampleCount,
      skippedSampleCount: built.skippedSampleCount,
      targets: built.targets,
    }

    options.onProgress?.({
      current: built.targets.length,
      total: built.targets.length,
      percent: 96,
      message: 'Validating and saving feedback model...',
    })
    const persisted = serializeModel(snapshot)
    const validated = deserializeModel(persisted)
    await atomicWriteJson(manifestPath, persisted)
    model = validated
    state = {
      ...state,
      builtRevision: capturedRevision,
      updatedAt: Date.now(),
      ...(state.revision === capturedRevision ? {} : { dirtyReason: state.dirtyReason }),
    }
    if (state.revision === capturedRevision) delete state.dirtyReason
    delete state.error
    await persistState()
    options.onProgress?.({
      current: built.targets.length,
      total: built.targets.length,
      percent: 100,
      message: `Feedback model ready: ${built.targets.length} targets, ${built.embeddedSampleCount} embedded samples.`,
    })
    return statusFromState(true)
  }

  buildPromise = run()
    .catch(async (error: unknown) => {
      model = previousModel
      state = {
        ...state,
        updatedAt: Date.now(),
        error: errorMessage(error),
      }
      await persistState().catch(() => {})
      throw error
    })
    .finally(() => {
      buildPromise = null
    })
  return buildPromise
}

export async function getSemanticFeedbackContext(
  query: string,
  mode: AssetFeedbackMode = 'auto',
): Promise<SemanticFeedbackContext> {
  await ensureLoaded()
  const activeModel = model
  if (mode === 'off' || !state.enabled || !activeModel) {
    return {
      mode,
      revision: state.revision,
      builtRevision: activeModel?.revision || 0,
      stale: Boolean(activeModel && activeModel.revision !== state.revision),
      targets: [],
    }
  }
  return {
    mode,
    revision: state.revision,
    builtRevision: activeModel.revision,
    stale: activeModel.revision !== state.revision,
    targets: activateFeedbackTargets(query, activeModel.targets),
  }
}

export async function getAssetFeedbackTargetContext(
  kind: AssetFeedbackTargetKind,
  id: number,
): Promise<SemanticFeedbackContext> {
  await ensureLoaded()
  const activeModel = model
  const target = activeModel?.targets.find((item) => item.kind === kind && item.id === id)
  return {
    mode: 'force',
    revision: state.revision,
    builtRevision: activeModel?.revision || 0,
    stale: Boolean(activeModel && activeModel.revision !== state.revision),
    targets: target ? [{ target, gate: 1, reason: 'selected target' }] : [],
  }
}

export function getFeedbackPrototypePaths(context: SemanticFeedbackContext): string[] {
  const paths = new Map<string, string>()
  for (const activation of context.targets) {
    for (const prototype of activation.target.positivePrototypes) {
      paths.set(pathKey(prototype.path), prototype.path)
    }
  }
  return [...paths.values()]
}
