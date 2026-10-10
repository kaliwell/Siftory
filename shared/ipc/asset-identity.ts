// Phase 2 stable asset identity contracts.
// Design: docs/designs/2026-08-11-local-nas-ai-asset-discovery-architecture.md
// sections 7.1 (FileEntry/Asset/AssetMember), 7.2 (identity strategy),
// 7.3 (authority boundaries) and 14 Phase 2. Storage authority: asset
// identity records stay with assets.jsonl as the authority; the mapping
// below is a rebuildable identity/member projection that lives next to the
// asset library (asset-identities.jsonl) and never mutates assets.jsonl,
// asset-library.sqlite or asset-catalog.sqlite
// (docs/reference/2026-08-11-storage-authority-boundaries.md).

// Design 7.2: prefer volume/FRN filesystem identity; fall back to the
// path+size+mtime strategy when the filesystem cannot provide one.
export type AssetIdStrategy = 'filesystem' | 'path'

// Design 7.1 AssetMember roles. Phase 2 requires original, preview-proxy,
// raw-companion and sidecar. Any user-visible query defaults to 'original'
// only; a preview-proxy must never surface as a user-visible original.
export type AssetMemberRole = 'original' | 'preview-proxy' | 'raw-companion' | 'sidecar'

export interface AssetMember {
  assetId: string
  role: AssetMemberRole
  path: string
  addedAt: number
}

export interface AssetIdentity {
  assetId: string
  strategy: AssetIdStrategy
  // 'fs:<volume>:<frn>' or 'path:<normalized-path>' — the basis the stable
  // AssetId is derived from. Moves on the same volume keep the fs key.
  identityKey: string
  // Current best-known path of the original member.
  path: string
  members: AssetMember[]
  updatedAt: number
}

export interface AssetIdentityResolveInput {
  absolutePath: string
  sizeBytes?: number
  modifiedAt?: number
  // Optional pre-resolved filesystem identity (volume serial + file index).
  filesystemIdentity?: string
}

export interface AssetShadowReportEntry {
  path: string
  assetId?: string
  reason: string
}

// Shadow projection comparison between the unified identity resolution and
// the existing asset-catalog projection (design Phase 2 task 2).
export interface AssetShadowReport {
  generatedAt: number
  comparedCount: number
  matchedCount: number
  onlyInLibrary: AssetShadowReportEntry[]
  onlyInUnified: AssetShadowReportEntry[]
}

export interface AssetIdentityResolveResult {
  ok: boolean
  identity?: AssetIdentity
  error?: string
}

export type AssetFileActionKind = 'open' | 'reveal'

export interface AssetFileActionRequest {
  // An AssetId ('asset_…') or a raw path; AssetId is resolved to the
  // original member before any shell action runs.
  ref: string
}

export interface AssetFileActionResult {
  ok: boolean
  path?: string
  error?: string
}

export interface AssetMoveRepairRequest {
  // New location of a file that was moved on the same volume; identity is
  // resolved from the filesystem and tags/categories/index follow the
  // stable AssetId to the new path.
  newPath: string
}

export interface AssetMoveRepairResult {
  ok: boolean
  repaired: boolean
  assetId?: string
  oldPath?: string
  newPath?: string
  derivedRebuildGrant?: AssetDerivedRebuildGrant
  error?: string
}

export interface AssetDerivedRebuildGrant {
  token: string
  expiresAt: number
}

export interface AssetDerivedRebuildPreviewResult {
  ok: boolean
  assetId?: string
  recoveryId?: string
  requiresDerivedRebuild?: boolean
  roots?: string[]
  expiresAt?: number
  estimatedBytes?: number
  fileCount?: number
  categories?: Array<{
    id: 'image-search-index' | 'thumbnails' | 'scan-logs' | 'vector-db'
    label: string
    estimatedBytes: number
    fileCount: number
  }>
  error?: string
}

export interface AssetDerivedRebuildStartResult {
  ok: boolean
  scheduled: boolean
  taskId?: number
  error?: string
}

export interface AssetDerivedRebuildCancelResult {
  ok: boolean
  cancelled: boolean
  error?: string
}

export interface AssetRepairRecoveryGrant {
  recoveryId: string
  assetId: string
  oldPath: string
  newPath: string
  state: 'prepared' | 'repairing' | 'awaiting-rebuild' | 'rebuilding' | 'failed'
  lastError?: string
  grant: AssetDerivedRebuildGrant
}

export interface AssetRepairRecoveryListResult {
  ok: boolean
  pending: AssetRepairRecoveryGrant[]
  error?: string
}

export const ASSET_IDENTITY_IPC = {
  RESOLVE: 'catalog:identity/resolve',
  SHADOW_REPORT: 'catalog:identity/shadowReport',
  FILE_OPEN: 'catalog:fileActions/open',
  FILE_REVEAL: 'catalog:fileActions/reveal',
  REPAIR_MOVED: 'catalog:identity/repair',
  DERIVED_REBUILD_PREVIEW: 'catalog:identity/derivedRebuildPreview',
  DERIVED_REBUILD_START: 'catalog:identity/derivedRebuildStart',
  DERIVED_REBUILD_CANCEL: 'catalog:identity/derivedRebuildCancel',
  REPAIR_RECOVERY_LIST: 'catalog:identity/repairRecoveryList',
} as const
