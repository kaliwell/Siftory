import type { AppSettingsData } from '../../shared/ipc-contract'

export type PersistedPanelKey =
  | 'clock'
  | 'folders'
  | 'prompts'
  | 'settings'
  | 'calc'
  | 'fm'
  | 'imageSearch'
  | 'unifiedSearch'
  | 'appStorage'
  | 'remoteTerminal'
  | 'duplicateFinder'
  | 'mediaSearch'
  | 'assetLibrary'
  | 'batchRename'

type DirectVisibilityKey =
  | 'showClock'
  | 'showFolders'
  | 'showPrompts'
  | 'showSettings'
  | 'showCalc'
  | 'showFM'
  | 'showImageSearch'
  | 'showUnifiedSearch'
  | 'showAppStorage'
  | 'showRemoteTerminal'
  | 'showDuplicateFinder'
  | 'showMediaSearch'
  | 'showAssetLibrary'
  | 'showBatchRename'

export function resolvePanelVisibility(
  settings: AppSettingsData,
  savedKey: PersistedPanelKey,
  directKey: DirectVisibilityKey,
  fallback: boolean,
): boolean {
  const directValue = settings[directKey]
  if (settings.globalVisible === false) {
    return settings.savedVisibility?.[savedKey] ?? directValue ?? fallback
  }
  return directValue ?? fallback
}
