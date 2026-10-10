import React from 'react'
import type {
  AssetCategory,
  AssetLibraryAssetItem,
  AssetLibraryStats,
  AssetSmartAlbum,
  AssetTag,
} from '../../../shared/ipc-contract'
import AssetLibraryAssetGrid from '../AssetLibraryAssetGrid'
import AssetSmartAlbumBar from './AssetSmartAlbumBar'
import {
  assetLibraryButtonStyle,
  assetLibraryInputStyle,
  formatAssetLibraryNumber,
} from './assetLibraryViewUtils'
import { useTranslation } from '../../i18n/useTranslation'
import { useAssetCollections } from '../../hooks/useAssetCollections'

type AssetSort = 'updated_desc' | 'name_asc' | 'size_desc'
type AssetSourceFilter = 'all' | 'image_search' | 'manual'
type AssetKindFilter = 'all' | 'image' | 'video_frame'

function dateInputValue(timestamp: number): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}

function startOfLocalDate(value: string): number {
  return value ? new Date(`${value}T00:00:00`).getTime() : 0
}

function endOfLocalDate(value: string): number {
  return value ? new Date(`${value}T23:59:59.999`).getTime() : 0
}

interface AssetLibraryAssetsViewProps {
  query: string
  categoryFilter: number
  tagFilter: number
  unclassifiedOnly: boolean
  archivedOnly: boolean
  sourceFilter: AssetSourceFilter
  kindFilter: AssetKindFilter
  modifiedAfter: number
  modifiedBefore: number
  minRating: number
  favoriteOnly: boolean
  sort: AssetSort
  stats: AssetLibraryStats
  rows: Array<{ category: AssetCategory; depth: number }>
  categories: AssetCategory[]
  tags: AssetTag[]
  assets: AssetLibraryAssetItem[]
  selectedIds: Set<number>
  lastArchivedIds: number[]
  batchCategoryId: number
  batchTagId: number
  loading: boolean
  offset: number
  total: number
  pageSize: number
  smartAlbums: AssetSmartAlbum[]
  selectedSmartAlbumId: number
  smartAlbumName: string
  smartAlbumBusy: boolean
  onQueryChange(value: string): void
  onCategoryFilterChange(value: number): void
  onTagFilterChange(value: number): void
  onUnclassifiedChange(value: boolean): void
  onArchivedChange(value: boolean): void
  onSourceFilterChange(value: AssetSourceFilter): void
  onKindFilterChange(value: AssetKindFilter): void
  onModifiedAfterChange(value: number): void
  onModifiedBeforeChange(value: number): void
  onMinRatingChange(value: number): void
  onFavoriteOnlyChange(value: boolean): void
  onSetSelectedRating(value: number): void
  onSetSelectedFavorite(value: boolean): void
  onSortChange(value: AssetSort): void
  onSelectPage(): void
  onClearSelection(): void
  onRestoreSelected(): void
  onArchiveSelected(): void
  onUndoArchive(): void
  onBatchCategoryChange(value: number): void
  onAssignCategory(): void
  onAddReferences(): void
  onImportReferences(categoryId: number): void
  onPasteReference(categoryId: number): void
  onBatchTagChange(value: number): void
  onAssignTag(): void
  onSetSelected(ids: number[], selected: boolean): void
  onOpenAsset(assetId: number): void
  onRevealAsset(assetId: number): void
  onReloadAssets(): void
  onPreviousPage(): void
  onNextPage(): void
  onSmartAlbumSelect(id: number): void
  onSmartAlbumNameChange(value: string): void
  onSmartAlbumCreate(): void
  onSmartAlbumUpdate(): void
  onSmartAlbumDelete(): void
}

const AssetLibraryAssetsView: React.FC<AssetLibraryAssetsViewProps> = ({
  query,
  categoryFilter,
  tagFilter,
  unclassifiedOnly,
  archivedOnly,
  sourceFilter,
  kindFilter,
  modifiedAfter,
  modifiedBefore,
  minRating,
  favoriteOnly,
  sort,
  stats,
  rows,
  categories,
  tags,
  assets,
  selectedIds,
  lastArchivedIds,
  batchCategoryId,
  batchTagId,
  loading,
  offset,
  total,
  pageSize,
  smartAlbums,
  selectedSmartAlbumId,
  smartAlbumName,
  smartAlbumBusy,
  onQueryChange,
  onCategoryFilterChange,
  onTagFilterChange,
  onUnclassifiedChange,
  onArchivedChange,
  onSourceFilterChange,
  onKindFilterChange,
  onModifiedAfterChange,
  onModifiedBeforeChange,
  onMinRatingChange,
  onFavoriteOnlyChange,
  onSetSelectedRating,
  onSetSelectedFavorite,
  onSortChange,
  onSelectPage,
  onClearSelection,
  onRestoreSelected,
  onArchiveSelected,
  onUndoArchive,
  onBatchCategoryChange,
  onAssignCategory,
  onAddReferences,
  onImportReferences,
  onPasteReference,
  onBatchTagChange,
  onAssignTag,
  onSetSelected,
  onOpenAsset,
  onRevealAsset,
  onReloadAssets,
  onPreviousPage,
  onNextPage,
  onSmartAlbumSelect,
  onSmartAlbumNameChange,
  onSmartAlbumCreate,
  onSmartAlbumUpdate,
  onSmartAlbumDelete,
}) => {
  const { t } = useTranslation()
  const { collectionId, collections, setCollectionId } = useAssetCollections()
  const [collecting, setCollecting] = React.useState(false)
  const [collectionError, setCollectionError] = React.useState('')
  const [repairStatus, setRepairStatus] = React.useState('')
  const [pendingRepairId, setPendingRepairId] = React.useState('')

  React.useEffect(() => {
    let mounted = true
    void window.electronAPI.assetIdentity
      .listPendingRepairs()
      .then((result) => {
        if (!mounted || !result.ok || result.pending.length === 0) return
        setPendingRepairId(result.pending[0].recoveryId)
        setRepairStatus(t('An interrupted moved asset repair is ready to retry.'))
      })
      .catch(() => undefined)
    return () => {
      mounted = false
    }
  }, [t])

  const scheduleRepairRecovery = async (token: string) => {
    const preview = await window.electronAPI.assetIdentity.previewDerivedRebuild(token)
    if (!preview.ok) throw new Error(preview.error || t('Could not preview the rebuild.'))
    if (preview.requiresDerivedRebuild) {
      const sizeMiB = ((preview.estimatedBytes || 0) / (1024 * 1024)).toFixed(1)
      const confirmed = window.confirm(
        t(
          'The asset identity was repaired, but derived indexes need rebuilding. Clear {files} derived files ({size} MiB) and rescan {roots} roots now?',
          {
            files: preview.fileCount || 0,
            size: sizeMiB,
            roots: preview.roots?.length || 0,
          },
        ),
      )
      if (!confirmed) return false
    }
    const started = await window.electronAPI.assetIdentity.startDerivedRebuild(token)
    if (!started.ok || !started.scheduled) {
      throw new Error(started.error || t('Could not schedule the derived rebuild.'))
    }
    setPendingRepairId('')
    setRepairStatus(
      preview.requiresDerivedRebuild
        ? t('Moved asset repaired; derived rebuild scheduled.')
        : t('Moved asset repair retry scheduled.'),
    )
    return true
  }

  const retryPendingRepair = async () => {
    try {
      const pending = await window.electronAPI.assetIdentity.listPendingRepairs()
      if (!pending.ok) throw new Error(pending.error || t('Could not load pending repairs.'))
      const recovery = pending.pending.find((item) => item.recoveryId === pendingRepairId)
      if (!recovery) {
        setPendingRepairId('')
        setRepairStatus(t('The moved asset repair is already complete.'))
        return
      }
      await scheduleRepairRecovery(recovery.grant.token)
    } catch (error) {
      setRepairStatus(error instanceof Error ? error.message : t('The operation failed.'))
    }
  }

  const repairMoved = async (assetId: number) => {
    const item = assets.find((candidate) => candidate.asset.id === assetId)
    if (!item) return
    setRepairStatus('')
    try {
      const selectedPath = await window.electronAPI.imageSearch.selectImage()
      if (!selectedPath) return
      const result = await window.electronAPI.assetIdentity.repairMoved(selectedPath)
      if (!result.repaired)
        throw new Error(result.error || t('The selected file is not this asset.'))
      onReloadAssets()
      const grant = result.derivedRebuildGrant
      if (!grant) {
        setRepairStatus(t('Moved asset repaired.'))
        return
      }
      const scheduled = await scheduleRepairRecovery(grant.token)
      if (!scheduled) {
        setRepairStatus(t('Moved asset repaired; derived rebuild was not started.'))
      }
    } catch (error) {
      setRepairStatus(error instanceof Error ? error.message : t('The operation failed.'))
    }
  }
  const collectSelected = async () => {
    const selected = assets.filter((item) => selectedIds.has(item.asset.id)).slice(0, 500)
    if (!collectionId || selected.length === 0) return
    setCollecting(true)
    setCollectionError('')
    try {
      const inputs = []
      for (let start = 0; start < selected.length; start += 8) {
        const batch = await Promise.all(
          selected.slice(start, start + 8).map(async ({ asset }) => {
            const resolved = await window.electronAPI.assetIdentity.resolve(asset.path)
            if (!resolved.ok || !resolved.identity)
              throw new Error(resolved.error || 'AssetId required')
            return {
              assetId: resolved.identity.assetId,
              mediaType: asset.kind === 'video_frame' ? 'video-frame' : 'image',
              displayName: asset.path.split(/[\\/]/).pop() || asset.path,
              displayPath: asset.path,
              sizeBytes: asset.fileSize,
              modifiedAt: asset.modifiedTime,
              source: {
                id: `asset-library:${asset.source}`,
                name: t(asset.source === 'manual' ? 'Manual import' : 'Image index'),
                type: 'local-generic' as const,
                availability: asset.missing ? ('offline' as const) : ('online' as const),
              },
            }
          }),
        )
        inputs.push(...batch)
      }
      await window.electronAPI.assetLibrary.addCollectionItems(collectionId, inputs)
    } catch {
      setCollectionError(t('The operation failed.'))
    } finally {
      setCollecting(false)
    }
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <AssetSmartAlbumBar
        albums={smartAlbums}
        selectedId={selectedSmartAlbumId}
        draftName={smartAlbumName}
        busy={smartAlbumBusy}
        onSelect={onSmartAlbumSelect}
        onDraftNameChange={onSmartAlbumNameChange}
        onCreate={onSmartAlbumCreate}
        onUpdate={onSmartAlbumUpdate}
        onDelete={onSmartAlbumDelete}
      />
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', padding: '4px 0' }}>
        <input
          data-testid="asset-filter-query"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t('Filter by file name or path...')}
          style={{ ...assetLibraryInputStyle, flex: '1 1 220px' }}
        />
        <select
          value={categoryFilter}
          onChange={(event) => onCategoryFilterChange(Number(event.target.value))}
          style={assetLibraryInputStyle}
        >
          <option value={0}>{t('All categories')}</option>
          {rows.map(({ category, depth }) => (
            <option key={category.id} value={category.id}>
              {'  '.repeat(depth)}
              {category.name}
            </option>
          ))}
        </select>
        <select
          value={tagFilter}
          onChange={(event) => onTagFilterChange(Number(event.target.value))}
          style={assetLibraryInputStyle}
        >
          <option value={0}>{t('All tags')}</option>
          {tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9 }}>
          <input
            type="checkbox"
            checked={unclassifiedOnly}
            onChange={(event) => onUnclassifiedChange(event.target.checked)}
          />
          {t('Unclassified')}
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9 }}>
          <input
            type="checkbox"
            checked={archivedOnly}
            onChange={(event) => onArchivedChange(event.target.checked)}
          />
          {t('Removed')} ({formatAssetLibraryNumber(stats.archivedAssets)})
        </label>
        <select
          data-testid="asset-filter-source"
          value={sourceFilter}
          onChange={(event) => onSourceFilterChange(event.target.value as AssetSourceFilter)}
          style={assetLibraryInputStyle}
        >
          <option value="all">{t('All asset sources')}</option>
          <option value="image_search">{t('Image index')}</option>
          <option value="manual">{t('Manual import')}</option>
        </select>
        <select
          data-testid="asset-filter-kind"
          value={kindFilter}
          onChange={(event) => onKindFilterChange(event.target.value as AssetKindFilter)}
          style={assetLibraryInputStyle}
        >
          <option value="all">{t('All media types')}</option>
          <option value="image">{t('Images')}</option>
          <option value="video_frame">{t('Video frames')}</option>
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 9 }}>
          {t('Modified from')}
          <input
            data-testid="asset-filter-modified-after"
            type="date"
            value={dateInputValue(modifiedAfter)}
            onChange={(event) => onModifiedAfterChange(startOfLocalDate(event.target.value))}
            style={assetLibraryInputStyle}
          />
        </label>
        <select
          data-testid="asset-filter-rating"
          value={minRating}
          onChange={(event) => onMinRatingChange(Number(event.target.value))}
          style={assetLibraryInputStyle}
        >
          <option value={0}>{t('Any rating')}</option>
          {[1, 2, 3, 4, 5].map((rating) => (
            <option key={rating} value={rating}>
              {rating}+ ★
            </option>
          ))}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 9 }}>
          <input
            data-testid="asset-filter-favorite"
            type="checkbox"
            checked={favoriteOnly}
            onChange={(event) => onFavoriteOnlyChange(event.target.checked)}
          />
          {t('Favorites only')}
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 9 }}>
          {t('Modified to')}
          <input
            data-testid="asset-filter-modified-before"
            type="date"
            value={dateInputValue(modifiedBefore)}
            onChange={(event) => onModifiedBeforeChange(endOfLocalDate(event.target.value))}
            style={assetLibraryInputStyle}
          />
        </label>
        <select
          value={sort}
          onChange={(event) => onSortChange(event.target.value as AssetSort)}
          style={assetLibraryInputStyle}
        >
          <option value="updated_desc">{t('Recent')}</option>
          <option value="name_asc">{t('Name')}</option>
          <option value="size_desc">{t('Size')}</option>
        </select>
      </div>
      <div
        style={{
          display: 'flex',
          gap: 4,
          alignItems: 'center',
          flexWrap: 'wrap',
          paddingBottom: 3,
        }}
      >
        <span style={{ fontSize: 9, opacity: 0.65 }}>
          {selectedIds.size} {t('selected')}
        </span>
        <button onClick={onSelectPage} style={assetLibraryButtonStyle}>
          {t('Select page')}
        </button>
        <button onClick={onClearSelection} style={assetLibraryButtonStyle}>
          {t('Clear selection')}
        </button>
        {archivedOnly ? (
          <button
            disabled={selectedIds.size === 0}
            onClick={onRestoreSelected}
            style={{ ...assetLibraryButtonStyle, color: 'rgb(85,220,160)' }}
          >
            {t('Restore selected')}
          </button>
        ) : (
          <button
            disabled={selectedIds.size === 0}
            onClick={onArchiveSelected}
            style={{ ...assetLibraryButtonStyle, color: 'rgb(255,105,105)' }}
            title={t('Remove from NekoSearch without deleting the original files')}
          >
            {t('Remove from Assets')}
          </button>
        )}
        <button
          disabled={lastArchivedIds.length === 0}
          onClick={onUndoArchive}
          style={assetLibraryButtonStyle}
          title={t('Restore the assets removed by the last operation')}
        >
          {t('Undo remove')}
        </button>
        <select
          data-testid="asset-library-collection-select"
          value={collectionId}
          onChange={(event) => setCollectionId(Number(event.target.value))}
          style={assetLibraryInputStyle}
        >
          <option value={0}>{t('Select collection')}</option>
          {collections.map((collection) => (
            <option key={collection.id} value={collection.id}>
              {collection.name}
            </option>
          ))}
        </select>
        <button
          data-testid="asset-library-collect-selected"
          disabled={!collectionId || selectedIds.size === 0 || collecting}
          onClick={() => void collectSelected()}
          style={assetLibraryButtonStyle}
        >
          {t('Collect selected')}
        </button>
        {collectionError ? (
          <span
            data-testid="asset-library-collection-error"
            style={{ color: '#ff8a8a', fontSize: 9 }}
          >
            {collectionError}
          </span>
        ) : null}
        {repairStatus ? (
          <span data-testid="asset-repair-status" style={{ fontSize: 9 }}>
            {repairStatus}
          </span>
        ) : null}
        {pendingRepairId ? (
          <button
            data-testid="asset-repair-retry"
            onClick={() => void retryPendingRepair()}
            style={assetLibraryButtonStyle}
          >
            {t('Retry moved asset repair')}
          </button>
        ) : null}
        <select
          data-testid="asset-rating-selected"
          disabled={archivedOnly || selectedIds.size === 0}
          defaultValue=""
          onChange={(event) => {
            if (!event.target.value) return
            onSetSelectedRating(Number(event.target.value))
            event.target.value = ''
          }}
          style={assetLibraryInputStyle}
        >
          <option value="">{t('Rate selected')}</option>
          <option value="0">{t('Clear rating')}</option>
          {[1, 2, 3, 4, 5].map((rating) => (
            <option key={rating} value={rating}>
              {rating} ★
            </option>
          ))}
        </select>
        <button
          data-testid="asset-favorite-selected"
          disabled={archivedOnly || selectedIds.size === 0}
          onClick={() => onSetSelectedFavorite(true)}
          style={assetLibraryButtonStyle}
        >
          {t('Favorite selected')}
        </button>
        <button
          disabled={archivedOnly || selectedIds.size === 0}
          onClick={() => onSetSelectedFavorite(false)}
          style={assetLibraryButtonStyle}
        >
          {t('Unfavorite selected')}
        </button>
        <select
          disabled={archivedOnly}
          value={batchCategoryId}
          onChange={(event) => onBatchCategoryChange(Number(event.target.value))}
          style={assetLibraryInputStyle}
        >
          <option value={0}>{t('Choose category')}</option>
          {rows.map(({ category, depth }) => (
            <option key={category.id} value={category.id}>
              {'  '.repeat(depth)}
              {category.name}
            </option>
          ))}
        </select>
        <button
          disabled={archivedOnly || !batchCategoryId || selectedIds.size === 0}
          onClick={onAssignCategory}
          style={assetLibraryButtonStyle}
        >
          {t('Classify')}
        </button>
        <button
          disabled={archivedOnly || !batchCategoryId || selectedIds.size === 0}
          onClick={onAddReferences}
          style={assetLibraryButtonStyle}
        >
          {t('Use as references')}
        </button>
        <button
          disabled={archivedOnly || !batchCategoryId}
          onClick={() => onImportReferences(batchCategoryId)}
          style={assetLibraryButtonStyle}
          title={t('Choose images from this computer as references for the selected category')}
        >
          + {t('Local reference')}
        </button>
        <button
          disabled={archivedOnly || !batchCategoryId}
          onClick={() => onPasteReference(batchCategoryId)}
          style={assetLibraryButtonStyle}
          title={t('Use the clipboard image as a reference for the selected category')}
        >
          {t('Paste reference')}
        </button>
        <select
          disabled={archivedOnly}
          value={batchTagId}
          onChange={(event) => onBatchTagChange(Number(event.target.value))}
          style={assetLibraryInputStyle}
        >
          <option value={0}>{t('Choose tag')}</option>
          {tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </select>
        <button
          disabled={archivedOnly || !batchTagId || selectedIds.size === 0}
          onClick={onAssignTag}
          style={assetLibraryButtonStyle}
        >
          {t('Add tag')}
        </button>
      </div>
      <AssetLibraryAssetGrid
        items={assets}
        categories={categories}
        tags={tags}
        selectedIds={selectedIds}
        resetToken={`${offset}:${query}:${categoryFilter}:${tagFilter}:${unclassifiedOnly}:${archivedOnly}:${sourceFilter}:${kindFilter}:${modifiedAfter}:${modifiedBefore}:${minRating}:${favoriteOnly}:${sort}`}
        onSetSelected={onSetSelected}
        onOpen={onOpenAsset}
        onReveal={onRevealAsset}
        onRepairMoved={(assetId) => void repairMoved(assetId)}
      />
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingTop: 3,
          fontSize: 9,
        }}
      >
        <span>
          {loading
            ? `${t('Loading')}...`
            : `${formatAssetLibraryNumber(Math.min(offset + 1, total))}-${formatAssetLibraryNumber(Math.min(offset + assets.length, total))} / ${formatAssetLibraryNumber(total)}`}
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button disabled={offset === 0} onClick={onPreviousPage} style={assetLibraryButtonStyle}>
            {t('Previous')}
          </button>
          <button
            disabled={offset + pageSize >= total}
            onClick={onNextPage}
            style={assetLibraryButtonStyle}
          >
            {t('Next')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default AssetLibraryAssetsView
