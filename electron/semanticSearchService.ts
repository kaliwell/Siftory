import fs from 'fs'
import path from 'path'
import {
  getProjectSearchMetadata,
  isProjectPreviewProxy,
  resolveProjectSearchInputPath,
} from './projectSearchIndexService'
import { app } from 'electron'
import { getInstalledModelDir } from './modelService'
import { getVisionModelCapability } from './modelRegistry'
import { getEmbeddingStorePaths } from './vectorDatabaseService'
import type {
  LayeredSearchResult,
  MatchLevel,
  SemanticSearchRequest,
  SemanticSearchProgress,
  SemanticSearchResponse,
} from '../shared/vectorTypes'
import { scoreAssetFeedback, type SemanticFeedbackContext } from './assetFeedbackModel'
import { getFeedbackPrototypePaths, getSemanticFeedbackContext } from './assetFeedbackModelService'
import {
  buildSemanticPathScope,
  filterSemanticVectorCandidates,
  type NativeScopeState,
} from './semanticSearchScope'
import {
  getMultilingualTextEmbeddings,
  isMultilingualTextEncoderAvailable,
} from './multilingualTextEncoder'
import { lookupQueryGloss, mergeQueryLexicon } from './queryLexicon'
import {
  normalizeTextEncoderSetting,
  resolveTextEncoderChoice,
  type TextEncoderKind,
  type TextEncoderSetting,
} from './textEncoderRouting'
import {
  buildSemanticPersonClassifier,
  classifySemanticPerson,
  SEMANTIC_PERSON_CLASSES,
  SEMANTIC_PERSON_HUMAN_PROMPTS,
  SEMANTIC_PERSON_NON_HUMAN_PROMPTS,
  type SemanticPersonMatch,
} from './semanticPersonClassification'
import {
  embeddingCachePathKey,
  ensureEmbeddingF16Cache,
  isEmbeddingF16CacheBuildRunning,
  readEmbeddingF16VectorsForPaths,
  streamEmbeddingF16Cache,
  type EmbeddingF16CacheHandle,
} from './embeddingF16Cache'
import { requireNormalizedEmbeddingVector } from './embeddingVectorValidation'
import { scanSemanticClipCache, type SemanticClipCandidate } from './semanticClipScan'
import { searchSemanticVectorScan } from './semanticVectorSearchWorkerHost'

// The candidate shape is shared with the semantic vector search worker
// (semanticClipScan.ts); keep scoring/tie-break changes in sync with it.
type SemanticCandidate = SemanticClipCandidate

interface CandidateCollection {
  paths: string[]
  truncated: boolean
  /**
   * Explicit Native scope state (VAL-036). Only a corrupt manifest fails
   * closed; absent/valid-empty keep the legacy explicit full-library
   * fallback.
   */
  scopeState: NativeScopeState
}

export interface PreparedClipEmbeddingCache {
  dim: number
  count: number
  vectorPath: string
  pathListPath: string
  dtype?: 'f16-le'
  delta?: {
    vectorPath: string
    pathListPath: string
    baseCount: number
  }
}

export function preparedClipEmbeddingCacheFromHandle(
  cache: EmbeddingF16CacheHandle,
): PreparedClipEmbeddingCache {
  return {
    dim: cache.meta.dim,
    count: cache.meta.count,
    vectorPath: cache.vectorPath,
    pathListPath: cache.pathIndexPath,
    dtype: 'f16-le',
    delta: cache.delta
      ? {
          vectorPath: cache.delta.vectorPath,
          pathListPath: cache.delta.pathIndexPath,
          baseCount: cache.delta.baseCount,
        }
      : undefined,
  }
}

interface DisposableTransformersRuntime {
  dispose?: () => unknown | Promise<unknown>
}

type ZeroShotClassifier = ((
  image: string,
  labels: string[],
  options?: Record<string, unknown>,
) => Promise<{ label: string; score: number }[]>) &
  DisposableTransformersRuntime

type ClipDevice = 'cpu' | 'dml' | 'gpu'
type SemanticProgressCallback = (progress: SemanticSearchProgress) => void

export interface ClipFeedbackTargetSearchOptions {
  topK: number
  isCancelled?: () => boolean
  isEligiblePath?: (filePath: string) => boolean
  onProgress?: (progress: {
    current: number
    total: number
    percent: number
    message: string
  }) => void
}
type ClipTokenizer = (
  prompts: string[],
  options: { padding: boolean; truncation: boolean },
) => Record<string, unknown>
interface ClipTextOutput {
  text_embeds?: {
    data?: ArrayLike<number>
    dims?: number[]
  }
}
type ClipTextModel = ((inputs: Record<string, unknown>) => Promise<ClipTextOutput>) &
  DisposableTransformersRuntime
interface ClipTransformersModule {
  env: {
    localModelPath: string
    cacheDir: string
    allowLocalModels: boolean
    allowRemoteModels: boolean
  }
  AutoTokenizer: {
    from_pretrained(model: string): Promise<ClipTokenizer>
  }
  CLIPTextModelWithProjection: {
    from_pretrained(
      model: string,
      options: { dtype: string; device: ClipDevice },
    ): Promise<ClipTextModel>
  }
}

const MAX_SEMANTIC_CANDIDATES = 1_000_000
const MAX_CLIP_SAMPLE = 256
const MAX_CLIP_SAMPLE_HARD_LIMIT = 2000
const CLIP_EMBEDDING_MODEL = 'clip_vit_base_patch32'
const CLIP_EMBEDDING_CAPABILITY = getVisionModelCapability(CLIP_EMBEDDING_MODEL)
const CLIP_EMBEDDING_DIM = CLIP_EMBEDDING_CAPABILITY.dim
const zeroShotClassifierPromises = new Map<ClipDevice, Promise<ZeroShotClassifier>>()
const clipTextModelPromises = new Map<ClipDevice, Promise<ClipTextModel>>()
let clipTokenizerPromise: Promise<ClipTokenizer> | null = null

export function isClipEmbeddingCacheBuildRunning(): boolean {
  return isEmbeddingF16CacheBuildRunning()
}

export function invalidateClipEmbeddingCacheMemory(): void {}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function applySemanticMetrics(
  progress: SemanticSearchProgress,
  startedAt: number,
): SemanticSearchProgress {
  const elapsedMs = Math.max(0, Date.now() - startedAt)
  const seconds = elapsedMs / 1000
  const itemsPerSecond = seconds > 0 ? progress.scanned / seconds : 0
  const percent = typeof progress.percent === 'number' ? progress.percent : undefined
  return {
    ...progress,
    startedAt,
    elapsedMs,
    itemsPerSecond: Number.isFinite(itemsPerSecond) ? itemsPerSecond : 0,
    etaMs:
      typeof percent === 'number' && percent > 0 && percent < 100
        ? Math.max(0, Math.round((elapsedMs * (100 - percent)) / percent))
        : progress.phase === 'done'
          ? 0
          : progress.etaMs,
  }
}

const SYNONYMS: Record<string, string[]> = {
  red: ['red', '\u7ea2', '\u7ea2\u8272'],
  blue: ['blue', '\u84dd', '\u84dd\u8272'],
  green: ['green', '\u7eff', '\u7eff\u8272'],
  yellow: ['yellow', '\u9ec4', '\u9ec4\u8272'],
  black: ['black', '\u9ed1', '\u9ed1\u8272'],
  white: ['white', '\u767d', '\u767d\u8272'],
  pink: ['pink', '\u7c89', '\u7c89\u8272'],
  purple: ['purple', '\u7d2b', '\u7d2b\u8272'],
  orange: ['orange', '\u6a59', '\u6a59\u8272'],
  gray: ['gray', 'grey', '\u7070', '\u7070\u8272'],
  woman: [
    'woman',
    'female',
    'girl',
    'lady',
    '\u7f8e\u5973',
    '\u5973\u4eba',
    '\u5973\u751f',
    '\u5973\u5b69',
    '\u5973\u6027',
  ],
  man: ['man', 'male', 'boy', 'guy', '\u7537\u4eba', '\u7537\u751f', '\u7537\u5b69'],
  person: ['person', 'people', 'portrait', '\u4eba', '\u4eba\u7269', '\u4eba\u50cf'],
  child: ['child', 'kid', 'baby', '\u513f\u7ae5', '\u5c0f\u5b69', '\u5b69\u5b50'],
  cat: ['cat', 'kitten', '\u732b', '\u732b\u54aa'],
  dog: ['dog', 'puppy', '\u72d7', '\u72d7\u72d7'],
  cow: ['cow', 'cattle', '\u725b', '\u5976\u725b', '\u9ec4\u725b'],
  horse: ['horse', '\u9a6c'],
  bird: ['bird', '\u9e1f'],
  anime: ['anime', 'cartoon', 'manga', '\u4e8c\u6b21\u5143', '\u52a8\u6f2b', '\u6f2b\u753b'],
  phone: ['phone', 'mobile', 'iphone', 'android', '\u624b\u673a'],
  car: ['car', 'vehicle', '\u6c7d\u8f66', '\u8f66'],
  food: ['food', 'meal', '\u98df\u7269', '\u7f8e\u98df'],
  screenshot: ['screenshot', 'screen', '\u622a\u5c4f', '\u622a\u56fe'],
  avatar: ['avatar', 'profile', '\u5934\u50cf'],
  wallpaper: ['wallpaper', '\u58c1\u7eb8'],
  comic: ['comic', 'manga', '\u6f2b\u753b'],
  photo: ['photo', 'picture', 'image', '\u7167\u7247', '\u56fe\u7247', '\u56fe'],
  gif: ['gif', '\u52a8\u56fe'],
  // ── Expanded synonyms for Chinese-English semantic search ──
  landscape: [
    'landscape',
    'scenery',
    'nature',
    '\u98ce\u666f',
    '\u666f\u8272',
    '\u81ea\u7136\u666f\u89c2',
  ],
  flower: ['flower', 'blossom', '\u82b1', '\u82b1\u6735', '\u9c9c\u82b1'],
  mountain: ['mountain', 'hill', '\u5c71', '\u5c71\u5cf0', '\u5c71\u8109'],
  water: [
    'water',
    'river',
    'lake',
    'ocean',
    'sea',
    '\u6c34',
    '\u6cb3',
    '\u6e56',
    '\u6d77',
    '\u6d77\u6d0b',
  ],
  sky: ['sky', 'cloud', '\u5929\u7a7a', '\u5929', '\u4e91', '\u4e91\u6735'],
  night: ['night', 'dark', '\u591c\u665a', '\u9ed1\u591c', '\u665a\u4e0a'],
  tree: ['tree', 'forest', 'wood', '\u6811', '\u6811\u6797', '\u68ee\u6797'],
  building: ['building', 'architecture', '\u5efa\u7b51', '\u623f\u5b50', '\u697c', '\u697c\u623f'],
  street: ['street', 'road', '\u8857\u9053', '\u9053\u8def', '\u8def'],
  indoor: ['indoor', 'room', 'interior', '\u5ba4\u5185', '\u623f\u95f4', '\u5c4b\u5185'],
  outdoor: ['outdoor', 'outside', '\u5ba4\u5916', '\u6237\u5916'],
  selfie: ['selfie', '\u81ea\u62cd', '\u81ea\u62cd\u7167'],
  text_content: ['text', 'document', '\u6587\u5b57', '\u6587\u6863', '\u6587\u4ef6'],
  logo: ['logo', 'brand', 'icon', '\u6807\u5fd7', 'logo', '\u56fe\u6807'],
  chart: ['chart', 'graph', 'diagram', '\u56fe\u8868', '\u8868\u683c'],
  animal: ['animal', '\u52a8\u7269', '\u5ba0\u7269'],
  fish: ['fish', '\u9c7c'],
  insect: ['insect', 'bug', '\u6606\u866b', '\u866b\u5b50'],
  fruit: ['fruit', '\u6c34\u679c'],
  vegetable: ['vegetable', '\u852c\u83dc', '\u83dc'],
  drink: ['drink', 'beverage', '\u996e\u6599', '\u996e\u54c1', '\u559d\u7684'],
  dessert: ['dessert', 'cake', '\u751c\u54c1', '\u86cb\u7cd5'],
  snow: ['snow', '\u96ea', '\u96ea\u666f', '\u4e0b\u96ea'],
  rain: ['rain', '\u96e8', '\u4e0b\u96e8'],
  sun: [
    'sun',
    'sunlight',
    'sunset',
    'sunrise',
    '\u592a\u9633',
    '\u65e5\u843d',
    '\u65e5\u51fa',
    '\u9633\u5149',
  ],
  beach: ['beach', 'coast', '\u6d77\u6ee9', '\u6c99\u6ee9', '\u6d77\u8fb9'],
  bridge: ['bridge', '\u6865', '\u6865\u6881'],
  vehicle: [
    'vehicle',
    'bus',
    'truck',
    'motorcycle',
    'bicycle',
    'bike',
    '\u516c\u4ea4',
    '\u6469\u6258',
    '\u81ea\u884c\u8f66',
    '\u5361\u8f66',
    '\u9762\u5305\u8f66',
  ],
  airplane: ['airplane', 'plane', 'aircraft', '\u98de\u673a', '\u822a\u7a7a'],
  train: ['train', 'railway', '\u706b\u8f66', '\u94c1\u8def'],
  ship: ['ship', 'boat', '\u8239'],
  glasses: ['glasses', 'sunglasses', '\u773c\u955c', '\u592a\u9633\u955c'],
  hat: ['hat', 'cap', '\u5e3d\u5b50'],
  bag: ['bag', 'backpack', 'handbag', '\u5305', '\u80cc\u5305', '\u624b\u63d0\u5305'],
  shoe: ['shoe', 'sneaker', '\u978b', '\u978b\u5b50'],
  clock: ['clock', 'watch', '\u949f', '\u8868', '\u949f\u8868', '\u65f6\u949f'],
  book: ['book', '\u4e66', '\u4e66\u7c4d', '\u6587\u4ef6'],
  computer: [
    'computer',
    'laptop',
    'pc',
    '\u7535\u8111',
    '\u7b14\u8bb0\u672c',
    '\u8ba1\u7b97\u673a',
  ],
  money: ['money', 'cash', '\u94b1', '\u73b0\u91d1'],
  game: ['game', 'gaming', '\u6e38\u620f'],
  sports: ['sports', 'sport', '\u4f53\u80b2', '\u8fd0\u52a8'],
  celebration: ['celebration', 'party', 'festival', '\u5e86\u795d', '\u6d3e\u5bf9', '\u8282\u65e5'],
  medical: ['medical', 'hospital', '\u533b\u7597', '\u533b\u9662', '\u5065\u5eb7'],
  map_content: ['map', '\u5730\u56fe'],
}

const CLIP_LABELS: Record<string, string> = {
  '\u7ea2': 'red',
  '\u7ea2\u8272': 'red',
  '\u84dd': 'blue',
  '\u84dd\u8272': 'blue',
  '\u7eff': 'green',
  '\u7eff\u8272': 'green',
  '\u9ec4': 'yellow',
  '\u9ec4\u8272': 'yellow',
  '\u9ed1': 'black',
  '\u9ed1\u8272': 'black',
  '\u767d': 'white',
  '\u767d\u8272': 'white',
  '\u7c89': 'pink',
  '\u7c89\u8272': 'pink',
  '\u7d2b': 'purple',
  '\u7d2b\u8272': 'purple',
  '\u7f8e\u5973': 'woman',
  '\u5973\u4eba': 'woman',
  '\u5973\u751f': 'woman',
  '\u5973\u5b69': 'girl',
  '\u7537\u4eba': 'man',
  '\u7537\u751f': 'man',
  '\u7537\u5b69': 'boy',
  '\u4eba': 'person',
  '\u4eba\u7269': 'person',
  '\u4eba\u50cf': 'portrait',
  '\u513f\u7ae5': 'child',
  '\u5c0f\u5b69': 'child',
  '\u732b': 'cat',
  '\u732b\u54aa': 'cat',
  '\u72d7': 'dog',
  '\u72d7\u72d7': 'dog',
  '\u725b': 'cow',
  '\u5976\u725b': 'cow',
  '\u9ec4\u725b': 'cow',
  '\u9a6c': 'horse',
  '\u9e1f': 'bird',
  '\u4e8c\u6b21\u5143': 'anime',
  '\u52a8\u6f2b': 'anime',
  '\u6f2b\u753b': 'manga',
  '\u624b\u673a': 'phone',
  '\u6c7d\u8f66': 'car',
  '\u8f66': 'car',
  '\u98df\u7269': 'food',
  '\u7f8e\u98df': 'food',
  '\u622a\u5c4f': 'screenshot',
  '\u622a\u56fe': 'screenshot',
  '\u5934\u50cf': 'avatar',
  '\u58c1\u7eb8': 'wallpaper',
  '\u7167\u7247': 'photo',
  '\u56fe\u7247': 'photo',
  '\u56fe': 'image',
  '\u52a8\u56fe': 'gif',
  // ── Expanded Chinese→English labels for recall ──
  '\u98ce\u666f': 'landscape',
  '\u666f\u8272': 'scenery',
  '\u81ea\u7136': 'nature',
  '\u82b1': 'flower',
  '\u82b1\u6735': 'flower',
  '\u5c71': 'mountain',
  '\u5c71\u5cf0': 'mountain',
  '\u6c34': 'water',
  '\u6cb3': 'river',
  '\u6e56': 'lake',
  '\u6d77': 'sea',
  '\u6d77\u6d0b': 'ocean',
  '\u5929\u7a7a': 'sky',
  '\u4e91': 'cloud',
  '\u591c\u665a': 'night',
  '\u9ed1\u591c': 'night',
  '\u6811': 'tree',
  '\u6811\u6797': 'forest',
  '\u68ee\u6797': 'forest',
  '\u5efa\u7b51': 'building',
  '\u623f\u5b50': 'building',
  '\u697c': 'building',
  '\u8857\u9053': 'street',
  '\u9053\u8def': 'road',
  '\u5ba4\u5185': 'indoor',
  '\u623f\u95f4': 'room',
  '\u5ba4\u5916': 'outdoor',
  '\u6237\u5916': 'outdoor',
  '\u81ea\u62cd': 'selfie',
  '\u6587\u5b57': 'text',
  '\u6587\u6863': 'document',
  '\u6807\u5fd7': 'logo',
  '\u56fe\u6807': 'icon',
  '\u56fe\u8868': 'chart',
  '\u8868\u683c': 'chart',
  '\u52a8\u7269': 'animal',
  '\u5ba0\u7269': 'animal',
  '\u9c7c': 'fish',
  '\u6606\u866b': 'insect',
  '\u866b\u5b50': 'insect',
  '\u6c34\u679c': 'fruit',
  '\u852c\u83dc': 'vegetable',
  '\u83dc': 'vegetable',
  '\u996e\u6599': 'drink',
  '\u996e\u54c1': 'drink',
  '\u751c\u54c1': 'dessert',
  '\u86cb\u7cd5': 'cake',
  '\u96ea': 'snow',
  '\u96e8': 'rain',
  '\u592a\u9633': 'sun',
  '\u65e5\u843d': 'sunset',
  '\u65e5\u51fa': 'sunrise',
  '\u6d77\u6ee9': 'beach',
  '\u6c99\u6ee9': 'beach',
  '\u6865': 'bridge',
  '\u516c\u4ea4': 'bus',
  '\u6469\u6258': 'motorcycle',
  '\u81ea\u884c\u8f66': 'bicycle',
  '\u98de\u673a': 'airplane',
  '\u706b\u8f66': 'train',
  '\u94c1\u8def': 'train',
  '\u8239': 'ship',
  '\u773c\u955c': 'glasses',
  '\u592a\u9633\u955c': 'sunglasses',
  '\u5e3d\u5b50': 'hat',
  '\u5305': 'bag',
  '\u80cc\u5305': 'backpack',
  '\u624b\u63d0\u5305': 'handbag',
  '\u978b': 'shoe',
  '\u978b\u5b50': 'shoe',
  '\u949f': 'clock',
  '\u8868': 'clock',
  '\u65f6\u949f': 'clock',
  '\u4e66': 'book',
  '\u7535\u8111': 'computer',
  '\u7b14\u8bb0\u672c': 'laptop',
  '\u94b1': 'money',
  '\u6e38\u620f': 'game',
  '\u4f53\u80b2': 'sports',
  '\u8fd0\u52a8': 'sports',
  '\u5e86\u795d': 'celebration',
  '\u6d3e\u5bf9': 'party',
  '\u533b\u7597': 'medical',
  '\u533b\u9662': 'hospital',
  '\u5730\u56fe': 'map',
}

const CLIP_DISTRACTOR_LABELS = [
  'person',
  'woman',
  'man',
  'cat',
  'dog',
  'cow',
  'horse',
  'bird',
  'car',
  'phone',
  'screenshot',
  'document',
  'cartoon',
  'food',
  'landscape',
  'building',
  'text',
]

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[_\-()[\]{}.,;，。！？!?:@#$%^&+=~`'"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenize(input: string): string[] {
  const normalized = normalizeText(input)
  if (!normalized) return []
  const asciiTokens = normalized.match(/[a-z0-9]+/g) || []
  const cjkRuns = normalized.match(/[\u4e00-\u9fff]{1,12}/g) || []
  const cjkTokens: string[] = []
  for (const run of cjkRuns) {
    cjkTokens.push(run)
    for (let size = 1; size <= Math.min(4, run.length); size++) {
      for (let i = 0; i <= run.length - size; i++) cjkTokens.push(run.slice(i, i + size))
    }
  }
  return [...new Set([...asciiTokens, ...cjkTokens].filter((t) => t.length > 0))]
}

function expandQueryTokens(tokens: string[]): string[] {
  const expanded = new Set(tokens)
  for (const token of tokens) {
    for (const values of Object.values(SYNONYMS)) {
      if (values.includes(token)) {
        for (const value of values) expanded.add(value)
      }
    }
  }
  return [...expanded]
}

function readCString(buf: Buffer, start: number): string {
  let end = start
  while (end < buf.length && buf[end] !== 0) end++
  return buf.toString('utf8', start, end)
}

function readExact(fd: number, offset: number, length: number): Buffer {
  if (!Number.isFinite(offset) || !Number.isFinite(length) || offset < 0 || length <= 0) {
    return Buffer.alloc(0)
  }
  const buf = Buffer.alloc(length)
  const bytes = fs.readSync(fd, buf, 0, length, offset)
  return bytes === length ? buf : buf.subarray(0, Math.max(0, bytes))
}

function readSegmentPaths(segmentPath: string, limit: number): string[] {
  const out: string[] = []
  let fd: number | null = null
  try {
    fd = fs.openSync(segmentPath, 'r')
    const header = readExact(fd, 0, 80)
    if (header.length < 80 || header.toString('ascii', 0, 4) !== 'IMS1') return out
    const recordCount = Number(header.readBigUInt64LE(8))
    const pathOffsetsOffset = Number(header.readBigUInt64LE(32))
    const pathBytesOffset = Number(header.readBigUInt64LE(40))
    const metadataOffset = Number(header.readBigUInt64LE(48))
    const count = Math.min(recordCount, limit)
    if (
      !Number.isFinite(count) ||
      count <= 0 ||
      pathOffsetsOffset <= 0 ||
      pathBytesOffset <= 0 ||
      metadataOffset <= pathBytesOffset
    ) {
      return out
    }

    const offsets = readExact(fd, pathOffsetsOffset, (count + 1) * 8)
    if (offsets.length < (count + 1) * 8) return out
    const requestedPathBytes = Number(offsets.readBigUInt64LE(count * 8))
    const maxPathBytes = Math.max(0, metadataOffset - pathBytesOffset)
    const pathBytesLength = Math.min(requestedPathBytes, maxPathBytes)
    if (!Number.isFinite(pathBytesLength) || pathBytesLength <= 0) return out
    const pathBytes = readExact(fd, pathBytesOffset, pathBytesLength)

    for (let i = 0; i < count; i++) {
      const rel = Number(offsets.readBigUInt64LE(i * 8))
      if (!Number.isFinite(rel) || rel < 0 || rel >= pathBytes.length) continue
      const p = readCString(pathBytes, rel)
      if (p) out.push(p)
    }
  } catch {
    /* ignore invalid segment */
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore close failure */
      }
    }
  }
  return out
}

function collectManifestPaths(limit: number): CandidateCollection {
  const paths: string[] = []
  let truncated = false
  const root = path.join(app.getPath('userData'), 'image-search-index')
  const manifestPath = path.join(root, 'manifest.json')
  let rawManifest: string
  try {
    rawManifest = fs.readFileSync(manifestPath, 'utf8')
  } catch {
    // No manifest: the Native index was never built (or was removed). This
    // absent state is the legacy "no scope" case, distinct from corruption.
    return { paths, truncated, scopeState: 'absent' }
  }
  const corrupt = (): CandidateCollection => {
    // A manifest that exists but cannot be parsed (or has an invalid shape)
    // must never silently widen the search to the full library (VAL-036).
    console.warn(
      '[semantic-scope] Native image search index manifest is corrupted; scope fails closed:',
      manifestPath,
    )
    return { paths: [], truncated: false, scopeState: 'corrupt' }
  }
  let manifest: { segments?: { file?: string }[] }
  try {
    manifest = JSON.parse(rawManifest) as { segments?: { file?: string }[] }
  } catch {
    return corrupt()
  }
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    (manifest.segments !== undefined && !Array.isArray(manifest.segments))
  ) {
    return corrupt()
  }
  try {
    const normalize = (value: string) =>
      value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
    let deleted = new Set<string>()
    try {
      const overlay = JSON.parse(fs.readFileSync(path.join(root, 'overlay.json'), 'utf8')) as {
        deleted?: string[]
      }
      deleted = new Set((overlay.deleted || []).map(normalize))
    } catch {
      /* no overlay */
    }
    const seen = new Set<string>()
    for (const seg of manifest.segments || []) {
      if (paths.length >= limit) {
        truncated = true
        break
      }
      if (!seg.file) continue
      const segPath = path.resolve(root, seg.file)
      const remaining = limit - paths.length
      for (const candidatePath of readSegmentPaths(segPath, remaining)) {
        const key = normalize(candidatePath)
        if (deleted.has(key) || seen.has(key)) continue
        seen.add(key)
        paths.push(candidatePath)
        if (paths.length >= limit) break
      }
      if (paths.length >= limit) truncated = true
    }
  } catch {
    /* segment reads are individually tolerant; an unreadable segment yields no paths */
  }
  return { paths, truncated, scopeState: paths.length > 0 ? 'ready' : 'valid-empty' }
}

function collectCandidatePaths(limit = MAX_SEMANTIC_CANDIDATES): CandidateCollection {
  const collected = collectManifestPaths(limit)
  const mapped = collected.paths.flatMap((candidatePath) => {
    const project = getProjectSearchMetadata(candidatePath)
    if (project) return [project.sourcePath]
    return isProjectPreviewProxy(candidatePath) ? [] : [candidatePath]
  })
  const deduped = [...new Set(mapped)].filter((p) => /^[A-Za-z]:[\\/]/.test(p))
  return {
    paths: deduped.slice(0, limit),
    truncated: collected.truncated || deduped.length > limit,
    scopeState:
      collected.paths.length > 0 && deduped.length === 0 ? 'valid-empty' : collected.scopeState,
  }
}

function hashText(input: string): number {
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function sampleCandidates(paths: string[], limit: number, salt = ''): string[] {
  if (paths.length <= limit) return paths
  const result: string[] = []
  let seed = hashText(salt || 'semantic')
  const used = new Set<number>()
  for (let i = 0; i < limit; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    let idx = seed % paths.length
    while (used.has(idx)) {
      idx = (idx + 1) % paths.length
    }
    used.add(idx)
    result.push(paths[idx])
  }
  return result
}

function getPreferredClipDevice(): ClipDevice {
  try {
    const settingsPath = path.join(app.getPath('userData'), 'vector-settings.json')
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { backend?: string }
    if (settings.backend === 'gpu') return process.platform === 'win32' ? 'dml' : 'gpu'
  } catch {
    /* default CPU */
  }
  return 'cpu'
}

function getClipEmbeddingFilePaths(): string[] {
  return getEmbeddingStorePaths(CLIP_EMBEDDING_MODEL, 'global')
}

function getVectorDbDir(): string {
  return path.join(app.getPath('userData'), 'vector-db')
}

function getClipEmbeddingCacheDir(): string {
  return path.join(getVectorDbDir(), 'embedding-cache')
}

async function ensureClipEmbeddingCache(
  sourcePaths: string[],
  onProgress?: SemanticProgressCallback,
  requestId?: string,
  startedAt = Date.now(),
): Promise<EmbeddingF16CacheHandle | null> {
  return ensureEmbeddingF16Cache({
    cacheDir: getClipEmbeddingCacheDir(),
    modelName: CLIP_EMBEDDING_MODEL,
    embeddingType: 'global',
    dim: CLIP_EMBEDDING_DIM,
    sourcePaths,
    onProgress: (progress) =>
      onProgress?.(
        applySemanticMetrics(
          {
            requestId,
            phase: 'scanning',
            scanned: progress.current,
            total: progress.total,
            percent: progress.percent,
            message: progress.message,
          },
          startedAt,
        ),
      ),
  })
}

/**
 * Prepares the shared CLIP cache and keeps the full handle available to callers
 * that also need its immutable row metadata (for example the ANN candidate path).
 */
export async function prepareClipEmbeddingF16Cache(
  onProgress?: ClipFeedbackTargetSearchOptions['onProgress'],
): Promise<EmbeddingF16CacheHandle> {
  const embeddingPaths = getClipEmbeddingFilePaths()
  if (embeddingPaths.length === 0) throw new Error('No CLIP embeddings found. Build CLIP first.')
  const cache = await ensureClipEmbeddingCache(embeddingPaths, (progress) => {
    onProgress?.({
      current: progress.scanned,
      total: progress.total || 0,
      percent: progress.percent || 0,
      message: progress.message || 'Preparing CLIP search cache...',
    })
  })
  if (!cache || cache.meta.count <= 0) throw new Error('CLIP search cache is empty')
  return cache
}

/** Returns only the read-only filesystem descriptor needed by compute workers. */
export async function prepareClipEmbeddingCache(
  onProgress?: ClipFeedbackTargetSearchOptions['onProgress'],
): Promise<PreparedClipEmbeddingCache> {
  return preparedClipEmbeddingCacheFromHandle(await prepareClipEmbeddingF16Cache(onProgress))
}

function getClipTextModelRoot(): string {
  const modelRoot = getInstalledModelDir(CLIP_EMBEDDING_MODEL)
  if (!modelRoot) {
    throw new Error(
      'CLIP text model is not installed or is incomplete. Open Settings > Models and download or repair CLIP ViT-B/32.',
    )
  }
  return modelRoot
}

export function isClipTextModelAvailable(): boolean {
  return getInstalledModelDir(CLIP_EMBEDDING_MODEL) !== null
}

export async function disposeSemanticSearchModels(): Promise<void> {
  const pending = [
    ...clipTextModelPromises.values(),
    ...zeroShotClassifierPromises.values(),
  ] as Promise<DisposableTransformersRuntime>[]
  clipTextModelPromises.clear()
  zeroShotClassifierPromises.clear()
  clipTokenizerPromise = null

  const settled = await Promise.allSettled(pending)
  const runtimes = new Set<DisposableTransformersRuntime>()
  for (const result of settled) {
    if (result.status === 'fulfilled') runtimes.add(result.value)
  }
  await Promise.allSettled(
    [...runtimes].map(async (runtime) => {
      await runtime.dispose?.()
    }),
  )
}

async function configureClipTransformers(): Promise<ClipTransformersModule> {
  const modelRoot = getClipTextModelRoot()
  const transformers =
    (await import('@huggingface/transformers')) as unknown as ClipTransformersModule
  transformers.env.localModelPath = modelRoot
  transformers.env.cacheDir = path.join(modelRoot, '.transformers-cache')
  transformers.env.allowLocalModels = true
  transformers.env.allowRemoteModels = false
  return transformers
}

async function getClipTokenizer(): Promise<ClipTokenizer> {
  if (!clipTokenizerPromise) {
    clipTokenizerPromise = (async () => {
      const { AutoTokenizer } = await configureClipTransformers()
      return AutoTokenizer.from_pretrained('Xenova/clip-vit-base-patch32')
    })().catch((err) => {
      clipTokenizerPromise = null
      throw err
    })
  }
  return clipTokenizerPromise
}

async function getClipTextModel(device: ClipDevice): Promise<ClipTextModel> {
  if (!clipTextModelPromises.has(device)) {
    const promise = (async () => {
      const { CLIPTextModelWithProjection } = await configureClipTransformers()
      return CLIPTextModelWithProjection.from_pretrained('Xenova/clip-vit-base-patch32', {
        dtype: 'q4',
        device,
      })
    })().catch(async (err) => {
      clipTextModelPromises.delete(device)
      if (device !== 'cpu') return getClipTextModel('cpu')
      throw err
    })
    clipTextModelPromises.set(device, promise)
  }
  return clipTextModelPromises.get(device)!
}

function normalizeVector(vec: unknown, expectedDim = CLIP_EMBEDDING_DIM): number[] {
  return requireNormalizedEmbeddingVector(vec, expectedDim)
}

export async function getClipTextEmbeddings(texts: string[]): Promise<Map<string, number[]>> {
  const uniqueTexts = [...new Set(texts.map((text) => text.trim()).filter(Boolean))]
  const result = new Map<string, number[]>()
  if (uniqueTexts.length === 0) return result
  const tokenizer = await getClipTokenizer()
  const model = await getClipTextModel(getPreferredClipDevice())
  const prompts = uniqueTexts.flatMap((text) => [`a photo of ${text}`, text])
  const inputs = tokenizer(prompts, { padding: true, truncation: true })
  const output = await model(inputs)
  const data = output?.text_embeds?.data
  const dims = output?.text_embeds?.dims
  if (!data || !Array.isArray(dims) || dims.length < 2) {
    throw new Error('CLIP returned no text embedding data')
  }
  const rows = dims[0]
  const dim = dims[1]
  if (
    !Number.isInteger(rows) ||
    rows !== prompts.length ||
    !Number.isInteger(dim) ||
    dim !== CLIP_EMBEDDING_DIM
  ) {
    throw new Error(`CLIP returned invalid text embedding dimensions: ${dims.join('x')}`)
  }
  if (data.length !== rows * dim) {
    throw new Error(`CLIP returned ${data.length} text values for ${rows}x${dim} embeddings`)
  }
  for (let index = 0; index < data.length; index++) {
    const value: unknown = data[index]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`CLIP text embedding component ${index} is not finite`)
    }
  }
  const values = Array.from(data as ArrayLike<number>)
  for (let textIndex = 0; textIndex < uniqueTexts.length; textIndex++) {
    const pooled = new Array(dim).fill(0)
    const firstRow = textIndex * 2
    const rowCount = 2
    for (let offset = 0; offset < rowCount; offset++) {
      const base = (firstRow + offset) * dim
      const vec = normalizeVector(values.slice(base, base + dim), dim)
      for (let i = 0; i < dim; i++) pooled[i] += vec[i]
    }
    for (let i = 0; i < dim; i++) pooled[i] /= rowCount
    result.set(uniqueTexts[textIndex], normalizeVector(pooled, dim))
  }
  return result
}

export async function getClipTextEmbedding(text: string): Promise<number[]> {
  return (await getClipTextEmbeddings([text])).get(text.trim()) || []
}

// ── Query text encoder routing (English CLIP / multilingual CLIP) ──
// Both encoders emit 512-d vectors in the same CLIP ViT-B/32 space, so all
// downstream comparison/rerank code is encoder-agnostic. Routing rule: the
// `textEncoder` vector setting selects the encoder; 'auto' routes queries
// containing CJK characters to the multilingual encoder. If the multilingual
// model is missing or fails to load, queries fall back to the English tower
// (recorded in the diagnostic below) instead of failing the search.

export interface QueryTextEncoderDiagnostic {
  encoder: TextEncoderKind
  multilingualFallback: boolean
  expansions: Array<{ text: string; gloss: string }>
}

let lastQueryTextEncoderDiagnostic: QueryTextEncoderDiagnostic = {
  encoder: 'english',
  multilingualFallback: false,
  expansions: [],
}

export function getLastQueryTextEncoderDiagnostic(): QueryTextEncoderDiagnostic {
  return lastQueryTextEncoderDiagnostic
}

function getTextEncoderSetting(): TextEncoderSetting {
  try {
    const settingsPath = path.join(app.getPath('userData'), 'vector-settings.json')
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      textEncoder?: unknown
    }
    return normalizeTextEncoderSetting(settings.textEncoder)
  } catch {
    return 'auto'
  }
}

// ── Bilingual query expansion ──
// Narrow-intent Chinese words (游戏/色图/动漫...) map too generically in the
// distilled multilingual tower. Exact lexicon hits are fused with the English
// CLIP embedding of their gloss (same 512-d space, validated on the real
// library 2026-07-27). Users extend the lexicon via userData/query-lexicon.json.

let queryLexiconCache: { mtimeMs: number; lexicon: Record<string, string> } | null = null

function getQueryLexicon(): Record<string, string> {
  const lexiconPath = path.join(app.getPath('userData'), 'query-lexicon.json')
  try {
    const stat = fs.statSync(lexiconPath)
    if (!queryLexiconCache || queryLexiconCache.mtimeMs !== stat.mtimeMs) {
      const parsed = JSON.parse(fs.readFileSync(lexiconPath, 'utf8')) as unknown
      queryLexiconCache = { mtimeMs: stat.mtimeMs, lexicon: mergeQueryLexicon(parsed) }
    }
    return queryLexiconCache.lexicon
  } catch {
    if (!queryLexiconCache) {
      queryLexiconCache = { mtimeMs: 0, lexicon: mergeQueryLexicon(null) }
    }
    return queryLexiconCache.lexicon
  }
}

function fuseEmbeddingPair(base: number[], gloss: number[]): number[] {
  const normalizedBase = normalizeVector(base)
  const normalizedGloss = normalizeVector(gloss)
  const fused = new Array(CLIP_EMBEDDING_DIM).fill(0)
  for (let i = 0; i < fused.length; i++) {
    fused[i] = (normalizedBase[i] + normalizedGloss[i]) / 2
  }
  return normalizeVector(fused)
}

export async function getQueryTextEmbeddings(texts: string[]): Promise<Map<string, number[]>> {
  const setting = getTextEncoderSetting()
  const uniqueTexts = [...new Set(texts.map((text) => text.trim()).filter(Boolean))]
  const multilingualSet = new Set(
    uniqueTexts.filter((text) => resolveTextEncoderChoice(text, setting) === 'multilingual'),
  )
  const result = new Map<string, number[]>()
  let encoder: TextEncoderKind = multilingualSet.size > 0 ? 'multilingual' : 'english'
  let multilingualFallback = false

  if (multilingualSet.size > 0) {
    const multilingualTexts = uniqueTexts.filter((text) => multilingualSet.has(text))
    try {
      if (!isMultilingualTextEncoderAvailable()) {
        throw new Error('multilingual text encoder model is not installed')
      }
      const embeddings = await getMultilingualTextEmbeddings(multilingualTexts)
      for (const [text, vector] of embeddings) result.set(text, normalizeVector(vector))
    } catch {
      multilingualFallback = true
      const embeddings = await getClipTextEmbeddings(multilingualTexts)
      for (const [text, vector] of embeddings) result.set(text, normalizeVector(vector))
    }
  }

  // Lexicon expansion: fuse multilingual embedding with the English-CLIP
  // embedding of the gloss. Skipped when the multilingual tower fell back
  // (both sides would be the same English-tower embedding).
  const expansions: Array<{ text: string; gloss: string }> = []
  if (!multilingualFallback && multilingualSet.size > 0) {
    const lexicon = getQueryLexicon()
    const expandable = uniqueTexts.filter((text) => {
      if (!multilingualSet.has(text) || !result.has(text)) return false
      const gloss = lookupQueryGloss(lexicon, text)
      if (gloss) expansions.push({ text, gloss })
      return !!gloss
    })
    if (expandable.length > 0) {
      const glossEmbeddings = await getClipTextEmbeddings(
        expansions.map((expansion) => expansion.gloss),
      )
      for (const expansion of expansions) {
        const base = result.get(expansion.text)
        const glossVector = glossEmbeddings.get(expansion.gloss)
        if (base && glossVector && base.length === glossVector.length) {
          result.set(expansion.text, fuseEmbeddingPair(base, glossVector))
        }
      }
    }
  }

  const englishTexts = uniqueTexts.filter((text) => !multilingualSet.has(text))
  if (englishTexts.length > 0) {
    const embeddings = await getClipTextEmbeddings(englishTexts)
    for (const [text, vector] of embeddings) result.set(text, normalizeVector(vector))
  }

  if (multilingualFallback) encoder = 'english'
  lastQueryTextEncoderDiagnostic = { encoder, multilingualFallback, expansions }
  return result
}

export async function getQueryTextEmbedding(text: string): Promise<number[]> {
  return (await getQueryTextEmbeddings([text])).get(text.trim()) || []
}

type QueryTextEmbeddingProvider = (text: string) => Promise<number[]>
let queryTextEmbeddingProvider: QueryTextEmbeddingProvider = getQueryTextEmbedding

/** Test hook: substitutes the CLIP text encoder so scope fixtures stay hermetic. */
export function setSemanticQueryTextEmbeddingProviderForTests(
  provider?: QueryTextEmbeddingProvider,
): void {
  queryTextEmbeddingProvider = provider ?? getQueryTextEmbedding
}

export interface ClipPersonSemanticScanOptions {
  isCancelled?: () => boolean
  isEligiblePath?: (filePath: string) => boolean
  onProgress?: (current: number, total: number, matched: number, message: string) => void
  onMatch: (filePath: string, match: SemanticPersonMatch) => void
  minimumHumanScore?: number
  minimumMargin?: number
}

export async function scanClipPersonSemanticGroups(
  options: ClipPersonSemanticScanOptions,
): Promise<{ scanned: number; eligible: number; matched: number; cacheCount: number }> {
  const embeddingPaths = getClipEmbeddingFilePaths()
  if (embeddingPaths.length === 0) throw new Error('Build CLIP embeddings before people groups')
  const cache = await ensureClipEmbeddingCache(embeddingPaths)
  if (!cache || cache.meta.count <= 0) throw new Error('CLIP embedding cache is empty')

  const prompts = [
    ...SEMANTIC_PERSON_HUMAN_PROMPTS,
    ...SEMANTIC_PERSON_NON_HUMAN_PROMPTS,
    ...SEMANTIC_PERSON_CLASSES.flatMap((definition) => definition.prompts),
  ]
  options.onProgress?.(0, cache.meta.count, 0, 'Preparing CLIP people classifier...')
  const textEmbeddings = await getQueryTextEmbeddings(prompts)
  const classifier = buildSemanticPersonClassifier(textEmbeddings)
  let scanned = 0
  let eligible = 0
  let matched = 0
  let currentCount = cache.meta.count
  await streamEmbeddingF16Cache(cache, {
    isCancelled: options.isCancelled,
    onVector: (filePath, vector) => {
      scanned += 1
      if (options.isEligiblePath && !options.isEligiblePath(filePath)) return
      eligible += 1
      const match = classifySemanticPerson(vector, classifier, {
        minimumHumanScore: options.minimumHumanScore,
        minimumMargin: options.minimumMargin,
      })
      if (!match) return
      matched += 1
      options.onMatch(filePath, match)
    },
    onProgress: (progress) => {
      currentCount = progress.total
      options.onProgress?.(
        progress.current,
        progress.total,
        matched,
        `Classifying people: ${progress.current.toLocaleString()}/${progress.total.toLocaleString()} CLIP images; ${matched.toLocaleString()} matched`,
      )
    },
  })
  return { scanned, eligible, matched, cacheCount: currentCount }
}

async function searchClipEmbeddingIndex(
  text: string,
  topK: number,
  feedback: SemanticFeedbackContext,
  onProgress?: SemanticProgressCallback,
  requestId?: string,
  startedAt = Date.now(),
  isCancelled?: () => boolean,
  acceptPathKeys?: ReadonlySet<string>,
): Promise<{
  results: SemanticCandidate[]
  scanned: number
  feedbackApplied: boolean
  feedbackMs: number
  textEncoderDiagnostic?: QueryTextEncoderDiagnostic
}> {
  if (isCancelled?.()) throw new Error('Semantic search cancelled')
  const embeddingPaths = getClipEmbeddingFilePaths()
  if (embeddingPaths.length === 0) {
    return { results: [], scanned: 0, feedbackApplied: false, feedbackMs: 0 }
  }

  onProgress?.(
    applySemanticMetrics(
      {
        requestId,
        phase: 'embedding',
        scanned: 0,
        percent: 0,
        message: 'Preparing CLIP text embedding...',
      },
      startedAt,
    ),
  )
  const query = requireNormalizedEmbeddingVector(
    await queryTextEmbeddingProvider(text),
    CLIP_EMBEDDING_DIM,
  )
  if (isCancelled?.()) throw new Error('Semantic search cancelled')
  const textEncoderDiagnostic = getLastQueryTextEncoderDiagnostic()
  const cache = await ensureClipEmbeddingCache(embeddingPaths, onProgress, requestId, startedAt)
  if (!cache || cache.meta.count <= 0) {
    return { results: [], scanned: 0, feedbackApplied: false, feedbackMs: 0 }
  }
  const feedbackActive = feedback.targets.length > 0
  const candidateK = feedbackActive
    ? Math.max(1000, Math.min(10000, Math.max(topK * 10, topK)))
    : topK
  let scanned: number
  let currentCount = cache.meta.count
  const reportScanProgress = (progress: { scanned: number; total: number; percent: number }) => {
    currentCount = progress.total
    onProgress?.(
      applySemanticMetrics(
        {
          requestId,
          phase: 'scanning',
          scanned: progress.scanned,
          total: progress.total,
          percent: Math.min(99, progress.percent),
          message: `Scanning CLIP cache: ${progress.scanned.toLocaleString()}/${progress.total.toLocaleString()} images`,
        },
        startedAt,
      ),
    )
  }
  if (!feedbackActive) {
    // VAL-028: without feedback reranking the exact scan runs in the semantic
    // vector worker (fused F16 decode + dot product; vectors and scope shared
    // per generation instead of cloned per query). Any worker failure falls
    // back to the in-process reference scan below.
    try {
      const workerScan = await searchSemanticVectorScan(cache, query, candidateK, {
        isCancelled,
        acceptPathKeys: acceptPathKeys && acceptPathKeys.size > 0 ? [...acceptPathKeys] : undefined,
        onProgress: reportScanProgress,
      })
      scanned = workerScan.scanned
      onProgress?.(
        applySemanticMetrics(
          {
            requestId,
            phase: 'done',
            scanned,
            total: currentCount,
            percent: 100,
            message: `CLIP embedding search complete: ${scanned.toLocaleString()} images`,
          },
          startedAt,
        ),
      )
      return {
        results: workerScan.candidates.slice(0, topK),
        scanned,
        feedbackApplied: false,
        feedbackMs: 0,
        textEncoderDiagnostic,
      }
    } catch (error) {
      if (isCancelled?.()) throw error
      console.warn(
        '[semantic-search] CLIP worker scan unavailable; falling back to the in-process scan:',
        errorMessage(error),
      )
    }
  }
  const feedbackPrototypePaths = new Set(
    getFeedbackPrototypePaths(feedback).map((filePath) => embeddingCachePathKey(filePath)),
  )
  const scan = await scanSemanticClipCache(cache, {
    query,
    candidateK,
    acceptPathKeys,
    feedbackPrototypeKeys: feedbackActive ? feedbackPrototypePaths : undefined,
    isCancelled,
    onProgress: reportScanProgress,
  })
  scanned = scan.scanned
  currentCount = scan.total
  const candidateByPath = scan.candidateByPath

  const rerankStartedAt = Date.now()
  if (feedbackActive && candidateByPath.size > 0) {
    onProgress?.(
      applySemanticMetrics(
        {
          requestId,
          phase: 'scanning',
          scanned,
          total: currentCount,
          percent: 99,
          message: `Applying reviewed feedback to ${candidateByPath.size.toLocaleString()} candidates...`,
        },
        startedAt,
      ),
    )
    const vectors = await readEmbeddingF16VectorsForPaths(
      cache,
      [...candidateByPath.values()].map((candidate) => candidate.path),
      { isCancelled },
    )
    let reranked = 0
    for (const candidate of candidateByPath.values()) {
      if (isCancelled?.()) throw new Error('Semantic search cancelled')
      const vector = vectors.get(embeddingCachePathKey(candidate.path))
      if (!vector) continue
      const baseScore = candidate.score
      const feedbackScore = scoreAssetFeedback(vector, feedback, baseScore)
      candidate.baseScore = baseScore
      candidate.feedbackBoost = feedbackScore.boost
      candidate.score = Math.max(0, Math.min(1, baseScore + feedbackScore.boost))
      candidate.reasons.push(...feedbackScore.reasons)
      reranked += 1
      if (reranked % 256 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  const top = [...candidateByPath.values()].sort((a, b) => b.score - a.score).slice(0, topK)
  const feedbackMs = feedbackActive ? Date.now() - rerankStartedAt : 0
  onProgress?.(
    applySemanticMetrics(
      {
        requestId,
        phase: 'done',
        scanned,
        total: currentCount,
        percent: 100,
        message: feedbackActive
          ? `CLIP search complete with reviewed feedback: ${scanned.toLocaleString()} images`
          : `CLIP embedding search complete: ${scanned.toLocaleString()} images`,
      },
      startedAt,
    ),
  )
  return {
    results: top,
    scanned,
    feedbackApplied: feedbackActive,
    feedbackMs,
    textEncoderDiagnostic,
  }
}

async function getZeroShotClassifier(device: ClipDevice): Promise<ZeroShotClassifier> {
  if (!zeroShotClassifierPromises.has(device)) {
    const promise = (async () => {
      const modelRoot = getClipTextModelRoot()
      const { pipeline, env } = await import('@huggingface/transformers')
      env.localModelPath = modelRoot
      env.cacheDir = path.join(modelRoot, 'clip-zero-shot-cache')
      env.allowLocalModels = true
      env.allowRemoteModels = false
      return (await pipeline('zero-shot-image-classification', 'Xenova/clip-vit-base-patch32', {
        dtype: 'q4',
        device,
      })) as ZeroShotClassifier
    })().catch((err) => {
      zeroShotClassifierPromises.delete(device)
      throw err
    })
    zeroShotClassifierPromises.set(device, promise)
  }
  return zeroShotClassifierPromises.get(device)!
}

async function classifyWithFallback(
  preferredDevice: ClipDevice,
  image: string,
  labels: string[],
): Promise<{ output: { label: string; score: number }[]; device: ClipDevice }> {
  try {
    const classifier = await getZeroShotClassifier(preferredDevice)
    const output = await classifier(image, labels, {
      hypothesis_template: 'a photo of {}',
    })
    return { output, device: preferredDevice }
  } catch (err) {
    if (preferredDevice === 'cpu') throw err
    zeroShotClassifierPromises.delete(preferredDevice)
    const classifier = await getZeroShotClassifier('cpu')
    const output = await classifier(image, labels, {
      hypothesis_template: 'a photo of {}',
    })
    return { output, device: 'cpu' }
  }
}

function buildClipPositiveLabels(text: string): string[] {
  const labels = new Set<string>()
  const ascii = normalizeText(text)
    .match(/[a-z0-9][a-z0-9 ]{0,40}/)?.[0]
    ?.trim()
  if (ascii) labels.add(ascii)

  for (const token of tokenize(text)) {
    const mapped = CLIP_LABELS[token]
    if (mapped) labels.add(mapped)
    const synonymLabels = SYNONYMS[token]
    if (synonymLabels) {
      for (const label of synonymLabels) {
        if (/^[a-z][a-z ]{1,40}$/.test(label)) labels.add(label)
      }
    }
  }

  if (labels.size === 0) labels.add(text)
  return [...labels].slice(0, 4)
}

function buildClipLabels(positiveLabels: string[]): string[] {
  const labels = new Set<string>()
  for (const label of positiveLabels) labels.add(label)
  for (const label of CLIP_DISTRACTOR_LABELS) {
    if (!positiveLabels.includes(label)) labels.add(label)
  }
  return [...labels].slice(0, 20)
}

async function scoreWithClipZeroShot(
  text: string,
  candidates: string[],
  topK: number,
): Promise<SemanticCandidate[]> {
  const preferredDevice = getPreferredClipDevice()
  const positiveLabels = buildClipPositiveLabels(text)
  const labels = buildClipLabels(positiveLabels)
  const sampleLimit = Math.min(
    candidates.length,
    MAX_CLIP_SAMPLE_HARD_LIMIT,
    Math.max(MAX_CLIP_SAMPLE, topK),
  )
  const sampled = sampleCandidates(candidates, sampleLimit, text)
  const scored: SemanticCandidate[] = []

  for (const filePath of sampled) {
    try {
      const inputPath = resolveProjectSearchInputPath(filePath)
      if (!fs.existsSync(inputPath)) continue
      const classified = await classifyWithFallback(preferredDevice, inputPath, labels)
      const output = classified.output
      const deviceLabel = classified.device.toUpperCase()
      const sorted = Array.isArray(output)
        ? [...output].sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
        : []
      const top = sorted[0]
      const bestPositive = Math.max(
        0,
        ...sorted.filter((x) => positiveLabels.includes(x.label)).map((x) => Number(x.score || 0)),
      )
      const bestOther = Math.max(
        0,
        ...sorted.filter((x) => !positiveLabels.includes(x.label)).map((x) => Number(x.score || 0)),
      )
      const margin = bestPositive - bestOther
      const isPositiveTop = !!top && positiveLabels.includes(top.label)
      if (isPositiveTop && bestPositive >= 0.05 && margin >= 0.01) {
        scored.push({
          path: filePath,
          score: Math.max(0, bestPositive + Math.max(0, margin) * 0.5),
          reasons: [
            `CLIP ${deviceLabel} visual semantic match ${top.label} ${bestPositive.toFixed(2)} margin ${margin.toFixed(2)}`,
          ],
        })
      }
    } catch {
      /* skip unreadable image */
    }
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, topK)
}

function scorePath(
  filePath: string,
  queryTokens: string[],
  expandedTokens: string[],
): SemanticCandidate {
  const basename = path.basename(filePath)
  const ext = path.extname(filePath).slice(1).toLowerCase()
  const dir = path.dirname(filePath)
  const haystack = normalizeText(`${basename} ${dir} ${ext}`)
  const nameOnly = normalizeText(path.basename(filePath, path.extname(filePath)))
  const reasons: string[] = []
  let score = 0
  let matchedQueryTokens = 0

  for (const token of queryTokens) {
    if (nameOnly.includes(token)) {
      score += 0.42
      matchedQueryTokens++
      reasons.push(`filename match ${token}`)
    } else if (haystack.includes(token)) {
      score += 0.2
      matchedQueryTokens++
      reasons.push(`path match ${token}`)
    }
  }

  for (const token of expandedTokens) {
    if (queryTokens.includes(token)) continue
    if (nameOnly.includes(token)) score += 0.16
    else if (haystack.includes(token)) score += 0.08
  }

  if (queryTokens.includes(ext)) score += 0.12
  if (matchedQueryTokens > 1) score += Math.min(0.22, matchedQueryTokens * 0.06)
  if (queryTokens.length > 0) score += (matchedQueryTokens / queryTokens.length) * 0.2

  return {
    path: filePath,
    score: Math.max(0, Math.min(1, score)),
    reasons: [...new Set(reasons)].slice(0, 4),
  }
}

function determineSemanticMatch(score: number): MatchLevel {
  if (score >= 0.85) return 'same_product'
  if (score >= 0.55) return 'similar_product'
  return 'weak'
}

export async function searchSemanticImages(
  req: SemanticSearchRequest,
  onProgress?: SemanticProgressCallback,
): Promise<SemanticSearchResponse> {
  const t0 = Date.now()
  const text = typeof req.text === 'string' ? req.text.trim() : ''
  const topK = Math.max(1, Math.min(1000, Math.floor(req.topK || 50)))
  const queryTokens = tokenize(text)
  const expandedTokens = expandQueryTokens(queryTokens)
  const collected = collectCandidatePaths()
  const candidates = collected.paths
  const candidatePathKeys = buildSemanticPathScope(candidates)
  const degradationReasons: string[] = []
  onProgress?.(
    applySemanticMetrics(
      {
        requestId: req.requestId,
        phase: 'preparing',
        scanned: 0,
        percent: 0,
        message: 'Preparing semantic search...',
      },
      t0,
    ),
  )

  if (collected.truncated) {
    degradationReasons.push(
      `Semantic candidate set capped at ${MAX_SEMANTIC_CANDIDATES.toLocaleString()} indexed images.`,
    )
  }

  if (!text || queryTokens.length === 0) {
    return {
      results: [],
      query: text,
      totalCandidates: candidates.length,
      matchedCandidates: 0,
      returnedCount: 0,
      fallbackCount: 0,
      totalMs: Date.now() - t0,
      degraded: true,
      degradationReasons: [...degradationReasons, 'Semantic query text is empty.'],
      searchMode: 'semantic',
    }
  }

  // VAL-036 fail-closed: a corrupted Native scope is not proof of an empty
  // index, so the search must not silently widen to the full CLIP library.
  if (collected.scopeState === 'corrupt') {
    return {
      results: [],
      query: text,
      totalCandidates: 0,
      matchedCandidates: 0,
      returnedCount: 0,
      fallbackCount: 0,
      totalMs: Date.now() - t0,
      degraded: true,
      degradationReasons: [
        ...degradationReasons,
        'Native image search index is corrupted; semantic search was not widened to the full CLIP library. Rebuild or clear the Native index to restore scoped search.',
      ],
      searchMode: 'semantic',
    }
  }

  const feedbackContext = await getSemanticFeedbackContext(text, req.feedbackMode || 'auto')
  if (req.isCancelled?.()) throw new Error('Semantic search cancelled')
  try {
    const clipSearch = await searchClipEmbeddingIndex(
      text,
      topK,
      feedbackContext,
      onProgress,
      req.requestId,
      t0,
      req.isCancelled,
      candidatePathKeys,
    )
    if (clipSearch.scanned > 0) {
      const scopedClipResults = filterSemanticVectorCandidates(
        clipSearch.results,
        candidatePathKeys,
      )
      const results: LayeredSearchResult[] = scopedClipResults.map((candidate) => {
        let stat: fs.Stats | null = null
        try {
          stat = fs.statSync(candidate.path)
        } catch {
          // The file may disappear between candidate collection and result mapping.
        }
        const finalScore = Math.round(candidate.score * 1000) / 1000
        const vectorScore = Math.round((candidate.baseScore ?? candidate.score) * 1000) / 1000
        return {
          imageId: candidate.path,
          path: candidate.path,
          finalScore,
          hashScore: 0,
          vectorScore,
          colorScore: 0,
          shapeScore: 0,
          localFeatureScore: 0,
          ocrScore: 0,
          ...(candidate.feedbackBoost !== undefined
            ? { feedbackBoost: Math.round(candidate.feedbackBoost * 1000) / 1000 }
            : {}),
          matchLevel: determineSemanticMatch(finalScore),
          reasons: candidate.reasons,
          indexSources: ['clip_embedding'],
          fileSize: stat?.size,
          modifiedTime: stat?.mtimeMs,
        }
      })
      return {
        results,
        query: text,
        totalCandidates: clipSearch.scanned,
        matchedCandidates: scopedClipResults.length,
        returnedCount: results.length,
        fallbackCount: 0,
        totalMs: Date.now() - t0,
        degraded: degradationReasons.length > 0,
        degradationReasons: [
          ...degradationReasons,
          ...(candidatePathKeys.size === 0
            ? [
                collected.scopeState === 'absent'
                  ? 'No Native image index found; searched the existing CLIP vector database directly.'
                  : 'Hash image index is empty; searched the existing CLIP vector database directly.',
              ]
            : []),
          `Using full CLIP embedding semantic search over ${clipSearch.scanned.toLocaleString()} images.`,
          ...(clipSearch.textEncoderDiagnostic?.multilingualFallback
            ? [
                'Multilingual text encoder unavailable; query fell back to the English CLIP text encoder.',
              ]
            : clipSearch.textEncoderDiagnostic?.encoder === 'multilingual'
              ? ['Using multilingual text encoder (clip-ViT-B-32-multilingual-v1) for this query.']
              : []),
          ...(clipSearch.feedbackApplied
            ? [
                `Applied reviewed feedback model r${feedbackContext.builtRevision} for ${feedbackContext.targets.map((target) => target.target.name).join(', ')}.`,
              ]
            : []),
        ],
        searchMode: 'semantic',
        textEncoderUsed: clipSearch.textEncoderDiagnostic?.encoder,
        feedbackApplied: clipSearch.feedbackApplied,
        feedbackRevision: feedbackContext.revision,
        feedbackBuiltRevision: feedbackContext.builtRevision,
        feedbackStale: feedbackContext.stale,
        feedbackMs: clipSearch.feedbackMs,
        feedbackTargets: feedbackContext.targets.map((activation) => ({
          kind: activation.target.kind,
          id: activation.target.id,
          name: activation.target.name,
          gate: activation.gate,
        })),
      }
    }
    degradationReasons.push(
      'No CLIP image embeddings found. Build CLIP embeddings for full semantic search.',
    )
  } catch (err: unknown) {
    if (req.isCancelled?.()) throw err
    degradationReasons.push(`CLIP embedding semantic search unavailable: ${errorMessage(err)}`)
  }

  if (req.isCancelled?.()) throw new Error('Semantic search cancelled')

  const matched = candidates
    .map((filePath) => scorePath(filePath, queryTokens, expandedTokens))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
  const scored = matched.slice(0, topK)
  onProgress?.(
    applySemanticMetrics(
      {
        requestId: req.requestId,
        phase: 'fallback',
        scanned: candidates.length,
        total: candidates.length,
        percent: 100,
        message: `Filename/path semantic scan complete: ${candidates.length.toLocaleString()} images`,
      },
      t0,
    ),
  )

  let finalScored = scored
  let fallbackCount = 0
  if (scored.length < topK && candidates.length > 0) {
    try {
      onProgress?.(
        applySemanticMetrics(
          {
            requestId: req.requestId,
            phase: 'fallback',
            scanned: candidates.length,
            total: candidates.length,
            percent: 100,
            message: 'Running CLIP fallback classification...',
          },
          t0,
        ),
      )
      const existing = new Set(scored.map((candidate) => candidate.path))
      const clipScored = await scoreWithClipZeroShot(text, candidates, topK - scored.length)
      fallbackCount = clipScored.filter((candidate) => !existing.has(candidate.path)).length
      finalScored = [...scored, ...clipScored.filter((candidate) => !existing.has(candidate.path))]
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
      degradationReasons.push(
        scored.length === 0
          ? `Filename/path had no hits. Used CLIP ${getPreferredClipDevice().toUpperCase()} fallback over ${Math.min(candidates.length, MAX_CLIP_SAMPLE_HARD_LIMIT, Math.max(MAX_CLIP_SAMPLE, topK))} sampled images.`
          : `Filename/path matched ${matched.length} candidates and returned ${scored.length}/${topK}. Added ${fallbackCount} CLIP ${getPreferredClipDevice().toUpperCase()} fallback result(s).`,
      )
    } catch (err: unknown) {
      degradationReasons.push(`CLIP semantic search unavailable: ${errorMessage(err)}`)
    }
  } else {
    degradationReasons.push('Using filename/path semantic search.')
  }

  const results: LayeredSearchResult[] = finalScored.map((candidate) => {
    let stat: fs.Stats | null = null
    try {
      stat = fs.statSync(candidate.path)
    } catch {
      // The file may disappear between candidate collection and result mapping.
    }
    const finalScore = Math.round(candidate.score * 1000) / 1000
    return {
      imageId: candidate.path,
      path: candidate.path,
      finalScore,
      hashScore: 0,
      vectorScore: 0,
      colorScore: 0,
      shapeScore: 0,
      localFeatureScore: 0,
      ocrScore: 0,
      matchLevel: determineSemanticMatch(finalScore),
      reasons: candidate.reasons.length > 0 ? candidate.reasons : ['semantic text matched path'],
      indexSources: ['semantic_text'],
      fileSize: stat?.size,
      modifiedTime: stat?.mtimeMs,
    }
  })

  return {
    results,
    query: text,
    totalCandidates: candidates.length,
    matchedCandidates: matched.length,
    returnedCount: results.length,
    fallbackCount,
    totalMs: Date.now() - t0,
    degraded: degradationReasons.length > 0,
    degradationReasons,
    searchMode: 'semantic',
  }
}
