import type {
  AssetCategory,
  AssetLibraryAssetItem,
  AssetLibraryReferenceItem,
} from '../../../shared/ipc-contract'
import ThumbnailImage from '../filemanager/ThumbnailImage'
import {
  assetFileExtension as fileExtension,
  assetFileName as fileName,
  assetLibraryButtonStyle as buttonStyle,
  assetLibraryInputStyle as inputStyle,
  formatAssetLibraryNumber as formatNumber,
} from './assetLibraryViewUtils'
import { useTranslation } from '../../i18n/useTranslation'

interface Props {
  category?: AssetCategory
  references: AssetLibraryReferenceItem[]
  editName: string
  editColor: string
  referenceThreshold: number
  activeTask: boolean
  categoryAssets: AssetLibraryAssetItem[]
  categoryAssetTotal: number
  categoryAssetsLoading: boolean
  onEditNameChange: (value: string) => void
  onEditColorChange: (value: string) => void
  onReferenceThresholdChange: (value: number) => void
  onSave: () => void
  onImportLocalReferences: () => void
  onPasteReference: () => void
  onBuildReferenceSuggestions: () => void
  onSearchAcceptedSamples: () => void
  onRemoveReference: (id: number) => void
  onRefreshAssets: () => void
  onViewAllAssets: () => void
  onOpenAsset: (id: number) => void
  onRevealAsset: (id: number) => void
}

export default function AssetLibraryCategoryDetailView({
  category,
  references,
  editName,
  editColor,
  referenceThreshold,
  activeTask,
  categoryAssets,
  categoryAssetTotal,
  categoryAssetsLoading,
  onEditNameChange,
  onEditColorChange,
  onReferenceThresholdChange,
  onSave,
  onImportLocalReferences,
  onPasteReference,
  onBuildReferenceSuggestions,
  onSearchAcceptedSamples,
  onRemoveReference,
  onRefreshAssets,
  onViewAllAssets,
  onOpenAsset,
  onRevealAsset,
}: Props) {
  const { t } = useTranslation()

  if (!category) {
    return (
      <div style={{ opacity: 0.4, fontSize: 10 }}>
        {t('Select a category to edit references and rules.')}
      </div>
    )
  }

  return (
    <section style={{ display: 'grid', gap: 5 }}>
      <div style={{ fontSize: 9, opacity: 0.55 }}>{t('SELECTED CATEGORY')}</div>
      <div style={{ display: 'flex', gap: 4 }}>
        <input
          value={editName}
          onChange={(event) => onEditNameChange(event.target.value)}
          style={{ ...inputStyle, flex: 1 }}
        />
        <input
          type="color"
          value={editColor}
          onChange={(event) => onEditColorChange(event.target.value)}
          style={{ width: 34, padding: 1 }}
        />
        <button onClick={onSave} style={buttonStyle}>
          {t('Save')}
        </button>
      </div>
      <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 9 }}>
          {references.length} {t('reference images')}
        </span>
        <button onClick={onImportLocalReferences} style={buttonStyle}>
          + {t('Local images')}
        </button>
        <button onClick={onPasteReference} style={buttonStyle}>
          {t('Paste image')}
        </button>
        <label style={{ fontSize: 9 }}>{t('AI threshold')}</label>
        <input
          type="number"
          min={0.5}
          max={1}
          step={0.01}
          value={referenceThreshold}
          onChange={(event) => onReferenceThresholdChange(Number(event.target.value))}
          style={{ ...inputStyle, width: 62 }}
        />
        <button
          disabled={activeTask || references.length === 0}
          onClick={onBuildReferenceSuggestions}
          style={buttonStyle}
        >
          {t('Build reference AI')}
        </button>
        <button
          disabled={activeTask}
          onClick={onSearchAcceptedSamples}
          style={buttonStyle}
          title={t('Search the full image library from accepted and rejected category samples')}
        >
          {t('Search accepted samples')}
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {references.slice(0, 30).map(({ reference, asset }) => (
          <div
            key={reference.id}
            style={{
              width: 88,
              display: 'grid',
              gap: 3,
              padding: 4,
              border: '1px solid rgba(var(--date),0.18)',
              borderLeft: `3px solid ${category.color}`,
            }}
            title={asset?.path || t('Asset {id}', { id: reference.assetId })}
          >
            {asset ? (
              <ThumbnailImage
                filePath={asset.path}
                ext={fileExtension(asset.path)}
                isDirectory={false}
                viewMode="medium-icon"
                style={{ width: 76, height: 64 }}
              />
            ) : (
              <div style={{ height: 64, display: 'grid', placeItems: 'center', opacity: 0.4 }}>
                {t('Missing')}
              </div>
            )}
            <div
              style={{
                fontSize: 8,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {asset ? fileName(asset.path) : t('Asset {id}', { id: reference.assetId })}
            </div>
            <button
              onClick={() => onRemoveReference(reference.id)}
              style={{ ...buttonStyle, padding: 2 }}
              title={t('Remove reference')}
            >
              {t('Remove')}
            </button>
          </div>
        ))}
      </div>
      <div
        style={{
          borderTop: '1px solid rgba(var(--date),0.14)',
          paddingTop: 7,
          display: 'grid',
          gap: 5,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 9, opacity: 0.65 }}>
            {t('CATEGORY ASSETS')} {formatNumber(categoryAssetTotal)}
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button disabled={categoryAssetsLoading} onClick={onRefreshAssets} style={buttonStyle}>
              {t('Refresh')}
            </button>
            <button
              disabled={categoryAssetTotal === 0}
              onClick={onViewAllAssets}
              style={buttonStyle}
            >
              {t('View all in Assets')}
            </button>
          </div>
        </div>
        {categoryAssetsLoading ? (
          <div style={{ fontSize: 9, opacity: 0.45 }}>{t('Loading category assets...')}</div>
        ) : categoryAssets.length > 0 ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
              gap: 5,
            }}
          >
            {categoryAssets.map((item) => (
              <div
                key={item.asset.id}
                title={item.asset.path}
                style={{
                  minWidth: 0,
                  display: 'grid',
                  gap: 3,
                  padding: 4,
                  border: '1px solid rgba(var(--date),0.16)',
                }}
              >
                <ThumbnailImage
                  filePath={item.asset.path}
                  ext={fileExtension(item.asset.path)}
                  isDirectory={false}
                  viewMode="large-icon"
                  style={{ width: '100%', height: 78 }}
                />
                <div
                  style={{
                    fontSize: 8,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {fileName(item.asset.path)}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3 }}>
                  <button
                    onClick={() => onOpenAsset(item.asset.id)}
                    style={{ ...buttonStyle, padding: 2, fontSize: 8 }}
                  >
                    {t('Open')}
                  </button>
                  <button
                    onClick={() => onRevealAsset(item.asset.id)}
                    style={{ ...buttonStyle, padding: 2, fontSize: 8 }}
                  >
                    {t('Folder')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 9, opacity: 0.45 }}>
            {t('No assets are assigned to this category.')}
          </div>
        )}
      </div>
    </section>
  )
}
