import React from 'react'
import type {
  AssetCategory,
  AssetLibraryAssetItem,
  AssetLibraryCategorySampleSearchResponse,
  AssetLibrarySimilarSearchResponse,
  AssetTag,
} from '../../../shared/ipc-contract'
import AssetLibraryAssetGrid from '../AssetLibraryAssetGrid'
import ThumbnailImage from '../filemanager/ThumbnailImage'
import {
  assetFileExtension,
  assetFileName,
  assetLibraryButtonStyle,
  assetLibraryInputStyle,
  formatAssetLibraryDuration,
  formatAssetLibraryNumber,
} from './assetLibraryViewUtils'
import { useTranslation } from '../../i18n/useTranslation'

type SearchScoreMap = NonNullable<
  React.ComponentProps<typeof AssetLibraryAssetGrid>['scoresByAssetId']
>

interface AssetLibrarySearchResultsViewProps {
  mode: 'samples' | 'similar'
  categoryId: number
  rows: Array<{ category: AssetCategory; depth: number }>
  categories: AssetCategory[]
  tags: AssetTag[]
  topK: number
  includeReviewed: boolean
  activeTask: boolean
  selectedIds: Set<number>
  result: AssetLibraryCategorySampleSearchResponse | AssetLibrarySimilarSearchResponse | null
  items: AssetLibraryAssetItem[]
  scores: SearchScoreMap
  offset: number
  pageSize: number
  onCategoryChange(categoryId: number): void
  onTopKChange(topK: number): void
  onIncludeReviewedChange(include: boolean): void
  onSearch(): void
  onClear(): void
  onRelevant(): void
  onNotRelevant(): void
  onSetSelected(ids: number[], selected: boolean): void
  onOpen(assetId: number): void
  onReveal(assetId: number): void
  onSimilar(assetId: number): void
  onPreviousPage(): void
  onNextPage(): void
}

const AssetLibrarySearchResultsView: React.FC<AssetLibrarySearchResultsViewProps> = ({
  mode,
  categoryId,
  rows,
  categories,
  tags,
  topK,
  includeReviewed,
  activeTask,
  selectedIds,
  result,
  items,
  scores,
  offset,
  pageSize,
  onCategoryChange,
  onTopKChange,
  onIncludeReviewedChange,
  onSearch,
  onClear,
  onRelevant,
  onNotRelevant,
  onSetSelected,
  onOpen,
  onReveal,
  onSimilar,
  onPreviousPage,
  onNextPage,
}) => {
  const { t } = useTranslation()
  const resultCount = result?.hits.length || 0
  const sampleResult =
    mode === 'samples' ? (result as AssetLibraryCategorySampleSearchResponse | null) : null
  const similarResult =
    mode === 'similar' ? (result as AssetLibrarySimilarSearchResponse | null) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          gap: 4,
          alignItems: 'center',
          flexWrap: 'wrap',
          padding: '4px 0',
        }}
      >
        <select
          data-testid="asset-search-category"
          value={categoryId}
          onChange={(event) => onCategoryChange(Number(event.target.value))}
          style={{ ...assetLibraryInputStyle, minWidth: 170 }}
          title={
            mode === 'samples' ? undefined : t('Category used when adding selected similar results')
          }
        >
          <option value={0}>
            {t(mode === 'samples' ? 'Choose sample category' : 'Choose target category')}
          </option>
          {rows.map(({ category, depth }) => (
            <option key={category.id} value={category.id}>
              {'  '.repeat(depth)}
              {category.name}
            </option>
          ))}
        </select>
        <select
          value={topK}
          onChange={(event) => onTopKChange(Number(event.target.value))}
          style={assetLibraryInputStyle}
          title={mode === 'samples' ? t('Maximum number of category sample matches') : undefined}
        >
          {[50, 100, 200, 500].map((value) => (
            <option key={value} value={value}>
              {t('Top')} {value}
            </option>
          ))}
        </select>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 9 }}>
          <input
            type="checkbox"
            checked={includeReviewed}
            onChange={(event) => onIncludeReviewedChange(event.target.checked)}
          />
          {t('Include reviewed')}
        </label>
        <button
          data-testid="asset-search-run"
          disabled={activeTask || (mode === 'samples' ? !categoryId : !result)}
          onClick={onSearch}
          style={assetLibraryButtonStyle}
        >
          {t(mode === 'samples' ? 'Search category samples' : 'Search again')}
        </button>
        <button disabled={!result} onClick={onClear} style={assetLibraryButtonStyle}>
          {t('Clear results')}
        </button>
        <span style={{ fontSize: 9, opacity: 0.65 }}>
          {selectedIds.size} {t('selected')}
        </span>
        <button
          disabled={!categoryId || selectedIds.size === 0 || activeTask}
          onClick={onRelevant}
          style={assetLibraryButtonStyle}
        >
          {t('Relevant')}
        </button>
        <button
          disabled={!categoryId || selectedIds.size === 0 || activeTask}
          onClick={onNotRelevant}
          style={{ ...assetLibraryButtonStyle, color: 'rgb(255,105,105)' }}
        >
          {t('Not relevant')}
        </button>
      </div>
      {sampleResult && (
        <div
          style={{
            display: 'flex',
            gap: 12,
            flexWrap: 'wrap',
            padding: '2px 0 5px',
            fontSize: 9,
            opacity: 0.72,
          }}
        >
          <span>{sampleResult.categoryName}</span>
          <span>
            {t('Samples')} +{formatAssetLibraryNumber(sampleResult.positiveSampleCount)} / -
            {formatAssetLibraryNumber(sampleResult.negativeSampleCount)}
          </span>
          <span>
            {t('Model')} {t('Revision {revision}', { revision: sampleResult.feedbackRevision })}
          </span>
          <span>{sampleResult.searchMode === 'clip_dino' ? 'CLIP + DINO' : 'CLIP'}</span>
          <span>
            {t('Scanned')} {formatAssetLibraryNumber(sampleResult.scanned)}
          </span>
          <span>
            {t('Returned')} {formatAssetLibraryNumber(sampleResult.returned)}
          </span>
          {sampleResult.searchMode === 'clip_dino' && (
            <span>
              DINO {formatAssetLibraryNumber(sampleResult.dinoCandidateCount || 0)}{' '}
              {t('candidates')} / +
              {formatAssetLibraryNumber(sampleResult.dinoPositiveSampleCount || 0)} / -
              {formatAssetLibraryNumber(sampleResult.dinoNegativeSampleCount || 0)}
            </span>
          )}
          {sampleResult.searchWarning && (
            <span style={{ color: 'rgb(var(--red))' }}>{sampleResult.searchWarning}</span>
          )}
          <span>{formatAssetLibraryDuration(sampleResult.searchMs)}</span>
        </div>
      )}
      {similarResult && (
        <div
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            flexWrap: 'wrap',
            padding: '2px 0 5px',
            fontSize: 9,
            opacity: 0.72,
          }}
        >
          <ThumbnailImage
            filePath={similarResult.queryPath}
            ext={assetFileExtension(similarResult.queryPath)}
            isDirectory={false}
            viewMode="large-icon"
            style={{ width: 42, height: 42 }}
          />
          <span title={similarResult.queryPath}>
            {t('Similar to')} {assetFileName(similarResult.queryPath)}
          </span>
          {similarResult.categoryName && <span>{similarResult.categoryName}</span>}
          <span>
            {t('Scanned')} {formatAssetLibraryNumber(similarResult.scanned)}
          </span>
          <span>
            {t('Returned')} {formatAssetLibraryNumber(similarResult.returned)}
          </span>
          <span>{formatAssetLibraryDuration(similarResult.searchMs)}</span>
        </div>
      )}
      {mode === 'similar' && !result && !activeTask ? (
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', opacity: 0.42 }}>
          {t('No similar results.')}
        </div>
      ) : (
        <AssetLibraryAssetGrid
          items={items}
          categories={categories}
          tags={tags}
          selectedIds={selectedIds}
          resetToken={`${result?.resultId || 'none'}:${offset}`}
          onSetSelected={onSetSelected}
          onOpen={onOpen}
          onReveal={onReveal}
          onSimilar={onSimilar}
          scoresByAssetId={scores}
        />
      )}
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
          {formatAssetLibraryNumber(Math.min(offset + 1, resultCount))}-
          {formatAssetLibraryNumber(Math.min(offset + items.length, resultCount))} /{' '}
          {formatAssetLibraryNumber(resultCount)}
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button disabled={offset === 0} onClick={onPreviousPage} style={assetLibraryButtonStyle}>
            {t('Previous')}
          </button>
          <button
            disabled={offset + pageSize >= resultCount}
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

export default AssetLibrarySearchResultsView
