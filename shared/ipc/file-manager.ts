// File manager and duplicate finder IPC contracts.

export interface DupGroup {
  hash: string
  size: number
  files: { path: string; name: string; size: number; mtime: number }[]
}

export interface DupScanProgress {
  state: 'scanning' | 'hashing' | 'done' | 'stopped' | 'error'
  scanned: number
  totalBytes: number
  duplicates: number
  currentPath?: string
  candidates?: number
  durationMs?: number
  error?: string
}

export interface LargestFile {
  path: string
  name: string
  size: number
  mtime: number
}

export interface DupScanOptions {
  dirPath: string
  minSize?: number // skip files smaller than this (bytes)
}

export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  mtime: number
  type: string
}

export interface DirListing {
  path: string
  files: FileEntry[]
  error?: string
}

/** Paged directory listing — for directories with 10K+ files */
export interface DirListingPaged {
  path: string
  files: FileEntry[]
  total: number
  hasMore: boolean
  error?: string
}

export interface DirListSort {
  field: 'name' | 'size' | 'type' | 'mtime' | 'ext'
  direction: 'asc' | 'desc'
}

export interface DirListRequest {
  dirPath: string
  sort?: DirListSort
  offset: number
  limit: number
}

export interface FMResult {
  success: boolean
  error?: string
  path?: string
  newPath?: string
}

export interface FMProgress {
  currentFile: string
  completed: number
  total: number
  percentage: number
  status: string
}

export interface FMFolderSizeRequest {
  folderPath: string
  /** Groups requests from one pane generation so navigation can cancel stale work. */
  requestId: string
}

export interface FMFolderSizeResult {
  path: string
  bytes: number
  fileCount: number
  folderCount: number
  entriesScanned: number
  complete: boolean
  partialReason?: 'entry-limit' | 'inaccessible' | 'entry-limit-and-inaccessible'
  durationMs: number
  cancelled?: boolean
  error?: string
}

export interface FMFolderSizeProgress {
  requestId: string
  path: string
  phase: 'queued' | 'scanning'
  entriesScanned: number
  bytes: number
}

export interface FMVolumeSpaceResult {
  path: string
  totalBytes: number
  usedBytes: number
  freeBytes: number
  availableBytes: number
  error?: string
}

export type FileManagerPaneLayout = 'single' | 'horizontal' | 'vertical' | 'triple' | 'quad'
export type FileManagerViewMode =
  | 'xlarge-icon'
  | 'large-icon'
  | 'medium-icon'
  | 'small-icon'
  | 'list'
  | 'details'
  | 'thumbnail-grid'
export type FileManagerGroupMode =
  | 'none'
  | 'type'
  | 'mtime'
  | 'size'
  | 'ext'
  | 'category'
  | 'folder-first'

export interface FileManagerFavoriteEntry {
  name: string
  path: string
}

export interface ThumbnailResult {
  path: string
  dataUrl: string | null
  error?: string
}

// ── ImageSearch Types ─────────────────────────────────────
