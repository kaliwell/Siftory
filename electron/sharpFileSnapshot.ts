import fs from 'node:fs/promises'
import { constants } from 'node:buffer'

/** Keep disappearing paths out of sharp's native missing-file error path. */
export async function readSharpFileSnapshot(
  filePath: string,
  maxBytes = constants.MAX_LENGTH,
): Promise<Buffer> {
  const file = await fs.open(filePath, 'r')
  try {
    const before = await file.stat()
    if (!before.isFile()) throw new Error('Image source must be a regular file')
    if (
      !Number.isSafeInteger(before.size) ||
      before.size <= 0 ||
      before.size > Math.min(maxBytes, constants.MAX_LENGTH)
    )
      throw new Error('Invalid image source size')
    // Read only the observed size: a growing source cannot cause an unbounded read.
    const bytes = Buffer.allocUnsafe(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        Math.min(1024 * 1024, bytes.length - offset),
        offset,
      )
      if (!bytesRead) throw new Error('Image source changed while reading')
      offset += bytesRead
    }
    const after = await file.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error('Image source changed while reading')
    return bytes
  } finally {
    await file.close()
  }
}
