import type { AssetCategory, AssetMetadataDeletionListResponse } from '../../../shared/ipc-contract'
import {
  assetLibraryButtonStyle as buttonStyle,
  assetLibraryInputStyle as inputStyle,
  formatAssetLibraryBytes as formatBytes,
  formatAssetLibraryNumber as formatNumber,
} from './assetLibraryViewUtils'
import { useTranslation } from '../../i18n/useTranslation'

type CategoryRow = { category: AssetCategory; depth: number }

interface Props {
  categories: AssetCategory[]
  rows: CategoryRow[]
  selectedCategoryId: number
  recentCategoryIds: number[]
  deletionHistoryOpen: boolean
  deletionHistory: AssetMetadataDeletionListResponse | null
  deletionHistoryOffset: number
  deletionHistoryPageSize: number
  deleteArmed: string
  draggedCategoryId: number | null
  dropTargetCategoryId: number | null | 'root'
  newCategoryName: string
  newCategoryColor: string
  newCategoryParent: number
  onToggleHistory: () => void
  onUndoLastDeletion: () => void
  onExportHistory: () => void
  onPurgeRestored: () => void
  onPurgeAll: () => void
  onRestoreDeletion: (id: number) => void
  onHistoryOffsetChange: (offset: number) => void
  onSelectCategory: (id: number) => void
  onDeleteCategory: (id: number) => void
  onDraggedCategoryChange: (id: number | null) => void
  onDropTargetChange: (id: number | null | 'root') => void
  onReparentCategory: (categoryId: number, parentId: number | null) => void
  onNewCategoryNameChange: (value: string) => void
  onNewCategoryColorChange: (value: string) => void
  onNewCategoryParentChange: (value: number) => void
  onCreateCategory: () => void
}

export default function AssetLibraryCategorySidebar({
  categories,
  rows,
  selectedCategoryId,
  recentCategoryIds,
  deletionHistoryOpen,
  deletionHistory,
  deletionHistoryOffset,
  deletionHistoryPageSize,
  deleteArmed,
  draggedCategoryId,
  dropTargetCategoryId,
  newCategoryName,
  newCategoryColor,
  newCategoryParent,
  onToggleHistory,
  onUndoLastDeletion,
  onExportHistory,
  onPurgeRestored,
  onPurgeAll,
  onRestoreDeletion,
  onHistoryOffsetChange,
  onSelectCategory,
  onDeleteCategory,
  onDraggedCategoryChange,
  onDropTargetChange,
  onReparentCategory,
  onNewCategoryNameChange,
  onNewCategoryColorChange,
  onNewCategoryParentChange,
  onCreateCategory,
}: Props) {
  const { t } = useTranslation()

  return (
    <div
      style={{
        minHeight: 0,
        overflow: 'auto',
        borderRight: '1px solid rgba(var(--date),0.16)',
        paddingRight: 7,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 5,
          marginBottom: 4,
        }}
      >
        <span style={{ fontSize: 9, opacity: 0.55 }}>{t('CATEGORY TREE')}</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            data-testid="asset-history-toggle"
            aria-pressed={deletionHistoryOpen}
            onClick={onToggleHistory}
            title={t('Browse category and tag deletion history')}
            style={buttonStyle}
          >
            {t('History')}
          </button>
          <button
            onClick={onUndoLastDeletion}
            title={t('Restore the most recently deleted category or tag and its relations')}
            style={buttonStyle}
          >
            {t('Undo last')}
          </button>
          <button
            onClick={onExportHistory}
            title={t('Export the full deletion history as JSON')}
            style={buttonStyle}
          >
            {t('Export')}
          </button>
          <button
            onClick={onPurgeRestored}
            title={t('Permanently delete already-restored history records')}
            style={buttonStyle}
          >
            {t('Purge restored')}
          </button>
          <button
            onClick={onPurgeAll}
            title={t('Permanently delete ALL deletion history records (two-step confirm)')}
            style={{ ...buttonStyle, color: 'rgb(255,105,105)' }}
          >
            {deleteArmed === 'purge-deletions' ? t('Confirm') : t('Purge all')}
          </button>
        </div>
      </div>

      {recentCategoryIds.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            flexWrap: 'wrap',
            marginBottom: 4,
          }}
        >
          <span style={{ fontSize: 8, opacity: 0.5 }}>{t('Recent')}:</span>
          {recentCategoryIds.map((id) => {
            const category = categories.find((item) => item.id === id)
            if (!category) return null
            return (
              <button
                key={id}
                onClick={() => onSelectCategory(id)}
                style={{
                  ...buttonStyle,
                  borderLeft: `3px solid ${category.color}`,
                  background: selectedCategoryId === id ? 'rgba(70,210,155,0.14)' : undefined,
                }}
              >
                {category.name}
              </button>
            )
          })}
        </div>
      )}

      {deletionHistoryOpen && deletionHistory && (
        <section
          style={{
            display: 'grid',
            gap: 4,
            borderBottom: '1px solid rgba(var(--date),0.16)',
            paddingBottom: 6,
            marginBottom: 6,
          }}
        >
          <div style={{ fontSize: 8, opacity: 0.62 }}>
            {formatNumber(deletionHistory.total)} {t('records')} ·{' '}
            {formatBytes(deletionHistory.totalBytes)} / {formatBytes(deletionHistory.maxBytes)}
          </div>
          {deletionHistory.items.length === 0 && (
            <div style={{ fontSize: 9, opacity: 0.45 }}>{t('No deletion history.')}</div>
          )}
          {deletionHistory.items.map((item) => (
            <div
              key={item.id}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0,1fr) auto',
                alignItems: 'center',
                gap: 4,
                fontSize: 8,
              }}
            >
              <div style={{ minWidth: 0 }} title={item.name}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.kind === 'category' ? t('Category') : t('Tag')}: {item.name}
                </div>
                <div style={{ opacity: 0.5 }}>
                  {new Date(item.deletedAt).toLocaleString()} · {item.relationCount}{' '}
                  {t('relations')} · {formatBytes(item.estimatedBytes)}
                </div>
              </div>
              {item.restoredAt ? (
                <span style={{ opacity: 0.48 }}>{t('Restored')}</span>
              ) : (
                <button
                  data-testid="asset-history-restore"
                  onClick={() => onRestoreDeletion(item.id)}
                  style={buttonStyle}
                >
                  {t('Restore')}
                </button>
              )}
            </div>
          ))}
          {deletionHistory.total > deletionHistoryPageSize && (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 4 }}>
              <button
                disabled={deletionHistoryOffset === 0}
                onClick={() =>
                  onHistoryOffsetChange(
                    Math.max(0, deletionHistoryOffset - deletionHistoryPageSize),
                  )
                }
                style={buttonStyle}
              >
                {t('Prev')}
              </button>
              <button
                disabled={deletionHistoryOffset + deletionHistoryPageSize >= deletionHistory.total}
                onClick={() =>
                  onHistoryOffsetChange(deletionHistoryOffset + deletionHistoryPageSize)
                }
                style={buttonStyle}
              >
                {t('Next')}
              </button>
            </div>
          )}
        </section>
      )}

      {draggedCategoryId !== null && (
        <div
          onDragOver={(event) => {
            event.preventDefault()
            onDropTargetChange('root')
          }}
          onDragLeave={() => onDropTargetChange(null)}
          onDrop={(event) => {
            event.preventDefault()
            onReparentCategory(draggedCategoryId, null)
            onDraggedCategoryChange(null)
            onDropTargetChange(null)
          }}
          style={{
            fontSize: 9,
            padding: '4px 6px',
            marginBottom: 3,
            border: `1px dashed ${dropTargetCategoryId === 'root' ? 'rgba(70,210,155,0.9)' : 'rgba(var(--date),0.3)'}`,
            opacity: 0.85,
          }}
        >
          {t('Drop here to move to root')}
        </div>
      )}

      {rows.map(({ category, depth }) => (
        <div
          key={category.id}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move'
            onDraggedCategoryChange(category.id)
          }}
          onDragEnd={() => {
            onDraggedCategoryChange(null)
            onDropTargetChange(null)
          }}
          onDragOver={(event) => {
            if (draggedCategoryId === null || draggedCategoryId === category.id) return
            event.preventDefault()
            onDropTargetChange(category.id)
          }}
          onDragLeave={() => onDropTargetChange(null)}
          onDrop={(event) => {
            event.preventDefault()
            if (draggedCategoryId !== null && draggedCategoryId !== category.id) {
              onReparentCategory(draggedCategoryId, category.id)
            }
            onDraggedCategoryChange(null)
            onDropTargetChange(null)
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            marginBottom: 2,
            marginLeft: depth * 12,
            outline:
              dropTargetCategoryId === category.id ? '1px dashed rgba(70,210,155,0.9)' : undefined,
            cursor: 'grab',
          }}
          title={t('Drag onto another category to re-parent')}
        >
          <button
            onClick={() => onSelectCategory(category.id)}
            style={{
              ...buttonStyle,
              flex: 1,
              textAlign: 'left',
              borderLeft: `4px solid ${category.color}`,
              background: selectedCategoryId === category.id ? 'rgba(70,210,155,0.14)' : undefined,
            }}
          >
            {category.name}
          </button>
          <button
            onClick={() => onDeleteCategory(category.id)}
            style={{ ...buttonStyle, color: 'rgb(255,105,105)', paddingInline: 6 }}
            title={t('Delete category')}
          >
            {deleteArmed === `category-${category.id}` ? t('Confirm') : 'x'}
          </button>
        </div>
      ))}

      <div
        style={{
          borderTop: '1px solid rgba(var(--date),0.14)',
          marginTop: 7,
          paddingTop: 7,
          display: 'grid',
          gap: 4,
        }}
      >
        <input
          data-testid="asset-new-category-name"
          value={newCategoryName}
          onChange={(event) => onNewCategoryNameChange(event.target.value)}
          placeholder={t('New category')}
          style={inputStyle}
        />
        <div style={{ display: 'flex', gap: 4 }}>
          <input
            type="color"
            value={newCategoryColor}
            onChange={(event) => onNewCategoryColorChange(event.target.value)}
            title={t('Category color')}
            style={{ width: 34, height: 26, padding: 1 }}
          />
          <select
            value={newCategoryParent}
            onChange={(event) => onNewCategoryParentChange(Number(event.target.value))}
            style={{ ...inputStyle, flex: 1 }}
          >
            <option value={0}>{t('Root category')}</option>
            {rows.map(({ category, depth }) => (
              <option key={category.id} value={category.id}>
                {'  '.repeat(depth)}
                {category.name}
              </option>
            ))}
          </select>
          <button
            data-testid="asset-create-category"
            aria-label={t('Create category')}
            onClick={onCreateCategory}
            style={buttonStyle}
          >
            {t('Create')}
          </button>
        </div>
      </div>
    </div>
  )
}
