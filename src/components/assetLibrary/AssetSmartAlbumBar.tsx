import React from 'react'
import type { AssetSmartAlbum } from '../../../shared/ipc-contract'
import { useTranslation } from '../../i18n/useTranslation'
import { assetLibraryButtonStyle, assetLibraryInputStyle } from './assetLibraryViewUtils'

interface AssetSmartAlbumBarProps {
  albums: AssetSmartAlbum[]
  selectedId: number
  draftName: string
  busy: boolean
  onSelect(id: number): void
  onDraftNameChange(value: string): void
  onCreate(): void
  onUpdate(): void
  onDelete(): void
}

const AssetSmartAlbumBar: React.FC<AssetSmartAlbumBarProps> = ({
  albums,
  selectedId,
  draftName,
  busy,
  onSelect,
  onDraftNameChange,
  onCreate,
  onUpdate,
  onDelete,
}) => {
  const { t } = useTranslation()
  return (
    <div
      data-testid="asset-smart-album-bar"
      style={{
        display: 'flex',
        gap: 4,
        alignItems: 'center',
        flexWrap: 'wrap',
        padding: '4px 0 0',
      }}
    >
      <select
        data-testid="asset-smart-album-select"
        value={selectedId}
        disabled={busy}
        onChange={(event) => onSelect(Number(event.target.value))}
        style={assetLibraryInputStyle}
        title={t('Apply a saved set of library filters')}
      >
        <option value={0}>{t('Smart albums')}</option>
        {albums.map((album) => (
          <option key={album.id} value={album.id}>
            {album.name}
          </option>
        ))}
      </select>
      <input
        data-testid="asset-smart-album-name"
        value={draftName}
        disabled={busy}
        maxLength={120}
        onChange={(event) => onDraftNameChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && draftName.trim()) onCreate()
        }}
        placeholder={t('Saved view name')}
        style={{ ...assetLibraryInputStyle, minWidth: 130 }}
      />
      <button
        disabled={busy || !draftName.trim()}
        onClick={onCreate}
        style={assetLibraryButtonStyle}
        title={t('Save the current filters as a smart album')}
      >
        {t('Save view')}
      </button>
      {selectedId > 0 && (
        <>
          <button
            disabled={busy || !draftName.trim()}
            onClick={onUpdate}
            style={assetLibraryButtonStyle}
            title={t('Replace this smart album with the current filters')}
          >
            {t('Update view')}
          </button>
          <button
            disabled={busy}
            onClick={onDelete}
            style={{ ...assetLibraryButtonStyle, color: 'rgb(255,105,105)' }}
          >
            {t('Delete view')}
          </button>
        </>
      )}
    </div>
  )
}

export default AssetSmartAlbumBar
