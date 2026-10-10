import fs from 'fs'
import path from 'path'

export interface ImageIndexAssetSourceRecord {
  path: string
  width: number
  height: number
  fileSize: number
  modifiedTime: number
  diffHash64?: string
  dctHash64?: string
}

interface ImageIndexManifestSegment {
  file: string
  recordCount?: number
}

interface ImageIndexManifest {
  segments?: ImageIndexManifestSegment[]
}

export interface ImageIndexReadProgress {
  current: number
  total: number
  message: string
}

interface ReadImageIndexOptions {
  onProgress?: (progress: ImageIndexReadProgress) => void
  isCancelled?: () => boolean
}

interface VerifyImageIndexOptions extends ReadImageIndexOptions {
  concurrency?: number
}

export interface ImageIndexVerificationResult {
  assets: ImageIndexAssetSourceRecord[]
  missing: number
  invalid: number
}

const HEADER_SIZE = 80
const FOOTER_SIZE = 16
const MAX_RECORDS = 1_000_000
const MAX_PATH_BYTES = 256 * 1024 * 1024
const MAX_SEGMENT_FILE_BYTES = 512 * 1024 * 1024
const MAX_SEGMENT_BUFFER_BYTES = 384 * 1024 * 1024
const MAX_TOTAL_SEGMENT_BYTES = 1024 * 1024 * 1024
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
const MAX_OVERLAY_BYTES = 16 * 1024 * 1024
const MAX_MANIFEST_SEGMENTS = 256

function normalizePathKey(filePath: string): string {
  return filePath.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function asSafeNumber(value: bigint, label: string): number {
  const numberValue = Number(value)
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) {
    throw new Error(`Invalid ${label} in image index`)
  }
  return numberValue
}

function hashHex(value: bigint): string {
  return value.toString(16).padStart(16, '0')
}

function safeDimension(value: number): number {
  return Number.isInteger(value) && value > 0 && value <= 1_000_000 ? value : 0
}

function safeInt64(value: bigint): number {
  const numberValue = Number(value)
  return Number.isSafeInteger(numberValue) && numberValue >= 0 ? numberValue : 0
}

async function readBuffer(
  handle: fs.promises.FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset)
    if (result.bytesRead <= 0) throw new Error('Unexpected end of image index segment')
    offset += result.bytesRead
  }
  return buffer
}

function resolveManifestInput(inputPath: string): {
  manifestPath?: string
  rootDir: string
  singleSegmentPath?: string
} {
  const resolved = path.resolve(inputPath)
  const stat = fs.statSync(resolved)
  if (stat.isFile() && path.extname(resolved).toLowerCase() === '.idx') {
    return { rootDir: path.dirname(resolved), singleSegmentPath: resolved }
  }
  if (stat.isFile()) return { rootDir: path.dirname(resolved), manifestPath: resolved }
  return { rootDir: resolved, manifestPath: path.join(resolved, 'manifest.json') }
}

function resolveSegmentPath(rootDir: string, segmentFile: string): string {
  if (!segmentFile || segmentFile.includes('\0'))
    throw new Error('Invalid image index segment path')
  const root = path.resolve(rootDir)
  const resolved = path.resolve(root, segmentFile)
  const prefix = `${root}${path.sep}`.toLowerCase()
  if (!resolved.toLowerCase().startsWith(prefix)) {
    throw new Error(`Image index segment escapes manifest directory: ${segmentFile}`)
  }
  return resolved
}

async function readDeletedOverlay(rootDir: string): Promise<Set<string>> {
  try {
    const overlayPath = path.join(rootDir, 'overlay.json')
    const stat = await fs.promises.stat(overlayPath)
    if (stat.size > MAX_OVERLAY_BYTES) throw new Error('Image index overlay exceeds safety limit')
    const raw = await fs.promises.readFile(overlayPath, 'utf8')
    const parsed = JSON.parse(raw) as { deleted?: unknown }
    if (!Array.isArray(parsed.deleted)) return new Set()
    return new Set(
      parsed.deleted
        .slice(0, MAX_RECORDS)
        .filter((value): value is string => typeof value === 'string')
        .map(normalizePathKey),
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    return new Set()
  }
}

async function readSegment(
  segmentPath: string,
  startProgress: number,
  totalProgress: number,
  options: ReadImageIndexOptions,
  remainingRecordBudget: number,
): Promise<{ records: ImageIndexAssetSourceRecord[]; sourceRecordCount: number }> {
  const handle = await fs.promises.open(segmentPath, 'r')
  try {
    const stat = await handle.stat()
    if (stat.size < HEADER_SIZE + FOOTER_SIZE) throw new Error('Image index segment is too small')
    if (stat.size > MAX_SEGMENT_FILE_BYTES) {
      throw new Error('Image index segment exceeds file-size safety limit')
    }
    const header = await readBuffer(handle, 0, HEADER_SIZE)
    if (header.toString('ascii', 0, 4) !== 'IMS1') throw new Error('Invalid image index magic')

    const version = header.readUInt32LE(4)
    if (version < 1 || version > 4) throw new Error(`Unsupported image index version: ${version}`)
    const recordCount = asSafeNumber(header.readBigUInt64LE(8), 'record count')
    if (recordCount > remainingRecordBudget) {
      throw new Error('Image index record count exceeds safety limit')
    }

    const declaredFileSize = asSafeNumber(header.readBigUInt64LE(16), 'file size')
    const pathOffsetsOffset = asSafeNumber(header.readBigUInt64LE(32), 'path offset table')
    const pathBytesOffset = asSafeNumber(header.readBigUInt64LE(40), 'path bytes')
    const metadataOffset = asSafeNumber(header.readBigUInt64LE(48), 'metadata')
    const diffHashOffset = asSafeNumber(header.readBigUInt64LE(56), 'diff hash')
    const footerOffset = asSafeNumber(header.readBigUInt64LE(64), 'footer')
    const effectiveSize = declaredFileSize || stat.size
    if (effectiveSize > stat.size || footerOffset + FOOTER_SIZE > stat.size) {
      throw new Error('Truncated image index segment')
    }

    const metadataSectionSize = diffHashOffset - metadataOffset
    const metadataSize =
      recordCount > 0 ? metadataSectionSize / recordCount : version >= 2 ? 32 : 24
    const offsetTableSize = (recordCount + 1) * 8
    const pathByteLength = metadataOffset - pathBytesOffset
    if (
      pathOffsetsOffset < HEADER_SIZE ||
      pathBytesOffset < pathOffsetsOffset + offsetTableSize ||
      pathByteLength < 0 ||
      pathByteLength > MAX_PATH_BYTES ||
      !Number.isInteger(metadataSize) ||
      metadataSize < 24 ||
      metadataSize > 64 ||
      metadataOffset + recordCount * metadataSize > stat.size ||
      diffHashOffset + recordCount * 8 > stat.size
    ) {
      throw new Error('Invalid image index segment offsets')
    }

    const dctHashOffset = diffHashOffset + recordCount * 8
    const deletedBitmapOffset = dctHashOffset + recordCount * 8
    const deletedBitmapSize = Math.ceil(recordCount / 8)
    const bufferBytes =
      offsetTableSize +
      pathByteLength +
      recordCount * metadataSize +
      recordCount * 8 +
      (version >= 3 ? recordCount * 8 : 0) +
      (version >= 4 ? deletedBitmapSize : 0)
    if (bufferBytes > MAX_SEGMENT_BUFFER_BYTES) {
      throw new Error('Image index segment exceeds memory safety limit')
    }
    if (version >= 3 && dctHashOffset + recordCount * 8 > stat.size) {
      throw new Error('Truncated DCT hash section')
    }
    if (version >= 4 && deletedBitmapOffset + deletedBitmapSize > stat.size) {
      throw new Error('Truncated deleted bitmap')
    }
    const sectionEnd =
      version >= 4
        ? deletedBitmapOffset + deletedBitmapSize
        : version >= 3
          ? dctHashOffset + recordCount * 8
          : diffHashOffset + recordCount * 8
    if (sectionEnd > footerOffset) throw new Error('Image index sections overlap footer')

    const offsets = await readBuffer(handle, pathOffsetsOffset, offsetTableSize)
    const pathBytes = await readBuffer(handle, pathBytesOffset, pathByteLength)
    const metadata = await readBuffer(handle, metadataOffset, recordCount * metadataSize)
    const diffHashes = await readBuffer(handle, diffHashOffset, recordCount * 8)
    const dctHashes = version >= 3 ? await readBuffer(handle, dctHashOffset, recordCount * 8) : null
    const deletedBitmap =
      version >= 4 ? await readBuffer(handle, deletedBitmapOffset, deletedBitmapSize) : null

    const records: ImageIndexAssetSourceRecord[] = []
    for (let index = 0; index < recordCount; index++) {
      if (options.isCancelled?.()) throw new Error('Asset sync cancelled')
      if (deletedBitmap && (deletedBitmap[index >> 3] & (1 << (index & 7))) !== 0) continue

      const pathStart = asSafeNumber(offsets.readBigUInt64LE(index * 8), 'path start')
      const pathEnd = asSafeNumber(offsets.readBigUInt64LE((index + 1) * 8), 'path end')
      if (pathStart > pathEnd || pathEnd > pathBytes.length) continue
      const terminator = pathEnd > pathStart && pathBytes[pathEnd - 1] === 0 ? pathEnd - 1 : pathEnd
      const filePath = pathBytes.toString('utf8', pathStart, terminator)
      if (!filePath) continue

      const metaOffset = index * metadataSize
      const fileSizeValue = metadata.readBigInt64LE(metaOffset + 8)
      const modifiedTimeValue = metadata.readBigInt64LE(metaOffset + 16)
      records.push({
        path: filePath,
        width: safeDimension(metadata.readInt32LE(metaOffset)),
        height: safeDimension(metadata.readInt32LE(metaOffset + 4)),
        fileSize: safeInt64(fileSizeValue),
        modifiedTime: safeInt64(modifiedTimeValue),
        diffHash64: hashHex(diffHashes.readBigUInt64LE(index * 8)),
        ...(dctHashes ? { dctHash64: hashHex(dctHashes.readBigUInt64LE(index * 8)) } : {}),
      })

      if (index % 2048 === 0) {
        options.onProgress?.({
          current: startProgress + index,
          total: totalProgress,
          message: `Reading ${path.basename(segmentPath)}`,
        })
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
    return { records, sourceRecordCount: recordCount }
  } finally {
    await handle.close()
  }
}

export async function verifyImageIndexAssets(
  records: ImageIndexAssetSourceRecord[],
  options: VerifyImageIndexOptions = {},
): Promise<ImageIndexVerificationResult> {
  const total = records.length
  const verified = new Array<ImageIndexAssetSourceRecord | undefined>(total)
  const concurrency = Math.max(1, Math.min(64, Math.floor(options.concurrency ?? 24)))
  let cursor = 0
  let completed = 0
  let missing = 0
  let invalid = 0

  const worker = async () => {
    for (;;) {
      if (options.isCancelled?.()) throw new Error('Asset sync cancelled')
      const index = cursor
      cursor += 1
      if (index >= total) return
      const record = records[index]
      try {
        const stat = await fs.promises.stat(record.path)
        if (!stat.isFile()) {
          invalid += 1
        } else {
          verified[index] = {
            ...record,
            width: safeDimension(record.width),
            height: safeDimension(record.height),
            fileSize: Number.isSafeInteger(stat.size) && stat.size >= 0 ? stat.size : 0,
            modifiedTime: Math.max(0, Math.round(stat.mtimeMs)),
          }
        }
      } catch {
        missing += 1
      }
      completed += 1
      if (completed % 512 === 0 || completed === total) {
        options.onProgress?.({
          current: completed,
          total,
          message: `Verifying indexed files (${missing + invalid} unavailable)`,
        })
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(total, 1)) }, worker))
  return {
    assets: verified.filter((record): record is ImageIndexAssetSourceRecord => !!record),
    missing,
    invalid,
  }
}

export async function readImageIndexAssets(
  inputPath: string,
  options: ReadImageIndexOptions = {},
): Promise<{ assets: ImageIndexAssetSourceRecord[]; sourceManifest: string }> {
  const input = resolveManifestInput(inputPath)
  let segments: Array<{ path: string; recordCount: number }>
  let sourceManifest = input.singleSegmentPath || input.manifestPath || input.rootDir

  if (input.singleSegmentPath) {
    segments = [{ path: input.singleSegmentPath, recordCount: 0 }]
  } else {
    if (!input.manifestPath || !fs.existsSync(input.manifestPath)) {
      throw new Error('Image Search manifest.json was not found')
    }
    const manifestStat = await fs.promises.stat(input.manifestPath)
    if (manifestStat.size > MAX_MANIFEST_BYTES) {
      throw new Error('Image Search manifest exceeds safety limit')
    }
    const parsed = JSON.parse(
      await fs.promises.readFile(input.manifestPath, 'utf8'),
    ) as ImageIndexManifest
    if (!Array.isArray(parsed.segments)) {
      throw new Error('Image Search manifest has an invalid segments list')
    }
    if (parsed.segments.length > MAX_MANIFEST_SEGMENTS) {
      throw new Error('Image Search manifest has too many segments')
    }
    segments = parsed.segments.map((segment) => {
      if (!segment || typeof segment.file !== 'string') {
        throw new Error('Image Search manifest contains an invalid segment')
      }
      return {
        path: resolveSegmentPath(input.rootDir, segment.file),
        recordCount:
          typeof segment.recordCount === 'number' && Number.isFinite(segment.recordCount)
            ? Math.max(0, Math.floor(segment.recordCount))
            : 0,
      }
    })
    sourceManifest = input.manifestPath
  }

  let totalSegmentBytes = 0
  for (const segment of segments) {
    const stat = await fs.promises.stat(segment.path)
    if (!stat.isFile()) throw new Error(`Image index segment is not a file: ${segment.path}`)
    if (stat.size > MAX_SEGMENT_FILE_BYTES) {
      throw new Error('Image index segment exceeds file-size safety limit')
    }
    totalSegmentBytes += stat.size
    if (totalSegmentBytes > MAX_TOTAL_SEGMENT_BYTES) {
      throw new Error('Image index segments exceed total-size safety limit')
    }
  }

  const deletedPaths = await readDeletedOverlay(input.rootDir)
  const declaredTotal = segments.reduce((sum, segment) => sum + segment.recordCount, 0)
  if (declaredTotal > MAX_RECORDS) {
    throw new Error('Image index manifest record count exceeds safety limit')
  }
  const byPath = new Map<string, ImageIndexAssetSourceRecord>()
  let current = 0
  let sourceRecordCount = 0
  for (const segment of segments) {
    const result = await readSegment(
      segment.path,
      current,
      declaredTotal,
      options,
      MAX_RECORDS - sourceRecordCount,
    )
    sourceRecordCount += result.sourceRecordCount
    for (const record of result.records) {
      const key = normalizePathKey(record.path)
      if (!deletedPaths.has(key) && !byPath.has(key)) byPath.set(key, record)
    }
    current += segment.recordCount || result.sourceRecordCount
    options.onProgress?.({
      current,
      total: declaredTotal || current,
      message: 'Merging index segments',
    })
  }

  return { assets: [...byPath.values()], sourceManifest }
}
