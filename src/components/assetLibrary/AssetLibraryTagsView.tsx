import type { AssetTag } from '../../../shared/ipc-contract'
import {
  assetLibraryButtonStyle as buttonStyle,
  assetLibraryInputStyle as inputStyle,
} from './assetLibraryViewUtils'
import { useTranslation } from '../../i18n/useTranslation'

interface Props {
  tags: AssetTag[]
  newTagName: string
  newTagColor: string
  tagThreshold: number
  activeTask: boolean
  editingTagId: number | null
  editingTagName: string
  editingTagColor: string
  deleteArmed: string
  onNewTagNameChange: (value: string) => void
  onNewTagColorChange: (value: string) => void
  onTagThresholdChange: (value: number) => void
  onCreateTag: () => void
  onBuildTagSuggestions: () => void
  onStartTagEdit: (tag: AssetTag) => void
  onEditingTagNameChange: (value: string) => void
  onEditingTagColorChange: (value: string) => void
  onSaveTagEdit: () => void
  onCancelTagEdit: () => void
  onDeleteTag: (id: number) => void
}

export default function AssetLibraryTagsView({
  tags,
  newTagName,
  newTagColor,
  tagThreshold,
  activeTask,
  editingTagId,
  editingTagName,
  editingTagColor,
  deleteArmed,
  onNewTagNameChange,
  onNewTagColorChange,
  onTagThresholdChange,
  onCreateTag,
  onBuildTagSuggestions,
  onStartTagEdit,
  onEditingTagNameChange,
  onEditingTagColorChange,
  onSaveTagEdit,
  onCancelTagEdit,
  onDeleteTag,
}: Props) {
  const { t } = useTranslation()

  return (
    <section
      style={{
        borderTop: '1px solid rgba(var(--date),0.16)',
        paddingTop: 8,
        display: 'grid',
        gap: 5,
      }}
    >
      <div style={{ fontSize: 9, opacity: 0.55 }}>{t('TEXT TAGS')}</div>
      <div style={{ display: 'flex', gap: 4 }}>
        <input
          data-testid="asset-new-tag-name"
          value={newTagName}
          onChange={(event) => onNewTagNameChange(event.target.value)}
          placeholder={t('New tag')}
          style={{ ...inputStyle, flex: 1 }}
        />
        <input
          type="color"
          value={newTagColor}
          onChange={(event) => onNewTagColorChange(event.target.value)}
          style={{ width: 34, padding: 1 }}
        />
        <button
          data-testid="asset-create-tag"
          aria-label={t('Create tag')}
          onClick={onCreateTag}
          style={buttonStyle}
        >
          {t('Create')}
        </button>
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 9 }}>{t('CLIP threshold')}</label>
        <input
          type="number"
          min={0.4}
          max={1}
          step={0.01}
          value={tagThreshold}
          onChange={(event) => onTagThresholdChange(Number(event.target.value))}
          style={{ ...inputStyle, width: 62 }}
        />
        <button
          disabled={activeTask || tags.length === 0}
          onClick={onBuildTagSuggestions}
          style={buttonStyle}
        >
          {t('Build tag AI')}
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {tags.map((tag) =>
          editingTagId === tag.id ? (
            <span
              key={tag.id}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                border: '1px solid rgba(var(--date),0.18)',
                padding: '2px 5px',
              }}
            >
              <input
                value={editingTagName}
                onChange={(event) => onEditingTagNameChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onSaveTagEdit()
                  if (event.key === 'Escape') onCancelTagEdit()
                }}
                style={{ ...inputStyle, width: 90 }}
              />
              <input
                type="color"
                value={editingTagColor}
                onChange={(event) => onEditingTagColorChange(event.target.value)}
                style={{ width: 26, padding: 1 }}
              />
              <button onClick={onSaveTagEdit} style={{ fontSize: 8, padding: '0 3px' }}>
                {t('Save')}
              </button>
              <button onClick={onCancelTagEdit} style={{ fontSize: 8, padding: '0 3px' }}>
                {t('Cancel')}
              </button>
            </span>
          ) : (
            <span
              key={tag.id}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                border: '1px solid rgba(var(--date),0.18)',
                padding: '2px 5px',
                color: tag.color,
              }}
            >
              #{tag.name}
              <button
                onClick={() => onStartTagEdit(tag)}
                title={t('Edit tag')}
                style={{ fontSize: 8, padding: '0 3px' }}
              >
                ✎
              </button>
              <button
                onClick={() => onDeleteTag(tag.id)}
                style={{ fontSize: 8, padding: '0 3px', color: 'rgb(255,105,105)' }}
              >
                {deleteArmed === `tag-${tag.id}` ? t('Confirm') : 'x'}
              </button>
            </span>
          ),
        )}
      </div>
    </section>
  )
}
