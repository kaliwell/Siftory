import type { AppSettingsData } from '../../shared/ipc-contract'

type SettingsData = Partial<AppSettingsData>
export type SettingsWriteStatus = 'saved' | 'pending' | 'error'

let pendingData: SettingsData | null = null
let inFlight: Promise<void> | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let retryCount = 0
let status: SettingsWriteStatus = 'saved'
const listeners = new Set<() => void>()
const RETRY_DELAYS = [1000, 3000]

function setStatus(next: SettingsWriteStatus): void {
  if (status === next) return
  status = next
  for (const listener of listeners) listener()
}

export function getSettingsWriteStatus(): SettingsWriteStatus {
  return status
}

export function subscribeSettingsWriteStatus(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function clearTimer(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
}

function scheduleFlush(delay: number): void {
  clearTimer()
  timer = setTimeout(() => {
    timer = null
    // Autosave failures are exposed by the shared status and retain their data.
    void flushSettingsWrites().catch(() => {})
  }, delay)
}

function writePending(): Promise<void> {
  if (inFlight) return inFlight
  const data = pendingData
  if (!data) return Promise.resolve()
  pendingData = null
  setStatus('pending')

  inFlight = Promise.resolve()
    .then(async () => {
      const existing = await window.electronAPI.loadSettings()
      await window.electronAPI.saveSettings({ ...(existing || {}), ...data })
      retryCount = 0
      setStatus(pendingData ? 'pending' : 'saved')
    })
    .catch(() => {
      // A newer edit wins over an older failed write, even across different hooks.
      pendingData = { ...data, ...(pendingData || {}) }
      setStatus('error')
      if (retryCount < RETRY_DELAYS.length) scheduleFlush(RETRY_DELAYS[retryCount++])
      throw new Error('Could not save local settings')
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/** Merge callers' edits and debounce disk I/O; keep failed edits until a later success. */
export function scheduleSettingsWrite(data: SettingsData): void {
  if (Object.keys(data).length === 0) return
  pendingData = { ...(pendingData || {}), ...data }
  retryCount = 0
  if (status !== 'error') setStatus('pending')
  scheduleFlush(500)
}

/** Drain edits, including edits queued during a write; reject if any disk write fails. */
export async function flushSettingsWrites(): Promise<void> {
  clearTimer()
  while (pendingData || inFlight) await writePending()
  clearTimer()
}
