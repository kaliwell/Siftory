import fs from 'fs'
import fsp from 'fs/promises'

function readRange(fd: number, offset: number, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const buffer = Buffer.alloc(length)
    fs.read(fd, buffer, 0, length, offset, (error, bytesRead) => {
      if (error) return reject(error)
      resolve(bytesRead < length ? buffer.subarray(0, bytesRead) : buffer)
    })
  })
}

export async function extractPsdThumbnailPreview(filePath: string): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined
  try {
    handle = await fsp.open(filePath, 'r')
    const header = await readRange(handle.fd, 0, 26)
    if (header.length < 26 || header.readUInt32BE(0) !== 0x38425053) return null

    let offset = 26
    let buffer = await readRange(handle.fd, offset, 4)
    if (buffer.length < 4) return null
    const colorModeLength = buffer.readUInt32BE(0)
    offset += 4 + colorModeLength

    buffer = await readRange(handle.fd, offset, 4)
    if (buffer.length < 4) return null
    const resourcesLength = buffer.readUInt32BE(0)
    offset += 4
    if (resourcesLength <= 0 || resourcesLength > 10 * 1024 * 1024) return null
    const resources = await readRange(handle.fd, offset, resourcesLength)

    let position = 0
    while (position + 8 <= resources.length) {
      const signature = resources.toString('ascii', position, position + 4)
      if (signature !== '8BIM' && signature !== '8B64') break
      const id = resources.readUInt16BE(position + 4)
      position += 6
      const nameLength = resources.readUInt8(position)
      position += 1 + nameLength
      if (position % 2 !== 0) position += 1
      if (position + 4 > resources.length) break
      const dataLength = resources.readUInt32BE(position)
      position += 4

      if (id === 1036 || id === 1033) {
        if (position + 4 > resources.length) break
        const format = resources.readUInt32BE(position)
        if (format === 1 && position + 32 <= resources.length) {
          return Buffer.from(resources.subarray(position + 28, position + dataLength))
        }
        return null
      }
      position += dataLength
      if (position % 2 !== 0) position += 1
    }
    return null
  } catch {
    return null
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}
