import React from 'react'
import type { AssetLibrarySuggestionItem } from '../../shared/ipc-contract'
import { useVirtualGrid } from '../hooks/useVirtualGrid'
import ThumbnailImage from './filemanager/ThumbnailImage'
import { useTranslation } from '../i18n/useTranslation'

interface AssetLibrarySuggestionGridProps {
  items: AssetLibrarySuggestionItem[]
  resetToken: unknown
  actionsDisabled?: boolean
  busyId?: number | null
  onReview: (id: number, status: 'confirmed' | 'rejected' | 'ignored') => void
  onUndo: (id: number) => void
  onOpen: (assetId: number) => void
  onSimilar: (assetId: number, categoryId?: number) => void
}

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}

const AssetLibrarySuggestionGrid: React.FC<AssetLibrarySuggestionGridProps> = ({
  items,
  resetToken,
  actionsDisabled = false,
  busyId = null,
  onReview,
  onUndo,
  onOpen,
  onSimilar,
}) => {
  const { t } = useTranslation()
  const rowHeight = 252
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
    minColumnWidth: 190,
    rowHeight,
    gap,
    resetToken,
  })
  const visible = items.slice(startIndex, endIndex)

  if (items.length === 0) {
    return (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', opacity: 0.4, fontSize: 11 }}>
        {t('No classification suggestions in this view.')}
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
          {visible.map(({ suggestion, asset, category, tag }) => (
            <div
              key={suggestion.id}
              aria-busy={busyId === suggestion.id}
              style={{
                height: rowHeight,
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 5,
                padding: 6,
                border: '1px solid rgba(var(--date),0.18)',
                borderRadius: 4,
                boxSizing: 'border-box',
                background: 'rgba(var(--bg),0.18)',
              }}
            >
              <ThumbnailImage
                deferLoading={isScrolling}
                filePath={asset.path}
                ext={`.${asset.path.split('.').pop()?.toLowerCase() || ''}`}
                isDirectory={false}
                loadPriority={10}
                targetSize={160}
                viewMode="xlarge-icon"
                style={{ width: '100%', height: 126 }}
              />
              <div
                style={{
                  fontSize: 9,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={asset.path}
              >
                {fileName(asset.path)}
              </div>
              <div
                style={{ display: 'flex', justifyContent: 'space-between', gap: 6, fontSize: 9 }}
              >
                <strong
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {category?.name || (tag ? `#${tag.name}` : t('Unknown target'))}
                </strong>
                <span style={{ color: 'rgb(85,220,160)' }}>
                  {(suggestion.confidence * 100).toFixed(1)}%
                </span>
              </div>
              <div style={{ fontSize: 8, opacity: 0.55 }}>
                {busyId === suggestion.id
                  ? t('Saving review...')
                  : `${suggestion.source} / ${suggestion.status}`}
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                  gap: 3,
                }}
              >
                <button onClick={() => onOpen(asset.id)} style={{ fontSize: 8, padding: 3 }}>
                  {t('Open')}
                </button>
                <button
                  onClick={() => onSimilar(asset.id, category?.id)}
                  style={{ fontSize: 8, padding: 3 }}
                  title={t('Find more assets visually similar to this suggestion')}
                >
                  {t('Similar')}
                </button>
                {suggestion.status === 'confirmed' ? (
                  <button
                    disabled={actionsDisabled}
                    onClick={() => onUndo(suggestion.id)}
                    style={{ fontSize: 8, padding: 3, color: 'rgb(255,190,95)' }}
                  >
                    {t('Undo Accept')}
                  </button>
                ) : (
                  <>
                    <button
                      disabled={actionsDisabled}
                      onClick={() => onReview(suggestion.id, 'confirmed')}
                      style={{ fontSize: 8, padding: 3, color: 'rgb(85,220,160)' }}
                    >
                      {t('Accept')}
                    </button>
                    {suggestion.status !== 'rejected' && (
                      <button
                        disabled={actionsDisabled}
                        onClick={() => onReview(suggestion.id, 'rejected')}
                        style={{ fontSize: 8, padding: 3, color: 'rgb(255,105,105)' }}
                      >
                        {t('Reject')}
                      </button>
                    )}
                    {suggestion.status !== 'ignored' && (
                      <button
                        disabled={actionsDisabled}
                        onClick={() => onReview(suggestion.id, 'ignored')}
                        style={{ fontSize: 8, padding: 3 }}
                      >
                        {t('Ignore')}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default AssetLibrarySuggestionGrid
