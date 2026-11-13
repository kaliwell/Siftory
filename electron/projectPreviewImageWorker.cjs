'use strict'
const { parentPort, workerData } = require('node:worker_threads')
const { createRequire } = require('node:module')
const sharp = createRequire(__filename)(workerData?.sharpPath || 'sharp')
if (workerData?.moduleRoots) {
  process.env.NODE_PATH = [...workerData.moduleRoots, process.env.NODE_PATH || ''].join(
    require('node:path').delimiter,
  )
  require('node:module')._initPaths()
}
const MAX_PROJECT_PREVIEW_PIXELS = 100_000_000
const PROJECT_PREVIEW_MAX_DIMENSION = 2048
const FOCUSED_VECTOR_EXTENSIONS = new Set(['ai', 'svg', 'eps'])
const VECTOR_BACKGROUND_DISTANCE = 72
const VECTOR_CONTENT_MARGIN_RATIO = 0.08
async function focusVectorArtwork(previewBytes) {
  const source = sharp(previewBytes, {
    animated: false,
    limitInputPixels: MAX_PROJECT_PREVIEW_PIXELS,
    sequentialRead: true,
  })
  const [metadata, stats, raw] = await Promise.all([
    source.metadata(),
    source.clone().stats(),
    source.clone().blur(3).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ])
  if (
    !metadata.width ||
    !metadata.height ||
    raw.info.channels < 3 ||
    raw.info.width < 32 ||
    raw.info.height < 32
  ) {
    return previewBytes
  }
  const pixelCount = raw.info.width * raw.info.height
  const mask = new Uint8Array(pixelCount)
  const background = stats.dominant
  const distanceLimit = VECTOR_BACKGROUND_DISTANCE * VECTOR_BACKGROUND_DISTANCE
  for (let y = 0; y < raw.info.height; y += 1) {
    for (let x = 0; x < raw.info.width; x += 1) {
      const pixelIndex = y * raw.info.width + x
      const offset = pixelIndex * raw.info.channels
      const red = raw.data[offset] - background.r
      const green = raw.data[offset + 1] - background.g
      const blue = raw.data[offset + 2] - background.b
      if (red * red + green * green + blue * blue > distanceLimit) mask[pixelIndex] = 1
    }
  }
  const queue = new Int32Array(pixelCount)
  const components = []
  const minimumArea = Math.max(32, pixelCount * 0.00005)
  const minimumWidth = Math.max(8, raw.info.width * 0.01)
  const minimumHeight = Math.max(8, raw.info.height * 0.01)
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] !== 1) continue
    let head = 0
    let tail = 0
    let area = 0
    let minX = raw.info.width
    let maxX = 0
    let minY = raw.info.height
    let maxY = 0
    queue[tail++] = start
    mask[start] = 2
    while (head < tail) {
      const current = queue[head++]
      const x = current % raw.info.width
      const y = Math.floor(current / raw.info.width)
      area += 1
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
      const visit = (next) => {
        if (next >= 0 && mask[next] === 1) {
          mask[next] = 2
          queue[tail++] = next
        }
      }
      visit(x > 0 ? current - 1 : -1)
      visit(x + 1 < raw.info.width ? current + 1 : -1)
      visit(y > 0 ? current - raw.info.width : -1)
      visit(y + 1 < raw.info.height ? current + raw.info.width : -1)
    }
    const width = maxX - minX + 1
    const height = maxY - minY + 1
    const boxArea = width * height
    const density = area / boxArea
    const planeLike = boxArea / pixelCount > 0.45 && density > 0.5
    const lineLike = width < minimumWidth || height < minimumHeight
    if (!planeLike && !lineLike && area >= minimumArea && density >= 0.015) {
      components.push({ minX, maxX, minY, maxY })
    }
  }
  if (components.length === 0) return previewBytes
  const left = Math.min(...components.map((component) => component.minX))
  const right = Math.max(...components.map((component) => component.maxX))
  const top = Math.min(...components.map((component) => component.minY))
  const bottom = Math.max(...components.map((component) => component.maxY))
  const width = right - left + 1
  const height = bottom - top + 1
  if (width >= raw.info.width * 0.92 && height >= raw.info.height * 0.92) return previewBytes
  const side = Math.ceil(Math.max(width, height) * (1 + VECTOR_CONTENT_MARGIN_RATIO))
  const extendLeft = Math.floor((side - width) / 2)
  const extendTop = Math.floor((side - height) / 2)
  const extracted = await source.clone().extract({ left, top, width, height }).png().toBuffer()
  return sharp(extracted)
    .extend({
      left: extendLeft,
      right: side - width - extendLeft,
      top: extendTop,
      bottom: side - height - extendTop,
      background,
    })
    .png()
    .toBuffer()
}
async function processPreview(previewBytes, sourceExt) {
  const image = sharp(previewBytes, {
    animated: false,
    density: 192,
    limitInputPixels: MAX_PROJECT_PREVIEW_PIXELS,
    sequentialRead: true,
  })
  const metadata = await image.metadata()
  if (!metadata.width || !metadata.height) return null
  const prepared = image
    .rotate()
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(PROJECT_PREVIEW_MAX_DIMENSION, PROJECT_PREVIEW_MAX_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true,
    })
  const focusedBytes = FOCUSED_VECTOR_EXTENSIONS.has(sourceExt)
    ? await focusVectorArtwork(await prepared.png().toBuffer())
    : null
  const output = await (focusedBytes ? sharp(focusedBytes) : prepared)
    .jpeg({ quality: 90 })
    .toBuffer({ resolveWithObject: true })
  return { data: output.data, width: output.info.width, height: output.info.height }
}
let manifestEntries = []
parentPort?.on('message', async (message) => {
  if (message.kind === 'manifestStart') {
    manifestEntries = []
    return
  }
  if (message.kind === 'manifestChunk') {
    manifestEntries.push(...message.entries)
    return
  }
  if (message.kind === 'manifestFinish') {
    message.kind = 'manifest'
    message.entries = manifestEntries
    manifestEntries = []
  }
  try {
    if (message.kind === 'extractImage') {
      const providers = createRequire(__filename)(workerData.providersPath)
      const provider = providers.BUILTIN_PROJECT_PREVIEW_PROVIDERS.find(
        (item) => item.id === message.providerId,
      )
      if (!provider || provider.id === 'windows-shell-thumbnail')
        throw new Error('Unsupported worker preview provider')
      const bytes =
        provider.id === 'pdfjs-first-page'
          ? await providers.extractPdfFirstPage(message.sourcePath, workerData.pdfModuleUrl)
          : await provider.extract(message.sourcePath)
      const result = bytes ? await processPreview(bytes, message.sourceExt) : null
      parentPort?.postMessage({ result })
      return
    }
    const result =
      message.kind === 'manifest'
        ? JSON.stringify({
            version: 1,
            entries: message.entries.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)),
          })
        : await processPreview(Buffer.from(message.bytes), message.sourceExt)
    if (message.kind === 'manifest' && message.temporaryPath) {
      await require('node:fs/promises').writeFile(message.temporaryPath, result, 'utf8')
      parentPort?.postMessage({ result: { written: true } })
    } else parentPort?.postMessage({ result })
  } catch (error) {
    parentPort?.postMessage({
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
