import path from 'path'
import { readJSON } from './settingsStore'

export type AssetLibraryStorageMode = 'jsonl' | 'sqlite'

const SETTINGS_FILENAME = 'floating_clock_settings.json'
const VECTOR_SETTINGS_FILENAME = 'vector-settings.json'

function normalizeStorageMode(value: unknown): AssetLibraryStorageMode | null {
  return value === 'jsonl' || value === 'sqlite' ? value : null
}

/**
 * Resolves relation storage using option > environment > settings > sqlite.
 * Invalid and retired values fail closed to the authoritative SQLite mode.
 */
export function resolveAssetLibraryStorageMode(
  userDataPath: string,
  override?: string,
): AssetLibraryStorageMode {
  const environmentMode = process.env.FLOATING_CLOCK_ASSET_STORAGE_MODE
  const settingsValue = (() => {
    if (override !== undefined || environmentMode !== undefined) return undefined
    const settings = readJSON(path.join(userDataPath, SETTINGS_FILENAME))
    return settings && typeof settings === 'object'
      ? (settings as Record<string, unknown>).storageMode
      : undefined
  })()
  const candidate = override ?? environmentMode ?? settingsValue ?? 'sqlite'
  const mode = normalizeStorageMode(candidate)
  if (mode) return mode

  console.warn(
    `[AssetLibrary] Invalid storage mode "${String(candidate)}"; falling back to sqlite mode`,
  )
  return 'sqlite'
}

export function resolveAssetReferenceEmbeddingBackend(userDataPath: string): 'cpu' | 'gpu' {
  const settings = readJSON(path.join(userDataPath, VECTOR_SETTINGS_FILENAME))
  return settings &&
    typeof settings === 'object' &&
    (settings as Record<string, unknown>).backend === 'gpu'
    ? 'gpu'
    : 'cpu'
}
