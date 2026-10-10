import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type {
  UnifiedSearchFeedbackKind,
  UnifiedSearchFeedbackMutationResult,
  UnifiedSearchFeedbackRequest,
  UnifiedSearchRankingFeedback,
  UnifiedSearchRequest,
  UnifiedSearchResultItem,
} from '../shared/ipc/unified-search'

const STORE_VERSION = 1
const MAX_RECORDS = 10_000
const MAX_INCORRECT_TIMESTAMPS = 16

interface UnifiedSearchFeedbackRecord {
  id: string
  queryKey: string
  fileEntryId: string
  assetId?: string
  videoId?: string
  kind: UnifiedSearchFeedbackKind
  timestampMs?: number
  createdAt: number
}

interface UnifiedSearchFeedbackFile {
  version: typeof STORE_VERSION
  revision: number
  records: UnifiedSearchFeedbackRecord[]
}

function stableSubject(request: UnifiedSearchRequest): object | undefined {
  if (!request.subject) return undefined
  return {
    x: Math.round(request.subject.x),
    y: Math.round(request.subject.y),
    w: Math.round(request.subject.w),
    h: Math.round(request.subject.h),
    label: request.subject.label.trim().slice(0, 80),
  }
}

function referenceFingerprint(referenceImagePath: string | undefined): string | undefined {
  if (!referenceImagePath) return undefined
  return crypto
    .createHash('sha256')
    .update(referenceImagePath.replace(/\//g, '\\').toLowerCase())
    .digest('hex')
}

/** Query text and absolute paths are hashed before persistence. */
export function unifiedSearchFeedbackQueryKey(request: UnifiedSearchRequest): string {
  const normalized = {
    query: request.query?.normalize('NFKC').trim().toLowerCase().slice(0, 2_000) ?? '',
    reference: referenceFingerprint(request.referenceImagePath),
    subject: stableSubject(request),
  }
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

function isFeedbackKind(value: unknown): value is UnifiedSearchFeedbackKind {
  return value === 'relevant' || value === 'irrelevant' || value === 'timestamp-wrong'
}

function boundedIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().slice(0, 512)
  return normalized || undefined
}

function normalizeRecord(value: unknown): UnifiedSearchFeedbackRecord | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Partial<UnifiedSearchFeedbackRecord>
  const id = boundedIdentifier(record.id)
  const queryKey = boundedIdentifier(record.queryKey)
  const fileEntryId = boundedIdentifier(record.fileEntryId)
  if (!id || !queryKey || !fileEntryId || !isFeedbackKind(record.kind)) return undefined
  const createdAt = Number(record.createdAt)
  if (!Number.isFinite(createdAt) || createdAt <= 0) return undefined
  const timestampMs = Number(record.timestampMs)
  return {
    id,
    queryKey,
    fileEntryId,
    ...(boundedIdentifier(record.assetId) ? { assetId: boundedIdentifier(record.assetId) } : {}),
    ...(boundedIdentifier(record.videoId) ? { videoId: boundedIdentifier(record.videoId) } : {}),
    kind: record.kind,
    ...(Number.isFinite(timestampMs) && timestampMs >= 0
      ? { timestampMs: Math.floor(timestampMs) }
      : {}),
    createdAt,
  }
}

function recordMatchesItem(
  record: UnifiedSearchFeedbackRecord,
  item: UnifiedSearchResultItem,
): boolean {
  if (record.assetId && item.assetId && record.assetId === item.assetId) return true
  return record.fileEntryId === item.fileEntryId
}

function projectRankingFeedback(
  records: readonly UnifiedSearchFeedbackRecord[],
): UnifiedSearchRankingFeedback | undefined {
  if (!records.length) return undefined
  const ordered = [...records].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  )
  const sentiment = ordered
    .filter((record) => record.kind === 'relevant' || record.kind === 'irrelevant')
    .at(-1)
  const incorrectTimestamps = [
    ...new Set(
      ordered
        .filter((record) => record.kind === 'timestamp-wrong' && record.timestampMs !== undefined)
        .map((record) => record.timestampMs!),
    ),
  ].slice(-MAX_INCORRECT_TIMESTAMPS)
  const timestampPenalty = Math.min(0.24, incorrectTimestamps.length * 0.08)
  const sentimentAdjustment =
    sentiment?.kind === 'relevant' ? 0.2 : sentiment?.kind === 'irrelevant' ? -1.25 : 0
  const adjustment =
    Math.round(Math.max(-1.5, Math.min(0.5, sentimentAdjustment - timestampPenalty)) * 1_000) /
    1_000
  const hasWrongTimestamp = incorrectTimestamps.length > 0
  const reason: UnifiedSearchRankingFeedback['reason'] =
    sentiment?.kind === 'relevant'
      ? hasWrongTimestamp
        ? 'relevant-and-timestamp-wrong'
        : 'relevant'
      : sentiment?.kind === 'irrelevant'
        ? hasWrongTimestamp
          ? 'irrelevant-and-timestamp-wrong'
          : 'irrelevant'
        : 'timestamp-wrong'
  return {
    adjustment,
    reason,
    feedbackCount: ordered.length,
    updatedAt: ordered.at(-1)!.createdAt,
    ...(hasWrongTimestamp ? { incorrectTimestamps } : {}),
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

export class UnifiedSearchFeedbackStore {
  private readonly filePath: string
  private records: UnifiedSearchFeedbackRecord[] = []
  private revision = 0
  private mutationMutex: Promise<void> = Promise.resolve()
  private loadError = ''

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, 'search-feedback', 'unified-search.json')
    this.load()
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.filePath, 'utf8'),
      ) as Partial<UnifiedSearchFeedbackFile>
      if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.records)) {
        throw new Error('Unsupported unified search feedback format')
      }
      this.records = parsed.records
        .map(normalizeRecord)
        .filter((record): record is UnifiedSearchFeedbackRecord => Boolean(record))
        .slice(-MAX_RECORDS)
      this.revision = Math.max(0, Math.floor(Number(parsed.revision) || 0))
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error)
    }
  }

  private async persist(): Promise<void> {
    if (this.loadError) throw new Error(`Feedback store needs repair: ${this.loadError}`)
    const snapshot: UnifiedSearchFeedbackFile = {
      version: STORE_VERSION,
      revision: this.revision,
      records: [...this.records],
    }
    await atomicWriteJson(this.filePath, snapshot)
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.mutationMutex.catch(() => {}).then(operation)
    this.mutationMutex = pending.then(
      () => undefined,
      () => undefined,
    )
    return pending
  }

  rankingFor(
    request: UnifiedSearchRequest,
    item: UnifiedSearchResultItem,
  ): UnifiedSearchRankingFeedback | undefined {
    const queryKey = unifiedSearchFeedbackQueryKey(request)
    return projectRankingFeedback(
      this.records.filter(
        (record) => record.queryKey === queryKey && recordMatchesItem(record, item),
      ),
    )
  }

  async submit(
    request: UnifiedSearchFeedbackRequest,
  ): Promise<UnifiedSearchFeedbackMutationResult> {
    const fileEntryId = boundedIdentifier(request.target.fileEntryId)
    if (!fileEntryId || !isFeedbackKind(request.kind)) {
      return { ok: false, error: 'Invalid feedback request' }
    }
    const timestampMs = Number(request.target.timestampMs)
    if (request.kind === 'timestamp-wrong' && (!Number.isFinite(timestampMs) || timestampMs < 0)) {
      return { ok: false, error: 'Timestamp feedback requires a valid hit time' }
    }
    return this.enqueueMutation(async () => {
      if (this.loadError) {
        return { ok: false, error: `Feedback store needs repair: ${this.loadError}` }
      }
      const assetId = boundedIdentifier(request.target.assetId)
      const videoId = boundedIdentifier(request.target.videoId)
      const record: UnifiedSearchFeedbackRecord = {
        id: crypto.randomUUID(),
        queryKey: unifiedSearchFeedbackQueryKey(request.search),
        fileEntryId,
        ...(assetId ? { assetId } : {}),
        ...(videoId ? { videoId } : {}),
        kind: request.kind,
        ...(request.kind === 'timestamp-wrong' ? { timestampMs: Math.floor(timestampMs) } : {}),
        createdAt: Math.max(Date.now(), (this.records.at(-1)?.createdAt ?? 0) + 1),
      }
      this.records = [...this.records, record].slice(-MAX_RECORDS)
      this.revision += 1
      try {
        await this.persist()
        return { ok: true, feedbackId: record.id }
      } catch (error) {
        this.records = this.records.filter((entry) => entry.id !== record.id)
        this.revision = Math.max(0, this.revision - 1)
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  async undo(feedbackId: string): Promise<UnifiedSearchFeedbackMutationResult> {
    const id = boundedIdentifier(feedbackId)
    if (!id) return { ok: false, error: 'Invalid feedback identifier' }
    return this.enqueueMutation(async () => {
      const index = this.records.findIndex((record) => record.id === id)
      if (index < 0) return { ok: false, error: 'Feedback entry no longer exists' }
      const previous = this.records[index]
      this.records = this.records.filter((record) => record.id !== id)
      this.revision += 1
      try {
        await this.persist()
        return { ok: true }
      } catch (error) {
        this.records.splice(index, 0, previous)
        this.revision = Math.max(0, this.revision - 1)
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  /** Test/diagnostic snapshot contains no query text or absolute paths. */
  snapshot(): UnifiedSearchFeedbackFile {
    return { version: STORE_VERSION, revision: this.revision, records: [...this.records] }
  }
}

let feedbackStore: UnifiedSearchFeedbackStore | null = null

export function initUnifiedSearchFeedbackStore(userDataPath: string): UnifiedSearchFeedbackStore {
  feedbackStore = new UnifiedSearchFeedbackStore(userDataPath)
  return feedbackStore
}

export function getUnifiedSearchFeedbackStore(): UnifiedSearchFeedbackStore | null {
  return feedbackStore
}
