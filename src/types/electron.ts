// ── Re-exports from the canonical IPC contract ──────────────
// Do NOT add types here — edit shared/ipc-contract.ts instead.

export type {
  FileEntry,
  DirListing,
  FMResult,
  FMProgress,
  ThumbnailResult,
  ElectronAPI,
  DupGroup,
  DupScanProgress,
  LargestFile,
  DupScanOptions,
} from '../../shared/ipc-contract'

// Vector / Rerank types
export type {
  ModelStatus,
  ModelInfo,
  ModelState,
  EmbeddingEntry,
  EmbeddingJob,
  EmbeddingProgress,
  VectorSearchResult,
  LayeredSearchRequest,
  LayeredSearchResponse,
  LayeredSearchResult,
  SearchMode,
  MatchLevel,
  FeatureExtractRequest,
  FeatureExtractProgress,
  VectorBuildRequest,
  VectorBuildProgress,
  VectorSettings,
} from '../../shared/vectorTypes'
