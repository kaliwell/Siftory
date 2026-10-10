import fs from 'fs'
import path from 'path'
import type { DiscoveryCatalogResultItem } from '../shared/ipc/discovery-catalog'
import type { SourceCatalogService } from './sourceCatalogService'

interface SftpVideoProjectionRecord {
  fileEntryId: string
  localPath: string
  videoId: string
  updatedAt: number
}

export class SftpVideoProjectionStore {
  private records: SftpVideoProjectionRecord[] | null = null

  constructor(private readonly filePath: string) {}

  upsert(record: SftpVideoProjectionRecord): void {
    const records = this.load().filter(
      (candidate) =>
        candidate.fileEntryId !== record.fileEntryId &&
        path.resolve(candidate.localPath) !== path.resolve(record.localPath),
    )
    records.push(record)
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    fs.writeFileSync(temporaryPath, JSON.stringify(records), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporaryPath, this.filePath)
    this.records = records
  }

  hydrate(
    localPaths: readonly string[],
    catalog: Pick<SourceCatalogService, 'getFileEntryForAction'>,
  ): DiscoveryCatalogResultItem[] {
    const wanted = new Set(localPaths.map((item) => path.resolve(item).toLowerCase()))
    const items: DiscoveryCatalogResultItem[] = []
    for (const projection of this.load()) {
      if (!wanted.has(path.resolve(projection.localPath).toLowerCase())) continue
      if (!fs.existsSync(projection.localPath)) continue
      const record = catalog.getFileEntryForAction(projection.fileEntryId)
      if (!record) continue
      items.push({
        fileEntryId: record.fileEntryId,
        displayName: record.displayName,
        displayPath: record.displayPath,
        recallPath: projection.localPath,
        sizeBytes: record.sizeBytes,
        modifiedAt: record.modifiedAt,
        source: {
          id: record.source.id,
          name: record.source.displayName,
          type: record.source.type,
          availability: record.source.availability,
        },
        indexState: ['metadata-ready', 'video-frame-ready'],
      })
    }
    return items
  }

  private load(): SftpVideoProjectionRecord[] {
    if (this.records) return [...this.records]
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown
      this.records = Array.isArray(parsed)
        ? parsed.filter(
            (item): item is SftpVideoProjectionRecord =>
              Boolean(item) &&
              typeof item.fileEntryId === 'string' &&
              typeof item.localPath === 'string' &&
              typeof item.videoId === 'string' &&
              typeof item.updatedAt === 'number',
          )
        : []
    } catch {
      this.records = []
    }
    return [...this.records]
  }
}

let activeStore: SftpVideoProjectionStore | null = null

export function initSftpVideoProjectionStore(filePath: string): SftpVideoProjectionStore {
  activeStore = new SftpVideoProjectionStore(filePath)
  return activeStore
}

export function getSftpVideoProjectionStore(): SftpVideoProjectionStore | null {
  return activeStore
}
