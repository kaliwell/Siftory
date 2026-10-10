export interface EmbeddingChildMemorySample {
  rssBytes: number
  privateBytes: number | null
  externalBytes: number
  arrayBuffersBytes: number
}

type MemoryProcess = Pick<NodeJS.Process, 'memoryUsage'> & {
  getProcessMemoryInfo?: () => Promise<{ private: number; residentSet: number }>
}

export async function captureEmbeddingChildMemory(
  target: MemoryProcess = process as MemoryProcess,
): Promise<EmbeddingChildMemorySample> {
  const usage = target.memoryUsage()
  let privateBytes: number | null = null
  try {
    const native = target.getProcessMemoryInfo ? await target.getProcessMemoryInfo() : null
    if (native && Number.isFinite(native.private) && native.private >= 0) {
      privateBytes = Math.floor(native.private * 1024)
    }
  } catch {
    privateBytes = null
  }
  return {
    rssBytes: Math.max(0, Math.floor(usage.rss)),
    privateBytes,
    externalBytes: Math.max(0, Math.floor(usage.external)),
    arrayBuffersBytes: Math.max(0, Math.floor(usage.arrayBuffers)),
  }
}

export function peakEmbeddingChildMemory(
  first: EmbeddingChildMemorySample,
  second: EmbeddingChildMemorySample,
): EmbeddingChildMemorySample {
  return {
    rssBytes: Math.max(first.rssBytes, second.rssBytes),
    privateBytes:
      first.privateBytes === null && second.privateBytes === null
        ? null
        : Math.max(first.privateBytes ?? 0, second.privateBytes ?? 0),
    externalBytes: Math.max(first.externalBytes, second.externalBytes),
    arrayBuffersBytes: Math.max(first.arrayBuffersBytes, second.arrayBuffersBytes),
  }
}

export function estimateDecodedImageBytes(value: unknown): number {
  const images = Array.isArray(value) ? value : [value]
  let total = 0
  for (const image of images) {
    if (!image || typeof image !== 'object') continue
    const candidate = image as {
      data?: unknown
      width?: unknown
      height?: unknown
      channels?: unknown
    }
    const data = candidate.data
    let bytes = 0
    if (ArrayBuffer.isView(data)) bytes = data.byteLength
    else if (
      Number.isSafeInteger(candidate.width) &&
      Number.isSafeInteger(candidate.height) &&
      Number.isSafeInteger(candidate.channels) &&
      (candidate.width as number) > 0 &&
      (candidate.height as number) > 0 &&
      (candidate.channels as number) > 0
    ) {
      bytes =
        (candidate.width as number) * (candidate.height as number) * (candidate.channels as number)
    }
    total += bytes
    if (!Number.isSafeInteger(total)) return Number.MAX_SAFE_INTEGER
  }
  return total
}
