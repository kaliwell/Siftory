import { useEffect } from 'react'
import { useStore } from '../stores/useStore'
import { scheduleSettingsWrite } from './settingsWriter'

/**
 * Auto-saves app settings whenever relevant store fields change.
 *
 * Uses a single zustand subscription (NOT 25+ individual selector hooks)
 * so panel drags don't trigger dozens of wasted React re-renders.
 * The hook itself renders nothing — it only schedules disk writes.
 */
export function useAutoSaveSettings(ready: boolean): void {
  useEffect(() => {
    if (!ready) return
    let previous: Record<string, unknown> | undefined

    // The writer already debounces disk I/O. Capture every update here so the final
    // checkbox or position change cannot be discarded by a leading-edge throttle.
    const save = () => {
      // Earlier subscribers may reconcile a legacy visibility change synchronously.
      const state = useStore.getState()
      const settings = {
        panelSizeDefaultsVersion: state.panelSizeDefaultsVersion,
        panelVisibilityDefaultsVersion: state.panelVisibilityDefaultsVersion,
        language: state.language,
        theme: state.themeIdx,
        themeId: state.themeId,
        themeMode: state.themeMode,
        showDate: state.showDate,
        transparency: state.transparency,
        fontScaleIdx: state.fontScaleIdx,
        linkedMove: state.linkedMove,
        displayScope: state.displayScope,
        workspaceNavigatorPos: state.workspaceNavigatorPos,
        clockPos: state.clockPos,
        foldersPos: state.foldersPos,
        promptsPos: state.promptsPos,
        settingsPos: state.settingsPos,
        calcPos: state.calcPos,
        clockSize: state.clockSize,
        foldersSize: state.foldersSize,
        promptsSize: state.promptsSize,
        settingsSize: state.settingsSize,
        calcSize: state.calcSize,
        fmPos: state.fmPos,
        fmSize: state.fmSize,
        imageSearchPos: state.imageSearchPos,
        imageSearchSize: state.imageSearchSize,
        unifiedSearchPos: state.unifiedSearchPos,
        unifiedSearchSize: state.unifiedSearchSize,
        appStoragePos: state.appStoragePos,
        appStorageSize: state.appStorageSize,
        remoteTerminalPos: state.remoteTerminalPos,
        remoteTerminalSize: state.remoteTerminalSize,
        dupFinderPos: state.dupFinderPos,
        dupFinderSize: state.dupFinderSize,
        mediaSearchPos: state.mediaSearchPos,
        mediaSearchSize: state.mediaSearchSize,
        assetLibraryPos: state.assetLibraryPos,
        assetLibrarySize: state.assetLibrarySize,
        batchRenamePos: state.batchRenamePos,
        batchRenameSize: state.batchRenameSize,
        showClock: state.showClock,
        showFolders: state.showFolders,
        showPrompts: state.showPrompts,
        showSettings: state.showSettings,
        showCalc: state.showCalc,
        showFM: state.showFM,
        showImageSearch: state.showImageSearch,
        showUnifiedSearch: state.showUnifiedSearch,
        showAppStorage: state.showAppStorage,
        showRemoteTerminal: state.showRemoteTerminal,
        showDuplicateFinder: state.showDuplicateFinder,
        showMediaSearch: state.showMediaSearch,
        showAssetLibrary: state.showAssetLibrary,
        showBatchRename: state.showBatchRename,
        manifestPath: state.manifestPath,
        recentManifests: state.recentManifests,
        imageSearchScanPaths: state.imageSearchScanPaths,
        imageSearchUiPreferences: state.imageSearchUiPreferences,
        mediaSearchUiPreferences: state.mediaSearchUiPreferences,
        globalVisible: state.globalVisible,
        savedVisibility: state.savedVisibility,
      }
      if (
        previous &&
        Object.entries(settings).every(([key, value]) => Object.is(value, previous![key]))
      )
        return
      previous = settings

      scheduleSettingsWrite(settings)
    }
    // Persist the canonical startup view even when the user makes no further edits.
    save()
    const unsub = useStore.subscribe(save)

    return unsub
  }, [ready])
}
