import type { AssetLibraryClusterSummary } from '../../../shared/ipc-contract'
import ThumbnailImage from '../filemanager/ThumbnailImage'
import {
  assetLibraryButtonStyle as buttonStyle,
  assetLibraryInputStyle as inputStyle,
  clusterMemberThumbnailStyle as memberThumbnailStyle,
  formatAssetLibraryNumber as formatNumber,
} from './assetLibraryViewUtils'
import { useTranslation } from '../../i18n/useTranslation'

export interface AssetLibraryClusterMemberSelection {
  groupId: number
  assetIds: Set<number>
}

interface Props {
  clusters: AssetLibraryClusterSummary[]
  filteredClusters: AssetLibraryClusterSummary[]
  selectedClusterIds: Set<number>
  memberSelection: AssetLibraryClusterMemberSelection | null
  armedDuplicateId: number | null
  onClusterSelected: (id: number, selected: boolean) => void
  onMemberToggled: (groupId: number, assetId: number) => void
  onRename: (id: number, name: string) => void
  onSplit: (groupId: number, assetIds: number[]) => void
  onMove: (groupId: number, targetGroupId: number | null, assetIds: number[]) => void
  onClearMemberSelection: () => void
  onApplyDuplicate: (id: number) => void
  onPromote: (summary: AssetLibraryClusterSummary) => void
  onIgnore: (id: number) => void
}

export default function AssetLibraryClusterGrid({
  clusters,
  filteredClusters,
  selectedClusterIds,
  memberSelection,
  armedDuplicateId,
  onClusterSelected,
  onMemberToggled,
  onRename,
  onSplit,
  onMove,
  onClearMemberSelection,
  onApplyDuplicate,
  onPromote,
  onIgnore,
}: Props) {
  const { t } = useTranslation()
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
        alignContent: 'start',
        gap: 7,
        padding: 4,
      }}
    >
      {filteredClusters.map((summary) => {
        const { group, representativeAsset, previewAssets } = summary
        const manualOpsAllowed = group.algorithm === 'compressed_kmeans'
        const selectedMembers =
          memberSelection?.groupId === group.id ? [...memberSelection.assetIds] : []
        return (
          <article
            key={group.id}
            style={{
              minWidth: 0,
              contentVisibility: 'auto',
              containIntrinsicSize: 'auto 227px',
              border: selectedClusterIds.has(group.id)
                ? '1px solid rgb(205,170,255)'
                : '1px solid rgba(var(--date),0.18)',
              borderRadius: 4,
              padding: 7,
              display: 'grid',
              gap: 6,
              position: 'relative',
            }}
          >
            {manualOpsAllowed && (
              <label
                style={{
                  position: 'absolute',
                  top: 4,
                  right: 6,
                  fontSize: 9,
                  opacity: 0.95,
                  zIndex: 2,
                  background: 'rgba(var(--bg, 30 30 30), 0.85)',
                  borderRadius: 3,
                  padding: '0 3px',
                }}
                title={t('Select for merge')}
              >
                <input
                  type="checkbox"
                  checked={selectedClusterIds.has(group.id)}
                  onChange={(event) => onClusterSelected(group.id, event.target.checked)}
                />
              </label>
            )}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                gap: 3,
                height: 76,
              }}
            >
              {(previewAssets.length > 0
                ? previewAssets
                : representativeAsset
                  ? [{ asset: representativeAsset, similarity: group.avgSimilarity }]
                  : []
              )
                .slice(0, 4)
                .map(({ asset }) => {
                  const memberSelected =
                    memberSelection?.groupId === group.id && memberSelection.assetIds.has(asset.id)
                  return (
                    <div
                      key={asset.id}
                      onClick={() => manualOpsAllowed && onMemberToggled(group.id, asset.id)}
                      style={{
                        cursor: manualOpsAllowed ? 'pointer' : 'default',
                        outline: memberSelected ? '2px solid rgb(205,170,255)' : 'none',
                        outlineOffset: -2,
                        width: '100%',
                        height: 76,
                        minWidth: 0,
                        overflow: 'hidden',
                        boxSizing: 'border-box',
                        position: 'relative',
                        background: 'rgba(var(--bg),0.16)',
                      }}
                      title={manualOpsAllowed ? t('Select members to split or move') : undefined}
                    >
                      <ThumbnailImage
                        filePath={asset.path}
                        ext={`.${asset.path.split('.').pop()?.toLowerCase() || ''}`}
                        isDirectory={false}
                        viewMode="large-icon"
                        style={memberThumbnailStyle}
                      />
                    </div>
                  )
                })}
            </div>
            <input
              defaultValue={group.name}
              onBlur={(event) => {
                const name = event.target.value.trim()
                if (name && name !== group.name) onRename(group.id, name)
              }}
              style={inputStyle}
            />
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 9,
                opacity: 0.7,
              }}
            >
              <span>
                {formatNumber(group.assetCount)} {t('assets')}
              </span>
              <span>
                {group.algorithm === 'category_feedback'
                  ? t('Category')
                  : group.algorithm === 'semantic_zero_shot'
                    ? t('Semantic')
                    : group.algorithm === 'duplicate_exact' || group.algorithm === 'duplicate_near'
                      ? t('Duplicate')
                      : t('Visual')}{' '}
                · {(group.avgSimilarity * 100).toFixed(1)}%
                {group.origin && group.origin !== 'auto' ? (
                  <span
                    style={{ color: 'rgb(205,170,255)', marginLeft: 4 }}
                    title={t('Manual {origin}{lineage} · kept across recalculations', {
                      origin: group.origin.replace('manual_', ''),
                      lineage: group.lineageKey ? ` · ${group.lineageKey}` : '',
                    })}
                  >
                    {t('Manual')}
                  </span>
                ) : null}
              </span>
            </div>
            {group.labels && group.labels.length > 0 && (
              <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', minHeight: 16 }}>
                {group.labels.map((label) => (
                  <span
                    key={label}
                    style={{
                      padding: '2px 4px',
                      fontSize: 8,
                      color: 'rgb(120,205,255)',
                      background: 'rgba(70,150,220,0.12)',
                      border: '1px solid rgba(90,180,240,0.22)',
                    }}
                  >
                    {label}
                  </span>
                ))}
              </div>
            )}
            {manualOpsAllowed &&
              (memberSelection?.groupId === group.id ? (
                <div
                  style={{
                    display: 'flex',
                    gap: 3,
                    alignItems: 'center',
                    fontSize: 9,
                    height: 27,
                    minWidth: 0,
                    overflow: 'hidden',
                  }}
                >
                  <span>
                    {selectedMembers.length} {t('selected')}:
                  </span>
                  <button
                    style={{ ...buttonStyle, color: 'rgb(205,170,255)' }}
                    title={t('Split selected members into a new group')}
                    onClick={() => onSplit(group.id, selectedMembers)}
                  >
                    {t('Split')}
                  </button>
                  <button
                    style={buttonStyle}
                    title={t('Move selected members out of clustering')}
                    onClick={() => onMove(group.id, null, selectedMembers)}
                  >
                    {t('Move out')}
                  </button>
                  <select
                    value=""
                    title={t('Move selected members to another group')}
                    onChange={(event) => {
                      const targetId = Number(event.target.value)
                      if (targetId) onMove(group.id, targetId, selectedMembers)
                    }}
                    style={{ ...inputStyle, fontSize: 9, flex: 1 }}
                  >
                    <option value="">{t('Move to…')}</option>
                    {clusters
                      .filter(
                        (candidate) =>
                          candidate.group.id !== group.id &&
                          candidate.group.algorithm === 'compressed_kmeans',
                      )
                      .map((candidate) => (
                        <option key={candidate.group.id} value={candidate.group.id}>
                          {candidate.group.name}
                        </option>
                      ))}
                  </select>
                  <button style={buttonStyle} onClick={onClearMemberSelection}>
                    ×
                  </button>
                </div>
              ) : (
                <div style={{ height: 27 }} aria-hidden="true" />
              ))}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
                gap: 4,
              }}
            >
              {group.algorithm === 'duplicate_exact' || group.algorithm === 'duplicate_near' ? (
                <button
                  disabled={group.status === 'confirmed'}
                  onClick={() => onApplyDuplicate(group.id)}
                  style={{
                    ...buttonStyle,
                    color: armedDuplicateId === group.id ? 'rgb(255,120,120)' : 'rgb(255,190,120)',
                  }}
                >
                  {group.status === 'confirmed'
                    ? t('Archived')
                    : armedDuplicateId === group.id
                      ? t('Confirm archive {count}', {
                          count: Math.max(0, group.assetCount - 1),
                        })
                      : t('Archive {count} copies', {
                          count: Math.max(0, group.assetCount - 1),
                        })}
                </button>
              ) : (
                <button
                  disabled={group.status === 'confirmed'}
                  onClick={() => onPromote(summary)}
                  style={{ ...buttonStyle, color: 'rgb(85,220,160)' }}
                >
                  {group.status === 'confirmed'
                    ? t('Applied')
                    : group.algorithm === 'category_feedback'
                      ? t('Apply matches')
                      : t('Convert to category')}
                </button>
              )}
              <button onClick={() => onIgnore(group.id)} style={buttonStyle}>
                {t('Ignore')}
              </button>
            </div>
          </article>
        )
      })}
      {filteredClusters.length === 0 && (
        <div style={{ opacity: 0.4, fontSize: 10 }}>
          {clusters.length === 0
            ? t('No AI groups. Build clusters after syncing assets and DINO embeddings.')
            : t('No groups match this filter.')}
        </div>
      )}
    </div>
  )
}
