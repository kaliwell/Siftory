import { contextBridge, ipcRenderer } from 'electron'

const GPU_READY_CHANNEL = 'thumbnail-gpu-internal:ready'
const GPU_RESULT_CHANNEL = 'thumbnail-gpu-internal:result'
const GPU_JOB_CHANNEL = 'thumbnail-gpu-internal:job'
const GPU_CANCEL_CHANNEL = 'thumbnail-gpu-internal:cancel'
const MAX_GPU_SOURCE_BYTES = 64 * 1024 * 1024
const MAX_GPU_OUTPUT_BYTES = 8 * 1024 * 1024
const MIN_GPU_DIMENSION = 32
const MAX_GPU_DIMENSION = 256
const GPU_INPUT_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/avif',
  'image/x-icon',
])

interface ThumbnailGpuJob {
  id: number
  bytes: Uint8Array
  mime: string
  maxDim: number
}

interface ThumbnailGpuReady {
  available: boolean
  device?: string
  error?: string
}

interface ThumbnailGpuResult {
  id: number
  ok: boolean
  bytes?: Uint8Array
  mime?: 'image/webp'
  error?: string
}

function boundedText(value: unknown, maximum = 512): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, maximum) : undefined
}

function normalizeJob(value: unknown): ThumbnailGpuJob | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  const id = Number(candidate.id)
  const maxDim = Number(candidate.maxDim)
  const mime = candidate.mime
  const bytes = candidate.bytes
  if (!Number.isSafeInteger(id) || id <= 0) return null
  if (!Number.isInteger(maxDim) || maxDim < MIN_GPU_DIMENSION || maxDim > MAX_GPU_DIMENSION)
    return null
  if (typeof mime !== 'string' || !GPU_INPUT_MIMES.has(mime)) return null
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return null
  if (bytes.byteLength > MAX_GPU_SOURCE_BYTES) return null
  return { id, maxDim, mime, bytes }
}

const bridge = Object.freeze({
  onJob(callback: (job: ThumbnailGpuJob) => void): () => void {
    if (typeof callback !== 'function') return () => undefined
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
      const job = normalizeJob(value)
      if (job) callback(job)
    }
    ipcRenderer.on(GPU_JOB_CHANNEL, listener)
    return () => ipcRenderer.removeListener(GPU_JOB_CHANNEL, listener)
  },
  onCancel(callback: (id: number) => void): () => void {
    if (typeof callback !== 'function') return () => undefined
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
      const id = Number(value)
      if (Number.isSafeInteger(id) && id > 0) callback(id)
    }
    ipcRenderer.on(GPU_CANCEL_CHANNEL, listener)
    return () => ipcRenderer.removeListener(GPU_CANCEL_CHANNEL, listener)
  },
  reportReady(value: ThumbnailGpuReady): void {
    ipcRenderer.send(GPU_READY_CHANNEL, {
      available: value?.available === true,
      device: boundedText(value?.device),
      error: boundedText(value?.error),
    })
  },
  reportResult(value: ThumbnailGpuResult): void {
    const id = Number(value?.id)
    if (!Number.isSafeInteger(id) || id <= 0) return
    const bytes = value?.bytes
    const validBytes = bytes instanceof Uint8Array && bytes.byteLength <= MAX_GPU_OUTPUT_BYTES
    ipcRenderer.send(GPU_RESULT_CHANNEL, {
      id,
      ok: value?.ok === true && validBytes,
      bytes: validBytes ? bytes : undefined,
      mime: validBytes ? 'image/webp' : undefined,
      error: boundedText(value?.error) || (validBytes ? undefined : 'Invalid GPU thumbnail output'),
    })
  },
})

contextBridge.exposeInMainWorld('thumbnailGpuBridge', bridge)
