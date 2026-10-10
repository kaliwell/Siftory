import type { ImageSearchDataCatalogProgress } from '../shared/ipc-contract'

export type CatalogVectorLayer = 'dino' | 'clip' | 'mixed'

export interface ImageSearchCatalogVectorSource {
  sourceId: string
  filePath: string
  physicalKey: string
  logicalName: string
  layer: CatalogVectorLayer
  sizeBytes: number
  modifiedAt: number
  sampleSha256: string
}

export interface ImageSearchCatalogNativeSource {
  sourceId: string
  physicalKey: string
  logicalName: string
  sizeBytes: number
  modifiedAt: number
}

export interface ImageSearchCatalogNativeRecord {
  path: string
  width: number
  height: number
  fileSize: number
  modifiedTime: number
  /** Undefined when the fast Native snapshot intentionally skipped source-file stats. */
  exists?: boolean
}

export interface ImageSearchDataCatalogWorkerInput {
  taskId: string
  generation: string
  databasePath: string
  buildMetadataPath: string
  roots: string[]
  nativeRecords: ImageSearchCatalogNativeRecord[]
  nativeSource: ImageSearchCatalogNativeSource
  vectorSources: ImageSearchCatalogVectorSource[]
  sourceSnapshot: string
  /** An immutable committed v2 catalog that may seed an append-only generation. */
  previousDatabasePath?: string
}

export interface ImageSearchDataCatalogSummary {
  generation: string
  builtAt: number
  unionPathCount: number
  nativeUniqueCount: number
  dinoUniqueCount: number
  clipUniqueCount: number
  completeCount: number
  missingDinoCount: number
  missingClipCount: number
  vectorOnlyCount: number
  duplicateRows: number
  malformedRows: number
  folderCount: number
}

export interface ImageSearchDataCatalogWorkerResult {
  generation: string
  databasePath: string
  builtAt: number
  durationMs: number
  summary: ImageSearchDataCatalogSummary
  buildMode: 'full' | 'incremental'
  reusedSourceCount: number
  fullBytesRead: number
  tailBytesRead: number
  changedPathCount: number
  catalogSha256: string
}

export interface ImageSearchDataCatalogWorkerProgressMessage {
  type: 'progress'
  progress: Partial<ImageSearchDataCatalogProgress>
}

export interface ImageSearchDataCatalogWorkerResultMessage {
  type: 'result'
  result: ImageSearchDataCatalogWorkerResult
}

export interface ImageSearchDataCatalogWorkerErrorMessage {
  type: 'error'
  error: string
}

export interface ImageSearchDataCatalogWorkerStoppedMessage {
  type: 'stopped'
}

export type ImageSearchDataCatalogWorkerMessage =
  | ImageSearchDataCatalogWorkerProgressMessage
  | ImageSearchDataCatalogWorkerResultMessage
  | ImageSearchDataCatalogWorkerErrorMessage
  | ImageSearchDataCatalogWorkerStoppedMessage
