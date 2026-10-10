import React, { useMemo } from 'react'
import type { ImageSearchResult } from '../../shared/ipc-contract'
import type { LayeredSearchResult } from '../../shared/vectorTypes'
import ThumbnailImage from './filemanager/ThumbnailImage'
import { useVirtualGrid } from '../hooks/useVirtualGrid'
import { useTranslation } from '../i18n/useTranslation'
import SearchEmptyState from './SearchEmptyState'

const PROJECT_KEYWORD_LABELS: Record<string, string> = {
  photoshop: 'Photoshop',
  krita: 'Krita',
  illustrator: 'Illustrator',
  layered: 'Layered',
  editable: 'Editable',
  vector: 'Vector',
  raster: 'Raster',
  raw: 'RAW',
  'camera-raw': 'Camera RAW',
  multipage: 'Multipage',
  'large-document': 'Large document',
  'pdf-compatible': 'PDF compatible',
  'clip-studio': 'CLIP Studio',
  coreldraw: 'CorelDRAW',
  indesign: 'InDesign',
}

const RESULT_ACTION_STYLE: React.CSSProperties = {
  minWidth: 0,
  padding: '1px 4px',
  fontSize: 8,
  whiteSpace: 'nowrap',
}

export type ImageSearchDisplayResult = ImageSearchResult & {
  _layered?: LayeredSearchResult
  segmentId?: number
}

export interface ImageSearchMetrics {
  scanned?: number
  candidates?: number
  returned?: number
  fallbackCount?: number
  ms?: number
  mode?: string
  indexType?: string
  bucketSize?: number
  fallbackUsed?: boolean
  searchMode?: string
}

interface ImageSearchResultGridProps {
  results: ImageSearchDisplayResult[]
  rawResultCount: number
  queryHash: string | null
  statusState: string
  searchQuery: string
  searchMetrics: ImageSearchMetrics | null
  showExtendedScores: boolean
  onOpenFile: (path: string) => void
  onOpenFolder: (path: string) => void
  onCopyPath: (path: string) => void
  onSearchSimilar: (path: string) => void
  onSubjectSearch: (path: string) => void
}

function fmtBytes(n: number | undefined): string {
  if (!n || !Number.isFinite(n) || n < 0) return ''
  if (n < 1024) return `${n}B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)}MB`
  return `${(n / 1073741824).toFixed(2)}GB`
}

const ImageSearchResultGrid: React.FC<ImageSearchResultGridProps> = ({
  results,
  rawResultCount,
  queryHash,
  statusState,
  searchQuery,
  searchMetrics,
  showExtendedScores,
  onOpenFile,
  onOpenFolder,
  onCopyPath,
  onSearchSimilar,
  onSubjectSearch,
}) => {
  const { t } = useTranslation()
  const filteredResults = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase()
    if (!needle) return results
    return results.filter((result) =>
      [result.path, result.sourceExt, result.projectDisplayType, ...(result.keywords ?? [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(needle),
    )
  }, [results, searchQuery])
  const rowHeight = 268
  const gap = 8
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
    itemCount: filteredResults.length,
    // A result card contains a 150px preview, metadata badges and five actions.
    // Below 240px those controls wrap or clip, so prefer fewer complete cards.
    minColumnWidth: 240,
    rowHeight,
    gap,
    resetToken: filteredResults,
  })
  const visibleResults = filteredResults.slice(startIndex, endIndex)
  const emptyState =
    rawResultCount > 0 && searchQuery.trim()
      ? {
          title: t('No visible image results'),
          description: t('Clear or change the name filter to show matching indexed images.'),
        }
      : rawResultCount === 0 && queryHash
        ? {
            title: t('No similar images found'),
            description: t('Try another query image or lower the similarity threshold.'),
          }
        : statusState === 'idle' && !queryHash
          ? {
              title: t('Prepare image search'),
              description: t(
                'Choose a folder, prepare the library, then search with an image or natural language.',
              ),
            }
          : {
              title: t('No image results yet'),
              description: t('Run an image or natural-language query to see results here.'),
            }

  return (
    <div
      ref={rootRef}
      data-testid="image-search-results"
      style={{ flex: 1, overflow: 'auto', padding: 4 }}
    >
      {filteredResults.length === 0 ? (
        <SearchEmptyState
          testId="image-search-empty-state"
          title={emptyState.title}
          description={emptyState.description}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {searchMetrics && (
            <div
              style={{
                fontSize: 9,
                opacity: 0.55,
                padding: '2px 6px',
                display: 'flex',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <span>
                {t('Search mode')}: {t(searchMetrics.searchMode || 'balanced')}
              </span>
              <span>
                {t('Index')}: {t(searchMetrics.indexType || 'linear')}
              </span>
              {searchMetrics.fallbackUsed && (
                <span style={{ color: 'rgb(255,200,100)' }}>{t('Fallback')}</span>
              )}
              {searchMetrics.bucketSize != null && (
                <span>
                  {t('Bucket')}: {searchMetrics.bucketSize.toLocaleString()}
                </span>
              )}
              <span>
                {t('Scan')}: {searchMetrics.scanned?.toLocaleString()}
              </span>
              <span>
                {t('Candidates')}: {searchMetrics.candidates?.toLocaleString()}
              </span>
              {searchMetrics.returned != null && (
                <span>
                  {t('Returned')}: {searchMetrics.returned.toLocaleString()}
                </span>
              )}
              {searchMetrics.fallbackCount != null && searchMetrics.fallbackCount > 0 && (
                <span>
                  {t('Fallback')}: {searchMetrics.fallbackCount.toLocaleString()}
                </span>
              )}
              <span>{searchMetrics.ms?.toFixed(1)}ms</span>
              <span>
                {t('Mode')}: {t(searchMetrics.mode || 'memory')}
              </span>
            </div>
          )}
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
                alignItems: 'start',
              }}
            >
              {visibleResults.map((r, visibleIndex) => {
                const ext = `.${(r.path.split('.').pop() || '').toLowerCase()}`
                return (
                  <div
                    key={`${r.id}\u0000${r.path}\u0000${startIndex + visibleIndex}`}
                    draggable={Boolean(r.dragToken)}
                    onDragStart={(event) => {
                      event.preventDefault()
                      if (r.dragToken) {
                        window.electronAPI.fileDrag.start(
                          r.dragToken,
                          event.shiftKey ? 'original' : 'compatible',
                        )
                      }
                    }}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                      padding: 6,
                      border: '1px solid rgba(var(--date),0.18)',
                      borderRadius: 3,
                      fontSize: 9,
                      alignItems: 'stretch',
                      minWidth: 0,
                      height: rowHeight,
                      boxSizing: 'border-box',
                      overflow: 'hidden',
                      background: 'rgba(var(--bg),0.16)',
                      cursor: r.dragToken ? 'grab' : 'default',
                    }}
                    title={`${r.path}\n${t(
                      r.dragUsesCompatibilityPreview
                        ? 'Drag a Photoshop-compatible preview; hold Shift to drag the original file'
                        : 'Drag to export the original file',
                    )}`}
                  >
                    <ThumbnailImage
                      deferLoading={isScrolling}
                      filePath={r.path}
                      ext={ext}
                      isDirectory={false}
                      loadPriority={10}
                      loadWhenRendered
                      targetSize={160}
                      viewMode="xlarge-icon"
                      style={{
                        width: 150,
                        height: 150,
                        alignSelf: 'center',
                      }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 500,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {r.path.split('\\').pop() || r.path}
                      </div>
                      {r.sourceKind === 'project' && (
                        <div
                          style={{
                            display: 'flex',
                            gap: 3,
                            marginTop: 3,
                            flexWrap: 'wrap',
                          }}
                          title={[
                            r.projectDisplayType,
                            ...(r.keywords ?? []).map((keyword) =>
                              PROJECT_KEYWORD_LABELS[keyword]
                                ? t(PROJECT_KEYWORD_LABELS[keyword])
                                : keyword,
                            ),
                            r.previewProvider
                              ? `${t('Preview provider')}: ${r.previewProvider}`
                              : undefined,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        >
                          {[r.sourceExt?.toUpperCase(), r.projectDisplayType]
                            .filter(Boolean)
                            .map((label) => (
                              <span
                                key={label}
                                style={{
                                  flex: '0 0 auto',
                                  padding: '1px 4px',
                                  borderRadius: 4,
                                  color: 'rgb(255,214,120)',
                                  background: 'rgba(255,190,70,0.13)',
                                  border: '1px solid rgba(255,190,70,0.3)',
                                }}
                              >
                                {label}
                              </span>
                            ))}
                          {(r.keywords ?? [])
                            .filter((keyword) => PROJECT_KEYWORD_LABELS[keyword])
                            .slice(0, 2)
                            .map((keyword) => (
                              <span
                                key={keyword}
                                style={{
                                  flex: '0 0 auto',
                                  padding: '1px 4px',
                                  borderRadius: 4,
                                  opacity: 0.72,
                                  background: 'rgba(var(--date),0.1)',
                                }}
                              >
                                {t(PROJECT_KEYWORD_LABELS[keyword])}
                              </span>
                            ))}
                        </div>
                      )}
                      <div
                        style={{
                          display: 'flex',
                          gap: 8,
                          opacity: 0.7,
                          marginTop: 1,
                          flexWrap: 'wrap',
                        }}
                      >
                        <span>{(r.score * 100).toFixed(1)}%</span>
                        {r.distance !== undefined && <span>d={r.distance}</span>}
                        {showExtendedScores && r._layered && (
                          <>
                            <span style={{ color: 'rgb(100,200,255)' }}>
                              V:{(r._layered.vectorScore * 100).toFixed(0)}%
                            </span>
                            <span style={{ color: 'rgb(255,200,100)' }}>
                              C:{(r._layered.colorScore * 100).toFixed(0)}%
                            </span>
                            <span style={{ color: 'rgb(200,255,100)' }}>
                              S:{(r._layered.shapeScore * 100).toFixed(0)}%
                            </span>
                          </>
                        )}
                        {showExtendedScores && r._layered?.matchLevel && (
                          <span style={{ opacity: 0.5 }}>{r._layered.matchLevel}</span>
                        )}
                        {r.width && r.height && (
                          <span>
                            {r.width}x{r.height}
                          </span>
                        )}
                        <span>{fmtBytes(r.fileSize)}</span>
                        {r.segmentId !== undefined && (
                          <span style={{ opacity: 0.5 }}>seg#{r.segmentId}</span>
                        )}
                        {r.diffHash64 && (
                          <span
                            style={{
                              fontFamily: 'Consolas, monospace',
                              fontSize: 8,
                              opacity: 0.4,
                            }}
                          >
                            {r.diffHash64.slice(0, 8)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
                        gap: 3,
                        flexShrink: 0,
                      }}
                    >
                      <button
                        onClick={() => onOpenFile(r.path)}
                        style={RESULT_ACTION_STYLE}
                        title={t('Open file')}
                      >
                        {t('Open')}
                      </button>
                      <button
                        onClick={() => onOpenFolder(r.path)}
                        style={RESULT_ACTION_STYLE}
                        title={t('Show in folder')}
                      >
                        {t('Folder')}
                      </button>
                      <button
                        onClick={() => onCopyPath(r.path)}
                        style={RESULT_ACTION_STYLE}
                        title={t('Copy path')}
                      >
                        {t('Copy')}
                      </button>
                      <button
                        onClick={() => onSearchSimilar(r.path)}
                        style={RESULT_ACTION_STYLE}
                        title={t('Use this result as the next query image')}
                      >
                        {t('Similar')}
                      </button>
                      <button
                        onClick={() => onSubjectSearch(r.path)}
                        disabled={r.sourceKind === 'project'}
                        style={RESULT_ACTION_STYLE}
                        title={
                          r.sourceKind === 'project'
                            ? t('Subject search for project files is not available yet')
                            : t('Search by subject (crop + DINOv2)')
                        }
                      >
                        {t('Subject')}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ImageSearchResultGrid
