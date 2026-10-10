import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import {
  VIDEO_SEMANTIC_SCHEMA_VERSION,
  type VideoSemanticJobRecord,
  type VideoSemanticJobState,
  type VideoSemanticPlannedSegment,
  type VideoSemanticSegmentRecord,
} from '../shared/videoSemantic'
import { normalizeVideoSemanticSegmentRecord } from './videoSemanticSchema'

const DATABASE_SCHEMA_VERSION = 1
export const VIDEO_SEMANTIC_DATABASE_FILENAME = 'video-semantic.sqlite'

export interface VideoSemanticVideoDataStats {
  generations: number
  segments: number
  events: number
  persons: number
  jobs: number
  preferences: number
}

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS semantic_generations (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  quantization TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  profile_revision TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  committed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_semantic_generations_video
  ON semantic_generations(video_id, committed_at DESC);
CREATE TABLE IF NOT EXISTS semantic_segments (
  id INTEGER PRIMARY KEY,
  segment_id TEXT NOT NULL UNIQUE,
  generation_id TEXT NOT NULL REFERENCES semantic_generations(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  profile_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  scenes_json TEXT NOT NULL,
  objects_json TEXT NOT NULL,
  search_tags_json TEXT NOT NULL,
  visual_text_json TEXT NOT NULL,
  transcript_refs_json TEXT NOT NULL,
  audio_events_json TEXT NOT NULL,
  language TEXT,
  warnings_json TEXT NOT NULL,
  evidence_frame_ids_json TEXT NOT NULL,
  evidence_frame_digest TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  quantization TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  profile_revision TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (end_ms > start_ms)
);
CREATE INDEX IF NOT EXISTS idx_semantic_segments_video_time
  ON semantic_segments(video_id, start_ms, end_ms);
CREATE INDEX IF NOT EXISTS idx_semantic_segments_generation
  ON semantic_segments(generation_id, start_ms);
CREATE TABLE IF NOT EXISTS semantic_events (
  segment_id TEXT NOT NULL REFERENCES semantic_segments(segment_id) ON DELETE CASCADE,
  event_index INTEGER NOT NULL,
  label TEXT NOT NULL,
  description TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  confidence REAL NOT NULL,
  PRIMARY KEY (segment_id, event_index)
);
CREATE INDEX IF NOT EXISTS idx_semantic_events_time ON semantic_events(start_ms, end_ms);
CREATE TABLE IF NOT EXISTS semantic_persons (
  segment_id TEXT NOT NULL REFERENCES semantic_segments(segment_id) ON DELETE CASCADE,
  person_index INTEGER NOT NULL,
  local_id TEXT NOT NULL,
  description TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  PRIMARY KEY (segment_id, person_index),
  UNIQUE (segment_id, local_id)
);
CREATE TABLE IF NOT EXISTS active_video_generations (
  video_id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES semantic_generations(id) ON DELETE RESTRICT,
  activated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS semantic_jobs (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  plan_fingerprint TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  state TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  completed_segments INTEGER NOT NULL DEFAULT 0,
  failed_segments INTEGER NOT NULL DEFAULT 0,
  attempts_json TEXT NOT NULL DEFAULT '{}',
  current_segment_id TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_semantic_jobs_state_updated
  ON semantic_jobs(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_semantic_jobs_video_created
  ON semantic_jobs(video_id, created_at DESC);
CREATE TABLE IF NOT EXISTS semantic_job_results (
  job_id TEXT NOT NULL REFERENCES semantic_jobs(id) ON DELETE CASCADE,
  planned_segment_id TEXT NOT NULL,
  record_json TEXT NOT NULL,
  staged_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, planned_segment_id)
);
CREATE TABLE IF NOT EXISTS semantic_video_preferences (
  video_id TEXT PRIMARY KEY,
  profile_override TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS semantic_fts USING fts5(
  segment_id UNINDEXED,
  summary,
  scenes,
  events,
  persons,
  objects,
  search_tags,
  visual_text,
  transcript_refs,
  audio_events,
  tokenize = 'unicode61'
);
PRAGMA user_version = ${DATABASE_SCHEMA_VERSION};
`

export interface VideoSemanticSearchHit {
  segment: VideoSemanticSegmentRecord
  score: number
  matchedFields: VideoSemanticMatchedField[]
}

export type VideoSemanticMatchedField =
  | 'visual-semantic'
  | 'visual-text'
  | 'transcript-reference'
  | 'audio-event'

const FTS_MATCH_START = String.fromCharCode(1)

export interface VideoSemanticDatabaseStats {
  generations: number
  activeVideos: number
  segments: number
  events: number
  persons: number
}

export interface VideoSemanticDatabaseOptions {
  readOnly?: boolean
  immutable?: boolean
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

function parsePlannedSegments(value: unknown): VideoSemanticPlannedSegment[] {
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as VideoSemanticPlannedSegment[]) : []
  } catch {
    return []
  }
}

function parseAttempts(value: unknown): Record<string, number> {
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === 'number' && Number.isSafeInteger(entry[1]) && entry[1] >= 0,
      ),
    )
  } catch {
    return {}
  }
}

function jobFromRow(row: Record<string, unknown>): VideoSemanticJobRecord {
  return {
    jobId: textValue(row.id),
    assetId: textValue(row.asset_id),
    videoId: textValue(row.video_id),
    generationId: textValue(row.generation_id),
    profileId: textValue(row.profile_id) as VideoSemanticJobRecord['profileId'],
    planFingerprint: textValue(row.plan_fingerprint),
    segments: parsePlannedSegments(row.plan_json),
    state: textValue(row.state) as VideoSemanticJobState,
    cursor: numberValue(row.cursor),
    completedSegments: numberValue(row.completed_segments),
    failedSegments: numberValue(row.failed_segments),
    attemptsBySegment: parseAttempts(row.attempts_json),
    ...(textValue(row.current_segment_id)
      ? { currentSegmentId: textValue(row.current_segment_id) }
      : {}),
    ...(textValue(row.last_error) ? { lastError: textValue(row.last_error) } : {}),
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
  }
}

function ftsText(values: readonly string[]): string {
  return values.join('\n')
}

function buildFtsQuery(query: string): string | null {
  const tokens =
    query
      .normalize('NFKC')
      .match(/[\p{L}\p{N}_-]+/gu)
      ?.slice(0, 16) ?? []
  if (tokens.length === 0) return null
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' AND ')
}

export class VideoSemanticDatabase {
  private database: DatabaseSync | null = null

  constructor(
    private readonly filePath: string,
    private readonly options: VideoSemanticDatabaseOptions = {},
  ) {}

  private open(): DatabaseSync {
    if (this.database) return this.database
    if (this.options.readOnly) {
      if (this.options.immutable) {
        try {
          if (fs.statSync(`${this.filePath}-wal`).size > 0) {
            throw new Error(
              'Cannot inspect an immutable video semantic database with active WAL data',
            )
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      const immutableUrl = pathToFileURL(this.filePath)
      if (this.options.immutable) immutableUrl.searchParams.set('immutable', '1')
      const database = new DatabaseSync(this.options.immutable ? immutableUrl : this.filePath, {
        readOnly: true,
        timeout: 5000,
      })
      try {
        database.exec('PRAGMA query_only = ON')
        const version = numberValue(database.prepare('PRAGMA user_version').get()?.user_version)
        if (version !== DATABASE_SCHEMA_VERSION) {
          throw new Error(`Unsupported video semantic database schema ${version}`)
        }
        this.database = database
        return database
      } catch (error) {
        database.close()
        throw error
      }
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const database = new DatabaseSync(this.filePath)
    try {
      database.exec('PRAGMA busy_timeout = 5000')
      database.exec('PRAGMA synchronous = NORMAL')
      database.exec('PRAGMA journal_mode = WAL')
      database.exec('PRAGMA foreign_keys = ON')
      const version = numberValue(database.prepare('PRAGMA user_version').get()?.user_version)
      if (version !== 0 && version !== DATABASE_SCHEMA_VERSION) {
        throw new Error(`Unsupported video semantic database schema ${version}`)
      }
      database.exec(SCHEMA_DDL)
      this.database = database
      return database
    } catch (error) {
      database.close()
      throw error
    }
  }

  close(): void {
    this.database?.close()
    this.database = null
  }

  private segmentFromRow(
    database: DatabaseSync,
    row: Record<string, unknown>,
  ): VideoSemanticSegmentRecord {
    const segmentId = textValue(row.segment_id)
    const events = database
      .prepare('SELECT * FROM semantic_events WHERE segment_id = ? ORDER BY event_index')
      .all(segmentId)
      .map((event) => ({
        label: textValue(event.label),
        description: textValue(event.description),
        startMs: numberValue(event.start_ms),
        endMs: numberValue(event.end_ms),
        confidence: numberValue(event.confidence),
      }))
    const persons = database
      .prepare('SELECT * FROM semantic_persons WHERE segment_id = ? ORDER BY person_index')
      .all(segmentId)
      .map((person) => ({
        localId: textValue(person.local_id),
        description: textValue(person.description),
        actions: parseStringArray(person.actions_json),
        confidence: numberValue(person.confidence),
      }))
    const candidate = {
      schemaVersion: numberValue(row.schema_version),
      segmentId,
      generationId: textValue(row.generation_id),
      assetId: textValue(row.asset_id),
      videoId: textValue(row.video_id),
      startMs: numberValue(row.start_ms),
      endMs: numberValue(row.end_ms),
      profileId: textValue(row.profile_id),
      summary: textValue(row.summary),
      scenes: parseStringArray(row.scenes_json),
      events,
      persons,
      objects: parseStringArray(row.objects_json),
      searchTags: parseStringArray(row.search_tags_json),
      visualText: parseStringArray(row.visual_text_json),
      transcriptRefs: parseStringArray(row.transcript_refs_json),
      audioEvents: parseStringArray(row.audio_events_json),
      ...(textValue(row.language) ? { language: textValue(row.language) } : {}),
      warnings: parseStringArray(row.warnings_json),
      evidenceFrameIds: parseStringArray(row.evidence_frame_ids_json),
      evidenceFrameDigest: textValue(row.evidence_frame_digest),
      modelId: textValue(row.model_id),
      modelRevision: textValue(row.model_revision),
      quantization: textValue(row.quantization),
      promptVersion: textValue(row.prompt_version),
      profileRevision: textValue(row.profile_revision),
      sourceFingerprint: textValue(row.source_fingerprint),
      createdAt: numberValue(row.created_at),
      updatedAt: numberValue(row.updated_at),
    }
    const normalized = normalizeVideoSemanticSegmentRecord(candidate)
    if (!normalized.ok) throw new Error(`Corrupt video semantic segment: ${normalized.error}`)
    return normalized.value
  }

  commitGeneration(records: readonly VideoSemanticSegmentRecord[], activatedAt = Date.now()): void {
    if (records.length === 0) throw new Error('Video semantic generation has no segments')
    const normalized = records.map((record) => {
      const result = normalizeVideoSemanticSegmentRecord(record)
      if (!result.ok) throw new Error(result.error)
      return result.value
    })
    const first = normalized[0]
    if (
      normalized.some(
        (record) =>
          record.generationId !== first.generationId ||
          record.videoId !== first.videoId ||
          record.assetId !== first.assetId ||
          record.modelId !== first.modelId ||
          record.modelRevision !== first.modelRevision ||
          record.quantization !== first.quantization ||
          record.promptVersion !== first.promptVersion ||
          record.profileRevision !== first.profileRevision ||
          record.sourceFingerprint !== first.sourceFingerprint,
      )
    ) {
      throw new Error('Video semantic generation contains mixed authorities')
    }
    const database = this.open()
    database.exec('BEGIN IMMEDIATE')
    try {
      database
        .prepare(
          `INSERT INTO semantic_generations (
            id, asset_id, video_id, model_id, model_revision, quantization,
            prompt_version, profile_revision, source_fingerprint, created_at, committed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            asset_id=excluded.asset_id, video_id=excluded.video_id,
            model_id=excluded.model_id, model_revision=excluded.model_revision,
            quantization=excluded.quantization, prompt_version=excluded.prompt_version,
            profile_revision=excluded.profile_revision,
            source_fingerprint=excluded.source_fingerprint,
            created_at=excluded.created_at, committed_at=excluded.committed_at`,
        )
        .run(
          first.generationId,
          first.assetId,
          first.videoId,
          first.modelId,
          first.modelRevision,
          first.quantization,
          first.promptVersion,
          first.profileRevision,
          first.sourceFingerprint,
          Math.min(...normalized.map((record) => record.createdAt)),
          activatedAt,
        )
      const oldSegmentIds = database
        .prepare('SELECT segment_id FROM semantic_segments WHERE generation_id = ?')
        .all(first.generationId)
        .map((row) => textValue(row.segment_id))
      const deleteFts = database.prepare('DELETE FROM semantic_fts WHERE segment_id = ?')
      for (const segmentId of oldSegmentIds) deleteFts.run(segmentId)
      database
        .prepare('DELETE FROM semantic_segments WHERE generation_id = ?')
        .run(first.generationId)

      const insertSegment = database.prepare(
        `INSERT INTO semantic_segments (
          segment_id, generation_id, asset_id, video_id, start_ms, end_ms, profile_id, summary,
          scenes_json, objects_json, search_tags_json, visual_text_json, transcript_refs_json,
          audio_events_json, language, warnings_json, evidence_frame_ids_json, evidence_frame_digest,
          model_id, model_revision, quantization, prompt_version, profile_revision, source_fingerprint,
          schema_version, created_at, updated_at
        ) VALUES (${new Array(27).fill('?').join(',')})`,
      )
      const insertEvent = database.prepare(
        `INSERT INTO semantic_events (
          segment_id, event_index, label, description, start_ms, end_ms, confidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      const insertPerson = database.prepare(
        `INSERT INTO semantic_persons (
          segment_id, person_index, local_id, description, actions_json, confidence
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      const insertFts = database.prepare(
        `INSERT INTO semantic_fts (
          segment_id, summary, scenes, events, persons, objects, search_tags,
          visual_text, transcript_refs, audio_events
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const record of normalized) {
        const values: SQLInputValue[] = [
          record.segmentId,
          record.generationId,
          record.assetId,
          record.videoId,
          record.startMs,
          record.endMs,
          record.profileId,
          record.summary,
          JSON.stringify(record.scenes),
          JSON.stringify(record.objects),
          JSON.stringify(record.searchTags),
          JSON.stringify(record.visualText),
          JSON.stringify(record.transcriptRefs),
          JSON.stringify(record.audioEvents),
          record.language ?? null,
          JSON.stringify(record.warnings),
          JSON.stringify(record.evidenceFrameIds),
          record.evidenceFrameDigest,
          record.modelId,
          record.modelRevision,
          record.quantization,
          record.promptVersion,
          record.profileRevision,
          record.sourceFingerprint,
          VIDEO_SEMANTIC_SCHEMA_VERSION,
          record.createdAt,
          record.updatedAt,
        ]
        insertSegment.run(...values)
        record.events.forEach((event, index) =>
          insertEvent.run(
            record.segmentId,
            index,
            event.label,
            event.description,
            event.startMs,
            event.endMs,
            event.confidence,
          ),
        )
        record.persons.forEach((person, index) =>
          insertPerson.run(
            record.segmentId,
            index,
            person.localId,
            person.description,
            JSON.stringify(person.actions),
            person.confidence,
          ),
        )
        insertFts.run(
          record.segmentId,
          record.summary,
          ftsText(record.scenes),
          ftsText(record.events.flatMap((event) => [event.label, event.description])),
          ftsText(record.persons.flatMap((person) => [person.description, ...person.actions])),
          ftsText(record.objects),
          ftsText(record.searchTags),
          ftsText(record.visualText),
          ftsText(record.transcriptRefs),
          ftsText(record.audioEvents),
        )
      }
      database
        .prepare(
          `INSERT INTO active_video_generations (video_id, generation_id, activated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(video_id) DO UPDATE SET
             generation_id=excluded.generation_id, activated_at=excluded.activated_at`,
        )
        .run(first.videoId, first.generationId, activatedAt)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  getActiveGenerationId(videoId: string): string | null {
    const row = this.open()
      .prepare('SELECT generation_id FROM active_video_generations WHERE video_id = ?')
      .get(videoId)
    return row ? textValue(row.generation_id) : null
  }

  stageJobResult(
    jobId: string,
    plannedSegmentId: string,
    rawRecord: VideoSemanticSegmentRecord,
    stagedAt = Date.now(),
  ): void {
    const job = this.getJob(jobId)
    if (!job) throw new Error('Video semantic staging job not found')
    const planned = job.segments.find((segment) => segment.segmentId === plannedSegmentId)
    if (!planned) throw new Error('Video semantic staging segment is not in the job plan')
    const normalized = normalizeVideoSemanticSegmentRecord(rawRecord)
    if (!normalized.ok) throw new Error(normalized.error)
    const record = normalized.value
    if (
      record.assetId !== job.assetId ||
      record.videoId !== job.videoId ||
      record.generationId !== job.generationId ||
      record.profileId !== job.profileId ||
      record.startMs !== planned.startMs ||
      record.endMs !== planned.endMs
    ) {
      throw new Error('Video semantic staged result conflicts with job authority')
    }
    this.open()
      .prepare(
        `INSERT INTO semantic_job_results (job_id, planned_segment_id, record_json, staged_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(job_id, planned_segment_id) DO UPDATE SET
           record_json=excluded.record_json, staged_at=excluded.staged_at`,
      )
      .run(jobId, plannedSegmentId, JSON.stringify(record), stagedAt)
  }

  getStagedJobResults(jobId: string): VideoSemanticSegmentRecord[] {
    const job = this.getJob(jobId)
    if (!job) return []
    const byId = new Map(
      this.open()
        .prepare(
          'SELECT planned_segment_id, record_json FROM semantic_job_results WHERE job_id = ?',
        )
        .all(jobId)
        .map((row) => [textValue(row.planned_segment_id), textValue(row.record_json)]),
    )
    const records: VideoSemanticSegmentRecord[] = []
    for (const segment of job.segments) {
      const serialized = byId.get(segment.segmentId)
      if (!serialized) continue
      let candidate: unknown
      try {
        candidate = JSON.parse(serialized)
      } catch {
        throw new Error('Corrupt staged video semantic result JSON')
      }
      const normalized = normalizeVideoSemanticSegmentRecord(candidate)
      if (!normalized.ok)
        throw new Error(`Corrupt staged video semantic result: ${normalized.error}`)
      records.push(normalized.value)
    }
    return records
  }

  clearStagedJobResults(jobId: string): number {
    return Number(
      this.open().prepare('DELETE FROM semantic_job_results WHERE job_id = ?').run(jobId).changes,
    )
  }

  getVideoProfileOverride(videoId: string): string {
    const row = this.open()
      .prepare('SELECT profile_override FROM semantic_video_preferences WHERE video_id = ?')
      .get(videoId)
    return row ? textValue(row.profile_override) : 'auto'
  }

  setVideoProfileOverride(videoId: string, profileOverride: string, updatedAt = Date.now()): void {
    this.open()
      .prepare(
        `INSERT INTO semantic_video_preferences (video_id, profile_override, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(video_id) DO UPDATE SET
           profile_override=excluded.profile_override, updated_at=excluded.updated_at`,
      )
      .run(videoId, profileOverride, updatedAt)
  }

  putJob(job: VideoSemanticJobRecord): void {
    this.open()
      .prepare(
        `INSERT INTO semantic_jobs (
          id, asset_id, video_id, generation_id, profile_id, plan_fingerprint, plan_json,
          state, cursor, completed_segments, failed_segments, attempts_json,
          current_segment_id, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          asset_id=excluded.asset_id, video_id=excluded.video_id,
          generation_id=excluded.generation_id, profile_id=excluded.profile_id,
          plan_fingerprint=excluded.plan_fingerprint, plan_json=excluded.plan_json,
          state=excluded.state, cursor=excluded.cursor,
          completed_segments=excluded.completed_segments,
          failed_segments=excluded.failed_segments, attempts_json=excluded.attempts_json,
          current_segment_id=excluded.current_segment_id, last_error=excluded.last_error,
          updated_at=excluded.updated_at`,
      )
      .run(
        job.jobId,
        job.assetId,
        job.videoId,
        job.generationId,
        job.profileId,
        job.planFingerprint,
        JSON.stringify(job.segments),
        job.state,
        job.cursor,
        job.completedSegments,
        job.failedSegments,
        JSON.stringify(job.attemptsBySegment),
        job.currentSegmentId ?? null,
        job.lastError ?? null,
        job.createdAt,
        job.updatedAt,
      )
  }

  getJob(jobId: string): VideoSemanticJobRecord | null {
    const row = this.open().prepare('SELECT * FROM semantic_jobs WHERE id = ?').get(jobId)
    return row ? jobFromRow(row) : null
  }

  listJobs(videoId?: string): VideoSemanticJobRecord[] {
    const rows = videoId
      ? this.open()
          .prepare('SELECT * FROM semantic_jobs WHERE video_id = ? ORDER BY created_at, id')
          .all(videoId)
      : this.open().prepare('SELECT * FROM semantic_jobs ORDER BY created_at, id').all()
    return rows.map(jobFromRow)
  }

  recoverInterruptedJobs(updatedAt = Date.now()): number {
    const result = this.open()
      .prepare(
        `UPDATE semantic_jobs
         SET state = 'queued', current_segment_id = NULL,
             last_error = 'interrupted-before-terminal-state', updated_at = ?
         WHERE state = 'running'`,
      )
      .run(updatedAt)
    return Number(result.changes)
  }

  getActiveSegments(videoId: string): VideoSemanticSegmentRecord[] {
    const database = this.open()
    const rows = database
      .prepare(
        `SELECT s.* FROM semantic_segments s
         JOIN active_video_generations a ON a.generation_id = s.generation_id
         WHERE a.video_id = ? AND s.video_id = a.video_id
         ORDER BY s.start_ms, s.segment_id`,
      )
      .all(videoId)
    return rows.map((row) => this.segmentFromRow(database, row))
  }

  search(query: string, limit = 50): VideoSemanticSearchHit[] {
    const ftsQuery = buildFtsQuery(query)
    if (!ftsQuery) return []
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)))
    const database = this.open()
    const rows = database
      .prepare(
        `SELECT s.*, bm25(semantic_fts) AS rank,
                highlight(semantic_fts, 1, char(1), char(2)) AS match_summary,
                highlight(semantic_fts, 2, char(1), char(2)) AS match_scenes,
                highlight(semantic_fts, 3, char(1), char(2)) AS match_events,
                highlight(semantic_fts, 4, char(1), char(2)) AS match_persons,
                highlight(semantic_fts, 5, char(1), char(2)) AS match_objects,
                highlight(semantic_fts, 6, char(1), char(2)) AS match_search_tags,
                highlight(semantic_fts, 7, char(1), char(2)) AS match_visual_text,
                highlight(semantic_fts, 8, char(1), char(2)) AS match_transcript_refs,
                highlight(semantic_fts, 9, char(1), char(2)) AS match_audio_events
         FROM semantic_fts
         JOIN semantic_segments s ON s.segment_id = semantic_fts.segment_id
         JOIN active_video_generations a
           ON a.video_id = s.video_id AND a.generation_id = s.generation_id
         WHERE semantic_fts MATCH ?
         ORDER BY rank, s.start_ms
         LIMIT ?`,
      )
      .all(ftsQuery, safeLimit)
    return rows.map((row) => {
      const matched = (key: string) => textValue(row[key]).includes(FTS_MATCH_START)
      const matchedFields: VideoSemanticMatchedField[] = []
      if (
        ['summary', 'scenes', 'events', 'persons', 'objects', 'search_tags'].some((field) =>
          matched(`match_${field}`),
        )
      ) {
        matchedFields.push('visual-semantic')
      }
      if (matched('match_visual_text')) matchedFields.push('visual-text')
      if (matched('match_transcript_refs')) matchedFields.push('transcript-reference')
      if (matched('match_audio_events')) matchedFields.push('audio-event')
      return {
        segment: this.segmentFromRow(database, row),
        score: Math.max(0, -numberValue(row.rank)),
        matchedFields,
      }
    })
  }

  deleteInactiveGenerations(videoId: string): number {
    const database = this.open()
    database.exec('BEGIN IMMEDIATE')
    try {
      const generationIds = database
        .prepare(
          `SELECT id FROM semantic_generations
           WHERE video_id = ?
             AND id NOT IN (
               SELECT generation_id FROM active_video_generations WHERE video_id = ?
             )`,
        )
        .all(videoId, videoId)
        .map((row) => textValue(row.id))
      const selectSegments = database.prepare(
        'SELECT segment_id FROM semantic_segments WHERE generation_id = ?',
      )
      const deleteFts = database.prepare('DELETE FROM semantic_fts WHERE segment_id = ?')
      const deleteGeneration = database.prepare('DELETE FROM semantic_generations WHERE id = ?')
      for (const generationId of generationIds) {
        for (const row of selectSegments.all(generationId)) deleteFts.run(textValue(row.segment_id))
        deleteGeneration.run(generationId)
      }
      database.exec('COMMIT')
      return generationIds.length
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  previewVideoData(videoIds: readonly string[]): VideoSemanticVideoDataStats {
    const ids = [...new Set(videoIds.filter(Boolean))]
    const result: VideoSemanticVideoDataStats = {
      generations: 0,
      segments: 0,
      events: 0,
      persons: 0,
      jobs: 0,
      preferences: 0,
    }
    if (ids.length === 0 || !fs.existsSync(this.filePath)) return result
    const database = this.open()
    const count = (sql: string, videoId: string): number =>
      numberValue(database.prepare(sql).get(videoId)?.count)
    for (const videoId of ids) {
      result.generations += count(
        'SELECT COUNT(*) AS count FROM semantic_generations WHERE video_id = ?',
        videoId,
      )
      result.segments += count(
        'SELECT COUNT(*) AS count FROM semantic_segments WHERE video_id = ?',
        videoId,
      )
      result.events += count(
        `SELECT COUNT(*) AS count FROM semantic_events
         WHERE segment_id IN (SELECT segment_id FROM semantic_segments WHERE video_id = ?)`,
        videoId,
      )
      result.persons += count(
        `SELECT COUNT(*) AS count FROM semantic_persons
         WHERE segment_id IN (SELECT segment_id FROM semantic_segments WHERE video_id = ?)`,
        videoId,
      )
      result.jobs += count(
        'SELECT COUNT(*) AS count FROM semantic_jobs WHERE video_id = ?',
        videoId,
      )
      result.preferences += count(
        'SELECT COUNT(*) AS count FROM semantic_video_preferences WHERE video_id = ?',
        videoId,
      )
    }
    return result
  }

  deleteVideoData(videoIds: readonly string[]): VideoSemanticVideoDataStats {
    const ids = [...new Set(videoIds.filter(Boolean))]
    const removed = this.previewVideoData(ids)
    if (ids.length === 0 || Object.values(removed).every((count) => count === 0)) return removed
    const database = this.open()
    database.exec('BEGIN IMMEDIATE')
    try {
      const segmentIds = database.prepare(
        'SELECT segment_id FROM semantic_segments WHERE video_id = ?',
      )
      const deleteFts = database.prepare('DELETE FROM semantic_fts WHERE segment_id = ?')
      const deleteActive = database.prepare(
        'DELETE FROM active_video_generations WHERE video_id = ?',
      )
      const deleteJobs = database.prepare('DELETE FROM semantic_jobs WHERE video_id = ?')
      const deletePreferences = database.prepare(
        'DELETE FROM semantic_video_preferences WHERE video_id = ?',
      )
      const deleteGenerations = database.prepare(
        'DELETE FROM semantic_generations WHERE video_id = ?',
      )
      for (const videoId of ids) {
        for (const row of segmentIds.all(videoId)) deleteFts.run(textValue(row.segment_id))
        deleteActive.run(videoId)
        deleteJobs.run(videoId)
        deletePreferences.run(videoId)
        deleteGenerations.run(videoId)
      }
      database.exec('COMMIT')
      return removed
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  stats(): VideoSemanticDatabaseStats {
    const database = this.open()
    const count = (table: string): number =>
      numberValue(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count)
    return {
      generations: count('semantic_generations'),
      activeVideos: count('active_video_generations'),
      segments: count('semantic_segments'),
      events: count('semantic_events'),
      persons: count('semantic_persons'),
    }
  }
}
