// Subject search, SAM segmentation, and batch rename IPC contracts.

export interface SubjectBBox {
  x: number
  y: number
  w: number
  h: number
  confidence: number
  label: string
}

export interface SubjectDetectionResult {
  ok: boolean
  imagePath: string
  width: number
  height: number
  subjects: SubjectBBox[]
  modelLoaded?: boolean
  error?: string
}

export interface SubjectSearchResult {
  imageId: string
  imagePath: string
  /** Short-lived main-process capability for dragging this exact search result. */
  dragToken?: string
  score: number
  modelName: string
}

// ── SAM Click Segmentation ────────────────────────────────

export interface SamPoint {
  x: number
  y: number
  /** 0 background, 1 foreground, 2 box top-left, 3 box bottom-right. */
  label?: 0 | 1 | 2 | 3
}

export interface SamSegmentResult {
  ok: boolean
  width?: number
  height?: number
  bbox?: { x: number; y: number; w: number; h: number }
  iou?: number
  maskPngDataUrl?: string
  /** Opaque main-process capability for searching with the authoritative mask. */
  segmentationSessionId?: string
  error?: string
}

export interface SamPreviewResult {
  ok: boolean
  dataUrl?: string
  width?: number
  height?: number
  sourceWidth?: number
  sourceHeight?: number
  error?: string
}

// ── Batch Rename Recovery ─────────────────────────────────

export type BatchRenameState =
  | 'scanning-origin'
  | 'scanning-modified'
  | 'matching'
  | 'copying'
  | 'done'
  | 'stopped'
  | 'error'

export interface BatchRenameProgress {
  taskId: string
  state: BatchRenameState
  originTotal: number
  modifiedTotal: number
  matched: number
  unmatched: number
  conflicts: number
  copied: number
  percent?: number
  currentFile?: string
  elapsedMs: number
  etaMs?: number
  error?: string
}

export interface BatchRenameStartRequest {
  originDir: string
  modifiedDir: string
  outputDir: string
  threshold?: number
  conflictPolicy?: 'keep-best' | 'skip' | 'keep-both'
}

export interface BatchRenameStartResponse {
  ok: boolean
  taskId?: string
  originCount?: number
  modifiedCount?: number
  error?: string
}

export interface BatchRenameResult {
  taskId: string
  state: 'done' | 'stopped' | 'error'
  matched: Array<{
    originalName: string
    modifiedPath: string
    outputPath: string
    score: number
    publishMode?: 'atomic-link' | 'exclusive-copy'
  }>
  unmatched: string[]
  pending: string[]
  pendingOriginals: string[]
  conflicts: string[]
  skippedOriginals: string[]
  durationMs: number
  error?: string
}

// ── Electron API Contract ─────────────────────────────────
