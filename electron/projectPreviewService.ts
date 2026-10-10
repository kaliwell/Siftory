import crypto from 'crypto'
import fsp from 'fs/promises'
import path from 'path'
import sharp from 'sharp'
import { classifyProjectFile } from '../shared/projectFileTypes'
import {
  ProjectPreviewManifestStore,
  projectPreviewCacheKey,
  projectSourceId,
  type ProjectPreviewManifestEntry,
} from './projectPreviewManifest'
import {
  BUILTIN_PROJECT_PREVIEW_PROVIDERS,
  providersForExtension,
  type ProjectPreviewProvider,
} from './projectPreviewProviders'
import { loadExternalProjectPreviewProviders } from './projectPreviewExternalProviders'

const MAX_PROJECT_PREVIEW_PIXELS = 100_000_000
const PROJECT_PREVIEW_MAX_DIMENSION = 2048
const FAILED_PREVIEW_RETRY_MS = 5 * 60 * 1000
const PROJECT_PREVIEW_ENCODING_VERSION = 'jpeg-v2-vector-focus'
const FOCUSED_VECTOR_EXTENSIONS = new Set(['ai', 'svg', 'eps'])
const VECTOR_BACKGROUND_DISTANCE = 72
const VECTOR_CONTENT_MARGIN_RATIO = 0.08

interface VectorComponentBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

async function focusVectorArtwork(previewBytes: Buffer): Promise<Buffer> {
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
  const components: VectorComponentBounds[] = []
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
      const visit = (next: number) => {
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

function cacheProviderVersion(provider: ProjectPreviewProvider): string {
  return `${provider.version}+${PROJECT_PREVIEW_ENCODING_VERSION}`
}

export class ProjectPreviewService {
  readonly manifest: ProjectPreviewManifestStore
  private readonly pending = new Map<string, Promise<ProjectPreviewManifestEntry>>()
  private readonly providers: readonly ProjectPreviewProvider[]

  constructor(userDataPath: string, providers?: readonly ProjectPreviewProvider[]) {
    this.manifest = new ProjectPreviewManifestStore(userDataPath)
    this.providers = providers ?? [
      ...BUILTIN_PROJECT_PREVIEW_PROVIDERS,
      ...loadExternalProjectPreviewProviders(userDataPath),
    ]
  }

  async getOrCreate(sourcePath: string): Promise<ProjectPreviewManifestEntry> {
    const resolved = path.resolve(sourcePath)
    const existing = this.pending.get(resolved)
    if (existing) return existing
    const task = this.createOrReuse(resolved).finally(() => this.pending.delete(resolved))
    this.pending.set(resolved, task)
    return task
  }

  private async createOrReuse(sourcePath: string): Promise<ProjectPreviewManifestEntry> {
    const classification = classifyProjectFile(sourcePath)
    if (!classification) throw new Error('Unsupported project file type')
    const stat = await fsp.stat(sourcePath)
    if (!stat.isFile()) throw new Error('Project preview source is not a file')
    const providers = providersForExtension(classification.sourceExt, this.providers)
    const common = {
      sourceId: projectSourceId(sourcePath),
      sourcePath,
      sourceExt: classification.sourceExt,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      keywords: classification.keywords,
    }
    const chainVersion = crypto
      .createHash('sha256')
      .update(
        providers.map((provider) => `${provider.id}@${cacheProviderVersion(provider)}`).join('|'),
      )
      .digest('hex')
      .slice(0, 16)
    const previous = await this.manifest.get(sourcePath)
    const sameSource =
      previous && previous.size === common.size && Math.abs(previous.mtimeMs - common.mtimeMs) <= 1
    if (sameSource && previous.status === 'ready' && previous.previewPath) {
      const providerStillMatches = providers.some(
        (provider) =>
          provider.id === previous.provider &&
          cacheProviderVersion(provider) === previous.providerVersion,
      )
      const previewStillExists = await fsp
        .stat(previous.previewPath)
        .then((previewStat) => previewStat.isFile())
        .catch(() => false)
      if (providerStillMatches && previewStillExists) return previous
    }
    if (
      sameSource &&
      previous.status !== 'ready' &&
      previous.provider === 'provider-chain' &&
      previous.providerVersion === chainVersion &&
      Date.now() - previous.updatedAt < FAILED_PREVIEW_RETRY_MS
    ) {
      return previous
    }

    if (providers.length === 0) {
      return this.recordFailure(
        {
          ...common,
          provider: 'provider-chain',
          providerVersion: chainVersion,
        },
        'unavailable',
        'NO_PREVIEW_PROVIDER',
        previous,
      )
    }

    let decodeFailed = false
    for (const provider of providers) {
      let previewBytes: Buffer | null
      try {
        previewBytes = await provider.extract(sourcePath)
      } catch {
        previewBytes = null
      }
      if (!previewBytes) continue
      const entry = await this.createPreviewEntry(
        {
          ...common,
          provider: provider.id,
          providerVersion: cacheProviderVersion(provider),
        },
        previewBytes,
        previous,
      )
      if (entry) return entry
      decodeFailed = true
    }
    return this.recordFailure(
      {
        ...common,
        provider: 'provider-chain',
        providerVersion: chainVersion,
      },
      decodeFailed ? 'error' : 'unavailable',
      decodeFailed ? 'PREVIEW_DECODE_FAILED' : 'NO_CONTENT_PREVIEW',
      previous,
    )
  }

  private async createPreviewEntry(
    base: Omit<ProjectPreviewManifestEntry, 'status' | 'updatedAt'>,
    previewBytes: Buffer,
    previous: ProjectPreviewManifestEntry | null,
  ): Promise<ProjectPreviewManifestEntry | null> {
    let temporaryPath = ''
    try {
      const image = sharp(previewBytes, {
        animated: false,
        density: 192,
        limitInputPixels: MAX_PROJECT_PREVIEW_PIXELS,
        sequentialRead: true,
      })
      const metadata = await image.metadata()
      if (!metadata.width || !metadata.height) return null
      const cacheKey = projectPreviewCacheKey(base)
      const previewPath = path.join(this.manifest.previewsDir, `${cacheKey}.jpg`)
      temporaryPath = `${previewPath}.${process.pid}.${Date.now()}.tmp`
      const prepared = image
        .rotate()
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .resize(PROJECT_PREVIEW_MAX_DIMENSION, PROJECT_PREVIEW_MAX_DIMENSION, {
          fit: 'inside',
          withoutEnlargement: true,
        })
      const focusedBytes = FOCUSED_VECTOR_EXTENSIONS.has(base.sourceExt)
        ? await focusVectorArtwork(await prepared.png().toBuffer())
        : null
      const output = await (focusedBytes ? sharp(focusedBytes) : prepared)
        .jpeg({ quality: 90 })
        .toBuffer({ resolveWithObject: true })
      await fsp.mkdir(this.manifest.previewsDir, { recursive: true })
      await fsp.writeFile(temporaryPath, output.data)
      await fsp.rename(temporaryPath, previewPath)
      const entry: ProjectPreviewManifestEntry = {
        ...base,
        keywords:
          base.sourceExt === 'ai' && base.provider === 'pdfjs-first-page'
            ? [...base.keywords, 'pdf-compatible']
            : base.keywords,
        previewPath,
        previewHash: crypto.createHash('sha256').update(output.data).digest('hex'),
        width: output.info.width,
        height: output.info.height,
        status: 'ready',
        updatedAt: Date.now(),
      }
      await this.manifest.upsert(entry)
      await this.removeReplacedPreview(previous, entry)
      return entry
    } catch {
      return null
    } finally {
      if (temporaryPath) await fsp.unlink(temporaryPath).catch(() => {})
    }
  }

  private async recordFailure(
    base: Omit<ProjectPreviewManifestEntry, 'status' | 'updatedAt'>,
    status: 'unavailable' | 'error',
    errorCode: string,
    previous: ProjectPreviewManifestEntry | null,
  ): Promise<ProjectPreviewManifestEntry> {
    const entry: ProjectPreviewManifestEntry = {
      ...base,
      status,
      errorCode,
      updatedAt: Date.now(),
    }
    await this.manifest.upsert(entry)
    await this.removeReplacedPreview(previous, entry)
    return entry
  }

  private async removeReplacedPreview(
    previous: ProjectPreviewManifestEntry | null,
    current: ProjectPreviewManifestEntry,
  ): Promise<void> {
    if (!previous?.previewPath || previous.previewPath === current.previewPath) return
    const previewRoot = path.resolve(this.manifest.previewsDir)
    const candidate = path.resolve(previous.previewPath)
    if (!candidate.startsWith(`${previewRoot}${path.sep}`)) return
    await fsp.unlink(candidate).catch(() => {})
  }
}

const services = new Map<string, ProjectPreviewService>()

export function getProjectPreviewService(userDataPath: string): ProjectPreviewService {
  const resolved = path.resolve(userDataPath)
  let service = services.get(resolved)
  if (!service) {
    service = new ProjectPreviewService(resolved)
    services.set(resolved, service)
  }
  return service
}
