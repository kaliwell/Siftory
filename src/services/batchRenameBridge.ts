// ── Batch Rename Bridge ──────────────────────────────────
// Frontend wrapper for batch rename IPC calls.

import type {
  BatchRenameProgress,
  BatchRenameResult,
  BatchRenameStartRequest,
  BatchRenameStartResponse,
} from '../../shared/ipc-contract'

export const batchRenameBridge = {
  start: (req: BatchRenameStartRequest): Promise<BatchRenameStartResponse> =>
    window.electronAPI.batchRename.start(req),

  stop: (): Promise<{ ok: boolean }> => window.electronAPI.batchRename.stop(),

  getProgress: (): Promise<BatchRenameProgress | null> =>
    window.electronAPI.batchRename.getProgress(),

  getResult: (): Promise<BatchRenameResult | null> => window.electronAPI.batchRename.getResult(),

  selectFolder: (): Promise<string | null> => window.electronAPI.batchRename.selectFolder(),

  onProgress: (cb: (progress: BatchRenameProgress) => void): (() => void) =>
    window.electronAPI.batchRename.onProgress(cb),
}
