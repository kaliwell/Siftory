/**
 * Shared settings writer — serializes writes from multiple hooks so they
 * never race on the same JSON file.
 *
 * Problem: useAutoSaveSettings and useAutoSaveFMSettings independently run
 * loadSettings → merge → saveSettings, each with its own inflight chain.
 * When both fire, the later write can overwrite the earlier one, losing data.
 *
 * Solution: single module-level accumulator + debounce + inflight chain.
 *
 * Usage:
 *   import { scheduleSettingsWrite } from './settingsWriter'
 *   // Inside your hook:
 *   scheduleSettingsWrite({ theme: themeIdx, showDate, ... })
 */

import type { AppSettingsData } from '../../shared/ipc-contract'

type SettingsData = Partial<AppSettingsData>

let writeChain: Promise<void> = Promise.resolve()
let pendingData: SettingsData | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function flush(): void {
  const data = pendingData
  pendingData = null
  if (!data || Object.keys(data).length === 0) return

  writeChain = writeChain.then(async () => {
    try {
      const existing = await window.electronAPI.loadSettings()
      await window.electronAPI.saveSettings({ ...(existing || {}), ...data })
    } catch (e: unknown) {
      console.error('[settingsWriter] Failed to save settings:', errorMessage(e))
    }
  })
}

/**
 * Schedule a merged write of partial settings data.
 *
 * - Accumulates data from multiple callers into a single pending payload.
 * - Debounces writes 500ms after the last call.
 * - Serializes writes through a single promise chain so no race occurs.
 */
export function scheduleSettingsWrite(data: SettingsData): void {
  pendingData = { ...(pendingData || {}), ...data }

  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(flush, 500)
}

/** Flush pending settings immediately and wait until the atomic disk write completes. */
export async function flushSettingsWrites(): Promise<void> {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  flush()
  await writeChain
}
