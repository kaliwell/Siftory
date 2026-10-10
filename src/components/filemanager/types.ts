// ── File Manager Types ──────────────────────────────────────

/** Supported pane layouts */
export type PaneLayout = 'single' | 'horizontal' | 'vertical' | 'triple' | 'quad'

/** Sort field for file listing */
export type SortField = 'name' | 'size' | 'type' | 'mtime' | 'ext'

/** Sort direction */
export type SortDirection = 'asc' | 'desc'

/** Sort state */
export interface SortState {
  field: SortField
  direction: SortDirection
}

/** View mode for file listing */
export type ViewMode =
  | 'xlarge-icon'
  | 'large-icon'
  | 'medium-icon'
  | 'small-icon'
  | 'list'
  | 'details'
  | 'thumbnail-grid'

/** Group mode for file listing */
export type GroupMode = 'none' | 'type' | 'mtime' | 'size' | 'ext' | 'category' | 'folder-first'

/** Group info for rendering a group section */
export interface GroupInfo {
  key: string
  label: string
  count: number
  files: (FileEntry & { thumbnail?: string })[]
}

/** View mode display names */
export const VIEW_MODE_LABELS: Record<ViewMode, string> = {
  'xlarge-icon': '▣ XL',
  'large-icon': '▣ Lrg',
  'medium-icon': '▤ Med',
  'small-icon': '▫ Sml',
  list: '☰ Lst',
  details: '≡ Det',
  'thumbnail-grid': '▦ Thu',
}

/** Group mode display names */
export const GROUP_MODE_LABELS: Record<GroupMode, string> = {
  none: '— No groups',
  type: 'By type',
  mtime: 'By date',
  size: 'By size',
  ext: 'By extension',
  category: 'By category',
  'folder-first': 'Folders first',
}

/** File entry from directory listing */
export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number // bytes, 0 for directories
  mtime: number // epoch ms
  type: string // file extension or "文件夹"
}

/** Directory listing result */
export interface DirListing {
  path: string
  files: FileEntry[]
  error?: string
}

/** Clipboard item for copy/cut */
export interface ClipboardItem {
  paths: string[]
  operation: 'copy' | 'cut'
}

/** Progress info for file operations */
export interface ProgressInfo {
  currentFile: string
  completed: number
  total: number
  percentage: number
  status: 'running' | 'paused' | 'done' | 'partial' | 'error' | 'cancelled'
  error?: string
  /** Failed file names (populated on partial success) */
  failedFiles?: string[]
  /** Operation ID for cancellation */
  opId?: number
}

/** Quick access favorite */
export interface FavoriteEntry {
  name: string
  path: string
}

/** File manager layout mode names */
export const LAYOUT_LABELS: Record<PaneLayout, string> = {
  single: 'Single',
  horizontal: 'H Split',
  vertical: 'V Split',
  triple: 'Triple',
  quad: 'Quad',
}

/** Default quick access paths */
export const DEFAULT_QUICK_ACCESS: FavoriteEntry[] = [
  { name: '桌面', path: '~/Desktop' },
  { name: '下载', path: '~/Downloads' },
  { name: '文档', path: '~/Documents' },
  { name: '图片', path: '~/Pictures' },
  { name: '视频', path: '~/Videos' },
  { name: '音乐', path: '~/Music' },
]

/** Pane count per layout */
export const LAYOUT_PANE_COUNT: Record<PaneLayout, number> = {
  single: 1,
  horizontal: 2,
  vertical: 2,
  triple: 3,
  quad: 4,
}
