import fs from 'fs'
import path from 'path'
import { Worker } from 'worker_threads'
import { app } from 'electron'
import type { DupGroup, DupScanProgress, LargestFile, DupScanOptions } from '../shared/ipc-contract'

type ProgressCallback = (progress: DupScanProgress) => void
type WorkerRequest =
  | { kind: 'duplicates'; dirPath: string; minSize: number }
  | { kind: 'largest'; dirPath: string; topN: number }
type WorkerMessage =
  | { type: 'progress'; progress: DupScanProgress }
  | { type: 'duplicates-result'; groups: DupGroup[]; progress: DupScanProgress }
  | { type: 'largest-result'; files: LargestFile[]; progress: DupScanProgress }
  | { type: 'stopped' }
  | { type: 'error'; error: string }

let activeWorker: Worker | null = null
let stopView: Int32Array | null = null
let progress: DupScanProgress = { state: 'done', scanned: 0, totalBytes: 0, duplicates: 0 }
let dupGroups: DupGroup[] = []

async function validateDirectory(dirPath: string): Promise<string | null> {
  try {
    const resolved = path.resolve(dirPath)
    const stat = await fs.promises.stat(resolved)
    return stat.isDirectory() ? resolved : null
  } catch {
    return null
  }
}

function workerPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'duplicateFinderWorker.js')
    : path.join(__dirname, 'duplicateFinderWorker.js')
}

function launchWorker(
  request: WorkerRequest,
  callback: ProgressCallback,
  onMessage: (message: WorkerMessage) => void,
): Worker {
  const stopBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  stopView = new Int32Array(stopBuffer)
  const worker = new Worker(workerPath(), { workerData: { request, stopBuffer } })
  activeWorker = worker

  worker.on('message', (message: WorkerMessage) => {
    if (message.type === 'progress') {
      progress = message.progress
      callback({ ...progress })
    }
    onMessage(message)
  })
  return worker
}

function clearWorker(worker: Worker): void {
  if (activeWorker === worker) {
    activeWorker = null
    stopView = null
  }
}

export async function startDuplicateScan(
  opts: DupScanOptions,
  callback: ProgressCallback,
): Promise<{ ok: boolean; error?: string }> {
  if (activeWorker) return { ok: false, error: 'Scan already running' }
  const dirPath = await validateDirectory(opts.dirPath)
  if (!dirPath) return { ok: false, error: 'Directory not found' }

  dupGroups = []
  progress = { state: 'scanning', scanned: 0, totalBytes: 0, duplicates: 0 }
  callback({ ...progress })

  let terminalMessage = false
  const worker = launchWorker(
    { kind: 'duplicates', dirPath, minSize: Math.max(0, opts.minSize ?? 1024) },
    callback,
    (message) => {
      if (message.type === 'duplicates-result') {
        terminalMessage = true
        dupGroups = message.groups
        progress = message.progress
        callback({ ...progress })
      } else if (message.type === 'stopped') {
        terminalMessage = true
        progress = { ...progress, state: 'stopped', currentPath: undefined }
        callback({ ...progress })
      } else if (message.type === 'error') {
        terminalMessage = true
        progress = { ...progress, state: 'error', error: message.error, currentPath: undefined }
        callback({ ...progress })
      }
    },
  )
  worker.once('error', (error) => {
    terminalMessage = true
    progress = { ...progress, state: 'error', error: String(error), currentPath: undefined }
    callback({ ...progress })
    clearWorker(worker)
  })
  worker.once('exit', (code) => {
    if (!terminalMessage && code !== 0) {
      progress = { ...progress, state: 'error', error: `Scan worker exited (${code})` }
      callback({ ...progress })
    }
    clearWorker(worker)
  })
  return { ok: true }
}

export function stopDuplicateScan(): { ok: boolean } {
  if (stopView) Atomics.store(stopView, 0, 1)
  return { ok: true }
}

export function getDupProgress(): DupScanProgress {
  return { ...progress }
}

export function getDupResults(): { groups: DupGroup[] } {
  return { groups: dupGroups }
}

export async function findLargestFiles(
  rawDirPath: string,
  topN: number,
  callback: ProgressCallback,
): Promise<{ ok: boolean; files: LargestFile[]; error?: string }> {
  if (activeWorker) return { ok: false, files: [], error: 'Scan already running' }
  const dirPath = await validateDirectory(rawDirPath)
  if (!dirPath) return { ok: false, files: [], error: 'Directory not found' }

  progress = { state: 'scanning', scanned: 0, totalBytes: 0, duplicates: 0 }
  callback({ ...progress })

  return new Promise((resolve) => {
    let settled = false
    const finish = (result: { ok: boolean; files: LargestFile[]; error?: string }) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const worker = launchWorker(
      { kind: 'largest', dirPath, topN: Math.max(1, Math.min(500, topN)) },
      callback,
      (message) => {
        if (message.type === 'largest-result') {
          progress = message.progress
          callback({ ...progress })
          finish({ ok: true, files: message.files })
        } else if (message.type === 'stopped') {
          progress = { ...progress, state: 'stopped', currentPath: undefined }
          callback({ ...progress })
          finish({ ok: false, files: [], error: 'Scan stopped' })
        } else if (message.type === 'error') {
          progress = { ...progress, state: 'error', error: message.error, currentPath: undefined }
          callback({ ...progress })
          finish({ ok: false, files: [], error: message.error })
        }
      },
    )
    worker.once('error', (error) => {
      clearWorker(worker)
      finish({ ok: false, files: [], error: String(error) })
    })
    worker.once('exit', (code) => {
      clearWorker(worker)
      if (!settled) finish({ ok: false, files: [], error: `Scan worker exited (${code})` })
    })
  })
}
