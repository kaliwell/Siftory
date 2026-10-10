import { spawnSync } from 'child_process'

const MIB = 1024 * 1024
const GIB = 1024 * MIB

export type EmbeddingBatchMode = 'auto' | 'manual' | 'default'

export interface EmbeddingMemorySnapshot {
  freeSystemMemoryBytes: number
  totalSystemMemoryBytes: number
  freeVideoMemoryBytes?: number
  totalVideoMemoryBytes?: number
}

export interface EmbeddingBatchSelection {
  batchSize: 4 | 8 | 16 | number
  mode: EmbeddingBatchMode
  reason: string
  memory: EmbeddingMemorySnapshot
}

interface EmbeddingBatchSelectionOptions extends EmbeddingMemorySnapshot {
  requestedBatchSize?: number
  backend: 'cpu' | 'gpu' | 'cuda'
  modelName: string
  maxConcurrency: number
}

function positiveBytes(value: number | undefined): number | undefined {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : undefined
}

function estimatedSystemWorkingSetBytes(
  modelName: string,
  batchSize: 8 | 16,
  maxConcurrency: number,
): number {
  const isClip = modelName === 'clip_vit_base_patch32'
  const twoWorkerGiB = batchSize === 16 ? (isClip ? 2.05 : 1.75) : isClip ? 1.75 : 1.55
  const workerFactor = Math.max(1, Math.min(2, maxConcurrency)) / 2
  return twoWorkerGiB * workerFactor * GIB
}

function estimatedVideoMemoryBytes(modelName: string, batchSize: 8 | 16): number {
  const isClip = modelName === 'clip_vit_base_patch32'
  if (batchSize === 16) return (isClip ? 2304 : 2048) * MIB
  return (isClip ? 1536 : 1280) * MIB
}

/**
 * Selects an embedding batch without changing explicit user values. Auto mode
 * uses measured DINO/CLIP working-set envelopes and preserves system/GPU
 * headroom. Missing VRAM telemetry is allowed, but never bypasses the RAM gate.
 */
export function selectEmbeddingBatchSize(
  options: EmbeddingBatchSelectionOptions,
): EmbeddingBatchSelection {
  const memory: EmbeddingMemorySnapshot = {
    freeSystemMemoryBytes: Math.max(0, options.freeSystemMemoryBytes),
    totalSystemMemoryBytes: Math.max(0, options.totalSystemMemoryBytes),
    freeVideoMemoryBytes: positiveBytes(options.freeVideoMemoryBytes),
    totalVideoMemoryBytes: positiveBytes(options.totalVideoMemoryBytes),
  }
  const requested = options.requestedBatchSize
  if (Number.isFinite(requested) && (requested as number) > 0) {
    return {
      batchSize: Math.max(1, Math.min(16, Math.floor(requested as number))),
      mode: 'manual',
      reason: 'explicit-user-value',
      memory,
    }
  }
  if (requested !== 0) {
    return { batchSize: 4, mode: 'default', reason: 'legacy-default', memory }
  }
  if (options.backend !== 'gpu') {
    return {
      batchSize: 4,
      mode: 'auto',
      reason: `${options.backend}-auto-conservative`,
      memory,
    }
  }

  const systemReserve = Math.max(3 * GIB, memory.totalSystemMemoryBytes * 0.18)
  const videoReserve = 768 * MIB
  const candidates: Array<8 | 16> = [16, 8]
  for (const candidate of candidates) {
    const systemRequired =
      systemReserve +
      estimatedSystemWorkingSetBytes(options.modelName, candidate, options.maxConcurrency)
    const minimumFreeRatio = candidate === 16 ? 0.3 : 0.25
    const systemRatio =
      memory.totalSystemMemoryBytes > 0
        ? memory.freeSystemMemoryBytes / memory.totalSystemMemoryBytes
        : 0
    const systemSafe =
      memory.freeSystemMemoryBytes >= systemRequired && systemRatio >= minimumFreeRatio
    const videoSafe =
      memory.freeVideoMemoryBytes === undefined ||
      memory.freeVideoMemoryBytes >=
        estimatedVideoMemoryBytes(options.modelName, candidate) + videoReserve
    if (systemSafe && videoSafe) {
      return {
        batchSize: candidate,
        mode: 'auto',
        reason: `auto-${candidate}-memory-headroom`,
        memory,
      }
    }
  }
  return { batchSize: 4, mode: 'auto', reason: 'auto-4-memory-guard', memory }
}

export function parseNvidiaSmiMemory(output: string): {
  freeVideoMemoryBytes: number
  totalVideoMemoryBytes: number
} | null {
  const rows = output
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(',').map((value) => Number(value.trim())))
    .filter(
      (row): row is [number, number] =>
        row.length >= 2 &&
        Number.isFinite(row[0]) &&
        row[0] > 0 &&
        Number.isFinite(row[1]) &&
        row[1] > 0,
    )
  if (rows.length === 0) return null
  const selected = rows.reduce((best, row) => (row[0] > best[0] ? row : best))
  return {
    freeVideoMemoryBytes: Math.floor(selected[0] * MIB),
    totalVideoMemoryBytes: Math.floor(selected[1] * MIB),
  }
}

export function readNvidiaVideoMemory(): {
  freeVideoMemoryBytes: number
  totalVideoMemoryBytes: number
} | null {
  if (process.platform !== 'win32') return null
  try {
    const result = spawnSync(
      'nvidia-smi.exe',
      ['--query-gpu=memory.free,memory.total', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', timeout: 1500, windowsHide: true },
    )
    return result.status === 0 ? parseNvidiaSmiMemory(result.stdout || '') : null
  } catch {
    return null
  }
}
