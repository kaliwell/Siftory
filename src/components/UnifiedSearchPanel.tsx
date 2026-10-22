import React, { useEffect, useMemo, useRef, useState } from 'react'
import type {
  MediaPlayerHitContext,
  SubjectBBox,
  UnifiedSearchExportFormat,
  UnifiedSearchFeedbackKind,
  UnifiedSearchFilters,
  UnifiedSearchRequest,
  UnifiedSearchResponse,
  UnifiedSearchResultItem,
  UnifiedTimelineFrameRate,
} from '../../shared/ipc-contract'
import { useAssetCollections } from '../hooks/useAssetCollections'
import { useLinkedMove } from '../hooks/useLinkedMove'
import { useTranslation } from '../i18n/useTranslation'
import { announceFirstSearchCompleted } from '../services/firstRunGuide'
import { useStore } from '../stores/useStore'
import { DEFAULT_UNIFIED_SEARCH_H, DEFAULT_UNIFIED_SEARCH_W } from '../types'
import {
  unifiedDegradedLabelKey,
  unifiedEvidenceHitLabelKey,
  unifiedEvidenceModelLabel,
  unifiedFeedbackReasonLabelKey,
} from '../utils/unifiedSearchEvidence'
import {
  videoEvidenceSourceLabelKeys,
  videoHitEvidenceLabelKeys,
  videoHitLabelKey,
  videoHitModelLabel,
} from '../utils/unifiedVideoEvidence'
import ThumbnailImage from './filemanager/ThumbnailImage'
import DraggablePanel from './DraggablePanel'
import SearchEmptyState from './SearchEmptyState'
import SubjectPickerModal, { type SubjectPickerData } from './SubjectPickerModal'

type DurationFilter = '' | 'under-minute' | 'one-five' | 'five-thirty' | 'over-thirty'
const PAGE_SIZE = 100
// The main process bounds fused recall to 500 candidates.
const MAX_CANDIDATES = 500

function durationFilterBounds(
  value: DurationFilter,
): Pick<UnifiedSearchFilters, 'minDurationMs' | 'maxDurationMs'> {
  if (value === 'under-minute') return { maxDurationMs: 60_000 }
  if (value === 'one-five') return { minDurationMs: 60_000, maxDurationMs: 300_000 }
  if (value === 'five-thirty') return { minDurationMs: 300_000, maxDurationMs: 1_800_000 }
  if (value === 'over-thirty') return { minDurationMs: 1_800_000 }
  return {}
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`
}

function collectionInput(item: UnifiedSearchResultItem) {
  return {
    ...(item.assetId ? { assetId: item.assetId } : {}),
    fileEntryId: item.fileEntryId,
    mediaType: item.mediaType,
    displayName: item.displayName,
    displayPath: item.displayPath,
    sizeBytes: item.sizeBytes,
    modifiedAt: item.modifiedAt,
    ...(item.videoId ? { videoId: item.videoId } : {}),
    ...(item.videoHitMs !== undefined ? { videoHitMs: item.videoHitMs } : {}),
    source: item.source,
  }
}

function mediaPlayerHitContext(
  item: UnifiedSearchResultItem,
  searchText: string,
  selectedTimestampMs: number,
): MediaPlayerHitContext | undefined {
  if (!item.videoHits?.length) return undefined
  const hits = item.videoHits.slice(0, 32).map((hit) => ({
    startMs: hit.timestampMs,
    ...(hit.endMs !== undefined ? { endMs: hit.endMs } : {}),
    kind: hit.kind,
    ...(hit.text ? { text: hit.text } : {}),
    evidenceSources: [...hit.evidenceSources],
  }))
  let selectedIndex = 0
  let selectedDistance = Math.abs(hits[0].startMs - selectedTimestampMs)
  for (let index = 1; index < hits.length; index += 1) {
    const distance = Math.abs(hits[index].startMs - selectedTimestampMs)
    if (distance < selectedDistance) {
      selectedIndex = index
      selectedDistance = distance
    }
  }
  return {
    ...(searchText.trim() ? { query: searchText.trim() } : {}),
    selectedIndex,
    hits,
  }
}

const UnifiedSearchPanel: React.FC = () => {
  const { t } = useTranslation()
  const isVisible = useStore((state) => state.showUnifiedSearch)
  const position = useStore((state) => state.unifiedSearchPos)
  const size = useStore((state) => state.unifiedSearchSize)
  const setPosition = useStore((state) => state.setUnifiedSearchPos)
  const setSize = useStore((state) => state.setUnifiedSearchSize)
  const linkedMove = useStore((state) => state.linkedMove)
  const locked = useStore((state) => state.lockedPanels.unifiedSearch ?? false)
  const visibilityLocked = useStore((state) => state.lockedVisibility.unifiedSearch ?? false)
  const togglePanelLocked = useStore((state) => state.togglePanelLocked)
  const toggleVisibilityLock = useStore((state) => state.toggleVisibilityLock)
  const handleMove = useLinkedMove('unifiedSearch', position, setPosition, linkedMove)
  const { collectionId, collections, setCollectionId } = useAssetCollections()
  const [activeResultId, setActiveResultId] = useState('')
  const [query, setQuery] = useState('')
  const [referenceImagePath, setReferenceImagePath] = useState('')
  const [subject, setSubject] = useState<SubjectBBox | undefined>()
  const [segmentationSessionId, setSegmentationSessionId] = useState('')
  const [subjectPicker, setSubjectPicker] = useState<SubjectPickerData | null>(null)
  const [sourceId, setSourceId] = useState('')
  const [mediaType, setMediaType] = useState('')
  const [durationFilter, setDurationFilter] = useState<DurationFilter>('')
  const [orientation, setOrientation] = useState('')
  const [indexLevel, setIndexLevel] = useState('')
  const [modifiedAfter, setModifiedAfter] = useState('')
  const [modifiedBefore, setModifiedBefore] = useState('')
  const [sources, setSources] = useState<Array<{ id: string; displayName: string }>>([])
  const [resultSnapshot, setResponse] = useState<{
    request: UnifiedSearchRequest
    result: UnifiedSearchResponse
  } | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState(false)
  const [actionPending, setActionPending] = useState('')
  const [error, setError] = useState('')
  const [lastFeedback, setLastFeedback] = useState<{ id: string; label: string } | null>(null)
  const [exportStatus, setExportStatus] = useState('')
  const [timelineFrameRate, setTimelineFrameRate] = useState<UnifiedTimelineFrameRate>(25)
  const detailRef = useRef<HTMLElement | null>(null)
  const queryInputRef = useRef<HTMLInputElement | null>(null)
  const resultsPaneRef = useRef<HTMLElement | null>(null)
  const hasActiveFilters = Boolean(
    sourceId ||
    mediaType ||
    durationFilter ||
    orientation ||
    indexLevel ||
    modifiedAfter ||
    modifiedBefore,
  )
  const hasQuery = Boolean(query.trim() || referenceImagePath || hasActiveFilters)
  const searchRequest = useMemo<UnifiedSearchRequest>(() => {
    const afterTimestamp = modifiedAfter
      ? new Date(`${modifiedAfter}T00:00:00`).getTime()
      : undefined
    const beforeTimestamp = modifiedBefore
      ? new Date(`${modifiedBefore}T23:59:59.999`).getTime()
      : undefined
    const filters: UnifiedSearchFilters = {
      ...(mediaType ? { mediaTypes: [mediaType as 'image' | 'video' | 'audio' | 'file'] } : {}),
      ...(sourceId ? { sourceIds: [sourceId] } : {}),
      ...durationFilterBounds(durationFilter),
      ...(orientation
        ? { orientations: [orientation as 'landscape' | 'portrait' | 'square'] }
        : {}),
      ...(indexLevel ? { indexLevels: [indexLevel as 'metadata-only' | 'partial' | 'full'] } : {}),
      ...(afterTimestamp !== undefined ? { modifiedAfter: afterTimestamp } : {}),
      ...(beforeTimestamp !== undefined ? { modifiedBefore: beforeTimestamp } : {}),
    }
    return {
      ...(query.trim() ? { query: query.trim() } : {}),
      ...(referenceImagePath ? { referenceImagePath } : {}),
      ...(referenceImagePath && subject ? { subject } : {}),
      ...(referenceImagePath && subject && segmentationSessionId ? { segmentationSessionId } : {}),
      ...(sourceId ? { sourceId } : {}),
      ...(Object.keys(filters).length ? { filters } : {}),
      limit: MAX_CANDIDATES,
    }
  }, [
    durationFilter,
    indexLevel,
    mediaType,
    modifiedAfter,
    modifiedBefore,
    orientation,
    query,
    referenceImagePath,
    segmentationSessionId,
    sourceId,
    subject,
  ])
  const [page, setPage] = useState<{ criteria: UnifiedSearchRequest | null; offset: number }>({
    criteria: null,
    offset: 0,
  })
  const response = resultSnapshot?.request === searchRequest ? resultSnapshot.result : null
  const requestedOffset = page.criteria === searchRequest ? page.offset : 0
  const offset = response?.items.length
    ? Math.min(requestedOffset, Math.floor((response.items.length - 1) / PAGE_SIZE) * PAGE_SIZE)
    : 0

  const latestSearch = useRef(searchRequest)
  latestSearch.current = searchRequest

  useEffect(() => {
    if (!isVisible) return
    let cancelled = false
    void window.electronAPI.discoveryCatalog
      .listSources()
      .then((items) => {
        if (!cancelled) setSources(items.map(({ id, displayName }) => ({ id, displayName })))
      })
      .catch(() => {
        if (!cancelled) setSources([])
      })
    return () => {
      cancelled = true
    }
  }, [isVisible])

  useEffect(() => {
    const focusFirstSearch = () => {
      queryInputRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      queryInputRef.current?.focus()
    }
    window.addEventListener('workspace-first-search-focus', focusFirstSearch)
    return () => window.removeEventListener('workspace-first-search-focus', focusFirstSearch)
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!isVisible) {
      setPending(false)
      return
    }
    if (!hasQuery) {
      setResponse(null)
      setPending(false)
      return
    }
    setPending(true)
    setError('')
    const timer = window.setTimeout(() => {
      void window.electronAPI.unifiedSearch
        .query(searchRequest)
        .then((result) => {
          if (!cancelled) {
            setResponse({ request: searchRequest, result })
            announceFirstSearchCompleted('unified')
          }
        })
        .catch(() => {
          if (!cancelled) {
            setResponse(null)
            setError(t('The operation failed.'))
          }
        })
        .finally(() => {
          if (!cancelled) setPending(false)
        })
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [hasQuery, isVisible, searchRequest, t])

  const refineSubject = async () => {
    if (!referenceImagePath) return
    setActionPending('subject')
    setError('')
    try {
      const result = await window.electronAPI.subject.detect(referenceImagePath)
      if (!result.ok) throw new Error(result.error)
      setSubjectPicker({
        imagePath: referenceImagePath,
        width: result.width,
        height: result.height,
        subjects: result.subjects,
      })
    } catch {
      setError(t('Subject detection failed'))
    } finally {
      setActionPending('')
    }
  }

  // Keep one ranked snapshot; page changes never rerun model inference or reshuffle earlier pages.
  const results = useMemo(
    () => response?.items.slice(offset, offset + PAGE_SIZE) ?? [],
    [response, offset],
  )
  const changePage = (nextOffset: number) => {
    setPage({ criteria: searchRequest, offset: nextOffset })
    setActiveResultId('')
    setSelectedIds(new Set())
    resultsPaneRef.current?.scrollTo({ top: 0 })
  }

  useEffect(() => {
    const visible = new Set(results.map((item) => item.fileEntryId))
    setSelectedIds((current) => new Set([...current].filter((id) => visible.has(id))))
    void window.electronAPI.unifiedSearch
      .setVisiblePaths(
        isVisible
          ? results.filter((item) => item.source.type !== 'sftp').map((item) => item.displayPath)
          : [],
      )
      .catch(() => {})
  }, [isVisible, results])

  const runAction = async (key: string, action: () => Promise<void>) => {
    setActionPending(key)
    setError('')
    try {
      await action()
    } catch {
      setError(t('The operation failed.'))
    } finally {
      setActionPending('')
    }
  }

  const refreshSearch = async () => {
    const result = await window.electronAPI.unifiedSearch.query(searchRequest)
    if (latestSearch.current === searchRequest) setResponse({ request: searchRequest, result })
  }

  const saveSearchFeedback = (item: UnifiedSearchResultItem, kind: UnifiedSearchFeedbackKind) =>
    runAction(`feedback:${kind}:${item.fileEntryId}`, async () => {
      const timestampMs = kind === 'timestamp-wrong' ? item.videoHitMs : undefined
      const result = await window.electronAPI.unifiedSearch.saveFeedback({
        search: searchRequest,
        target: {
          fileEntryId: item.fileEntryId,
          ...(item.assetId ? { assetId: item.assetId } : {}),
          ...(item.videoId ? { videoId: item.videoId } : {}),
          ...(timestampMs !== undefined ? { timestampMs } : {}),
        },
        kind,
      })
      if (!result.ok || !result.feedbackId) throw new Error(result.error)
      setLastFeedback({ id: result.feedbackId, label: item.displayName })
      await refreshSearch()
    })

  const undoSearchFeedback = () => {
    if (!lastFeedback) return Promise.resolve()
    return runAction(`feedback:undo:${lastFeedback.id}`, async () => {
      const result = await window.electronAPI.unifiedSearch.undoFeedback(lastFeedback.id)
      if (!result.ok) throw new Error(result.error)
      setLastFeedback(null)
      await refreshSearch()
    })
  }

  const open = (item: UnifiedSearchResultItem) =>
    runAction(`open:${item.fileEntryId}`, async () => {
      if (item.source.type === 'sftp') {
        if (item.mediaType !== 'video') {
          await download(item)
          return
        }
        const timestampMs = item.videoHitMs ?? item.videoHits?.[0]?.timestampMs ?? 0
        const grant = await window.electronAPI.discoveryCatalog.createRemoteDownloadGrant(
          item.fileEntryId,
        )
        if (!grant.ok || !grant.token) throw new Error(grant.error)
        const prepared = await window.electronAPI.discoveryCatalog.prepareRemoteVideo(
          grant.token,
          timestampMs,
        )
        if (!prepared.ok || !prepared.videoId) throw new Error(prepared.error)
        const hitContext = mediaPlayerHitContext(item, query, timestampMs)
        const opened = await window.electronAPI.mediaSearch.openMediaAtTime({
          videoId: prepared.videoId,
          timestampMs: prepared.timestampMs ?? timestampMs,
          ...(hitContext ? { hitContext } : {}),
        })
        if (!opened.ok) throw new Error(opened.error)
        return
      }
      if (item.videoId) {
        const timestampMs = item.videoHitMs ?? item.videoHits?.[0]?.timestampMs ?? 0
        const hitContext = mediaPlayerHitContext(item, query, timestampMs)
        const result = await window.electronAPI.mediaSearch.openMediaAtTime({
          videoId: item.videoId,
          timestampMs,
          ...(hitContext ? { hitContext } : {}),
        })
        if (!result.ok) throw new Error(result.error)
        return
      }
      const result = await window.electronAPI.assetIdentity.openOriginal(
        item.assetId || item.displayPath,
      )
      if (!result.ok) throw new Error(result.error)
    })

  const reveal = (item: UnifiedSearchResultItem) =>
    runAction(`reveal:${item.fileEntryId}`, async () => {
      const result = await window.electronAPI.assetIdentity.revealOriginal(
        item.assetId || item.displayPath,
      )
      if (!result.ok) throw new Error(result.error)
    })

  const collect = (items: UnifiedSearchResultItem[]) =>
    runAction('collect', async () => {
      if (!collectionId || items.length === 0) return
      await window.electronAPI.assetLibrary.addCollectionItems(
        collectionId,
        items.slice(0, 500).map(collectionInput),
      )
    })

  const exportSelected = (format: UnifiedSearchExportFormat) =>
    runAction(`export:${format}`, async () => {
      const items = results.filter((item) => selectedIds.has(item.fileEntryId)).slice(0, 500)
      if (!items.length) return
      const result = await window.electronAPI.unifiedSearch.exportResults({
        format,
        search: searchRequest,
        items,
        ...(format === 'edl' || format === 'fcpxml' ? { frameRate: timelineFrameRate } : {}),
      })
      if (!result.ok) {
        if (result.error === 'cancelled') return
        throw new Error(result.error)
      }
      setExportStatus(
        format === 'edl' || format === 'fcpxml'
          ? t('{count} clips exported; {clamped} clamped; {skipped} skipped', {
              count: result.exportedCount ?? 0,
              clamped: result.clampedCount ?? 0,
              skipped: result.skippedCount ?? 0,
            })
          : t('{count} results exported', { count: result.exportedCount ?? items.length }),
      )
    })

  const download = async (item: UnifiedSearchResultItem) => {
    const grant = await window.electronAPI.discoveryCatalog.createRemoteDownloadGrant(
      item.fileEntryId,
    )
    if (!grant.ok || !grant.token) throw new Error(grant.error)
    const directory = await window.electronAPI.remoteTerminal.chooseDownloadDirectory()
    if (!directory.ok || !directory.token) return
    const queued = await window.electronAPI.remoteTerminal.enqueueCatalogDownload(
      grant.token,
      directory.token,
      'rename',
    )
    if (!queued.ok) throw new Error(queued.error)
  }

  useEffect(() => {
    if (activeResultId && isVisible) detailRef.current?.focus({ preventScroll: true })
  }, [activeResultId, isVisible])

  const activeResult = results.find((item) => item.fileEntryId === activeResultId)
  const renderDetails = (item: UnifiedSearchResultItem) => (
    <div className="unified-search-detail-content">
      <div className="unified-search-result-heading">
        <strong className="unified-search-result-name">{item.displayName}</strong>
        <span className="unified-search-result-meta">
          {formatBytes(item.sizeBytes)} · {item.source.name} · {item.mediaType}
        </span>
        <span className="unified-search-result-actions">
          <button
            data-testid="unified-result-open"
            disabled={Boolean(actionPending)}
            onClick={() => void open(item)}
          >
            {t('Open')}
          </button>
          {item.source.type !== 'sftp' ? (
            <button
              data-testid="unified-result-reveal"
              disabled={Boolean(actionPending)}
              onClick={() => void reveal(item)}
            >
              {t('Folder')}
            </button>
          ) : null}
          {item.source.type === 'sftp' ? (
            <button
              data-testid="unified-result-download"
              disabled={Boolean(actionPending)}
              onClick={() => void runAction(`download:${item.fileEntryId}`, () => download(item))}
            >
              {t('Download')}
            </button>
          ) : null}
          <button
            data-testid="unified-result-collect"
            disabled={!collectionId || Boolean(actionPending)}
            onClick={() => void collect([item])}
          >
            {t('Collect')}
          </button>
        </span>
      </div>
      <div
        title={item.displayPath}
        className="unified-search-result-path"
        style={{
          opacity: 0.55,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {item.displayPath}
      </div>
      <div className="unified-search-feedback-row">
        <button
          data-testid="unified-search-feedback-relevant"
          disabled={Boolean(actionPending)}
          onClick={() => void saveSearchFeedback(item, 'relevant')}
        >
          {t('Relevant')}
        </button>
        <button
          data-testid="unified-search-feedback-irrelevant"
          disabled={Boolean(actionPending)}
          onClick={() => void saveSearchFeedback(item, 'irrelevant')}
        >
          {t('Not relevant')}
        </button>
        {item.videoHitMs !== undefined ? (
          <button
            data-testid="unified-search-feedback-timestamp"
            disabled={Boolean(actionPending)}
            onClick={() => void saveSearchFeedback(item, 'timestamp-wrong')}
          >
            {t('Wrong hit time')}
          </button>
        ) : null}
        {item.rankingFeedback ? (
          <span data-testid="unified-search-feedback-explanation">
            {t(unifiedFeedbackReasonLabelKey(item.rankingFeedback))} ·{' '}
            {item.rankingFeedback.adjustment >= 0 ? '+' : ''}
            {item.rankingFeedback.adjustment.toFixed(2)}
          </span>
        ) : null}
      </div>
      {item.evidence?.length ? (
        <div className="unified-search-evidence-list">
          {item.evidence.map((evidence, index) => {
            const model = unifiedEvidenceModelLabel(evidence)
            const sources = videoEvidenceSourceLabelKeys(evidence.evidenceSources ?? []).map(
              (key) => t(key),
            )
            const timeRange =
              evidence.startMs === undefined
                ? ''
                : evidence.endMs !== undefined && evidence.endMs > evidence.startMs
                  ? `${formatDuration(evidence.startMs)}–${formatDuration(evidence.endMs)}`
                  : formatDuration(evidence.startMs)
            return (
              <div
                key={`${evidence.lane}:${evidence.hitType}:${evidence.startMs ?? index}:${index}`}
                data-testid="unified-search-evidence-card"
                className="unified-search-evidence-card"
              >
                <div className="unified-search-evidence-heading">
                  <strong>{t(unifiedEvidenceHitLabelKey(evidence))}</strong>
                  {timeRange ? (
                    <span>
                      {t('Time range')}: {timeRange}
                    </span>
                  ) : null}
                  {evidence.confidence !== undefined ? (
                    <span>
                      {t('Confidence')}:{' '}
                      {Math.round(Math.max(0, Math.min(1, evidence.confidence)) * 100)}%
                    </span>
                  ) : null}
                </div>
                <div className="unified-search-evidence-summary" title={evidence.summary}>
                  {evidence.summary}
                </div>
                <div className="unified-search-evidence-meta">
                  <span>
                    {t('Model source')}: {model ?? t('Metadata or rules')}
                  </span>
                  {sources.length ? (
                    <span>
                      {t('Evidence')}: {sources.join(' + ')}
                    </span>
                  ) : null}
                </div>
              </div>
            )
          })}
          {item.degradedReason ? (
            <div className="unified-search-evidence-degraded">
              {t('Degraded')}: {t(unifiedDegradedLabelKey(item.degradedReason))}
            </div>
          ) : null}
        </div>
      ) : null}
      {item.videoId && item.videoHits?.length ? (
        <div
          data-testid="unified-video-evidence"
          style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}
        >
          {item.videoHits.map((hit, index) => {
            const evidence = videoHitEvidenceLabelKeys(hit).map((key) => t(key))
            const model = videoHitModelLabel(hit)
            return (
              <button
                key={`${hit.kind}:${hit.timestampMs}:${hit.frameId ?? index}`}
                data-testid="unified-video-hit"
                disabled={Boolean(actionPending)}
                title={[hit.text, `${t('Evidence')}: ${evidence.join(' + ')}`, model]
                  .filter(Boolean)
                  .join('\n')}
                onClick={() =>
                  void runAction(`seek:${item.fileEntryId}:${hit.timestampMs}`, async () => {
                    const result = await window.electronAPI.mediaSearch.openMediaAtTime({
                      videoId: item.videoId!,
                      timestampMs: hit.timestampMs,
                      hitContext: mediaPlayerHitContext(item, query, hit.timestampMs)!,
                    })
                    if (!result.ok) throw new Error(result.error)
                  })
                }
                style={{ fontSize: 10, padding: '1px 5px' }}
              >
                {t(videoHitLabelKey(hit))} · {formatDuration(hit.timestampMs)} · {t('Evidence')}:{' '}
                {evidence.join(' + ')}
                {model ? ` · ${t('AI generated')}: ${model}` : ''}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )

  return (
    <DraggablePanel
      panelId="unifiedSearch"
      title="Unified Search"
      displayTitle={t('Unified search')}
      dataPanel="unified-search"
      x={position.x}
      y={position.y}
      defaultX={240}
      defaultY={80}
      w={size.w}
      h={size.h}
      defaultW={DEFAULT_UNIFIED_SEARCH_W}
      defaultH={DEFAULT_UNIFIED_SEARCH_H}
      onMove={handleMove}
      onResize={setSize}
      locked={locked}
      onToggleLock={() => togglePanelLocked('unifiedSearch')}
      visibilityLocked={visibilityLocked}
      onToggleVisibilityLock={() => toggleVisibilityLock('unifiedSearch')}
    >
      <div
        className="split-tool-shell unified-search-shell"
        data-testid="unified-search-page"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault()
        }}
        onDrop={(event) => {
          event.preventDefault()
          const file = event.dataTransfer.files[0]
          if (!file || !file.type.startsWith('image/')) return
          try {
            const path = window.electronAPI.getPathForFile(file)
            if (path) {
              setReferenceImagePath(path)
              setSubject(undefined)
              setSegmentationSessionId('')
            }
          } catch {
            setError(t('The operation failed.'))
          }
        }}
        style={{
          padding: 6,
        }}
      >
        <div className="split-tool-workspace unified-search-workspace">
          <aside className="split-tool-control-pane unified-search-control-pane">
            <div
              className="unified-search-toolbar"
              style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}
            >
              <input
                ref={queryInputRef}
                data-testid="unified-search-query"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('Search by name or describe an image')}
                autoFocus
                style={{ flex: '1 1 260px' }}
              />
              <select
                data-testid="unified-search-source-filter"
                value={sourceId}
                onChange={(event) => setSourceId(event.target.value)}
                aria-label={t('Sources')}
              >
                <option value="">{t('All sources')}</option>
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.displayName}
                  </option>
                ))}
              </select>
              <button
                data-testid="unified-search-reference"
                onClick={() =>
                  void window.electronAPI.imageSearch.selectImage().then((path) => {
                    if (!path) return
                    setReferenceImagePath(path)
                    setSubject(undefined)
                    setSegmentationSessionId('')
                  })
                }
              >
                {t('Reference image')}
              </button>
              <button
                data-testid="unified-search-paste-image"
                onClick={() =>
                  void runAction('paste', async () => {
                    const result = await window.electronAPI.imageSearch.pasteClipboardImage()
                    if (!result.ok || !result.path) throw new Error(result.error)
                    setReferenceImagePath(result.path)
                    setSubject(undefined)
                    setSegmentationSessionId('')
                  })
                }
              >
                {t('Paste image')}
              </button>
              {referenceImagePath ? (
                <button
                  data-testid="unified-search-refine-subject"
                  disabled={Boolean(actionPending)}
                  onClick={() => void refineSubject()}
                >
                  {t('Refine subject on the original image')}
                </button>
              ) : null}
              {referenceImagePath ? (
                <button
                  onClick={() => {
                    setReferenceImagePath('')
                    setSubject(undefined)
                    setSegmentationSessionId('')
                  }}
                >
                  {t('Remove')}
                </button>
              ) : null}
            </div>
            <details className="unified-search-more">
              <summary>{t('Collections and export')}</summary>
              <div className="unified-search-more__content">
                <select
                  data-testid="unified-search-collection-select"
                  value={collectionId}
                  onChange={(event) => setCollectionId(Number(event.target.value))}
                >
                  <option value={0}>{t('Select collection')}</option>
                  {collections.map((collection) => (
                    <option key={collection.id} value={collection.id}>
                      {collection.name}
                    </option>
                  ))}
                </select>
                <button
                  data-testid="unified-search-collect-selected"
                  disabled={!collectionId || selectedIds.size === 0 || Boolean(actionPending)}
                  onClick={() =>
                    void collect(results.filter((item) => selectedIds.has(item.fileEntryId)))
                  }
                >
                  {t('Collect selected')} ({selectedIds.size})
                </button>
                <button
                  data-testid="unified-search-export-json"
                  disabled={selectedIds.size === 0 || Boolean(actionPending)}
                  onClick={() => void exportSelected('json')}
                >
                  {t('Export JSON')}
                </button>
                <button
                  data-testid="unified-search-export-csv"
                  disabled={selectedIds.size === 0 || Boolean(actionPending)}
                  onClick={() => void exportSelected('csv')}
                >
                  {t('Export CSV')}
                </button>
                <select
                  data-testid="unified-search-timeline-frame-rate"
                  value={timelineFrameRate}
                  onChange={(event) =>
                    setTimelineFrameRate(Number(event.target.value) as UnifiedTimelineFrameRate)
                  }
                  aria-label={t('Timeline frame rate')}
                >
                  {[23.976, 24, 25, 29.97, 30, 50, 59.94, 60].map((frameRate) => (
                    <option key={frameRate} value={frameRate}>
                      {t('{rate} fps', { rate: frameRate })}
                    </option>
                  ))}
                </select>
                <button
                  data-testid="unified-search-export-edl"
                  disabled={selectedIds.size === 0 || Boolean(actionPending)}
                  onClick={() => void exportSelected('edl')}
                >
                  {t('Export EDL')}
                </button>
                <button
                  data-testid="unified-search-export-fcpxml"
                  disabled={selectedIds.size === 0 || Boolean(actionPending)}
                  onClick={() => void exportSelected('fcpxml')}
                >
                  {t('Export FCPXML')}
                </button>
                {exportStatus ? (
                  <span data-testid="unified-search-export-status">{exportStatus}</span>
                ) : null}
              </div>
            </details>
            <div
              className="unified-search-filters"
              data-testid="unified-search-filters"
              style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}
            >
              <select
                data-testid="unified-search-media-filter"
                value={mediaType}
                onChange={(event) => setMediaType(event.target.value)}
                aria-label={t('Media type')}
              >
                <option value="">{t('All media')}</option>
                <option value="image">{t('Images')}</option>
                <option value="video">{t('Videos')}</option>
                <option value="audio">{t('Audio')}</option>
                <option value="file">{t('Other files')}</option>
              </select>
              <select
                data-testid="unified-search-duration-filter"
                value={durationFilter}
                onChange={(event) => setDurationFilter(event.target.value as DurationFilter)}
                aria-label={t('Duration')}
              >
                <option value="">{t('All durations')}</option>
                <option value="under-minute">{t('Under 1 minute')}</option>
                <option value="one-five">{t('1 to 5 minutes')}</option>
                <option value="five-thirty">{t('5 to 30 minutes')}</option>
                <option value="over-thirty">{t('Over 30 minutes')}</option>
              </select>
              <select
                data-testid="unified-search-orientation-filter"
                value={orientation}
                onChange={(event) => setOrientation(event.target.value)}
                aria-label={t('Orientation')}
              >
                <option value="">{t('All orientations')}</option>
                <option value="landscape">{t('Landscape')}</option>
                <option value="portrait">{t('Portrait')}</option>
                <option value="square">{t('Square')}</option>
              </select>
              <select
                data-testid="unified-search-index-filter"
                value={indexLevel}
                onChange={(event) => setIndexLevel(event.target.value)}
                aria-label={t('Index readiness')}
              >
                <option value="">{t('All index states')}</option>
                <option value="metadata-only">{t('Metadata only')}</option>
                <option value="partial">{t('Partial AI index')}</option>
                <option value="full">{t('Full AI index')}</option>
              </select>
              <label>
                {t('From date')}
                <input
                  type="date"
                  value={modifiedAfter}
                  onChange={(event) => setModifiedAfter(event.target.value)}
                />
              </label>
              <label>
                {t('To date')}
                <input
                  type="date"
                  value={modifiedBefore}
                  onChange={(event) => setModifiedBefore(event.target.value)}
                />
              </label>
              <button
                disabled={!hasActiveFilters}
                onClick={() => {
                  setSourceId('')
                  setMediaType('')
                  setDurationFilter('')
                  setOrientation('')
                  setIndexLevel('')
                  setModifiedAfter('')
                  setModifiedBefore('')
                }}
              >
                {t('Clear filters')}
              </button>
            </div>
            {referenceImagePath ? (
              <div style={{ display: 'flex', gap: 5, opacity: 0.65 }}>
                {subject ? (
                  <span data-testid="unified-search-subject">
                    {t('Subject')}: {subject.label}
                    {segmentationSessionId ? ` · ${t('Fine mask')}` : ''}
                  </span>
                ) : null}
                <span
                  title={referenceImagePath}
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {referenceImagePath}
                </span>
              </div>
            ) : null}
            {response?.degradedReason ? (
              <div
                data-testid="unified-search-degraded"
                title={response.actionableHint}
                style={{ color: '#e3b45f' }}
              >
                {response.degradedReason}
                {response.actionableHint ? ` · ${response.actionableHint}` : ''}
              </div>
            ) : null}
            {error ? (
              <div data-testid="unified-search-error" style={{ color: '#ff8a8a' }}>
                {error}
              </div>
            ) : null}
            <div style={{ opacity: 0.65 }} role="status">
              {pending
                ? t('Searching...')
                : hasQuery
                  ? t('{count} results total', { count: response?.total ?? 0 })
                  : t('Search all indexed sources from one place.')}
            </div>
            {hasQuery && (
              <div className="unified-search-pagination" aria-label={t('Search pages')}>
                <button
                  data-testid="unified-search-previous-page"
                  disabled={pending || offset === 0}
                  onClick={() => changePage(Math.max(0, offset - PAGE_SIZE))}
                >
                  {t('Previous')}
                </button>
                <span data-testid="unified-search-page-range">
                  {t('Showing {start}–{end} of {total}', {
                    start: results.length ? offset + 1 : 0,
                    end: results.length ? offset + results.length : 0,
                    total: response?.total ?? 0,
                  })}
                </span>
                <button
                  data-testid="unified-search-next-page"
                  disabled={
                    pending ||
                    results.length < PAGE_SIZE ||
                    offset + PAGE_SIZE >= (response?.items.length ?? 0)
                  }
                  onClick={() => changePage(offset + PAGE_SIZE)}
                >
                  {t('Next')}
                </button>
                {(response?.total ?? 0) > MAX_CANDIDATES && (
                  <small>
                    {t('Showing up to 500 candidates. Refine your search to see more.')}
                  </small>
                )}
              </div>
            )}
          </aside>
          <div className="unified-search-content">
            <main
              ref={resultsPaneRef}
              className="split-tool-results-pane unified-search-results-pane"
            >
              <div className="unified-search-results">
                {lastFeedback ? (
                  <div
                    data-testid="unified-search-feedback-undo"
                    className="unified-search-feedback-undo"
                  >
                    <span>
                      {t('Feedback saved locally')}: {lastFeedback.label}
                    </span>
                    <button
                      disabled={Boolean(actionPending)}
                      onClick={() => void undoSearchFeedback()}
                    >
                      {t('Undo')}
                    </button>
                  </div>
                ) : null}
                <div className="unified-search-grid">
                  {results.map((item) => (
                    <article
                      key={item.fileEntryId}
                      data-testid="unified-search-result"
                      className="unified-search-tile"
                      data-active={activeResultId === item.fileEntryId}
                    >
                      <input
                        type="checkbox"
                        aria-label={t('Select result')}
                        checked={selectedIds.has(item.fileEntryId)}
                        onChange={(event) => {
                          const checked = event.target.checked
                          setSelectedIds((current) => {
                            const next = new Set(current)
                            if (checked) next.add(item.fileEntryId)
                            else next.delete(item.fileEntryId)
                            return next
                          })
                        }}
                      />
                      <button
                        className="unified-search-tile__preview"
                        aria-pressed={activeResultId === item.fileEntryId}
                        onClick={() => setActiveResultId(item.fileEntryId)}
                        onDoubleClick={() => {
                          if (!actionPending) void open(item)
                        }}
                      >
                        {item.source.type !== 'sftp' ? (
                          <ThumbnailImage
                            filePath={item.displayPath}
                            ext={'.' + (item.displayName.split('.').pop() ?? '')}
                            isDirectory={false}
                            viewMode="thumbnail-grid"
                            style={{ height: 150, width: '100%' }}
                          />
                        ) : (
                          <span className="unified-search-tile__remote">{t('Remote file')}</span>
                        )}
                        <strong title={item.displayName}>{item.displayName}</strong>
                        <span>
                          {item.mediaType} · {formatBytes(item.sizeBytes)}
                        </span>
                      </button>
                    </article>
                  ))}
                </div>
                {!hasQuery && !pending ? (
                  <SearchEmptyState
                    testId="unified-search-empty-state"
                    title={t('Search all indexed sources')}
                    description={t(
                      'Enter natural language, a file name, or choose a reference image to begin.',
                    )}
                  />
                ) : hasQuery && !pending && results.length === 0 ? (
                  <SearchEmptyState
                    testId="unified-search-empty-state"
                    title={t('No results')}
                    description={t('Try clearing filters or use a broader query.')}
                  />
                ) : null}
              </div>
            </main>
            {activeResult && (
              <aside
                ref={detailRef}
                tabIndex={-1}
                className="unified-search-detail"
                aria-label={t('Details')}
              >
                <button
                  className="unified-search-detail__close"
                  onClick={() => setActiveResultId('')}
                >
                  {t('Close')}
                </button>
                {activeResult.source.type !== 'sftp' && (
                  <ThumbnailImage
                    filePath={activeResult.displayPath}
                    ext={'.' + (activeResult.displayName.split('.').pop() ?? '')}
                    isDirectory={false}
                    viewMode="xlarge-icon"
                    targetSize={512}
                    style={{ height: 240, width: '100%' }}
                  />
                )}
                {renderDetails(activeResult)}
              </aside>
            )}
          </div>
        </div>
      </div>
      {subjectPicker ? (
        <SubjectPickerModal
          data={subjectPicker}
          onPick={(selected) => {
            setSubject(selected)
            setSegmentationSessionId('')
            setSubjectPicker(null)
          }}
          onSegment={(bbox, sessionId) => {
            setSubject({ ...bbox, confidence: 1, label: 'sam' })
            setSegmentationSessionId(sessionId)
            setSubjectPicker(null)
          }}
          onAuto={() => {
            setSubject(undefined)
            setSegmentationSessionId('')
            setSubjectPicker(null)
          }}
          onCancel={() => setSubjectPicker(null)}
        />
      ) : null}
    </DraggablePanel>
  )
}

export default UnifiedSearchPanel
