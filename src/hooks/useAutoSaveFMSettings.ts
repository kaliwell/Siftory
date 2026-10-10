import { useEffect, useRef } from 'react'
import { useStore } from '../stores/useStore'
import { useFMStore } from '../stores/useFMStore'
import { scheduleSettingsWrite } from './settingsWriter'

/**
 * Auto-saves File Manager settings whenever FM store fields change.
 *
 * Uses zustand subscribe (no React re-renders) for both stores,
 * since FM state lives in useFMStore but showFM lives in useStore.
 */
export function useAutoSaveFMSettings(): void {
  const prevRef = useRef('')
  const skipFirst = useRef(true)

  useEffect(() => {
    const flush = () => {
      if (skipFirst.current) {
        skipFirst.current = false
        return
      }

      const appState = useStore.getState()
      const fmState = useFMStore.getState()

      const data = {
        showFM: appState.showFM,
        fmLayout: fmState.fmLayout,
        fmPaneTabs: fmState.fmPaneTabs,
        fmActiveTab: fmState.fmActiveTab,
        fmPaneSorts: fmState.fmPaneSorts,
        fmShowHidden: fmState.fmShowHidden,
        fmFavorites: fmState.fmFavorites,
        fmViewModes: fmState.fmViewModes,
        fmGroupModes: fmState.fmGroupModes,
        fmGroupExpanded: fmState.fmGroupExpanded,
        fmFontScale: fmState.fmFontScale,
      }
      const snapshot = JSON.stringify(data)
      if (snapshot === prevRef.current) return
      prevRef.current = snapshot

      scheduleSettingsWrite(data)
    }

    const unsub1 = useStore.subscribe(flush)
    const unsub2 = useFMStore.subscribe(flush)

    return () => {
      unsub1()
      unsub2()
    }
  }, [])
}
