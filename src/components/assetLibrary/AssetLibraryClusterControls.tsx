import type { AssetCategory } from '../../../shared/ipc-contract'
import {
  assetLibraryButtonStyle as buttonStyle,
  assetLibraryInputStyle as inputStyle,
  formatAssetLibraryNumber as formatNumber,
} from './assetLibraryViewUtils'
import { useTranslation } from '../../i18n/useTranslation'

export type AssetLibraryClusterTypeFilter = 'all' | 'visual' | 'duplicate' | 'other'

interface Props {
  rows: Array<{ category: AssetCategory; depth: number }>
  activeTask: boolean
  totalAssets: number
  clusterTotal: number
  clusteredAssetCount: number
  selectedClusterCount: number
  categoryId: number
  categoryTopK: number
  categoryMinScore: number
  categoryIncludeReviewed: boolean
  autoCount: boolean
  count: number
  minSize: number
  minSimilarity: number
  semanticRefine: boolean
  semanticSimilarity: number
  semanticMaxSplits: number
  typeFilter: AssetLibraryClusterTypeFilter
  scopePaths: string[]
  onCategoryIdChange: (value: number) => void
  onCategoryTopKChange: (value: number) => void
  onCategoryMinScoreChange: (value: number) => void
  onCategoryIncludeReviewedChange: (value: boolean) => void
  onAutoCountChange: (value: boolean) => void
  onCountChange: (value: number) => void
  onMinSizeChange: (value: number) => void
  onMinSimilarityChange: (value: number) => void
  onSemanticRefineChange: (value: boolean) => void
  onSemanticSimilarityChange: (value: number) => void
  onSemanticMaxSplitsChange: (value: number) => void
  onTypeFilterChange: (value: AssetLibraryClusterTypeFilter) => void
  onBuildCategoryGroup: () => void
  onBuildClusters: () => void
  onRefreshLabels: () => void
  onBuildPeopleGroups: () => void
  onBuildDuplicates: () => void
  onBuildNearDuplicates: () => void
  onMergeSelected: () => void
  onRefresh: () => void
  onSelectPaths: () => void
  onClearPaths: () => void
  onRemovePath: (path: string) => void
}

export default function AssetLibraryClusterControls(props: Props) {
  const { t } = useTranslation()
  const {
    rows,
    activeTask,
    totalAssets,
    clusterTotal,
    clusteredAssetCount,
    selectedClusterCount,
    categoryId,
    categoryTopK,
    categoryMinScore,
    categoryIncludeReviewed,
    autoCount,
    count,
    minSize,
    minSimilarity,
    semanticRefine,
    semanticSimilarity,
    semanticMaxSplits,
    typeFilter,
    scopePaths,
  } = props

  return (
    <>
      <div
        style={{
          display: 'flex',
          gap: 5,
          alignItems: 'center',
          flexWrap: 'wrap',
          padding: '4px 0',
          borderBottom: '1px solid rgba(var(--date),0.14)',
        }}
      >
        <strong style={{ fontSize: 9, color: 'rgb(85,220,160)' }}>{t('Category group')}</strong>
        <select
          data-testid="asset-cluster-category"
          value={categoryId}
          onChange={(event) => props.onCategoryIdChange(Number(event.target.value))}
          style={{ ...inputStyle, minWidth: 160, maxWidth: 260 }}
          title={t(
            "Use this category's accepted assets, references and rejected samples to find a new group",
          )}
        >
          <option value={0}>{t('Choose category')}</option>
          {rows.map(({ category, depth }) => (
            <option key={category.id} value={category.id}>
              {'  '.repeat(depth)}
              {category.name}
            </option>
          ))}
        </select>
        <label style={{ fontSize: 9 }}>{t('Results')}</label>
        <input
          type="number"
          min={10}
          max={5000}
          value={categoryTopK}
          onChange={(event) => props.onCategoryTopKChange(Number(event.target.value))}
          style={{ ...inputStyle, width: 66 }}
          title={t('Maximum images retained in this category candidate group')}
        />
        <label style={{ fontSize: 9 }}>{t('Min score')}</label>
        <input
          type="number"
          min={0}
          max={1}
          step={0.01}
          value={categoryMinScore}
          onChange={(event) => props.onCategoryMinScoreChange(Number(event.target.value))}
          style={{ ...inputStyle, width: 62 }}
          title={t('Discard category matches below this CLIP + DINO score')}
        />
        <label
          style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 9 }}
          title={t('Also include assets already accepted into or rejected from this category')}
        >
          <input
            type="checkbox"
            checked={categoryIncludeReviewed}
            onChange={(event) => props.onCategoryIncludeReviewedChange(event.target.checked)}
          />
          {t('Include reviewed')}
        </label>
        <button
          data-testid="asset-cluster-build-category"
          disabled={activeTask || !categoryId}
          onClick={props.onBuildCategoryGroup}
          style={{ ...buttonStyle, color: 'rgb(85,220,160)' }}
          title={t(
            "Create or replace one independent candidate group using this category's reviewed samples",
          )}
        >
          {t('Build category group')}
        </button>
        <span style={{ fontSize: 8, opacity: 0.55 }}>
          {t('CLIP recall + DINO subject rerank + rejected-sample suppression')}
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 5,
          alignItems: 'center',
          flexWrap: 'wrap',
          padding: '4px 0',
        }}
      >
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 9 }}>
          <input
            type="checkbox"
            checked={autoCount}
            onChange={(event) => props.onAutoCountChange(event.target.checked)}
          />
          {t('Auto groups')}
        </label>
        <label style={{ fontSize: 9 }}>{t('Groups')}</label>
        <input
          type="number"
          min={2}
          max={256}
          disabled={autoCount}
          value={count}
          onChange={(event) => props.onCountChange(Number(event.target.value))}
          style={{ ...inputStyle, width: 55 }}
        />
        <label style={{ fontSize: 9 }}>{t('Min size')}</label>
        <input
          type="number"
          min={2}
          max={10000}
          value={minSize}
          onChange={(event) => props.onMinSizeChange(Number(event.target.value))}
          style={{ ...inputStyle, width: 62 }}
        />
        <label style={{ fontSize: 9 }}>{t('Purity')}</label>
        <input
          type="number"
          min={0.4}
          max={0.98}
          step={0.01}
          value={minSimilarity}
          onChange={(event) => props.onMinSimilarityChange(Number(event.target.value))}
          style={{ ...inputStyle, width: 62 }}
          title={t('Minimum exact DINO cosine similarity for every image kept in a cluster')}
        />
        <label
          title={t('Split each DINO visual group into more precise CLIP image-semantic subgroups')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 9 }}
        >
          <input
            type="checkbox"
            checked={semanticRefine}
            onChange={(event) => props.onSemanticRefineChange(event.target.checked)}
          />
          {t('Semantic refine')}
        </label>
        <label style={{ fontSize: 9 }}>{t('Semantic purity')}</label>
        <input
          type="number"
          min={0.6}
          max={0.99}
          step={0.01}
          disabled={!semanticRefine}
          value={semanticSimilarity}
          onChange={(event) => props.onSemanticSimilarityChange(Number(event.target.value))}
          style={{ ...inputStyle, width: 62 }}
          title={t(
            'Start a new semantic subgroup when CLIP image similarity falls below this value',
          )}
        />
        <label style={{ fontSize: 9 }}>{t('Max splits')}</label>
        <input
          type="number"
          min={1}
          max={8}
          disabled={!semanticRefine}
          value={semanticMaxSplits}
          onChange={(event) => props.onSemanticMaxSplitsChange(Number(event.target.value))}
          style={{ ...inputStyle, width: 52 }}
          title={t('Maximum CLIP semantic subgroups created inside one DINO visual group')}
        />
        <button
          disabled={activeTask || totalAssets === 0}
          onClick={props.onBuildClusters}
          style={buttonStyle}
        >
          {t('Recalculate clusters')}
        </button>
        <button
          disabled={activeTask || clusterTotal === 0}
          onClick={props.onRefreshLabels}
          title={t('Recalculate names and semantic labels without rebuilding cluster members')}
          style={buttonStyle}
        >
          {t('Refresh labels')}
        </button>
        <button
          disabled={activeTask || totalAssets === 0}
          onClick={props.onBuildPeopleGroups}
          title={t(
            'Classify every cached CLIP image and create dedicated real-person semantic groups',
          )}
          style={{ ...buttonStyle, color: 'rgb(120,205,255)' }}
        >
          {t('Build people groups')}
        </button>
        <button
          disabled={activeTask || totalAssets === 0}
          onClick={props.onBuildDuplicates}
          title={t(
            'Scan the whole library for byte-identical files (SHA-256) and rebuild duplicate groups',
          )}
          style={{ ...buttonStyle, color: 'rgb(255,190,120)' }}
        >
          {t('Build duplicates')}
        </button>
        <button
          disabled={activeTask || totalAssets === 0}
          onClick={props.onBuildNearDuplicates}
          title={t('Group visually near-identical images by perceptual hash (dHash, no re-decode)')}
          style={{ ...buttonStyle, color: 'rgb(255,190,120)' }}
        >
          {t('Build near duplicates')}
        </button>
        <button
          disabled={activeTask || selectedClusterCount < 2}
          onClick={props.onMergeSelected}
          title={t(
            'Merge the selected groups into one (members are unioned, kept across recalculations)',
          )}
          style={{ ...buttonStyle, color: 'rgb(205,170,255)' }}
        >
          {t('Merge')} ({selectedClusterCount})
        </button>
        {(
          [
            ['all', 'All'],
            ['visual', 'Visual'],
            ['duplicate', 'Duplicates'],
            ['other', 'Other'],
          ] as Array<[AssetLibraryClusterTypeFilter, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => props.onTypeFilterChange(id)}
            style={{
              ...buttonStyle,
              color: typeFilter === id ? 'rgb(85,220,160)' : undefined,
              borderColor: typeFilter === id ? 'rgb(85,220,160)' : undefined,
            }}
          >
            {t(label)}
          </button>
        ))}
        <button onClick={props.onRefresh} style={buttonStyle}>
          {t('Refresh')}
        </button>
        <button disabled={activeTask} onClick={props.onSelectPaths} style={buttonStyle}>
          + {t('Folders / Drives')}
        </button>
        <button
          disabled={activeTask || scopePaths.length === 0}
          onClick={props.onClearPaths}
          style={buttonStyle}
        >
          {t('All data')}
        </button>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          flexWrap: 'wrap',
          minHeight: 20,
          paddingBottom: 3,
          fontSize: 9,
        }}
      >
        <span style={{ opacity: 0.55 }}>{t('Scope')}:</span>
        {scopePaths.length === 0 ? (
          <span style={{ color: 'rgb(85,220,160)' }}>{t('All active assets with DINO')}</span>
        ) : (
          scopePaths.map((scopePath) => (
            <span
              key={scopePath}
              title={scopePath}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                maxWidth: 260,
                border: '1px solid rgba(var(--date),0.18)',
                padding: '2px 4px',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {scopePath}
              </span>
              <button
                disabled={activeTask}
                onClick={() => props.onRemovePath(scopePath)}
                title={t('Remove scope')}
                style={{ padding: '0 3px', color: 'rgb(255,105,105)', fontSize: 8 }}
              >
                x
              </button>
            </span>
          ))
        )}
        <span style={{ opacity: 0.55, marginLeft: 5 }}>
          {t('Grouped')} {formatNumber(clusteredAssetCount)} / {formatNumber(totalAssets)} (
          {totalAssets > 0 ? ((clusteredAssetCount / totalAssets) * 100).toFixed(1) : '0.0'}%);
          {t('remaining')} {formatNumber(Math.max(0, totalAssets - clusteredAssetCount))}
        </span>
      </div>
    </>
  )
}
