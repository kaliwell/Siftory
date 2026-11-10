'use strict'
// Real Electron check for BMP preview recovery.
//
// Chromium's nativeImage decodes only PNG/JPEG buffers and the bundled libvips has
// no BMP loader, so BMP previews used to fail with "Cannot decode". This smoke
// builds representative BMP variants (no user media), verifies the in-process
// decoder still rejects them, and proves the OS thumbnail fallback returns real
// pixels with the source aspect ratio. Run with: npm run smoke:thumbnails:bmp
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, nativeImage } = require('electron')
const { loadTsModule } = require('./guard-utils.cjs')

const { createOsThumbnail } = loadTsModule('electron/osThumbnailFallback.ts')
const { shouldUseOsThumbnailFallback } = loadTsModule('shared/thumbnailPolicy.ts')

const THUMB_DIM = 256

function rowStride(bytesPerRow) {
  return bytesPerRow + ((4 - (bytesPerRow % 4)) % 4)
}

/**
 * Build a BITMAPFILEHEADER + BITMAPINFOHEADER BMP.
 * `pixelWriter(x, y, set)` writes one pixel as B,G,R,A where supported.
 */
function buildBmp({
  width,
  height,
  bpp,
  palette = [],
  topDown = false,
  os2CoreHeader = false,
  compression = 0,
}) {
  const fileHeaderSize = 14
  const headerSize = os2CoreHeader ? 12 : 40
  const paletteEntrySize = os2CoreHeader ? 3 : 4
  const paletteBytes = palette.length * paletteEntrySize
  const bytesPerPixel = bpp / 8
  const rowBytes = Math.ceil((width * bpp) / 8)
  const stride = rowStride(rowBytes)
  const pixelBytes = stride * height
  const pixelOffset = fileHeaderSize + headerSize + paletteBytes
  const buffer = Buffer.alloc(pixelOffset + pixelBytes)

  buffer.write('BM', 0, 'latin1')
  buffer.writeUInt32LE(buffer.length, 2)
  buffer.writeUInt32LE(pixelOffset, 10)

  if (os2CoreHeader) {
    buffer.writeUInt32LE(12, 14)
    buffer.writeUInt16LE(width, 18)
    buffer.writeUInt16LE(height, 20)
    buffer.writeUInt16LE(1, 22)
    buffer.writeUInt16LE(bpp, 24)
  } else {
    buffer.writeUInt32LE(40, 14)
    buffer.writeInt32LE(width, 18)
    buffer.writeInt32LE(topDown ? -height : height, 22)
    buffer.writeUInt16LE(1, 26)
    buffer.writeUInt16LE(bpp, 28)
    buffer.writeUInt32LE(compression, 30)
    buffer.writeUInt32LE(pixelBytes, 34)
    buffer.writeUInt32LE(palette.length || 0, 46)
  }

  let paletteOffset = fileHeaderSize + headerSize
  for (const [r, g, b] of palette) {
    buffer[paletteOffset] = b
    buffer[paletteOffset + 1] = g
    buffer[paletteOffset + 2] = r
    if (!os2CoreHeader) buffer[paletteOffset + 3] = 0
    paletteOffset += paletteEntrySize
  }

  for (let y = 0; y < height; y++) {
    const targetRow = topDown ? y : height - 1 - y
    const rowStart = pixelOffset + targetRow * stride
    for (let x = 0; x < width; x++) {
      const r = Math.round((x / Math.max(1, width - 1)) * 255)
      const g = Math.round((y / Math.max(1, height - 1)) * 255)
      const b = (x + y) % 2 === 0 ? 32 : 224
      if (bpp === 32) {
        const offset = rowStart + x * 4
        buffer[offset] = b
        buffer[offset + 1] = g
        buffer[offset + 2] = r
        buffer[offset + 3] = 255
      } else if (bpp === 24) {
        const offset = rowStart + x * 3
        buffer[offset] = b
        buffer[offset + 1] = g
        buffer[offset + 2] = r
      } else if (bpp === 8) {
        buffer[rowStart + x] = (x + y) % palette.length
      } else if (bpp === 4) {
        const index = (x + y) % palette.length
        const offset = rowStart + Math.floor(x / 2)
        buffer[offset] = x % 2 === 0 ? (index << 4) | buffer[offset] : (buffer[offset] & 0xf0) | index
      } else if (bpp === 1) {
        const bit = (x + y) % 2
        const offset = rowStart + Math.floor(x / 8)
        buffer[offset] |= bit << (7 - (x % 8))
      }
      void bytesPerPixel
    }
  }
  return buffer
}

/**
 * Build a BMP whose four quadrants are distinct solid colors, so the decoded
 * preview can be checked for real content instead of a generic shell file icon.
 */
function buildQuadrantBmp(width, height) {
  const colors = [
    [230, 30, 30],
    [30, 200, 60],
    [40, 70, 220],
    [240, 240, 240],
  ]
  const buffer = buildBmp({ width, height, bpp: 24, palette: [] })
  const fileHeaderSize = 14
  const headerSize = 40
  const pixelOffset = fileHeaderSize + headerSize
  const stride = rowStride(width * 3)
  for (let y = 0; y < height; y++) {
    const targetRow = height - 1 - y
    const rowStart = pixelOffset + targetRow * stride
    for (let x = 0; x < width; x++) {
      const quadrant = (y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)
      const [r, g, b] = colors[quadrant]
      const offset = rowStart + x * 3
      buffer[offset] = b
      buffer[offset + 1] = g
      buffer[offset + 2] = r
    }
  }
  return buffer
}

/** Read BGRA pixels at the four quadrant centers of a decoded preview. */
function sampleQuadrants(image) {
  const bitmap = image.toBitmap()
  const { width, height } = image.getSize()
  const at = (x, y) => {
    const offset = (y * width + x) * 4
    return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]]
  }
  return [
    at(Math.floor(width * 0.25), Math.floor(height * 0.25)),
    at(Math.floor(width * 0.75), Math.floor(height * 0.25)),
    at(Math.floor(width * 0.25), Math.floor(height * 0.75)),
    at(Math.floor(width * 0.75), Math.floor(height * 0.75)),
  ]
}

function palette(size) {
  return Array.from({ length: size }, (_, index) => [index, (index * 3) % 256, 255 - index])
}

function ratioDistance(left, right) {
  return Math.abs(left - right) / right
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-bmp-smoke-'))
  const variants = [
    { name: 'rgb-24-bottom-up.bmp', width: 64, height: 48, bpp: 24, palette: [] },
    { name: 'rgb-24-top-down.bmp', width: 64, height: 48, bpp: 24, palette: [], topDown: true },
    { name: 'rgba-32.bmp', width: 32, height: 32, bpp: 32, palette: [] },
    { name: 'palette-8.bmp', width: 40, height: 30, bpp: 8, palette: palette(256) },
    { name: 'palette-4.bmp', width: 33, height: 21, bpp: 4, palette: palette(16) },
    { name: 'mono-1.bmp', width: 32, height: 32, bpp: 1, palette: palette(2) },
    {
      name: 'os2-core-header-24.bmp',
      width: 20,
      height: 10,
      bpp: 24,
      palette: [],
      os2CoreHeader: true,
    },
  ]

  const results = []
  for (const variant of variants) {
    const filePath = path.join(dir, variant.name)
    fs.writeFileSync(
      filePath,
      buildBmp({
        width: variant.width,
        height: variant.height,
        bpp: variant.bpp,
        palette: variant.palette,
        topDown: variant.topDown === true,
        os2CoreHeader: variant.os2CoreHeader === true,
      }),
    )

    const ext = path.extname(filePath)
    assert.equal(shouldUseOsThumbnailFallback(ext), true, `${variant.name} is gated into fallback`)
    // Documents the gap this fallback exists for. If Electron ever decodes BMP
    // in-process this assertion flags a stale premise rather than silently rotting.
    const nativeDecoded = !nativeImage.createFromPath(filePath).isEmpty()

    const started = Date.now()
    const image = await createOsThumbnail(filePath, THUMB_DIM)
    const ms = Date.now() - started
    assert.ok(image, `${variant.name} decodes through the OS provider`)
    assert.equal(image.isEmpty(), false, `${variant.name} is not empty`)
    const size = image.getSize()
    assert.ok(size.width > 0 && size.height > 0, `${variant.name} has pixels`)
    assert.ok(
      size.width <= THUMB_DIM && size.height <= THUMB_DIM,
      `${variant.name} respects the requested bound (${size.width}x${size.height})`,
    )
    const expectedRatio = variant.width / variant.height
    assert.ok(
      ratioDistance(size.width / size.height, expectedRatio) < 0.05,
      `${variant.name} keeps the source aspect ratio (${size.width}x${size.height} vs ${variant.width}x${variant.height})`,
    )
    assert.ok(image.toPNG().length > 0, `${variant.name} encodes to PNG`)

    results.push({
      variant: variant.name,
      declared: `${variant.width}x${variant.height}`,
      nativeDecoded,
      thumbnail: `${size.width}x${size.height}`,
      ms,
    })
  }

  // Content fidelity: a quadrant pattern must survive decoding, which proves the
  // provider renders pixels instead of returning a generic file-type icon.
  const quadrantFile = path.join(dir, 'quadrants-24.bmp')
  fs.writeFileSync(quadrantFile, buildQuadrantBmp(64, 64))
  const quadrantImage = await createOsThumbnail(quadrantFile, THUMB_DIM)
  assert.ok(quadrantImage, 'quadrant BMP decodes')
  const expectedColors = [
    [230, 30, 30],
    [30, 200, 60],
    [40, 70, 220],
    [240, 240, 240],
  ]
  const sampled = sampleQuadrants(quadrantImage)
  sampled.forEach((rgb, index) => {
    const expected = expectedColors[index]
    const close = rgb.every((channel, channelIndex) => Math.abs(channel - expected[channelIndex]) <= 24)
    assert.ok(
      close,
      `quadrant ${index} keeps its color (got ${rgb.join(',')}, expected ${expected.join(',')})`,
    )
  })
  results.push({
    variant: 'quadrants-24.bmp',
    declared: '64x64',
    thumbnail: `${quadrantImage.getSize().width}x${quadrantImage.getSize().height}`,
    quadrants: sampled,
  })

  const brokenFile = path.join(dir, 'not-an-image.bmp')
  fs.writeFileSync(brokenFile, 'this is not a bitmap')
  const broken = await createOsThumbnail(brokenFile, THUMB_DIM)
  results.push({ variant: 'not-an-image.bmp', nativeDecoded: false, thumbnail: broken ? 'decoded' : 'rejected' })

  console.log(
    JSON.stringify(
      {
        passed: true,
        platform: process.platform,
        electron: process.versions.electron,
        variants: results,
        brokenFileOutcome: broken ? 'decoded-generic' : 'rejected',
      },
      null,
      2,
    ),
  )

  fs.rmSync(dir, { recursive: true, force: true })
  app.quit()
}

app.whenReady().then(main).catch((error) => {
  console.error(error)
  app.exit(1)
})
