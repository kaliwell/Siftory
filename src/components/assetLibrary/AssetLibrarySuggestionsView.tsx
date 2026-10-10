import React from 'react'
import type { AssetLibrarySuggestionItem } from '../../../shared/ipc-contract'
import AssetLibrarySuggestionGrid from '../AssetLibrarySuggestionGrid'
import {
  assetLibraryButtonStyle,
  assetLibraryInputStyle,
  formatAssetLibraryNumber,
} from './assetLibraryViewUtils'
import { useTranslation } from '../../i18n/useTranslation'

export type AssetSuggestionStatus =
  | 'suggested'
  | 'low_confidence'
  | 'confirmed'
  | 'rejected'
  | 'ignored'
export type AssetSuggestionSource = 'all' | 'reference_image' | 'text_label'

interface AssetLibrarySuggestionsViewProps {
  status: AssetSuggestionStatus
  source: AssetSuggestionSource
  items: AssetLibrarySuggestionItem[]
  total: number
  offset: number
  pageSize: number
  busyId: number | null
  onStatusChange(status: AssetSuggestionStatus): void
  onSourceChange(source: AssetSuggestionSource): void
  onRefresh(): void
  onReview(id: number, status: 'confirmed' | 'rejected' | 'ignored'): void
  onUndo(id: number): void
  onOpen(assetId: number): void
  onSimilar(assetId: number, categoryId?: number): void
  onPreviousPage(): void
  onNextPage(): void
}

const STATUS_TABS: Array<[AssetSuggestionStatus, string]> = [
  ['suggested', 'To review'],
  ['low_confidence', 'Low confidence'],
  ['confirmed', 'Accepted'],
  ['rejected', 'Rejected'],
  ['ignored', 'Ignored'],
]

const AssetLibrarySuggestionsView: React.FC<AssetLibrarySuggestionsViewProps> = ({
  status,
  source,
  items,
  total,
  offset,
  pageSize,
  busyId,
  onStatusChange,
  onSourceChange,
  onRefresh,
  onReview,
  onUndo,
  onOpen,
  onSimilar,
  onPreviousPage,
  onNextPage,
}) => {
  const { t } = useTranslation()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          gap: 5,
          alignItems: 'center',
          flexWrap: 'wrap',
          padding: '4px 0',
        }}
      >
        {STATUS_TABS.map(([id, label]) => (
          <button
            key={id}
            aria-pressed={status === id}
            onClick={() => onStatusChange(id)}
            style={{
              ...assetLibraryButtonStyle,
              borderColor: status === id ? 'rgb(85,220,160)' : 'rgba(var(--date),0.28)',
              color: status === id ? 'rgb(85,220,160)' : undefined,
              background: status === id ? 'rgba(85,220,160,0.1)' : undefined,
            }}
          >
            {t(label)}
          </button>
        ))}
        <select
          value={source}
          onChange={(event) => onSourceChange(event.target.value as AssetSuggestionSource)}
          style={assetLibraryInputStyle}
        >
          <option value="all">{t('All sources')}</option>
          <option value="reference_image">{t('Reference image')}</option>
          <option value="text_label">{t('Text label')}</option>
        </select>
        <button onClick={onRefresh} style={assetLibraryButtonStyle}>
          {t('Refresh')}
        </button>
        <span style={{ fontSize: 9, opacity: 0.6 }}>
          {formatAssetLibraryNumber(total)} {t('results')}
        </span>
      </div>
      <AssetLibrarySuggestionGrid
        items={items}
        resetToken={`${status}:${source}:${offset}`}
        actionsDisabled={busyId !== null}
        busyId={busyId}
        onReview={onReview}
        onUndo={onUndo}
        onOpen={onOpen}
        onSimilar={onSimilar}
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
          {formatAssetLibraryNumber(Math.min(offset + 1, total))}-
          {formatAssetLibraryNumber(Math.min(offset + items.length, total))} /{' '}
          {formatAssetLibraryNumber(total)}
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

export default AssetLibrarySuggestionsView
