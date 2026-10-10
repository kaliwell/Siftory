// Application storage inventory IPC contracts.

export type AppStorageScanState = 'idle' | 'scanning' | 'stopping' | 'done' | 'error'

export interface AppStoragePathEntry {
  path: string
  kind: 'app' | 'data' | 'cache' | 'unknown'
  bytes: number
  exists: boolean
  accessible: boolean
  source: string
}

export interface AppStorageEntry {
  id: string
  name: string
  publisher?: string
  version?: string
  installLocation?: string
  uninstallString?: string
  estimatedRegistryBytes?: number
  totalBytes: number
  scannedBytes: number
  dataBytes: number
  cacheBytes: number
  inaccessibleCount: number
  paths: AppStoragePathEntry[]
  tags: string[]
}

export interface AppStorageScanStatus {
  state: AppStorageScanState
  appCount: number
  scannedCount: number
  totalBytes: number
  currentApp?: string
  warnings: number
  errors: number
  message?: string
}

export interface AppStorageScanResult {
  apps: AppStorageEntry[]
  status: AppStorageScanStatus
  savedAt?: number
  cachePath?: string
}
