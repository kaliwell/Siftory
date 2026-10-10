export interface VectorGcShardPreview {
  name: string
  sourceBytes: number
  totalRecords: number
  activeRecords: number
  staleRecords: number
  duplicateRecords: number
  malformedRecords: number
  predictedBytes: number
  reclaimableBytes: number
  modelName?: string
  embeddingType?: string
  dim?: number
}

export interface VectorGcPreview {
  token: string
  createdAt: number
  expiresAt: number
  activeAssetCount: number
  shards: VectorGcShardPreview[]
  reclaimableBytes: number
}

export interface VectorGcProgress {
  taskId?: string
  state: 'idle' | 'running' | 'completed' | 'cancelled' | 'error'
  completedShards: number
  totalShards: number
  currentShard?: string
  freedBytes: number
  pendingReleaseBytes: number
  backups: number
  errors: string[]
  startedAt?: number
  updatedAt?: number
  finishedAt?: number
}

export interface VectorStoreMigrationModelPreview {
  modelName: string
  embeddingType: string
  dim: number
  sourceBytes: number
  estimatedBinaryBytes: number
  alreadyCurrent: boolean
}

export interface VectorStoreMigrationPreview {
  token: string
  createdAt: number
  expiresAt: number
  currentGeneration?: string
  models: VectorStoreMigrationModelPreview[]
  sourceBytes: number
  estimatedBinaryBytes: number
}

export interface VectorStoreMigrationProgress {
  taskId?: string
  state: 'idle' | 'running' | 'completed' | 'cancelled' | 'error'
  completedModels: number
  totalModels: number
  currentModel?: string
  writtenBytes: number
  generation?: string
  errors: string[]
  startedAt?: number
  updatedAt?: number
  finishedAt?: number
}
