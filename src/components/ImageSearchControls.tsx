import React from 'react'
import type { SearchMode } from '../../shared/vectorTypes'
import type { SearchExperienceMode } from '../services/searchSetupWorkflow'
import { productSearchCoreActionIds } from '../services/productInformationArchitecture'
import { useTranslation } from '../i18n/useTranslation'
import CollapsibleSearchSection from './CollapsibleSearchSection'
import type { ImageSearchSortMode } from './imageSearchSort'

export const IMAGE_SEARCH_TOPK_OPTIONS = [20, 50, 100, 200, 500, 1000]

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'score', label: 'Score' },
  { value: 'projectFirst', label: 'Project files first' },
  { value: 'distance', label: 'Distance' },
  { value: 'fileSize', label: 'Size' },
  { value: 'resolution', label: 'Resolution' },
]

type ScanMode = 'addNew' | 'update' | 'updateAll'

interface ImageSearchControlsProps {
  experienceMode: SearchExperienceMode
  workflowRunning: boolean
  isScanning: boolean
  searching: boolean
  scanPaths: string[]
  manualPath: string
  setManualPath: (value: string) => void
  scanMode: ScanMode
  setScanMode: (value: ScanMode) => void
  buildScanThumbnails: boolean
  setBuildScanThumbnails: (value: boolean) => void
  showDrivePicker: boolean
  availableDrives: string[]
  searchQuery: string
  setSearchQuery: (value: string) => void
  semanticQuery: string
  setSemanticQuery: (value: string) => void
  testImagePath: string | null
  dragOver: boolean
  threshold: number
  setThreshold: (value: number) => void
  topK: number
  setTopK: (value: number) => void
  sortBy: ImageSearchSortMode
  setSortBy: (value: ImageSearchSortMode) => void
  searchMode: SearchMode
  setSearchMode: (value: SearchMode) => void
  semanticModelReady: boolean
  showExtendedScores: boolean
  setShowExtendedScores: (value: boolean) => void
  onStartScan: () => void
  onStopScan: () => void
  onPrepareLibrary: () => void
  onCancelSetup: () => void
  onSelectPaths: () => void
  onToggleDrivePicker: () => void
  onAddDrive: (drive: string) => void
  onManualKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void
  onManualAdd: () => void
  onClearPaths: () => void
  onRemovePath: (path: string) => void
  onQueryImage: () => void
  onPasteClipboardImage: () => void
  onRefreshSearch: () => void
  onClearQueryImage: () => void
  onSemanticSearch: () => void
  libraryExpanded: boolean
  onToggleLibrary: () => void
}

const ImageSearchControls: React.FC<ImageSearchControlsProps> = ({
  experienceMode,
  workflowRunning,
  isScanning,
  searching,
  scanPaths,
  manualPath,
  setManualPath,
  scanMode,
  setScanMode,
  buildScanThumbnails,
  setBuildScanThumbnails,
  showDrivePicker,
  availableDrives,
  searchQuery,
  setSearchQuery,
  semanticQuery,
  setSemanticQuery,
  testImagePath,
  dragOver,
  threshold,
  setThreshold,
  topK,
  setTopK,
  sortBy,
  setSortBy,
  searchMode,
  setSearchMode,
  semanticModelReady,
  showExtendedScores,
  setShowExtendedScores,
  onStartScan,
  onStopScan,
  onPrepareLibrary,
  onCancelSetup,
  onSelectPaths,
  onToggleDrivePicker,
  onAddDrive,
  onManualKeyDown,
  onManualAdd,
  onClearPaths,
  onRemovePath,
  onQueryImage,
  onPasteClipboardImage,
  onRefreshSearch,
  onClearQueryImage,
  onSemanticSearch,
  libraryExpanded,
  onToggleLibrary,
}) => {
  const { t } = useTranslation()
  const taskBusy = isScanning || workflowRunning
  return (
    <div
      className="image-search-controls"
      data-testid="image-search-core-actions"
      data-experience-mode={experienceMode}
      data-core-actions={productSearchCoreActionIds('image', experienceMode).join(' ')}
    >
      <CollapsibleSearchSection
        id="image-search-library-section"
        step="02"
        title={t('Library preparation')}
        description={t('Choose folders, scan changes, and build the searchable library.')}
        expanded={libraryExpanded}
        onToggle={onToggleLibrary}
        tone="library"
        testId="image-search-library-section"
        summary={`${scanPaths.length}/64`}
      >
        <div
          className="image-search-scan-controls"
          style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}
        >
          <button
            data-testid="search-prepare-library"
            data-onboarding-action="image-prepare-library"
            onClick={onPrepareLibrary}
            disabled={taskBusy || scanPaths.length === 0}
            style={{ fontSize: 11, padding: '3px 12px' }}
            title={t(
              'Scan images, build missing DINO and CLIP embeddings, then build the vector index',
            )}
          >
            {t('Prepare Library')}
          </button>
          <button
            onClick={workflowRunning ? onCancelSetup : onStopScan}
            disabled={!taskBusy}
            style={{ fontSize: 11, padding: '3px 10px', opacity: taskBusy ? 1 : 0.45 }}
          >
            {t('Stop')}
          </button>
          {experienceMode === 'advanced' && (
            <>
              <button
                data-testid="image-search-start-scan"
                onClick={onStartScan}
                disabled={taskBusy || scanPaths.length === 0}
                style={{ fontSize: 11, padding: '3px 10px' }}
              >
                {t('Start Scan')}
              </button>
              <select
                value={scanMode}
                onChange={(e) => setScanMode(e.target.value as ScanMode)}
                disabled={taskBusy}
                style={{ fontSize: 10, padding: '3px 6px' }}
                title={t('Scan mode')}
              >
                <option value="addNew">{t('Add New')}</option>
                <option value="update">{t('Update')}</option>
                <option value="updateAll">{t('Update All')}</option>
              </select>
              <label
                title={t(
                  'Reuse the native scan decode to build JPEG thumbnails for new or changed images',
                )}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 9 }}
              >
                <input
                  type="checkbox"
                  checked={buildScanThumbnails}
                  disabled={taskBusy}
                  onChange={(event) => setBuildScanThumbnails(event.target.checked)}
                />
                {t('Native thumbs')}
              </label>
            </>
          )}
          <button
            data-testid="image-search-select-folders"
            onClick={onSelectPaths}
            disabled={taskBusy}
            style={{ fontSize: 10, padding: '3px 8px' }}
          >
            + {t('Folders')}
          </button>
          <div style={{ position: 'relative' }}>
            <button
              onClick={onToggleDrivePicker}
              disabled={taskBusy}
              style={{ fontSize: 10, padding: '3px 8px' }}
            >
              + {t('Drive')}
            </button>
            {showDrivePicker && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  zIndex: 10,
                  minWidth: 80,
                  background: 'rgba(var(--bg),0.98)',
                  border: '1px solid rgba(var(--date),0.3)',
                  boxShadow: '0 4px 10px rgba(0,0,0,0.35)',
                }}
              >
                {availableDrives.map((drive) => (
                  <button
                    key={drive}
                    onClick={() => onAddDrive(drive)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      fontSize: 10,
                      padding: '4px 8px',
                      background: 'transparent',
                      color: 'rgb(var(--fg))',
                      border: 'none',
                    }}
                  >
                    {drive}
                  </button>
                ))}
              </div>
            )}
          </div>
          <input
            data-testid="image-search-manual-path"
            value={manualPath}
            onChange={(e) => setManualPath(e.target.value)}
            onKeyDown={onManualKeyDown}
            disabled={taskBusy}
            placeholder={t('Image folder or drive path...')}
            style={{ flex: '1 1 220px', minWidth: 180, fontSize: 10, padding: '4px 7px' }}
          />
          <button
            data-testid="image-search-add-path"
            onClick={onManualAdd}
            disabled={taskBusy || !manualPath.trim()}
            style={{ fontSize: 10, padding: '3px 8px' }}
          >
            {t('Add')}
          </button>
          <button
            onClick={onClearPaths}
            disabled={taskBusy || scanPaths.length === 0}
            style={{ fontSize: 10, padding: '3px 8px', color: 'rgb(255,130,130)' }}
          >
            {t('Clear All')}
          </button>
        </div>

        <div className="image-search-scan-paths">
          <span style={{ fontSize: 10, opacity: 0.65 }}>
            {t('Scan Paths')} ({scanPaths.length}/64)
          </span>
          {scanPaths.map((p) => (
            <span
              key={p}
              title={p}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                maxWidth: 190,
                padding: '2px 5px',
                background: 'rgba(var(--date),0.12)',
                border: '1px solid rgba(var(--date),0.12)',
                fontSize: 9,
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p}
              </span>
              <button
                onClick={() => onRemovePath(p)}
                disabled={taskBusy}
                aria-label={`${t('Remove')}: ${p}`}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: 'inherit',
                  opacity: taskBusy ? 0.35 : 0.8,
                  padding: 0,
                  cursor: taskBusy ? 'default' : 'pointer',
                }}
              >
                x
              </button>
            </span>
          ))}
        </div>
      </CollapsibleSearchSection>

      <CollapsibleSearchSection
        id="image-search-query-section"
        step="03"
        title={t('Search input')}
        description={t('Search with an image, filename filter, or natural-language description.')}
        expanded={true}
        collapsible={false}
        pinned
        tone="query"
        testId="image-search-query-section"
        summary={searching ? t('Searching...') : t('Ready')}
      >
        <div
          className="image-search-query-controls"
          style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}
        >
          <button
            data-testid="image-search-query-image"
            onClick={onQueryImage}
            disabled={searching || workflowRunning}
            style={{ fontSize: 11, padding: '3px 12px' }}
          >
            {t('Query')}
          </button>
          <button
            onClick={onPasteClipboardImage}
            disabled={searching || workflowRunning}
            style={{ fontSize: 11, padding: '3px 10px' }}
          >
            {t('Paste')}
          </button>
          <button
            onClick={onRefreshSearch}
            disabled={searching || workflowRunning}
            style={{ fontSize: 11, padding: '3px 10px' }}
          >
            {t('Refresh')}
          </button>
          <input
            readOnly
            value={testImagePath || ''}
            placeholder={
              dragOver
                ? t('Drop image to search...')
                : t('Drop an image, click Query, or Paste clipboard image...')
            }
            style={{ flex: '1 1 220px', minWidth: 0, fontSize: 11, padding: '4px 8px' }}
            title={testImagePath || undefined}
          />
          {testImagePath && (
            <button
              onClick={onClearQueryImage}
              disabled={searching || workflowRunning}
              style={{ fontSize: 10, padding: '3px 8px' }}
            >
              {t('Clear')}
            </button>
          )}
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('Filter by name (optional)...')}
            style={{ flex: '1 1 160px', minWidth: 0, fontSize: 11, padding: '4px 8px' }}
          />
        </div>

        <div
          className="image-search-semantic-controls"
          style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
        >
          <button
            data-testid="image-search-semantic-query"
            onClick={onSemanticSearch}
            disabled={searching || workflowRunning || !semanticModelReady}
            title={!semanticModelReady ? t('The selected model is not ready.') : undefined}
            style={{ fontSize: 11, padding: '3px 10px' }}
          >
            {t('Semantic')}
          </button>
          <input
            value={semanticQuery}
            onChange={(e) => setSemanticQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSemanticSearch()
            }}
            placeholder={t('Semantic text: red screenshot, phone, avatar...')}
            style={{ flex: '1 1 240px', minWidth: 0, fontSize: 11, padding: '4px 8px' }}
          />
        </div>

        {experienceMode === 'advanced' && (
          <div
            className="image-search-parameter-controls"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              fontSize: 10,
            }}
          >
            <span style={{ opacity: 0.6 }}>{t('Threshold')}:</span>
            <input
              type="range"
              min={0.5}
              max={1}
              step={0.01}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              style={{ width: 80 }}
            />
            <span>{Math.round(threshold * 100)}%</span>
            <span style={{ opacity: 0.6 }}>{t('Top')}:</span>
            <select
              value={topK}
              onChange={(e) => setTopK(Number(e.target.value))}
              style={{ fontSize: 10 }}
            >
              {IMAGE_SEARCH_TOPK_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span style={{ opacity: 0.6 }}>{t('Sort')}:</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as ImageSearchSortMode)}
              style={{ fontSize: 10 }}
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.label)}
                </option>
              ))}
            </select>
            <span style={{ opacity: 0.6 }}>{t('Search')}:</span>
            <select
              value={searchMode}
              onChange={(e) => setSearchMode(e.target.value as SearchMode)}
              style={{ fontSize: 10 }}
            >
              <option value="fast">{t('Fast')}</option>
              <option value="standard">{t('Standard')}</option>
              <option value="precise">{t('Precise')}</option>
            </select>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, opacity: 0.8 }}>
              <input
                type="checkbox"
                checked={showExtendedScores}
                onChange={(e) => setShowExtendedScores(e.target.checked)}
              />
              {t('Scores')}
            </label>
          </div>
        )}
      </CollapsibleSearchSection>
    </div>
  )
}

export default ImageSearchControls
