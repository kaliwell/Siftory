'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const zlib = require('node:zlib')

// Read only the merged image, never the layer tree. Source planes are sampled
// into a bounded preview, including for files whose layers occupy several GB.
const MAX_PIXELS = 100_000_000
const MAX_DECODED_BYTES = 256 * 1024 * 1024
const MAX_ZIP_BYTES = 128 * 1024 * 1024
const MAX_SIDE = 1024
const READ_WINDOW = 256 * 1024

function unpackRow(input, length) {
  const row = Buffer.alloc(length)
  let src = 0
  let dst = 0
  while (src < input.length) {
    const tag = input[src++]
    if (tag === 128) continue
    const count = tag < 128 ? tag + 1 : 257 - tag
    if (dst + count > length) throw new Error('PSD RLE row overflow')
    if (tag < 128) {
      if (src + count > input.length) throw new Error('PSD RLE row truncated')
      input.copy(row, dst, src, src + count)
      src += count
    } else {
      if (src === input.length) throw new Error('PSD RLE repeat truncated')
      row.fill(input[src++], dst, dst + count)
    }
    dst += count
  }
  if (dst !== length) throw new Error('PSD RLE row incomplete')
  return row
}

function undoPrediction(row, depth, width) {
  if (depth === 16) {
    for (let x = 1; x < width; x++) {
      const offset = x * 2
      row.writeUInt16BE((row.readUInt16BE(offset) + row.readUInt16BE(offset - 2)) & 65535, offset)
    }
    return row
  }
  for (let i = 1; i < row.length; i++) row[i] = (row[i] + row[i - 1]) & 255
  if (depth !== 32) return row
  // Float prediction stores the four byte positions in separate planes.
  const interleaved = Buffer.alloc(row.length)
  for (let x = 0; x < width; x++) {
    for (let byte = 0; byte < 4; byte++) interleaved[x * 4 + byte] = row[x + byte * width]
  }
  return interleaved
}

async function extractPsdCompositePreview(sourcePath) {
  let handle
  let input
  let inflate
  const deadline = Date.now() + 10_000
  try {
    handle = await fsp.open(sourcePath, 'r')
    const stat = await handle.stat()
    if (!stat.isFile()) return null
    let window = Buffer.alloc(0)
    let windowOffset = 0
    const read = async (offset, length) => {
      if (Date.now() > deadline) throw new Error('PSD preview time budget exceeded')
      if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > stat.size)
        throw new Error('PSD section outside file')
      if (offset < windowOffset || offset + length > windowOffset + window.length) {
        const buffer = Buffer.alloc(Math.min(Math.max(READ_WINDOW, length), stat.size - offset))
        let filled = 0
        while (filled < buffer.length) {
          const { bytesRead } = await handle.read(
            buffer,
            filled,
            buffer.length - filled,
            offset + filled,
          )
          if (!bytesRead) throw new Error('PSD source truncated')
          filled += bytesRead
        }
        window = buffer
        windowOffset = offset
      }
      return window.subarray(offset - windowOffset, offset - windowOffset + length)
    }
    const header = await read(0, 26)
    if (header.toString('ascii', 0, 4) !== '8BPS') return null
    const version = header.readUInt16BE(4)
    const channels = header.readUInt16BE(12)
    const height = header.readUInt32BE(14)
    const width = header.readUInt32BE(18)
    const depth = header.readUInt16BE(22)
    const mode = header.readUInt16BE(24)
    const colors = mode === 1 ? 1 : mode === 3 ? 3 : 0
    if (
      ![1, 2].includes(version) ||
      ![8, 16, 32].includes(depth) ||
      !colors ||
      channels < colors ||
      channels > colors + 1 ||
      !width ||
      !height ||
      width > 32768 ||
      height > 32768 ||
      width * height > MAX_PIXELS
    )
      return null
    const rowBytes = width * (depth / 8)
    const totalBytes = rowBytes * height * channels
    if (totalBytes > MAX_DECODED_BYTES) return null

    let offset = 26
    for (const sizeBytes of [4, 4, version === 2 ? 8 : 4]) {
      const lengthBuffer = await read(offset, sizeBytes)
      const length =
        sizeBytes === 8 ? Number(lengthBuffer.readBigUInt64BE()) : lengthBuffer.readUInt32BE()
      offset += sizeBytes + length
      if (!Number.isSafeInteger(offset) || offset > stat.size) return null
    }
    const compression = (await read(offset, 2)).readUInt16BE()
    offset += 2
    if (compression > 3) return null
    const scale = Math.min(1, MAX_SIDE / Math.max(width, height))
    const outWidth = Math.max(1, Math.round(width * scale))
    const outHeight = Math.max(1, Math.round(height * scale))
    const rgba = Buffer.alloc(outWidth * outHeight * 4, 255)
    const sampleX = Array.from({ length: outWidth }, (_, x) =>
      Math.min(width - 1, Math.floor(((x + 0.5) * width) / outWidth)),
    )
    const sampleY = new Map(
      Array.from({ length: outHeight }, (_, y) => [
        Math.min(height - 1, Math.floor(((y + 0.5) * height) / outHeight)),
        y,
      ]),
    )
    const render = (row, channel, outY) => {
      for (let x = 0; x < outWidth; x++) {
        const byteOffset = sampleX[x] * (depth / 8)
        let value =
          depth === 8
            ? row[byteOffset] / 255
            : depth === 16
              ? row.readUInt16BE(byteOffset) / 65535
              : row.readFloatBE(byteOffset)
        value = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
        const alpha = channel === colors
        // Float composite colors are linear-light. Alpha remains linear.
        if (depth === 32 && !alpha)
          value = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055
        const byte = Math.round(value * 255)
        const pixel = (outY * outWidth + x) * 4
        if (alpha) rgba[pixel + 3] = byte
        else if (colors === 1) rgba.fill(byte, pixel, pixel + 3)
        else rgba[pixel + channel] = byte
      }
    }

    if (compression <= 1) {
      let rowOffsets
      if (compression === 1) {
        const countBytes = version === 2 ? 4 : 2
        const table = await read(offset, channels * height * countBytes)
        let cursor = offset + table.length
        rowOffsets = new Float64Array(channels * height + 1)
        for (let i = 0; i < channels * height; i++) {
          rowOffsets[i] = cursor
          cursor +=
            countBytes === 4
              ? table.readUInt32BE(i * countBytes)
              : table.readUInt16BE(i * countBytes)
          if (cursor > stat.size) return null
        }
        rowOffsets[channels * height] = cursor
      } else if (offset + totalBytes > stat.size) return null
      for (let channel = 0; channel < channels; channel++) {
        for (const [sourceY, outY] of sampleY) {
          const index = channel * height + sourceY
          const start = rowOffsets ? rowOffsets[index] : offset + index * rowBytes
          const length = rowOffsets ? rowOffsets[index + 1] - start : rowBytes
          // Valid PackBits rows cannot need more than two bytes per output byte
          // plus padding. Bound corrupt counts before allocating/reading.
          if (length > rowBytes * 2 + 1024) return null
          const encoded = await read(start, length)
          render(compression === 1 ? unpackRow(encoded, rowBytes) : encoded, channel, outY)
        }
      }
    } else {
      if (stat.size - offset > MAX_ZIP_BYTES || offset >= stat.size) return null
      input = fs.createReadStream(sourcePath, {
        fd: handle.fd,
        autoClose: false,
        start: offset,
        end: stat.size - 1,
      })
      inflate = zlib.createInflate()
      input.on('error', (error) => inflate.destroy(error))
      input.pipe(inflate)
      let row = Buffer.alloc(rowBytes)
      let filled = 0
      let rowIndex = 0
      let decoded = 0
      for await (const chunk of inflate) {
        decoded += chunk.length
        if (decoded > totalBytes || Date.now() > deadline)
          throw new Error('PSD ZIP budget exceeded')
        let position = 0
        while (position < chunk.length) {
          const count = Math.min(rowBytes - filled, chunk.length - position)
          chunk.copy(row, filled, position, position + count)
          filled += count
          position += count
          if (filled === rowBytes) {
            const outY = sampleY.get(rowIndex % height)
            if (outY !== undefined)
              render(
                compression === 3 ? undoPrediction(row, depth, width) : row,
                Math.floor(rowIndex / height),
                outY,
              )
            rowIndex++
            filled = 0
          }
        }
      }
      if (decoded !== totalBytes || filled !== 0) return null
    }
    return await require('sharp')(rgba, {
      raw: { width: outWidth, height: outHeight, channels: 4 },
    })
      .flatten({ background: '#ffffff' })
      .png()
      .toBuffer()
  } catch {
    // Unsupported/corrupt composites still get the isolated Shell fallback.
    return null
  } finally {
    inflate?.destroy()
    input?.destroy()
    await handle?.close().catch(() => {})
  }
}

module.exports = { extractPsdCompositePreview }
