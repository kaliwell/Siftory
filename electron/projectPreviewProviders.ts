import fsp from 'fs/promises'
import zlib from 'zlib'
import { createCanvas } from '@napi-rs/canvas'
import type { ProjectSourceExt } from '../shared/projectFileTypes'

const PSD_MAX_RESOURCE_BYTES = 32 * 1024 * 1024
const KRA_MAX_CENTRAL_DIRECTORY_BYTES = 8 * 1024 * 1024
const KRA_MAX_PREVIEW_BYTES = 100 * 1024 * 1024
const ZIP_TAIL_BYTES = 65_557
const SVG_MAX_SOURCE_BYTES = 16 * 1024 * 1024
const PDF_MAX_SOURCE_BYTES = 256 * 1024 * 1024
const PDF_MAX_DIMENSION = 2048
const PDF_MAX_CANVAS_PIXELS = 16_000_000
const TIFF_MAX_SOURCE_BYTES = 300 * 1024 * 1024
const SHELL_MAX_SOURCE_BYTES = 4 * 1024 * 1024 * 1024
const SHELL_THUMBNAIL_DIMENSION = 1024
const SHELL_THUMBNAIL_TIMEOUT_MS = 15_000
const SHELL_ICON_COMPARE_DIMENSION = 64
const SHELL_ICON_SIMILARITY_THRESHOLD = 0.035

const UNSAFE_SVG_MARKUP =
  /<!doctype|<!entity|<script\b|<foreignObject\b|\son[a-z]+\s*=|(?:href|src)\s*=\s*["']\s*(?:https?:|file:|ftp:|data:|\\\\|\/\/)/i

export interface ProjectPreviewProvider {
  id: string
  version: string
  extensions: readonly ProjectSourceExt[]
  extract(sourcePath: string): Promise<Buffer | null>
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

async function readRange(
  handle: Awaited<ReturnType<typeof fsp.open>>,
  offset: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, offset)
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead)
}

export async function extractPsdEmbeddedPreview(sourcePath: string): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined
  try {
    handle = await fsp.open(sourcePath, 'r')
    const header = await readRange(handle, 0, 26)
    if (header.length !== 26 || header.toString('ascii', 0, 4) !== '8BPS') return null
    const version = header.readUInt16BE(4)
    if (version !== 1 && version !== 2) return null

    let offset = 26
    let sizeBuffer = await readRange(handle, offset, 4)
    if (sizeBuffer.length !== 4) return null
    const colorModeLength = sizeBuffer.readUInt32BE(0)
    offset += 4 + colorModeLength

    sizeBuffer = await readRange(handle, offset, 4)
    if (sizeBuffer.length !== 4) return null
    const resourcesLength = sizeBuffer.readUInt32BE(0)
    offset += 4
    if (resourcesLength <= 0 || resourcesLength > PSD_MAX_RESOURCE_BYTES) return null
    const resources = await readRange(handle, offset, resourcesLength)

    let position = 0
    while (position + 12 <= resources.length) {
      const signature = resources.toString('ascii', position, position + 4)
      if (signature !== '8BIM' && signature !== '8B64') return null
      const resourceId = resources.readUInt16BE(position + 4)
      position += 6
      const nameLength = resources.readUInt8(position)
      position += 1 + nameLength
      if (position % 2 !== 0) position += 1
      if (position + 4 > resources.length) return null
      const dataLength = resources.readUInt32BE(position)
      position += 4
      if (dataLength > resources.length - position) return null
      if (resourceId === 1036 || resourceId === 1033) {
        if (dataLength < 28 || resources.readUInt32BE(position) !== 1) return null
        const jpeg = resources.subarray(position + 28, position + dataLength)
        return jpeg.length > 0 ? Buffer.from(jpeg) : null
      }
      position += dataLength
      if (position % 2 !== 0) position += 1
    }
    return null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

interface ZipPreviewEntry {
  compression: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

async function findKraPreviewEntry(
  handle: Awaited<ReturnType<typeof fsp.open>>,
  fileSize: number,
): Promise<ZipPreviewEntry | null> {
  const tailLength = Math.min(fileSize, ZIP_TAIL_BYTES)
  const tail = await readRange(handle, fileSize - tailLength, tailLength)
  let eocd = -1
  for (let index = tail.length - 22; index >= 0; index--) {
    if (tail.readUInt32LE(index) === 0x06054b50) {
      eocd = index
      break
    }
  }
  if (eocd < 0) return null
  const centralSize = tail.readUInt32LE(eocd + 12)
  const centralOffset = tail.readUInt32LE(eocd + 16)
  if (
    centralSize <= 0 ||
    centralSize > KRA_MAX_CENTRAL_DIRECTORY_BYTES ||
    centralOffset + centralSize > fileSize
  ) {
    return null
  }
  const central = await readRange(handle, centralOffset, centralSize)
  let position = 0
  let fallback: ZipPreviewEntry | null = null
  while (position + 46 <= central.length) {
    if (central.readUInt32LE(position) !== 0x02014b50) return null
    const compression = central.readUInt16LE(position + 10)
    const compressedSize = central.readUInt32LE(position + 20)
    const uncompressedSize = central.readUInt32LE(position + 24)
    const nameLength = central.readUInt16LE(position + 28)
    const extraLength = central.readUInt16LE(position + 30)
    const commentLength = central.readUInt16LE(position + 32)
    const localHeaderOffset = central.readUInt32LE(position + 42)
    const end = position + 46 + nameLength + extraLength + commentLength
    if (end > central.length) return null
    const name = central
      .toString('utf8', position + 46, position + 46 + nameLength)
      .replaceAll('\\', '/')
      .toLowerCase()
    const entry = { compression, compressedSize, uncompressedSize, localHeaderOffset }
    if (name === 'mergedimage.png') return entry
    if (name === 'preview.png') fallback = entry
    position = end
  }
  return fallback
}

export async function extractKraMergedPreview(sourcePath: string): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined
  try {
    handle = await fsp.open(sourcePath, 'r')
    const stat = await handle.stat()
    const entry = await findKraPreviewEntry(handle, stat.size)
    if (
      !entry ||
      entry.compressedSize <= 0 ||
      entry.compressedSize > KRA_MAX_PREVIEW_BYTES ||
      entry.uncompressedSize <= 0 ||
      entry.uncompressedSize > KRA_MAX_PREVIEW_BYTES ||
      (entry.compression !== 0 && entry.compression !== 8)
    ) {
      return null
    }
    const localHeader = await readRange(handle, entry.localHeaderOffset, 30)
    if (localHeader.length !== 30 || localHeader.readUInt32LE(0) !== 0x04034b50) return null
    const nameLength = localHeader.readUInt16LE(26)
    const extraLength = localHeader.readUInt16LE(28)
    const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength
    const compressed = await readRange(handle, dataOffset, entry.compressedSize)
    if (compressed.length !== entry.compressedSize) return null
    const output =
      entry.compression === 0
        ? compressed
        : zlib.inflateRawSync(compressed, { maxOutputLength: KRA_MAX_PREVIEW_BYTES })
    return output.length === entry.uncompressedSize ? output : null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

export async function extractSafeSvgPreview(sourcePath: string): Promise<Buffer | null> {
  try {
    const stat = await fsp.stat(sourcePath)
    if (!stat.isFile() || stat.size <= 0 || stat.size > SVG_MAX_SOURCE_BYTES) return null
    const svg = await fsp.readFile(sourcePath)
    const markup = svg.toString('utf8')
    if (!/<svg(?:\s|>)/i.test(markup) || UNSAFE_SVG_MARKUP.test(markup)) return null
    return svg
  } catch {
    return null
  }
}

export async function extractTiffArtwork(sourcePath: string): Promise<Buffer | null> {
  try {
    const stat = await fsp.stat(sourcePath)
    if (!stat.isFile() || stat.size <= 0 || stat.size > TIFF_MAX_SOURCE_BYTES) return null
    return await fsp.readFile(sourcePath)
  } catch {
    return null
  }
}

export function projectPreviewBitmapDifference(left: Buffer, right: Buffer): number {
  if (left.length !== right.length || left.length === 0) return 1
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference += Math.abs(left[index] - right[index])
  }
  return difference / (left.length * 255)
}

export async function extractWindowsShellThumbnail(sourcePath: string): Promise<Buffer | null> {
  if (process.platform !== 'win32') return null
  try {
    const stat = await fsp.stat(sourcePath)
    if (!stat.isFile() || stat.size <= 0 || stat.size > SHELL_MAX_SOURCE_BYTES) return null
    const electron = await import('electron')
    if (
      !electron.app?.isReady() ||
      typeof electron.nativeImage?.createThumbnailFromPath !== 'function'
    ) {
      return null
    }
    const thumbnail = await withTimeout(
      electron.nativeImage.createThumbnailFromPath(sourcePath, {
        width: SHELL_THUMBNAIL_DIMENSION,
        height: SHELL_THUMBNAIL_DIMENSION,
      }),
      SHELL_THUMBNAIL_TIMEOUT_MS,
    )
    if (!thumbnail || thumbnail.isEmpty()) return null

    const fileIcon = await withTimeout(
      electron.app.getFileIcon(sourcePath, { size: 'large' }),
      SHELL_THUMBNAIL_TIMEOUT_MS,
    )
    if (fileIcon && !fileIcon.isEmpty()) {
      const comparisonSize = {
        width: SHELL_ICON_COMPARE_DIMENSION,
        height: SHELL_ICON_COMPARE_DIMENSION,
      }
      const thumbnailBitmap = thumbnail.resize(comparisonSize).toBitmap()
      const iconBitmap = fileIcon.resize(comparisonSize).toBitmap()
      if (
        projectPreviewBitmapDifference(Buffer.from(thumbnailBitmap), Buffer.from(iconBitmap)) <=
        SHELL_ICON_SIMILARITY_THRESHOLD
      ) {
        return null
      }
    }
    const png = thumbnail.toPNG()
    return png.length > 0 ? Buffer.from(png) : null
  } catch {
    return null
  }
}

export async function extractPdfFirstPage(sourcePath: string): Promise<Buffer | null> {
  let destroyLoadingTask: (() => Promise<void>) | undefined
  try {
    const stat = await fsp.stat(sourcePath)
    if (!stat.isFile() || stat.size <= 0 || stat.size > PDF_MAX_SOURCE_BYTES) return null
    const bytes = await fsp.readFile(sourcePath)
    if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-', 'ascii'))) return null

    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      canvasMaxAreaInBytes: PDF_MAX_CANVAS_PIXELS * 4,
      disableFontFace: true,
      maxImageSize: PDF_MAX_CANVAS_PIXELS,
      stopAtErrors: true,
      useSystemFonts: true,
      useWasm: false,
      verbosity: pdfjs.VerbosityLevel.ERRORS,
    })
    destroyLoadingTask = () => loadingTask.destroy()
    const document = await loadingTask.promise
    const page = await document.getPage(1)
    try {
      const baseViewport = page.getViewport({ scale: 1 })
      if (
        !Number.isFinite(baseViewport.width) ||
        !Number.isFinite(baseViewport.height) ||
        baseViewport.width <= 0 ||
        baseViewport.height <= 0
      ) {
        return null
      }
      const scale = Math.min(
        PDF_MAX_DIMENSION / Math.max(baseViewport.width, baseViewport.height),
        Math.sqrt(PDF_MAX_CANVAS_PIXELS / (baseViewport.width * baseViewport.height)),
      )
      if (!Number.isFinite(scale) || scale <= 0) return null
      const viewport = page.getViewport({ scale })
      const width = Math.max(1, Math.ceil(viewport.width))
      const height = Math.max(1, Math.ceil(viewport.height))
      if (width * height > PDF_MAX_CANVAS_PIXELS) return null

      const canvas = createCanvas(width, height)
      const context = canvas.getContext('2d')
      await page.render({
        annotationMode: 0,
        background: 'rgb(255,255,255)',
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise
      return canvas.toBuffer('image/png')
    } finally {
      page.cleanup()
    }
  } catch {
    return null
  } finally {
    await destroyLoadingTask?.().catch(() => {})
  }
}

export const BUILTIN_PROJECT_PREVIEW_PROVIDERS: readonly ProjectPreviewProvider[] = [
  {
    id: 'psd-embedded-jpeg',
    version: '1',
    extensions: ['psd', 'psb'],
    extract: extractPsdEmbeddedPreview,
  },
  {
    id: 'kra-merged-png',
    version: '1',
    extensions: ['kra'],
    extract: extractKraMergedPreview,
  },
  {
    id: 'svg-safe-raster',
    version: '1',
    extensions: ['svg'],
    extract: extractSafeSvgPreview,
  },
  {
    id: 'pdfjs-first-page',
    version: '1',
    extensions: ['pdf', 'ai'],
    extract: extractPdfFirstPage,
  },
  {
    id: 'tiff-direct',
    version: '1',
    extensions: ['tif', 'tiff'],
    extract: extractTiffArtwork,
  },
  {
    id: 'windows-shell-thumbnail',
    version: '1',
    extensions: [
      'psd',
      'psb',
      'kra',
      'svg',
      'pdf',
      'ai',
      'eps',
      'tif',
      'tiff',
      'cr2',
      'cr3',
      'nef',
      'arw',
      'dng',
      'raf',
      'orf',
      'rw2',
      'pef',
      'srw',
      'clip',
      'cdr',
      'indd',
    ],
    extract: extractWindowsShellThumbnail,
  },
]

export function providerForExtension(
  sourceExt: ProjectSourceExt,
  providers: readonly ProjectPreviewProvider[] = BUILTIN_PROJECT_PREVIEW_PROVIDERS,
): ProjectPreviewProvider | null {
  return providers.find((provider) => provider.extensions.includes(sourceExt)) ?? null
}

export function providersForExtension(
  sourceExt: ProjectSourceExt,
  providers: readonly ProjectPreviewProvider[] = BUILTIN_PROJECT_PREVIEW_PROVIDERS,
): ProjectPreviewProvider[] {
  return providers.filter((provider) => provider.extensions.includes(sourceExt))
}
