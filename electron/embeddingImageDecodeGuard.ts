import fs from 'node:fs/promises'
import { decodeEmbeddingInput } from '../shared/embeddingInputFailure'
import { readEmbeddingImageHeader } from './embeddingImageHeader'

/** Keep unsupported JPEG encodings away from native decoders. A worker crash
 * is never reclassified here; only independently inspected header facts count.
 * The normal decoder retains responsibility for all inconclusive inspections.
 */
export async function decodeEmbeddingImageInput<T>(
  imagePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  return decodeEmbeddingInput(async () => {
    const handle = await fs.open(imagePath, 'r')
    try {
      const before = await handle.stat()
      if (before.isFile()) {
        const header = await readEmbeddingImageHeader(handle, before.size)
        if (header?.format === 'jpeg' && header.unsupported) {
          const after = await handle.stat()
          const current = await fs.stat(imagePath)
          if (
            before.size === after.size &&
            before.mtimeMs === after.mtimeMs &&
            before.size === current.size &&
            before.mtimeMs === current.mtimeMs &&
            before.ino === current.ino &&
            before.dev === current.dev
          ) {
            throw new Error(
              `jpegload: JPEG header uses unsupported encoding (${header.encoding}, ${header.depth}-bit)`,
            )
          }
        }
      }
    } finally {
      await handle.close()
    }
    return operation()
  })
}
