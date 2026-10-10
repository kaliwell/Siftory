export interface ThumbnailGpuResourceDecision {
  lanes: number
  inFlightSourceBytes: number
  reason: 'memory-pressure' | 'default' | 'high-headroom'
}

const GIB = 1024 ** 3

export function decideThumbnailGpuResources(input: {
  requestedLanes: number
  totalSystemMemoryBytes: number
  freeSystemMemoryBytes: number
}): ThumbnailGpuResourceDecision {
  const requested = Math.max(1, Math.min(8, Math.floor(input.requestedLanes) || 1))
  const freeRatio =
    input.totalSystemMemoryBytes > 0
      ? input.freeSystemMemoryBytes / input.totalSystemMemoryBytes
      : 0
  if (input.freeSystemMemoryBytes < 3 * GIB || freeRatio < 0.18) {
    return { lanes: 1, inFlightSourceBytes: 64 * 1024 ** 2, reason: 'memory-pressure' }
  }
  if (input.totalSystemMemoryBytes >= 32 * GIB && input.freeSystemMemoryBytes >= 12 * GIB) {
    return {
      lanes: Math.min(4, requested),
      inFlightSourceBytes: 128 * 1024 ** 2,
      reason: 'high-headroom',
    }
  }
  return {
    lanes: Math.min(2, requested),
    inFlightSourceBytes: 96 * 1024 ** 2,
    reason: 'default',
  }
}
