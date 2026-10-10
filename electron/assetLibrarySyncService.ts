import type { AssetLibraryTaskProgress, AssetLibraryTaskResult } from '../shared/ipc/asset-library'
import {
  readImageIndexAssets,
  verifyImageIndexAssets,
  type ImageIndexAssetSourceRecord,
} from './imageIndexAssetSource'
import { getImageSearchStatus } from './imageSearchService'
import type { AssetMetadataSyncResult } from './assetMetadataStore'
import { requireAssetLibraryStores } from './assetLibraryStorageContext'
import { taskPercent, type AssetLibraryRunningTask } from './assetLibraryTaskController'

interface AssetLibrarySyncAssetStore {
  replaceFromImageIndex(
    sourceRecords: ImageIndexAssetSourceRecord[],
    sourceManifest: string,
    isCancelled: () => boolean,
    onProgress?: (current: number, total: number) => void,
  ): Promise<AssetMetadataSyncResult>
}

export interface AssetLibrarySyncHost {
  startTask(
    type: 'sync',
    runner: (task: AssetLibraryRunningTask) => Promise<string>,
  ): AssetLibraryTaskResult
  publishProgress(patch: Partial<AssetLibraryTaskProgress>): void
  markFeedbackDirty(reason: string): Promise<void>
  invalidateSearchResults?(): void
}

export interface AssetLibrarySyncDependencies {
  getDefaultSourcePath(): string | undefined
  getAssetStore(): AssetLibrarySyncAssetStore
  readSource: typeof readImageIndexAssets
  verifySource: typeof verifyImageIndexAssets
}

const defaultDependencies: AssetLibrarySyncDependencies = {
  getDefaultSourcePath: () => getImageSearchStatus().segmentPath,
  getAssetStore: () => requireAssetLibraryStores().assets,
  readSource: readImageIndexAssets,
  verifySource: verifyImageIndexAssets,
}

export function startAssetLibrarySyncTask(
  manifestPath: string | undefined,
  host: AssetLibrarySyncHost,
  dependencies: AssetLibrarySyncDependencies = defaultDependencies,
): AssetLibraryTaskResult {
  return host.startTask('sync', async (task) => {
    const sourcePath = manifestPath?.trim() || dependencies.getDefaultSourcePath()
    if (!sourcePath) throw new Error('Load or build an Image Search index first')

    const source = await dependencies.readSource(sourcePath, {
      isCancelled: () => task.cancelled,
      onProgress: ({ current, total, message }) => {
        host.publishProgress({
          current,
          total,
          percent: Math.round(taskPercent(current, total) * 0.35),
          message,
        })
      },
    })
    const verified = await dependencies.verifySource(source.assets, {
      concurrency: 24,
      isCancelled: () => task.cancelled,
      onProgress: ({ current, total, message }) => {
        host.publishProgress({
          current,
          total,
          percent: 35 + Math.round(taskPercent(current, total) * 0.55),
          message,
        })
      },
    })
    host.publishProgress({
      current: verified.assets.length,
      total: verified.assets.length,
      percent: 92,
      message: 'Saving asset metadata...',
    })
    const result = await dependencies.getAssetStore().replaceFromImageIndex(
      verified.assets,
      source.sourceManifest,
      () => task.cancelled,
      (current, total) => {
        host.publishProgress({
          current,
          total,
          percent: 92 + Math.round(taskPercent(current, total) * 0.07),
          message: 'Updating asset library...',
        })
      },
    )
    const unavailable = verified.missing + verified.invalid
    if (result.added > 0 || result.updated > 0 || result.missing > 0) {
      host.invalidateSearchResults?.()
      await host.markFeedbackDirty('Asset library synchronized with Image Search')
    }
    return `Synced ${result.total.toLocaleString()} available assets: ${result.added} new, ${result.updated} updated, ${result.missing} marked missing, ${unavailable} stale index records skipped.`
  })
}
