import crypto from 'crypto'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import type { ProjectSourceExt } from '../shared/projectFileTypes'

export type ProjectPreviewStatus = 'ready' | 'unavailable' | 'error'

export interface ProjectPreviewManifestEntry {
  sourceId: string
  sourcePath: string
  sourceExt: ProjectSourceExt
  size: number
  mtimeMs: number
  provider: string
  providerVersion: string
  previewPath?: string
  previewHash?: string
  diffHash64?: string
  dctHash64?: string
  width?: number
  height?: number
  keywords: string[]
  status: ProjectPreviewStatus
  errorCode?: string
  updatedAt: number
}

interface ProjectPreviewManifestFile {
  version: 1
  entries: ProjectPreviewManifestEntry[]
}

export function projectSourceId(sourcePath: string): string {
  const normalized = path.resolve(sourcePath)
  const stablePath = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  return crypto.createHash('sha256').update(stablePath).digest('hex')
}

export function projectPreviewCacheKey(
  entry: Pick<
    ProjectPreviewManifestEntry,
    'sourcePath' | 'size' | 'mtimeMs' | 'provider' | 'providerVersion'
  >,
): string {
  return crypto
    .createHash('sha256')
    .update(
      [
        projectSourceId(entry.sourcePath),
        String(entry.size),
        String(Math.round(entry.mtimeMs)),
        entry.provider,
        entry.providerVersion,
      ].join('|'),
    )
    .digest('hex')
}

export class ProjectPreviewManifestStore {
  readonly rootDir: string
  readonly previewsDir: string
  readonly manifestPath: string
  private readonly entries = new Map<string, ProjectPreviewManifestEntry>()
  private loaded = false
  private writeChain: Promise<void> = Promise.resolve()

  constructor(userDataPath: string) {
    this.rootDir = path.join(userDataPath, 'project-previews', 'v1')
    this.previewsDir = path.join(this.rootDir, 'previews')
    this.manifestPath = path.join(this.rootDir, 'manifest.json')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    await fsp.mkdir(this.previewsDir, { recursive: true })
    try {
      const parsed = JSON.parse(
        await fsp.readFile(this.manifestPath, 'utf8'),
      ) as Partial<ProjectPreviewManifestFile>
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
        throw new Error('Unsupported project preview manifest')
      }
      for (const entry of parsed.entries) {
        if (
          entry &&
          typeof entry.sourceId === 'string' &&
          typeof entry.sourcePath === 'string' &&
          Array.isArray(entry.keywords)
        ) {
          this.entries.set(entry.sourceId, entry)
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && fs.existsSync(this.manifestPath)) {
        const backup = `${this.manifestPath}.corrupted-${Date.now()}`
        await fsp.rename(this.manifestPath, backup).catch(() => {})
      }
    }
    this.loaded = true
  }

  async get(sourcePath: string): Promise<ProjectPreviewManifestEntry | null> {
    await this.load()
    return this.entries.get(projectSourceId(sourcePath)) ?? null
  }

  async upsert(entry: ProjectPreviewManifestEntry): Promise<void> {
    await this.load()
    this.entries.set(entry.sourceId, entry)
    this.writeChain = this.writeChain.then(() => this.writeAtomic())
    await this.writeChain
  }

  async list(): Promise<ProjectPreviewManifestEntry[]> {
    await this.load()
    return [...this.entries.values()]
  }

  async removeMany(sourcePaths: readonly string[]): Promise<number> {
    await this.load()
    let removed = 0
    for (const sourcePath of sourcePaths) {
      if (this.entries.delete(projectSourceId(sourcePath))) removed += 1
    }
    if (removed > 0) {
      this.writeChain = this.writeChain.then(() => this.writeAtomic())
      await this.writeChain
    }
    return removed
  }

  private async writeAtomic(): Promise<void> {
    const payload: ProjectPreviewManifestFile = {
      version: 1,
      entries: [...this.entries.values()].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)),
    }
    const temporaryPath = `${this.manifestPath}.${process.pid}.${Date.now()}.tmp`
    await fsp.writeFile(temporaryPath, JSON.stringify(payload, null, 2), 'utf8')
    await fsp.rename(temporaryPath, this.manifestPath)
  }
}
