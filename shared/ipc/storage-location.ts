/** Stable library identity is independent of a machine's filesystem layout.
 * A future LAN client will use libraryId/sourceId, never the server's disk paths.
 * Only the local backend is implemented; network access is not enabled here.
 */
export interface LibraryAssetLocation {
  libraryId: string
  sourceId: string
  relativePath: string
}

export interface StorageLocationStatus {
  backend: 'local'
  libraryId: string
  root: string
  previousRoot?: string
  pending: boolean
  lastMigration?: { state: 'completed' | 'failed'; at: number }
  externalMediaDirectory: boolean
}

export interface StorageMigrationSelection {
  token: string
  destination: string
}

export const STORAGE_LOCATION_IPC = {
  STATUS: 'appStorage:getLocation',
  SELECT: 'appStorage:selectMigrationDestination',
  START: 'appStorage:startMigration',
} as const
