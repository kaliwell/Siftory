import React, { useEffect, useRef } from 'react'
import type { AssetCategory, AssetLibraryAssetItem, AssetTag } from '../../shared/ipc-contract'
import { useVirtualGrid } from '../hooks/useVirtualGrid'
import { useTranslation } from '../i18n/useTranslation'
import { resolveSelectionRange } from '../utils/selectionRange'
import ThumbnailImage from './filemanager/ThumbnailImage'

interface AssetLibraryAssetGridProps {
  items: AssetLibraryAssetItem[]
  categories: AssetCategory[]
  tags: AssetTag[]
  selectedIds: Set<number>
  resetToken: unknown
  onSetSelected: (ids: number[], selected: boolean) => void
  onOpen: (assetId: number) => void
  onReveal: (assetId: number) => void
  onRepairMoved?: (assetId: number) => void
  onSimilar?: (assetId: number) => void
  scoresByAssetId?: ReadonlyMap<
    number,
    {
      score: number
      positiveScore: number
      negativeScore: number
      reviewState: 'positive' | 'negative' | 'unreviewed'
    }
  >
}

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}

function extension(filePath: string): string {
  const suffix = filePath.split('.').pop()?.toLowerCase()
  return suffix ? `.${suffix}` : ''
}

const AssetLibraryAssetGrid: React.FC<AssetLibraryAssetGridProps> = ({
  items,
  categories,
  tags,
  selectedIds,
  resetToken,
  onSetSelected,
  onOpen,
  onReveal,
  onRepairMoved,
  onSimilar,
  scoresByAssetId,
}) => {
  const { t } = useTranslation()
  const selectionAnchorRef = useRef<number | null>(null)
  const categoryById = new Map(categories.map((category) => [category.id, category]))
  const tagById = new Map(tags.map((tag) => [tag.id, tag]))
  const rowHeight = scoresByAssetId ? 260 : 244
  const gap = 7
  const {
    columns,
    contentRef,
    endIndex,
    isScrolling,
    offsetTop,
    rootRef,
    startIndex,
    totalHeight,
  } = useVirtualGrid({
    itemCount: items.length,
    minColumnWidth: 178,
    rowHeight,
    gap,
    resetToken,
  })
  const visible = items.slice(startIndex, endIndex)

  useEffect(() => {
    selectionAnchorRef.current = null
  }, [resetToken])

  useEffect(() => {
    if (selectedIds.size === 0) selectionAnchorRef.current = null
  }, [selectedIds])

  const setSelection = (assetId: number, selected: boolean, shiftKey: boolean) => {
    const anchorId = selectionAnchorRef.current
    const rangeIds = shiftKey
      ? resolveSelectionRange(
          items.map((item) => item.asset.id),
          anchorId,
          assetId,
        )
      : null
    if (rangeIds) {
      onSetSelected(rangeIds, selected)
      return
    }
    selectionAnchorRef.current = assetId
    onSetSelected([assetId], selected)
  }

  if (items.length === 0) {
    return (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', opacity: 0.4, fontSize: 11 }}>
        {t('No assets match the current filters.')}
      </div>
    )
  }

  return (
    <div ref={rootRef} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 4 }}>
      <div
        ref={contentRef}
        style={{ contain: 'layout paint', height: totalHeight, position: 'relative' }}
      >
        <div
          style={{
            position: 'absolute',
            top: 0,
            transform: `translate3d(0, ${offsetTop}px, 0)`,
            left: 0,
            right: 0,
            display: 'grid',
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gap,
          }}
        >
          {visible.map((item) => {
            const selected = selectedIds.has(item.asset.id)
            const sampleScore = scoresByAssetId?.get(item.asset.id)
            const categoryLabels = item.categories
              .map((assignment) => categoryById.get(assignment.categoryId))
              .filter((category): category is AssetCategory => !!category)
            const tagLabels = item.tags
              .map((assignment) => tagById.get(assignment.tagId))
              .filter((tag): tag is AssetTag => !!tag)
            return (
              <div
                key={item.asset.id}
                style={{
                  height: rowHeight,
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 5,
                  padding: 6,
                  boxSizing: 'border-box',
                  border: selected
                    ? '1px solid rgb(75,220,160)'
                    : '1px solid rgba(var(--date),0.18)',
                  borderRadius: 4,
                  background: selected ? 'rgba(45,180,125,0.12)' : 'rgba(var(--bg),0.18)',
                  overflow: 'hidden',
                }}
                title={item.asset.path}
              >
                <div style={{ position: 'relative', height: 142, flexShrink: 0 }}>
                  <ThumbnailImage
                    deferLoading={isScrolling}
                    filePath={item.asset.path}
                    ext={extension(item.asset.path)}
                    isDirectory={false}
                    loadPriority={10}
                    targetSize={160}
                    viewMode="xlarge-icon"
                    style={{ width: '100%', height: 142 }}
                  />
                  <input
                    data-testid="asset-select"
                    data-asset-id={item.asset.id}
                    type="checkbox"
                    checked={selected}
                    readOnly
                    onClick={(event) =>
                      setSelection(item.asset.id, event.currentTarget.checked, event.shiftKey)
                    }
                    aria-label={t('Select {name}', { name: fileName(item.asset.path) })}
                    title={t('Shift-click to select or clear the range from the previous checkbox')}
                    style={{ position: 'absolute', top: 4, left: 4, margin: 0 }}
                  />
                </div>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {fileName(item.asset.path)}
                </div>
                {(item.asset.favorite || item.asset.rating) && (
                  <div style={{ fontSize: 9, color: 'rgb(255,190,70)' }}>
                    {item.asset.favorite ? '♥ ' : ''}
                    {item.asset.rating ? `${'★'.repeat(item.asset.rating)}` : ''}
                  </div>
                )}
                {sampleScore && (
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 4,
                      minHeight: 12,
                      fontSize: 8,
                      color:
                        sampleScore.reviewState === 'positive'
                          ? 'rgb(85,220,160)'
                          : sampleScore.reviewState === 'negative'
                            ? 'rgb(255,105,105)'
                            : 'rgb(var(--date))',
                    }}
                    title={t('Positive {positive}% | Negative {negative}%', {
                      positive: (sampleScore.positiveScore * 100).toFixed(1),
                      negative: (sampleScore.negativeScore * 100).toFixed(1),
                    })}
                  >
                    <span>
                      {t('Match')} {(sampleScore.score * 100).toFixed(1)}%
                    </span>
                    <span>{t(sampleScore.reviewState)}</span>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 3, minHeight: 16, overflow: 'hidden' }}>
                  {categoryLabels.slice(0, 2).map((category) => (
                    <span
                      key={`category-${category.id}`}
                      style={{
                        borderLeft: `3px solid ${category.color}`,
                        padding: '1px 4px',
                        fontSize: 8,
                        background: 'rgba(var(--date),0.08)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {category.name}
                    </span>
                  ))}
                  {tagLabels.slice(0, 2).map((tag) => (
                    <span
                      key={`tag-${tag.id}`}
                      style={{ color: tag.color, fontSize: 8, padding: '1px 2px' }}
                    >
                      #{tag.name}
                    </span>
                  ))}
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns:
                      onSimilar || (onRepairMoved && item.asset.missing)
                        ? '1fr 1fr 1fr'
                        : '1fr 1fr',
                    gap: 4,
                  }}
                >
                  <button onClick={() => onOpen(item.asset.id)} style={{ fontSize: 9, padding: 3 }}>
                    {t('Open')}
                  </button>
                  <button
                    onClick={() => onReveal(item.asset.id)}
                    style={{ fontSize: 9, padding: 3 }}
                  >
                    {t('Folder')}
                  </button>
                  {onSimilar && (
                    <button
                      onClick={() => onSimilar(item.asset.id)}
                      style={{ fontSize: 9, padding: 3 }}
                      title={t('Use this image as the next similarity query')}
                    >
                      {t('Similar')}
                    </button>
                  )}
                  {!onSimilar && onRepairMoved && item.asset.missing && (
                    <button
                      data-testid="asset-repair-moved"
                      onClick={() => onRepairMoved(item.asset.id)}
                      style={{ fontSize: 9, padding: 3 }}
                      title={t('Locate the moved original and repair its stable identity')}
                    >
                      {t('Repair')}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default AssetLibraryAssetGrid
