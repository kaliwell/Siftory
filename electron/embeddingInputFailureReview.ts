import fs from 'node:fs/promises'
import { readEmbeddingImageHeader } from './embeddingImageHeader'

const DINO_MAX_PIXELS = Math.floor((256 * 1024 * 1024) / 3)
const DEFAULT_MAX_PIXELS = 268_402_689

export interface FailedEmbeddingInput {
  inputPath?: string
  inputFailure?: boolean
  error?: string
  modelName: string
}

export interface EmbeddingInputRejection {
  code:
    | 'INPUT_NOT_SUPPORTED'
    | 'INPUT_INVALID_HEADER'
    | 'INPUT_PIXEL_LIMIT'
    | 'INPUT_DECODE_REJECTED'
  format: string
  sizeBytes: number
  width?: number
  height?: number
  depth?: number
  encoding?: string
}

// Never turn runtime/provider/persistence failures into skipped inputs, even
// when their source happens to be an unsupported image. Unknown errors require
// independent header evidence; a normal supported header is not sufficient.
export function isEmbeddingInputFailureCandidate(error?: string): boolean {
  if (
    !error ||
    /cuda|directml|onnx|execution provider|inference|tensor|model|worker|child|persist|database|disk|enospc|eacces|eperm|enomem|bad_alloc|out of memory/i.test(
      error,
    )
  )
    return false
  return (
    /^(?:Unknown error|Input buffer is empty|Input (?:buffer|file) contains unsupported image format|Input image exceeds pixel limit)$/i.test(
      error.trim(),
    ) ||
    /(?:^|\n)(?:VipsJpeg:|jpegload(?:_buffer)?:|vipspng:|pngload(?:_buffer)?:|gifload:|webpload:|tiffload:)/i.test(
      error,
    )
  )
}

export async function recheckEmbeddingInputFailure(
  input: FailedEmbeddingInput,
): Promise<EmbeddingInputRejection | null> {
  if (
    !input.inputPath ||
    input.inputFailure !== true ||
    !isEmbeddingInputFailureCandidate(input.error)
  )
    return null
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(input.inputPath, 'r')
    const before = await handle.stat()
    if (!before.isFile()) return null
    const header = await readEmbeddingImageHeader(handle, before.size)
    if (!header) return null
    const after = await handle.stat()
    const current = await fs.stat(input.inputPath)
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      current.size !== before.size ||
      current.mtimeMs !== before.mtimeMs ||
      current.ino !== before.ino ||
      current.dev !== before.dev
    )
      return null
    let code: EmbeddingInputRejection['code'] | undefined
    if (header.unsupported) code = 'INPUT_NOT_SUPPORTED'
    else if (header.invalid) code = 'INPUT_INVALID_HEADER'
    else if (
      /pixel limit/i.test(input.error!) &&
      header.width &&
      header.height &&
      header.width * header.height >
        (input.modelName.startsWith('dino') ? DINO_MAX_PIXELS : DEFAULT_MAX_PIXELS)
    )
      code = 'INPUT_PIXEL_LIMIT'
    else if (
      /(?:^|\n)(?:VipsJpeg:|jpegload(?:_buffer)?:|vipspng:|pngload(?:_buffer)?:|gifload:|webpload:|tiffload:)/i.test(
        input.error!,
      ) ||
      /^Input (?:buffer|file) contains unsupported image format$/i.test(input.error!)
    )
      code = 'INPUT_DECODE_REJECTED'
    if (!code) return null
    return {
      code,
      format: header.format,
      sizeBytes: before.size,
      width: header.width,
      height: header.height,
      depth: header.depth,
      encoding: header.encoding,
    }
  } catch {
    // Missing/denied files or failed inspection are not proof of bad input.
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

export async function reviewEmbeddingInputFailures<T extends FailedEmbeddingInput>(
  inputs: readonly T[],
  isCancelled: () => boolean,
): Promise<Array<{ input: T; rejection: EmbeddingInputRejection | null }>> {
  const results = new Array<{ input: T; rejection: EmbeddingInputRejection | null }>(inputs.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(4, inputs.length) }, async () => {
      while (!isCancelled()) {
        const index = cursor++
        if (index >= inputs.length) return
        results[index] = {
          input: inputs[index],
          rejection: await recheckEmbeddingInputFailure(inputs[index]),
        }
      }
    }),
  )
  return results.filter(Boolean)
}
