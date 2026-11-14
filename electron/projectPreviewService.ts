import { scanErrorRecorder } from './scanErrorLog'
import { runShellPreviewCompute, reportShellPreviewDiagnostic } from './projectPreviewShellRuntime'
import type { ScanResponsiveness } from './scanResponsiveness'
import crypto from 'crypto'
import fsp from 'fs/promises'
import path from 'path'
import { runProjectPreviewCompute } from './projectPreviewCompute'
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

const FAILED_PREVIEW_RETRY_MS = 5 * 60 * 1000
const RESOURCE_PREVIEW_RETRY_MS = 30 * 60 * 1000
const PROJECT_PREVIEW_ENCODING_VERSION = 'jpeg-v2-vector-focus'

function cacheProviderVersion(provider: ProjectPreviewProvider): string {
  return `${provider.version}+${PROJECT_PREVIEW_ENCODING_VERSION}`
}

export interface ProjectPreviewRequestOptions {
  diagnostics?: ScanResponsiveness
  isCancelled?: () => boolean
  forceRetry?: boolean
  pdfTimeoutMs?: number
}

export class ProjectPreviewService {
  readonly manifest: ProjectPreviewManifestStore
  private readonly pending = new Map<string, Promise<ProjectPreviewManifestEntry>>()
  private readonly offloadProviders: boolean
  private readonly providers: readonly ProjectPreviewProvider[]

  constructor(userDataPath: string, providers?: readonly ProjectPreviewProvider[]) {
    this.offloadProviders = providers === undefined
    this.manifest = new ProjectPreviewManifestStore(userDataPath)
    this.providers = providers ?? [
      ...BUILTIN_PROJECT_PREVIEW_PROVIDERS,
      ...loadExternalProjectPreviewProviders(userDataPath),
    ]
  }

  async getOrCreate(
    sourcePath: string,
    options: ProjectPreviewRequestOptions = {},
  ): Promise<ProjectPreviewManifestEntry> {
    const resolved = path.resolve(sourcePath)
    // A scan owns its cancellation; do not cancel another caller's shared job.
    if (options.isCancelled || options.forceRetry || options.pdfTimeoutMs)
      return this.createOrReuse(resolved, options)
    const existing = this.pending.get(resolved)
    if (existing) return existing
    const task = this.createOrReuse(resolved).finally(() => this.pending.delete(resolved))
    this.pending.set(resolved, task)
    return task
  }

  private async createOrReuse(
    sourcePath: string,
    options: ProjectPreviewRequestOptions = {},
  ): Promise<ProjectPreviewManifestEntry> {
    const measure = <T>(name: string, operation: () => T): T =>
      options.diagnostics ? options.diagnostics.measure(name, operation) : operation()
    const checkCancelled = () => {
      if (options.isCancelled?.())
        throw Object.assign(new Error('PROJECT_PREVIEW_CANCELLED'), {
          code: 'PROJECT_PREVIEW_CANCELLED',
        })
    }
    checkCancelled()
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
      !options.forceRetry &&
      previous.status !== 'ready' &&
      previous.provider === 'provider-chain' &&
      previous.providerVersion === chainVersion &&
      Date.now() < (previous.retryAfter ?? previous.updatedAt + FAILED_PREVIEW_RETRY_MS)
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
      checkCancelled()
      let previewBytes: Buffer | null = null
      let prepared: { data: Uint8Array; width: number; height: number } | null = null
      try {
        if (
          this.offloadProviders &&
          provider.id === 'windows-shell-thumbnail' &&
          BUILTIN_PROJECT_PREVIEW_PROVIDERS.includes(provider)
        ) {
          previewBytes = await measure(`provider:${provider.id}`, () =>
            runShellPreviewCompute(sourcePath, {
              isCancelled: options.isCancelled,
              onMetrics: (metrics) => {
                if (options.diagnostics) options.diagnostics.event('shell-preview', metrics)
                else reportShellPreviewDiagnostic(metrics)
                if (metrics.outcome !== 'ready')
                  scanErrorRecorder.record(
                    'windows-shell',
                    metrics.errorCode ??
                      metrics.failureCode ??
                      (metrics.outcome === 'source-limit'
                        ? 'SHELL_SOURCE_LIMIT'
                        : metrics.outcome === 'icon-only'
                          ? 'SHELL_ICON_ONLY'
                          : 'SHELL_NO_PREVIEW'),
                    sourcePath,
                    metrics.reason,
                    metrics.outcome === 'error' ? 'error' : 'warning',
                    {
                      step: metrics.activeStep,
                      durationMs: metrics.durationMs,
                      sourceInfo: metrics.sourceInfo,
                    },
                  )
              },
            }),
          )
        } else if (
          this.offloadProviders &&
          BUILTIN_PROJECT_PREVIEW_PROVIDERS.includes(provider) &&
          provider.id !== 'windows-shell-thumbnail'
        ) {
          prepared = (await measure(`provider:${provider.id}`, () =>
            runProjectPreviewCompute(
              {
                kind: 'extractImage',
                sourcePath,
                sourceExt: classification.sourceExt,
                providerId: provider.id,
              },
              { isCancelled: options.isCancelled, timeoutMs: options.pdfTimeoutMs ?? 120_000 },
            ),
          )) as typeof prepared
        } else
          previewBytes = await measure(`provider:${provider.id}`, () =>
            provider.extract(sourcePath),
          )
      } catch (error) {
        checkCancelled()
        const code = (error as { code?: string }).code
        if (code?.startsWith('PDF_PREVIEW_') || code?.startsWith('SHELL_PREVIEW_')) {
          console.warn('[ProjectPreview]', provider.id, code)
          return this.recordFailure(
            { ...common, provider: 'provider-chain', providerVersion: chainVersion },
            'error',
            code,
            previous,
            Date.now() + RESOURCE_PREVIEW_RETRY_MS,
          )
        }
        decodeFailed = true
      }
      checkCancelled()
      if (!previewBytes && !prepared) continue
      const entry = await measure('preview-save', () =>
        this.createPreviewEntry(
          {
            ...common,
            provider: provider.id,
            providerVersion: cacheProviderVersion(provider),
          },
          previewBytes,
          previous,
          prepared,
        ),
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
    previewBytes: Buffer | null,
    previous: ProjectPreviewManifestEntry | null,
    prepared: { data: Uint8Array; width: number; height: number } | null = null,
  ): Promise<ProjectPreviewManifestEntry | null> {
    let temporaryPath = ''
    try {
      const output =
        prepared ??
        ((await runProjectPreviewCompute({
          kind: 'image',
          bytes: previewBytes,
          sourceExt: base.sourceExt,
        })) as { data: Uint8Array; width: number; height: number })
      const cacheKey = projectPreviewCacheKey(base)
      const previewPath = path.join(this.manifest.previewsDir, `${cacheKey}.jpg`)
      temporaryPath = `${previewPath}.${process.pid}.${crypto.randomUUID()}.tmp`
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
        width: output.width,
        height: output.height,
        status: 'ready',
        updatedAt: Date.now(),
      }
      await this.manifest.upsert(entry)
      await this.removeReplacedPreview(previous, entry)
      return entry
    } catch (error) {
      scanErrorRecorder.record('preview-output', 'PREVIEW_OUTPUT_FAILED', base.sourcePath, error)
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
    retryAfter?: number,
  ): Promise<ProjectPreviewManifestEntry> {
    const entry: ProjectPreviewManifestEntry = {
      ...base,
      status,
      errorCode,
      ...(retryAfter ? { retryAfter } : {}),
      ...(previous?.previewPath
        ? {
            previewPath: previous.previewPath,
            previewHash: previous.previewHash,
            width: previous.width,
            height: previous.height,
          }
        : {}),
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
