import React from 'react'
import type { MediaSearchStatus } from '../../shared/ipc-contract'
import type { SearchExperienceMode } from '../services/searchSetupWorkflow'
import { productSearchCoreActionIds } from '../services/productInformationArchitecture'
import { useTranslation } from '../i18n/useTranslation'
import CollapsibleSearchSection, { SearchControlSectionsToolbar } from './CollapsibleSearchSection'

type MediaSearchModel = 'dinov2_vitb14' | 'clip_vit_base_patch32'
type MediaSearchBackend = 'cpu' | 'gpu'
type MediaSearchViewMode = 'videos' | 'frames'
type MediaSearchSortMode = 'score' | 'time'

export type MediaSearchControlSectionId = 'sources' | 'library' | 'query' | 'maintenance'

interface MediaSearchControlsProps {
  workspaceView?: 'search' | 'sources'
  expandedSections: Record<MediaSearchControlSectionId, boolean>
  experienceMode: SearchExperienceMode
  workflowRunning: boolean
  availableDrives: string[]
  canSearchFrames: boolean
  clipModelReady: boolean
  dinoModelReady: boolean
  dragOverQueryImage: boolean
  manualPath: string
  multimodalEnabled: boolean
  queryImagePath: string
  searchBackend: MediaSearchBackend
  searchModel: MediaSearchModel
  searchTopK: number
  selectedPathCount: number
  showDrivePicker: boolean
  sortMode: MediaSearchSortMode
  status: MediaSearchStatus
  textQuery: string
  viewMode: MediaSearchViewMode
  modeControl: React.ReactNode
  sourceStatus: React.ReactNode
  libraryStatus: React.ReactNode
  maintenanceStatus: React.ReactNode
  onAddDrivePath: (drive: string) => void
  onAddManualPath: () => void
  onBuildFrameEmbeddings: (modelName: MediaSearchModel) => void
  onBuildFrames: () => void
  onChooseFfmpegDir: () => void
  onChooseSingleVideo: () => void
  onChooseVideoFiles: () => void
  onChooseFolders: () => void
  onChooseQueryImage: () => void
  onClearCache: () => void
  onClearFfmpegDir: () => void
  onClearQueryImage: () => void
  onClearSelectedPaths: () => void
  onClearVideoData: () => void
  onLoadData: () => void
  onOpenFfmpegToolsDir: () => void
  onPasteClipboardImage: () => void
  onQueryImageDrop: (event: React.DragEvent<HTMLElement>) => void
  onRefreshQuerySearch: () => void
  onRunPrimarySearch: () => void
  onSearchBackendChange: (backend: MediaSearchBackend) => void
  onSearchModelChange: (modelName: MediaSearchModel) => void
  onSearchTopKChange: (value: number) => void
  onSetDragOverQueryImage: (value: boolean) => void
  onSetManualPath: (value: string) => void
  onSetMultimodalEnabled: (value: boolean) => void
  onSetTextQuery: (value: string) => void
  onSetViewMode: (mode: MediaSearchViewMode) => void
  onSortModeChange: (mode: MediaSearchSortMode) => void
  onStartScan: () => void
  onStopTask: () => void
  onPrepareLibrary: () => void
  onCancelSetup: () => void
  onToggleDrivePicker: () => void
  onToggleSection: (id: MediaSearchControlSectionId) => void
  onSetAllSectionsExpanded: (expanded: boolean) => void
}

const MediaSearchControls: React.FC<MediaSearchControlsProps> = ({
  workspaceView,
  expandedSections,
  experienceMode,
  workflowRunning,
  availableDrives,
  canSearchFrames,
  clipModelReady,
  dinoModelReady,
  dragOverQueryImage,
  manualPath,
  multimodalEnabled,
  queryImagePath,
  searchBackend,
  searchModel,
  searchTopK,
  selectedPathCount,
  showDrivePicker,
  sortMode,
  status,
  textQuery,
  viewMode,
  modeControl,
  sourceStatus,
  libraryStatus,
  maintenanceStatus,
  onAddDrivePath,
  onAddManualPath,
  onBuildFrameEmbeddings,
  onBuildFrames,
  onChooseFfmpegDir,
  onChooseSingleVideo,
  onChooseVideoFiles,
  onChooseFolders,
  onChooseQueryImage,
  onClearCache,
  onClearFfmpegDir,
  onClearQueryImage,
  onClearSelectedPaths,
  onClearVideoData,
  onLoadData,
  onOpenFfmpegToolsDir,
  onPasteClipboardImage,
  onQueryImageDrop,
  onRefreshQuerySearch,
  onRunPrimarySearch,
  onSearchBackendChange,
  onSearchModelChange,
  onSearchTopKChange,
  onSetDragOverQueryImage,
  onSetManualPath,
  onSetMultimodalEnabled,
  onSetTextQuery,
  onSetViewMode,
  onSortModeChange,
  onStartScan,
  onStopTask,
  onPrepareLibrary,
  onCancelSetup,
  onToggleDrivePicker,
  onToggleSection,
  onSetAllSectionsExpanded,
}) => {
  const { t } = useTranslation()
  const running = status.state === 'running' || workflowRunning

  return (
    <div className="media-search-control-stack">
      {workspaceView === 'search' ? (
        modeControl
      ) : (
        <SearchControlSectionsToolbar
          panelId="media-search"
          leadingControl={modeControl}
          onExpandAll={() => onSetAllSectionsExpanded(true)}
          onCollapseAll={() => onSetAllSectionsExpanded(false)}
        />
      )}
      <div
        className="media-search-controls"
        data-testid="media-search-core-actions"
        data-experience-mode={experienceMode}
        data-core-actions={productSearchCoreActionIds('video', experienceMode).join(' ')}
      >
        {workspaceView !== 'search' && (
          <CollapsibleSearchSection
            id="media-search-sources-section"
            step="01"
            title={t('Video sources')}
            description={t('Choose videos, folders, or drives to include in this library.')}
            expanded={expandedSections.sources}
            onToggle={() => onToggleSection('sources')}
            tone="sources"
            testId="media-search-sources-section"
            summary={`${selectedPathCount}/64`}
          >
            <div className="media-search-source-controls">
              <button
                data-testid="media-search-select-single-video"
                onClick={onChooseSingleVideo}
                disabled={running}
              >
                {t('Select One Video')}
              </button>
              <button
                data-testid="media-search-select-videos"
                onClick={onChooseVideoFiles}
                disabled={running}
              >
                {t('Select Videos')}
              </button>
              <button
                data-testid="media-search-select-folders"
                onClick={onChooseFolders}
                disabled={running}
              >
                {t('Select Folder')}
              </button>
              <div style={{ position: 'relative' }}>
                <button onClick={onToggleDrivePicker} disabled={running}>
                  + {t('Drive')}
                </button>
                {showDrivePicker && (
                  <div
                    style={{
                      position: 'absolute',
                      top: '100%',
                      left: 0,
                      zIndex: 20,
                      minWidth: 80,
                      background: 'rgba(var(--bg), 0.98)',
                      border: '1px solid rgba(var(--date), 0.3)',
                      boxShadow: '0 4px 10px rgba(0,0,0,0.35)',
                    }}
                  >
                    {availableDrives.map((drive) => (
                      <button
                        key={drive}
                        onClick={() => onAddDrivePath(drive)}
                        style={{
                          display: 'block',
                          width: '100%',
                          textAlign: 'left',
                          border: 'none',
                          background: 'transparent',
                          color: 'rgb(var(--fg))',
                        }}
                      >
                        {drive}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <input
                value={manualPath}
                onChange={(event) => onSetManualPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onAddManualPath()
                }}
                disabled={running}
                placeholder={t('Video file or folder path...')}
                style={{ flex: '1 1 220px', minWidth: 180 }}
              />
              <button onClick={onAddManualPath} disabled={running || !manualPath.trim()}>
                {t('Add')}
              </button>
              <button
                onClick={onClearSelectedPaths}
                disabled={running || selectedPathCount === 0}
                style={{ color: 'rgb(255,130,130)' }}
              >
                {t('Clear Paths')}
              </button>
            </div>
            {sourceStatus}
          </CollapsibleSearchSection>
        )}

        {workspaceView !== 'search' && (
          <CollapsibleSearchSection
            id="media-search-library-section"
            step="02"
            title={t('Video library preparation')}
            description={t('Scan files, extract frames, and build visual embeddings.')}
            expanded={expandedSections.library}
            onToggle={() => onToggleSection('library')}
            tone="library"
            testId="media-search-library-section"
            summary={t(status.state)}
          >
            <div className="media-search-build-controls">
              <button
                data-testid="search-prepare-library"
                onClick={onPrepareLibrary}
                disabled={running || selectedPathCount === 0}
                title={t(
                  'Scan videos, extract frames, then build missing DINO and CLIP frame embeddings',
                )}
              >
                {t('Prepare Library')}
              </button>
              <button
                onClick={workflowRunning ? onCancelSetup : onStopTask}
                disabled={!running}
                style={{ opacity: running ? 1 : 0.45 }}
              >
                {t('Stop')}
              </button>
              {experienceMode === 'advanced' && (
                <>
                  <button onClick={onStartScan} disabled={running}>
                    {t('Scan')}
                  </button>
                  <button
                    onClick={onLoadData}
                    disabled={running}
                    title={t(
                      'Load full Media Search lists and embedding coverage. This is intentionally manual because it can take seconds on large manifests.',
                    )}
                  >
                    {t('Load Data')}
                  </button>
                  <button
                    data-testid="media-search-build-frames"
                    onClick={onBuildFrames}
                    disabled={running}
                  >
                    {t('Build Frames')}
                  </button>
                  <button
                    onClick={() => onBuildFrameEmbeddings('dinov2_vitb14')}
                    disabled={running || !dinoModelReady}
                    title={!dinoModelReady ? t('The selected model is not ready.') : undefined}
                  >
                    DINO {t('Frames')}
                  </button>
                  <button
                    onClick={() => onBuildFrameEmbeddings('clip_vit_base_patch32')}
                    disabled={running || !clipModelReady}
                    title={!clipModelReady ? t('The selected model is not ready.') : undefined}
                  >
                    CLIP {t('Frames')}
                  </button>
                </>
              )}
            </div>
            {libraryStatus}
          </CollapsibleSearchSection>
        )}

        {workspaceView !== 'sources' && (
          <CollapsibleSearchSection
            id="media-search-query-section"
            step="03"
            title={t('Video search')}
            description={t('Search by reference image, natural language, and result filters.')}
            expanded={true}
            collapsible={false}
            pinned
            tone="query"
            testId="media-search-query-section"
            summary={`${searchTopK} topK`}
          >
            <div className="media-search-query-controls">
              <button
                data-testid="media-search-query-image"
                onClick={onChooseQueryImage}
                disabled={running}
              >
                {t('Query')}
              </button>
              <button onClick={onPasteClipboardImage} disabled={running}>
                {t('Paste')}
              </button>
              <button onClick={onRefreshQuerySearch} disabled={running}>
                {t('Refresh')}
              </button>
              <input
                readOnly
                value={queryImagePath}
                placeholder={
                  dragOverQueryImage
                    ? t('Drop image to search video frames...')
                    : t('Drop an image, click Query, or Paste clipboard image...')
                }
                title={queryImagePath || undefined}
                onDragOver={(event) => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = running ? 'none' : 'copy'
                  onSetDragOverQueryImage(true)
                }}
                onDragLeave={() => onSetDragOverQueryImage(false)}
                onDrop={onQueryImageDrop}
                style={{
                  flex: '1 1 260px',
                  minWidth: 180,
                  borderColor: dragOverQueryImage ? 'rgba(100,180,255,0.85)' : undefined,
                  background: dragOverQueryImage ? 'rgba(100,180,255,0.12)' : undefined,
                }}
              />
              {queryImagePath && (
                <button onClick={onClearQueryImage} disabled={running}>
                  {t('Clear')}
                </button>
              )}
              {experienceMode === 'advanced' && (
                <>
                  <select
                    value={searchModel}
                    onChange={(event) =>
                      onSearchModelChange(event.target.value as MediaSearchModel)
                    }
                    title={t('Search model')}
                  >
                    <option value="clip_vit_base_patch32">CLIP</option>
                    <option value="dinov2_vitb14">DINO</option>
                  </select>
                  <select
                    value={searchBackend}
                    onChange={(event) =>
                      onSearchBackendChange(event.target.value as MediaSearchBackend)
                    }
                    title={t('Backend')}
                  >
                    <option value="gpu">{t('GPU')}</option>
                    <option value="cpu">{t('CPU')}</option>
                  </select>
                </>
              )}
              <select
                value={searchTopK}
                onChange={(event) => onSearchTopKChange(Number(event.target.value))}
                style={{ width: 56 }}
                title={t('Maximum search results')}
              >
                {[20, 50, 100, 200, 500, 1000].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <span style={{ opacity: 0.7 }}>{t('topK')}</span>
              <input
                type="text"
                data-testid="media-search-text-query"
                value={textQuery}
                disabled={running}
                onChange={(event) => onSetTextQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onRunPrimarySearch()
                }}
                placeholder={t('Text query...')}
                style={{ width: 120 }}
              />
              <button
                data-testid="media-search-run-query"
                onClick={onRunPrimarySearch}
                disabled={running || !canSearchFrames}
              >
                {t(multimodalEnabled ? 'Multi' : 'Search Frames')}
              </button>
              {experienceMode === 'advanced' && (
                <>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: 12,
                      opacity: 0.7,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={multimodalEnabled}
                      onChange={(event) => onSetMultimodalEnabled(event.target.checked)}
                    />
                    {t('Multi')}
                  </label>
                  <select
                    value={viewMode}
                    onChange={(event) => onSetViewMode(event.target.value as MediaSearchViewMode)}
                  >
                    <option value="videos">{t('Videos')}</option>
                    <option value="frames">{t('Frames')}</option>
                  </select>
                  {viewMode === 'frames' && (
                    <select
                      value={sortMode}
                      onChange={(event) =>
                        onSortModeChange(event.target.value as MediaSearchSortMode)
                      }
                    >
                      <option value="score">{t('By Score')}</option>
                      <option value="time">{t('By Time')}</option>
                    </select>
                  )}
                </>
              )}
            </div>
          </CollapsibleSearchSection>
        )}

        {workspaceView !== 'search' && (
          <CollapsibleSearchSection
            id="media-search-maintenance-section"
            step="04"
            title={t('AI semantics and maintenance')}
            description={t(
              'Review visual, language, dialogue, and audio readiness with maintenance diagnostics.',
            )}
            expanded={expandedSections.maintenance}
            onToggle={() => onToggleSection('maintenance')}
            tone="maintenance"
            testId="media-search-maintenance-section"
            summary={t(experienceMode === 'simple' ? 'AUTO' : 'MANUAL')}
          >
            {experienceMode === 'advanced' && (
              <div className="media-search-maintenance-controls">
                <button onClick={onChooseFfmpegDir}>{t('FFmpeg Dir')}</button>
                <button onClick={onOpenFfmpegToolsDir}>{t('Tools')}</button>
                <button onClick={onClearFfmpegDir}>{t('Clear FF')}</button>
                <button onClick={onClearCache} disabled={running}>
                  {t('Clear Temp')}
                </button>
                <button
                  onClick={onClearVideoData}
                  disabled={running}
                  style={{
                    color: 'rgb(255,115,115)',
                    borderColor: 'rgba(255,115,115,0.55)',
                    background: 'rgba(120,0,0,0.28)',
                  }}
                  title={t(
                    'Clear video manifests, frames, frame index, and old CLIP/DINO frame embeddings',
                  )}
                >
                  {t('Clear Video Data')}
                </button>
              </div>
            )}
            {maintenanceStatus}
          </CollapsibleSearchSection>
        )}
      </div>
    </div>
  )
}

export default MediaSearchControls
