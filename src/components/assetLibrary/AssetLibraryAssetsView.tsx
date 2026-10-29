import AssetLibraryControls from './AssetLibraryControls'
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
import AssetCollectionCreateForm from './AssetCollectionCreateForm'
import {
  assetLibraryButtonStyle,
  assetLibraryInputStyle,
  formatAssetLibraryNumber,
} from './assetLibraryViewUtils'
import { useTranslation } from '../../i18n/useTranslation'
import { notifyAssetCollectionsChanged, useAssetCollections } from '../../hooks/useAssetCollections'

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
  onCollectFromIndex(): void
  onOpenSources(): void
  collectingFromIndex: boolean
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
  onCollectFromIndex,
  onOpenSources,
  collectingFromIndex,
  onPreviousPage,
  onNextPage,
  onSmartAlbumSelect,
  onSmartAlbumNameChange,
  onSmartAlbumCreate,
  onSmartAlbumUpdate,
  onSmartAlbumDelete,
}) => {
  const { t } = useTranslation()
  const {
    collectionId,
    collections,
    setCollectionId,
    refreshCollections,
    error: collectionsError,
  } = useAssetCollections()
  const [collecting, setCollecting] = React.useState(false)
  const [creatingCollection, setCreatingCollection] = React.useState(false)
  const [collectionMessage, setCollectionMessage] = React.useState('')
  const collectingRef = React.useRef(false)
  const [thumbnailWidth, setThumbnailWidth] = React.useState(240)
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
    if (collectingRef.current || !collectionId || selected.length === 0) return
    collectingRef.current = true
    setCollectionMessage('')
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
      notifyAssetCollectionsChanged()
      setCollectionMessage(t('Added {count} items to collection', { count: selected.length }))
    } catch {
      setCollectionError(t('The operation failed.'))
    } finally {
      collectingRef.current = false
      setCollecting(false)
    }
  }
  const activeFilters = [
    categoryFilter,
    tagFilter,
    unclassifiedOnly,
    archivedOnly,
    sourceFilter !== 'all',
    kindFilter !== 'all',
    modifiedAfter,
    modifiedBefore,
    minRating,
    favoriteOnly,
    selectedSmartAlbumId,
  ].filter(Boolean).length
  const resetFilters = () => {
    onQueryChange('')
    onCategoryFilterChange(0)
    onTagFilterChange(0)
    onUnclassifiedChange(false)
    onArchivedChange(false)
    onSourceFilterChange('all')
    onKindFilterChange('all')
    onModifiedAfterChange(0)
    onModifiedBeforeChange(0)
    onMinRatingChange(0)
    onFavoriteOnlyChange(false)
    onSmartAlbumSelect(0)
  }
  return (
    <div className="asset-library-browser">
      <AssetLibraryControls>
        <div className="asset-library-browser-controls">
          <div className="asset-library-query-bar">
            <input
              data-testid="asset-filter-query"
              value={query}
              aria-label={t('Find assets')}
              placeholder={t('Filter by file name or path...')}
              onChange={(event) => onQueryChange(event.target.value)}
            />
            <label className="asset-library-star-filter">
              <input
                data-testid="asset-filter-favorite"
                type="checkbox"
                checked={favoriteOnly}
                onChange={(event) => onFavoriteOnlyChange(event.target.checked)}
              />
              {t('Starred only')}
            </label>
            <details
              className="workspace-disclosure asset-library-more-filters"
              data-testid="asset-library-filters"
            >
              <summary>
                {t('Library filters')}
                {activeFilters > 0 ? ` · ${activeFilters}` : ''}
              </summary>
              <div className="asset-library-filter-fields">
                <label>
                  {t('Category')}{' '}
                  <select
                    aria-label={t('Category')}
                    data-testid="asset-filter-category"
                    value={categoryFilter}
                    onChange={(event) => onCategoryFilterChange(Number(event.target.value))}
                  >
                    <option value={0}>{t('All categories')}</option>
                    {rows.map(({ category, depth }) => (
                      <option key={category.id} value={category.id}>
                        {'  '.repeat(depth)}
                        {category.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t('Media type')}{' '}
                  <select
                    data-testid="asset-filter-kind"
                    aria-label={t('Media type')}
                    value={kindFilter}
                    onChange={(event) => onKindFilterChange(event.target.value as AssetKindFilter)}
                  >
                    <option value="all">{t('All media types')}</option>
                    <option value="image">{t('Images')}</option>
                    <option value="video_frame">{t('Video frames')}</option>
                  </select>
                </label>
                <label>
                  {t('Tags')}
                  <select
                    value={tagFilter}
                    onChange={(event) => onTagFilterChange(Number(event.target.value))}
                  >
                    <option value={0}>{t('All tags')}</option>
                    {tags.map((tag) => (
                      <option key={tag.id} value={tag.id}>
                        {tag.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t('Source')}
                  <select
                    data-testid="asset-filter-source"
                    value={sourceFilter}
                    onChange={(event) =>
                      onSourceFilterChange(event.target.value as AssetSourceFilter)
                    }
                  >
                    <option value="all">{t('All asset sources')}</option>
                    <option value="image_search">{t('Image index')}</option>
                    <option value="manual">{t('Manual import')}</option>
                  </select>
                </label>
                <label>
                  {t('Modified from')}
                  <input
                    data-testid="asset-filter-modified-after"
                    type="date"
                    value={dateInputValue(modifiedAfter)}
                    onChange={(event) =>
                      onModifiedAfterChange(startOfLocalDate(event.target.value))
                    }
                  />
                </label>
                <label>
                  {t('Modified to')}
                  <input
                    data-testid="asset-filter-modified-before"
                    type="date"
                    value={dateInputValue(modifiedBefore)}
                    onChange={(event) => onModifiedBeforeChange(endOfLocalDate(event.target.value))}
                  />
                </label>
                <label>
                  {t('Rating')}
                  <select
                    data-testid="asset-filter-rating"
                    value={minRating}
                    onChange={(event) => onMinRatingChange(Number(event.target.value))}
                  >
                    <option value={0}>{t('Any rating')}</option>
                    {[1, 2, 3, 4, 5].map((rating) => (
                      <option key={rating} value={rating}>
                        {rating}+ ★
                      </option>
                    ))}
                  </select>
                </label>
                <label className="asset-library-check">
                  <input
                    type="checkbox"
                    checked={unclassifiedOnly}
                    onChange={(event) => onUnclassifiedChange(event.target.checked)}
                  />
                  {t('Unclassified')}
                </label>
                <label className="asset-library-check">
                  <input
                    type="checkbox"
                    checked={archivedOnly}
                    onChange={(event) => onArchivedChange(event.target.checked)}
                  />
                  {t('Removed')} ({formatAssetLibraryNumber(stats.archivedAssets)})
                </label>
              </div>
              <details className="workspace-disclosure" data-testid="asset-library-albums">
                <summary>{t('Saved filters')}</summary>
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
              </details>
            </details>
            {(activeFilters > 0 || query) && (
              <button data-testid="asset-clear-filters" onClick={resetFilters}>
                {t('Clear filters')}
              </button>
            )}
          </div>
          <div className="asset-library-results-bar">
            <span aria-live="polite">
              {loading
                ? t('Loading')
                : t('{count} assets', { count: formatAssetLibraryNumber(total) })}
            </span>
            <div className="asset-library-results-options">
              <select
                aria-label={t('Sort')}
                value={sort}
                onChange={(event) => onSortChange(event.target.value as AssetSort)}
              >
                <option value="updated_desc">{t('Recent')}</option>
                <option value="name_asc">{t('Name')}</option>
                <option value="size_desc">{t('Size')}</option>
              </select>
              <details
                className="workspace-disclosure asset-library-display-options"
                data-testid="asset-library-display-options"
              >
                <summary>{t('Display options')}</summary>
                <div className="asset-library-display-fields">
                  {' '}
                  <label className="asset-library-thumbnail-size">
                    {t('Thumbnail size')}
                    <input
                      data-testid="asset-thumbnail-size"
                      type="range"
                      min={180}
                      max={320}
                      step={20}
                      value={thumbnailWidth}
                      aria-label={t('Thumbnail size')}
                      onChange={(event) => setThumbnailWidth(Number(event.target.value))}
                    />
                  </label>
                </div>
              </details>
            </div>
          </div>
          {selectedIds.size > 0 && (
            <div className="asset-library-selection-bar" data-testid="asset-library-selection-bar">
              <strong>{t('{count} selected', { count: selectedIds.size })}</strong>
              <button onClick={onSelectPage} disabled={assets.length === 0}>
                {t('Select page')}
              </button>

              {collections.length > 0 && (
                <select
                  data-testid="asset-library-collection-select"
                  aria-label={t('Choose collection')}
                  value={collectionId}
                  disabled={collecting}
                  onChange={(event) => setCollectionId(Number(event.target.value))}
                >
                  <option value={0}>{t('Choose collection')}</option>
                  {collections.map((collection) => (
                    <option key={collection.id} value={collection.id}>
                      {collection.name}
                    </option>
                  ))}
                </select>
              )}
              <button
                className="workspace-button-primary"
                data-testid="asset-library-collect-selected"
                disabled={
                  collecting ||
                  Boolean(collectionsError) ||
                  (collections.length > 0 && !collectionId)
                }
                onClick={() =>
                  collections.length === 0 ? setCreatingCollection(true) : void collectSelected()
                }
              >
                {t(
                  collecting
                    ? 'Collecting...'
                    : collections.length === 0
                      ? 'New collection'
                      : 'Add to collection',
                )}
              </button>
              <details className="workspace-disclosure" data-testid="asset-library-batch-actions">
                <summary>{t('More actions')}</summary>
                <div className="asset-library-batch-fields">
                  {collections.length > 0 && (
                    <button
                      data-testid="asset-library-create-collection"
                      disabled={collecting}
                      onClick={() => setCreatingCollection((value) => !value)}
                    >
                      {t('New collection')}
                    </button>
                  )}
                  <button
                    data-testid="asset-favorite-selected"
                    disabled={archivedOnly}
                    onClick={() => onSetSelectedFavorite(true)}
                  >
                    {t('Star selected')}
                  </button>
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
                    title={t(
                      'Choose images from this computer as references for the selected category',
                    )}
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
                  {archivedOnly ? (
                    <button onClick={onRestoreSelected}>{t('Restore selected')}</button>
                  ) : (
                    <button
                      onClick={onArchiveSelected}
                      title={t('Remove from NekoSearch without deleting the original files')}
                    >
                      {t('Remove from Assets')}
                    </button>
                  )}
                </div>
              </details>
              <button disabled={collecting} onClick={onClearSelection}>
                {t('Clear selection')}
              </button>
              {creatingCollection && (
                <AssetCollectionCreateForm
                  onCancel={() => setCreatingCollection(false)}
                  onCreated={async (collection) => {
                    await refreshCollections()
                    setCollectionId(collection.id)
                    setCreatingCollection(false)
                  }}
                />
              )}
            </div>
          )}
          {lastArchivedIds.length > 0 && (
            <button className="asset-library-undo" onClick={onUndoArchive}>
              {t('Undo remove')}
            </button>
          )}
          {(collectionsError || collectionError || collectionMessage) && (
            <div
              role={collectionsError || collectionError ? 'alert' : 'status'}
              data-testid="asset-library-collection-status"
            >
              {collectionsError || collectionError || collectionMessage}
            </div>
          )}
          {repairStatus && (
            <div data-testid="asset-repair-status" role="status">
              {repairStatus}
            </div>
          )}
          {pendingRepairId && (
            <button data-testid="asset-repair-retry" onClick={() => void retryPendingRepair()}>
              {t('Retry moved asset repair')}
            </button>
          )}
        </div>
      </AssetLibraryControls>
      {assets.length === 0 ? (
        <div className="asset-library-empty" data-testid="asset-library-empty">
          <strong>
            {t(
              loading
                ? 'Loading'
                : stats.totalAssets === 0
                  ? 'Start your asset library'
                  : 'No assets match the current filters.',
            )}
          </strong>
          {!loading && (
            <>
              <p>
                {t(
                  stats.totalAssets === 0
                    ? 'Collect indexed images here, then organize them into collections.'
                    : 'Try another keyword or clear the filters.',
                )}
              </p>
              <div>
                {stats.totalAssets === 0 ? (
                  <>
                    <button
                      className="workspace-button-primary"
                      disabled={collectingFromIndex}
                      onClick={onCollectFromIndex}
                    >
                      {t('Collect from image index')}
                    </button>
                    <button onClick={onOpenSources}>{t('Manage sources')}</button>
                  </>
                ) : (
                  <button onClick={resetFilters}>{t('Clear filters')}</button>
                )}
              </div>
            </>
          )}
        </div>
      ) : (
        <AssetLibraryAssetGrid
          thumbnailWidth={thumbnailWidth}
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
      )}
      <div className="asset-library-pagination">
        <span>{`${formatAssetLibraryNumber(Math.min(offset + 1, total))}–${formatAssetLibraryNumber(Math.min(offset + assets.length, total))} / ${formatAssetLibraryNumber(total)}`}</span>
        <div>
          <button disabled={loading || offset === 0} onClick={onPreviousPage}>
            {t('Previous')}
          </button>
          <button disabled={loading || offset + pageSize >= total} onClick={onNextPage}>
            {t('Next')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default AssetLibraryAssetsView
