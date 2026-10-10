import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AssetFeedbackModelStatus,
  AssetCategory,
  AssetLibraryClusterSummary,
  AssetLibraryStats,
  AssetLibrarySuggestionItem,
  AssetLibraryTaskProgress,
  AssetLibraryTaskResult,
  AssetSmartAlbum,
  AssetSmartAlbumRules,
  AssetTag,
} from '../../shared/ipc-contract'
import { useStore } from '../stores/useStore'
import { useLinkedMove } from '../hooks/useLinkedMove'
import { DEFAULT_ASSET_LIBRARY_H, DEFAULT_ASSET_LIBRARY_W } from '../types'
import DraggablePanel from './DraggablePanel'
import AssetLibraryBackupView from './assetLibrary/AssetLibraryBackupView'
import AssetLibraryAssetsView from './assetLibrary/AssetLibraryAssetsView'
import AssetLibraryCategoryDetailView from './assetLibrary/AssetLibraryCategoryDetailView'
import AssetLibraryCategorySidebar from './assetLibrary/AssetLibraryCategorySidebar'
import AssetLibraryClusterControls from './assetLibrary/AssetLibraryClusterControls'
import AssetLibraryClusterGrid from './assetLibrary/AssetLibraryClusterGrid'
import AssetLibraryHeader from './assetLibrary/AssetLibraryHeader'
import AssetLibraryModeTabs from './assetLibrary/AssetLibraryModeTabs'
import AssetLibrarySearchResultsView from './assetLibrary/AssetLibrarySearchResultsView'
import AssetLibrarySuggestionsView from './assetLibrary/AssetLibrarySuggestionsView'
import AssetLibraryTagsView from './assetLibrary/AssetLibraryTagsView'
import useAssetLibraryBackups from './assetLibrary/useAssetLibraryBackups'
import useAssetLibraryAssets from './assetLibrary/useAssetLibraryAssets'
import useAssetLibrarySearches from './assetLibrary/useAssetLibrarySearches'
import useAssetLibraryTaxonomy from './assetLibrary/useAssetLibraryTaxonomy'
import { useTranslation } from '../i18n/useTranslation'
import {
  assetLibraryErrorMessage as errorMessage,
  buildAssetCategoryRows as categoryRows,
  EMPTY_ASSET_FEEDBACK_STATUS as EMPTY_FEEDBACK_STATUS,
  EMPTY_ASSET_LIBRARY_STATS as EMPTY_STATS,
  formatAssetLibraryNumber as formatNumber,
  type AssetLibraryMode as LibraryMode,
  type AssetLibraryReviewMode as ReviewMode,
  type AssetLibraryViewMode as ViewMode,
} from './assetLibrary/assetLibraryViewUtils'

const AssetLibraryPanel: React.FC = () => {
  const { t } = useTranslation()
  const assetLibraryPos = useStore((state) => state.assetLibraryPos)
  const assetLibrarySize = useStore((state) => state.assetLibrarySize)
  const setAssetLibraryPos = useStore((state) => state.setAssetLibraryPos)
  const setAssetLibrarySize = useStore((state) => state.setAssetLibrarySize)
  const linkedMove = useStore((state) => state.linkedMove)
  const locked = useStore((state) => state.lockedPanels.assetLibrary ?? false)
  const visibilityLocked = useStore((state) => state.lockedVisibility.assetLibrary ?? false)
  const togglePanelLocked = useStore((state) => state.togglePanelLocked)
  const toggleVisibilityLock = useStore((state) => state.toggleVisibilityLock)
  const manifestPath = useStore((state) => state.manifestPath)
  const handleMove = useLinkedMove('assetLibrary', assetLibraryPos, setAssetLibraryPos, linkedMove)

  const [view, setView] = useState<ViewMode>('library')
  const [libraryMode, setLibraryMode] = useState<LibraryMode>('assets')
  const [reviewMode, setReviewMode] = useState<ReviewMode>('suggestions')
  const [stats, setStats] = useState<AssetLibraryStats>(EMPTY_STATS)
  const [feedbackStatus, setFeedbackStatus] =
    useState<AssetFeedbackModelStatus>(EMPTY_FEEDBACK_STATUS)
  const [categories, setCategories] = useState<AssetCategory[]>([])
  const [tags, setTags] = useState<AssetTag[]>([])
  const [smartAlbums, setSmartAlbums] = useState<AssetSmartAlbum[]>([])
  const [selectedSmartAlbumId, setSelectedSmartAlbumId] = useState(0)
  const [smartAlbumName, setSmartAlbumName] = useState('')
  const [smartAlbumBusy, setSmartAlbumBusy] = useState(false)
  const [suggestions, setSuggestions] = useState<AssetLibrarySuggestionItem[]>([])
  const [suggestionTotal, setSuggestionTotal] = useState(0)
  const [suggestionOffset, setSuggestionOffset] = useState(0)
  const [clusters, setClusters] = useState<AssetLibraryClusterSummary[]>([])
  const [clusterTypeFilter, setClusterTypeFilter] = useState<
    'all' | 'visual' | 'duplicate' | 'other'
  >('all')
  const filteredClusters = useMemo(() => {
    switch (clusterTypeFilter) {
      case 'visual':
        return clusters.filter((c) => c.group.algorithm === 'compressed_kmeans')
      case 'duplicate':
        return clusters.filter(
          (c) => c.group.algorithm === 'duplicate_exact' || c.group.algorithm === 'duplicate_near',
        )
      case 'other':
        return clusters.filter(
          (c) =>
            c.group.algorithm !== 'compressed_kmeans' &&
            c.group.algorithm !== 'duplicate_exact' &&
            c.group.algorithm !== 'duplicate_near',
        )
      default:
        return clusters
    }
  }, [clusters, clusterTypeFilter])
  const [task, setTask] = useState<AssetLibraryTaskProgress | null>(null)
  const [error, setError] = useState('')

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [armedDuplicateId, setArmedDuplicateId] = useState<number | null>(null)
  const [selectedClusterIds, setSelectedClusterIds] = useState<Set<number>>(new Set())
  const [memberSelection, setMemberSelection] = useState<{
    groupId: number
    assetIds: Set<number>
  } | null>(null)
  const [suggestionStatus, setSuggestionStatus] = useState<
    'suggested' | 'low_confidence' | 'confirmed' | 'rejected' | 'ignored'
  >('suggested')
  const [suggestionSource, setSuggestionSource] = useState<
    'all' | 'reference_image' | 'text_label'
  >('all')
  const [clusterCount, setClusterCount] = useState(96)
  const [clusterAutoCount, setClusterAutoCount] = useState(true)
  const [clusterMinSize, setClusterMinSize] = useState(5)
  const [clusterMinSimilarity, setClusterMinSimilarity] = useState(0.76)
  const [clusterSemanticRefine, setClusterSemanticRefine] = useState(true)
  const [clusterSemanticSimilarity, setClusterSemanticSimilarity] = useState(0.86)
  const [clusterSemanticMaxSplits, setClusterSemanticMaxSplits] = useState(4)
  const [clusterScopePaths, setClusterScopePaths] = useState<string[]>([])
  const [clusterCategoryId, setClusterCategoryId] = useState(0)
  const [clusterCategoryTopK, setClusterCategoryTopK] = useState(500)
  const [clusterCategoryMinScore, setClusterCategoryMinScore] = useState(0.55)
  const [clusterCategoryIncludeReviewed, setClusterCategoryIncludeReviewed] = useState(false)
  const suggestionRequestId = useRef(0)
  const clusterRequestId = useRef(0)
  const suggestionMutationRef = useRef<number | null>(null)
  const [suggestionMutationId, setSuggestionMutationId] = useState<number | null>(null)

  const rows = useMemo(() => categoryRows(categories), [categories])
  const activeTask = task?.state === 'running'
  const suggestionPageSize = 100
  const clusteredAssetCount = useMemo(
    () =>
      clusters
        .filter((item) => item.group.algorithm === 'compressed_kmeans')
        .reduce((sum, item) => sum + item.group.assetCount, 0),
    [clusters],
  )

  const refreshBase = useCallback(async () => {
    const [nextStats, nextCategories, nextTags, nextFeedbackStatus, nextSmartAlbums] =
      await Promise.all([
        window.electronAPI.assetLibrary.getStats(),
        window.electronAPI.assetLibrary.listCategories(),
        window.electronAPI.assetLibrary.listTags(),
        window.electronAPI.assetLibrary.getFeedbackStatus(),
        window.electronAPI.assetLibrary.listSmartAlbums(),
      ])
    setStats(nextStats)
    setCategories(nextCategories)
    setTags(nextTags)
    setFeedbackStatus(nextFeedbackStatus)
    setSmartAlbums(nextSmartAlbums)
  }, [])

  const {
    pageSize,
    assets,
    total: assetTotal,
    loading,
    query,
    categoryFilter,
    tagFilter,
    unclassifiedOnly,
    archivedOnly,
    sourceFilter,
    kindFilter,
    modifiedAfter,
    modifiedBefore,
    minRating,
    favoriteOnly,
    sort,
    offset,
    batchCategoryId,
    batchTagId,
    lastArchivedIds,
    setQuery,
    setCategoryFilter,
    setTagFilter,
    setUnclassifiedOnly,
    setArchivedOnly,
    setSourceFilter,
    setKindFilter,
    setModifiedAfter,
    setModifiedBefore,
    setMinRating,
    setFavoriteOnly,
    setSort,
    setOffset,
    setBatchCategoryId,
    setBatchTagId,
    load: loadAssets,
    setSelectionForIds,
    assignCategory,
    assignTag,
    archiveSelected,
    restoreSelected,
    undoLastArchive,
    setSelectedUserMetadata,
    applySmartAlbum,
    reset: resetAssets,
  } = useAssetLibraryAssets({
    active: view === 'library' && libraryMode === 'assets',
    selectedIds,
    setSelectedIds,
    setError,
    refreshBase,
  })

  const currentSmartAlbumRules = useCallback(
    (): AssetSmartAlbumRules => ({
      sort,
      ...(query.trim() ? { query: query.trim() } : {}),
      ...(categoryFilter > 0 ? { categoryId: categoryFilter } : {}),
      ...(tagFilter > 0 ? { tagId: tagFilter } : {}),
      ...(unclassifiedOnly ? { unclassified: true } : {}),
      ...(archivedOnly ? { archivedOnly: true } : {}),
      ...(sourceFilter !== 'all' ? { source: sourceFilter } : {}),
      ...(kindFilter !== 'all' ? { kind: kindFilter } : {}),
      ...(modifiedAfter > 0 ? { modifiedAfter } : {}),
      ...(modifiedBefore > 0 ? { modifiedBefore } : {}),
      ...(minRating > 0 ? { minRating } : {}),
      ...(favoriteOnly ? { favoriteOnly: true } : {}),
    }),
    [
      archivedOnly,
      categoryFilter,
      kindFilter,
      modifiedAfter,
      modifiedBefore,
      minRating,
      favoriteOnly,
      query,
      sort,
      sourceFilter,
      tagFilter,
      unclassifiedOnly,
    ],
  )

  const selectSmartAlbum = useCallback(
    (id: number) => {
      setSelectedSmartAlbumId(id)
      const album = smartAlbums.find((candidate) => candidate.id === id)
      if (!album) {
        setSmartAlbumName('')
        return
      }
      setSmartAlbumName(album.name)
      applySmartAlbum(album.rules)
    },
    [applySmartAlbum, smartAlbums],
  )

  const createSmartAlbum = useCallback(async () => {
    const name = smartAlbumName.trim()
    if (!name || smartAlbumBusy) return
    setSmartAlbumBusy(true)
    setError('')
    try {
      const album = await window.electronAPI.assetLibrary.createSmartAlbum({
        name,
        rules: currentSmartAlbumRules(),
      })
      const nextAlbums = await window.electronAPI.assetLibrary.listSmartAlbums()
      setSmartAlbums(nextAlbums)
      setSelectedSmartAlbumId(album.id)
      setSmartAlbumName(album.name)
    } catch (albumError) {
      setError(errorMessage(albumError))
    } finally {
      setSmartAlbumBusy(false)
    }
  }, [currentSmartAlbumRules, smartAlbumBusy, smartAlbumName])

  const updateSelectedSmartAlbum = useCallback(async () => {
    if (!selectedSmartAlbumId || !smartAlbumName.trim() || smartAlbumBusy) return
    setSmartAlbumBusy(true)
    setError('')
    try {
      const album = await window.electronAPI.assetLibrary.updateSmartAlbum(selectedSmartAlbumId, {
        name: smartAlbumName.trim(),
        rules: currentSmartAlbumRules(),
      })
      setSmartAlbums(await window.electronAPI.assetLibrary.listSmartAlbums())
      setSmartAlbumName(album.name)
    } catch (albumError) {
      setError(errorMessage(albumError))
    } finally {
      setSmartAlbumBusy(false)
    }
  }, [currentSmartAlbumRules, selectedSmartAlbumId, smartAlbumBusy, smartAlbumName])

  const deleteSelectedSmartAlbum = useCallback(async () => {
    if (!selectedSmartAlbumId || smartAlbumBusy) return
    setSmartAlbumBusy(true)
    setError('')
    try {
      const result = await window.electronAPI.assetLibrary.deleteSmartAlbum(selectedSmartAlbumId)
      if (!result.ok) throw new Error(result.error || 'Could not delete smart album')
      setSmartAlbums(await window.electronAPI.assetLibrary.listSmartAlbums())
      setSelectedSmartAlbumId(0)
      setSmartAlbumName('')
    } catch (albumError) {
      setError(errorMessage(albumError))
    } finally {
      setSmartAlbumBusy(false)
    }
  }, [selectedSmartAlbumId, smartAlbumBusy])

  const loadSuggestions = useCallback(async () => {
    const requestId = ++suggestionRequestId.current
    try {
      const response = await window.electronAPI.assetLibrary.listSuggestions({
        status: suggestionStatus,
        source: suggestionSource,
        offset: suggestionOffset,
        limit: suggestionPageSize,
      })
      if (requestId !== suggestionRequestId.current) return
      setSuggestions(response.items)
      setSuggestionTotal(response.total)
    } catch (loadError) {
      if (requestId === suggestionRequestId.current) setError(errorMessage(loadError))
    }
  }, [suggestionOffset, suggestionSource, suggestionStatus])

  const loadClusters = useCallback(async () => {
    const requestId = ++clusterRequestId.current
    try {
      const clusters = await window.electronAPI.assetLibrary.listClusters()
      if (requestId !== clusterRequestId.current) return
      setClusters(clusters)
      // prune selections that reference groups no longer present
      const alive = new Set(clusters.map((c) => c.group.id))
      setSelectedClusterIds((prev) => {
        const next = new Set([...prev].filter((id) => alive.has(id)))
        return next.size === prev.size ? prev : next
      })
      setMemberSelection((prev) => (prev && !alive.has(prev.groupId) ? null : prev))
    } catch (loadError) {
      if (requestId === clusterRequestId.current) setError(errorMessage(loadError))
    }
  }, [])

  useEffect(() => {
    void refreshBase().catch((loadError) => setError(errorMessage(loadError)))
  }, [refreshBase])

  useEffect(() => {
    if (view === 'review' && reviewMode === 'suggestions') void loadSuggestions()
  }, [loadSuggestions, reviewMode, view])

  useEffect(() => {
    if (view === 'clusters') void loadClusters()
  }, [loadClusters, view])

  const runMutation = useCallback(
    async (operation: () => Promise<unknown>, refreshAssets = false) => {
      setError('')
      try {
        const result = await operation()
        if (
          result &&
          typeof result === 'object' &&
          'ok' in result &&
          (result as { ok?: unknown }).ok === false
        ) {
          throw new Error(String((result as { error?: unknown }).error || 'Operation failed'))
        }
        await refreshBase()
        if (refreshAssets) await loadAssets()
      } catch (mutationError) {
        setError(errorMessage(mutationError))
      }
    },
    [loadAssets, refreshBase],
  )

  const runTask = useCallback(
    async (
      operation: () => Promise<AssetLibraryTaskResult>,
    ): Promise<AssetLibraryTaskResult | null> => {
      setError('')
      try {
        const result = await operation()
        if (!result.ok) {
          setError(result.error || 'Task could not be started')
          return null
        }
        return result
      } catch (taskError) {
        setError(errorMessage(taskError))
        return null
      }
    },
    [],
  )

  const {
    deletionHistoryPageSize,
    selectedCategory,
    selectedCategoryId,
    references,
    categoryAssets,
    categoryAssetTotal,
    categoryAssetsLoading,
    newCategoryName,
    newCategoryColor,
    newCategoryParent,
    editCategoryName,
    editCategoryColor,
    referenceThreshold,
    newTagName,
    newTagColor,
    tagThreshold,
    editingTagId,
    editingTagName,
    editingTagColor,
    draggedCategoryId,
    dropTargetCategoryId,
    recentCategoryIds,
    deleteArmed,
    deletionHistoryOpen,
    deletionHistoryOffset,
    deletionHistory,
    setSelectedCategoryId,
    setNewCategoryName,
    setNewCategoryColor,
    setNewCategoryParent,
    setEditCategoryName,
    setEditCategoryColor,
    setReferenceThreshold,
    setNewTagName,
    setNewTagColor,
    setTagThreshold,
    setEditingTagName,
    setEditingTagColor,
    setDraggedCategoryId,
    setDropTargetCategoryId,
    setDeletionHistoryOffset,
    loadReferences,
    loadCategoryAssets,
    createCategory,
    createTag,
    startTagEdit,
    saveTagEdit,
    cancelTagEdit,
    reparentCategory,
    addReferences,
    importLocalReferences,
    pasteReferenceImage,
    saveCategory,
    removeReference,
    buildReferenceSuggestions,
    buildTagSuggestions,
    toggleDeletionHistory,
    undoLastDeletion,
    exportDeletionHistory,
    purgeRestoredDeletions,
    purgeAllDeletions,
    restoreDeletion,
    deleteCategory,
    deleteTag,
  } = useAssetLibraryTaxonomy({
    categories,
    selectedIds,
    batchCategoryId,
    active: view === 'library' && libraryMode === 'categories',
    setError,
    runMutation,
    runTask,
  })

  useEffect(() => {
    if (categories.some((category) => category.id === clusterCategoryId)) return
    const preferred = categories.find((category) => category.id === selectedCategoryId)
    setClusterCategoryId(preferred?.id || categories[0]?.id || 0)
  }, [categories, clusterCategoryId, selectedCategoryId])

  const openSampleSearch = useCallback(() => {
    setReviewMode('sampleSearch')
    setView('review')
  }, [])

  const openSimilarSearch = useCallback(() => {
    setReviewMode('similar')
    setView('review')
  }, [])

  const {
    pageSize: sampleSearchPageSize,
    sampleResult: sampleSearchResult,
    sampleCategoryId: sampleSearchCategoryId,
    sampleOffset: sampleSearchOffset,
    samplePage: sampleSearchPage,
    sampleScores: sampleSearchScores,
    similarResult: similarSearchResult,
    similarCategoryId: similarTargetCategoryId,
    similarOffset: similarSearchOffset,
    similarPage: similarSearchPage,
    similarScores: similarSearchScores,
    topK: sampleSearchTopK,
    includeReviewed: sampleSearchIncludeReviewed,
    setSampleCategory: setSampleSearchCategoryId,
    setSimilarCategoryId: setSimilarTargetCategoryId,
    setTopK: setSampleSearchTopK,
    setIncludeReviewed: setSampleSearchIncludeReviewed,
    setSampleOffset: setSampleSearchOffset,
    setSimilarOffset: setSimilarSearchOffset,
    loadSampleResults: loadSampleSearchResults,
    loadSimilarResults: loadSimilarSearchResults,
    trackTask: trackSearchTask,
    handleTaskProgress: handleSearchTaskProgress,
    startSample: startSampleSearch,
    startSimilar: startSimilarSearch,
    reviewSample: reviewSampleSearchSelection,
    reviewSimilar: reviewSimilarSearchSelection,
    clearSample: clearSampleSearch,
    clearSimilar: clearSimilarSearch,
    reset: resetSearches,
  } = useAssetLibrarySearches({
    selectedIds,
    setSelectedIds,
    setError,
    runTask,
    runMutation,
    openSampleSearch,
    openSimilarSearch,
  })

  useEffect(() => {
    void window.electronAPI.assetLibrary.getTaskProgress().then((progress) => {
      setTask(progress)
      trackSearchTask(progress)
    })
  }, [trackSearchTask])

  useEffect(() => {
    return window.electronAPI.assetLibrary.onTaskProgress((progress) => {
      setTask(progress)
      handleSearchTaskProgress(progress)
      if (progress.state === 'done') {
        void refreshBase()
        if (view === 'library' && libraryMode === 'assets') void loadAssets()
        if (view === 'review' && reviewMode === 'suggestions') void loadSuggestions()
        if (view === 'clusters') void loadClusters()
      }
      if (progress.state === 'error') setError(progress.error || progress.message)
    })
  }, [
    handleSearchTaskProgress,
    libraryMode,
    loadAssets,
    loadClusters,
    loadSuggestions,
    refreshBase,
    reviewMode,
    view,
  ])

  const onBackupRestored = useCallback(async () => {
    setSelectedIds(new Set())
    resetAssets()
    setSuggestionOffset(0)
    resetSearches()
    await refreshBase()
    if (view === 'library' && libraryMode === 'assets') await loadAssets()
    if (view === 'library' && libraryMode === 'categories') {
      await loadReferences()
      await loadCategoryAssets()
    }
    if (view === 'review' && reviewMode === 'suggestions') await loadSuggestions()
    if (view === 'clusters') await loadClusters()
  }, [
    libraryMode,
    loadAssets,
    loadCategoryAssets,
    loadClusters,
    loadReferences,
    loadSuggestions,
    refreshBase,
    resetAssets,
    resetSearches,
    reviewMode,
    view,
  ])

  const {
    open: backupOpen,
    backups,
    busy: backupBusy,
    message: backupMessage,
    restoreArmedId: backupRestoreArmed,
    deleteArmedId: backupDeleteArmed,
    verification: backupVerification,
    backupPassphrase,
    backupPassphraseConfirmation,
    setBackupPassphrase,
    setBackupPassphraseConfirmation,
    setOpen: setBackupOpen,
    toggle: toggleBackups,
    load: loadBackups,
    create: createBackup,
    verify: verifyBackup,
    restore: restoreBackup,
    export: exportBackup,
    import: importBackup,
    delete: deleteBackup,
  } = useAssetLibraryBackups({ setError, onRestored: onBackupRestored })

  const selectTab = (next: ViewMode) => {
    if (next === 'review' && !sampleSearchCategoryId && selectedCategoryId) {
      setSampleSearchCategoryId(selectedCategoryId)
    }
    setView(next)
    setBackupOpen(false)
    setError('')
  }

  const reviewSuggestion = (id: number, status: 'confirmed' | 'rejected' | 'ignored') => {
    if (suggestionMutationRef.current !== null) return
    suggestionMutationRef.current = id
    setSuggestionMutationId(id)
    setError('')
    void (async () => {
      let reviewed = false
      try {
        const result = await window.electronAPI.assetLibrary.reviewSuggestions([id], status)
        if (!result.ok) throw new Error(result.error || 'Could not review suggestion')
        reviewed = true
      } catch (mutationError) {
        setError(errorMessage(mutationError))
      } finally {
        suggestionMutationRef.current = null
        setSuggestionMutationId(null)
      }
      if (reviewed) {
        void loadSuggestions()
        void refreshBase().catch((refreshError) => setError(errorMessage(refreshError)))
      }
    })()
  }

  const undoSuggestion = (id: number) => {
    if (suggestionMutationRef.current !== null) return
    suggestionMutationRef.current = id
    setSuggestionMutationId(id)
    setError('')
    void (async () => {
      let undone = false
      try {
        const result = await window.electronAPI.assetLibrary.undoSuggestions([id])
        if (!result.ok) throw new Error(result.error || 'Could not undo accepted suggestion')
        undone = true
      } catch (mutationError) {
        setError(errorMessage(mutationError))
      } finally {
        suggestionMutationRef.current = null
        setSuggestionMutationId(null)
      }
      if (undone) {
        void loadSuggestions()
        void refreshBase().catch((refreshError) => setError(errorMessage(refreshError)))
      }
    })()
  }

  const renderAssets = () => (
    <AssetLibraryAssetsView
      query={query}
      categoryFilter={categoryFilter}
      tagFilter={tagFilter}
      unclassifiedOnly={unclassifiedOnly}
      archivedOnly={archivedOnly}
      sourceFilter={sourceFilter}
      kindFilter={kindFilter}
      modifiedAfter={modifiedAfter}
      modifiedBefore={modifiedBefore}
      minRating={minRating}
      favoriteOnly={favoriteOnly}
      sort={sort}
      stats={stats}
      rows={rows}
      categories={categories}
      tags={tags}
      assets={assets}
      selectedIds={selectedIds}
      lastArchivedIds={lastArchivedIds}
      batchCategoryId={batchCategoryId}
      batchTagId={batchTagId}
      loading={loading}
      offset={offset}
      total={assetTotal}
      pageSize={pageSize}
      onQueryChange={(value) => {
        setQuery(value)
        setOffset(0)
      }}
      onCategoryFilterChange={(value) => {
        setCategoryFilter(value)
        setOffset(0)
      }}
      onTagFilterChange={(value) => {
        setTagFilter(value)
        setOffset(0)
      }}
      onUnclassifiedChange={(value) => {
        setUnclassifiedOnly(value)
        if (value) setArchivedOnly(false)
        setOffset(0)
      }}
      onArchivedChange={(value) => {
        setArchivedOnly(value)
        if (value) setUnclassifiedOnly(false)
        setOffset(0)
      }}
      onSourceFilterChange={(value) => {
        setSourceFilter(value)
        setOffset(0)
      }}
      onKindFilterChange={(value) => {
        setKindFilter(value)
        setOffset(0)
      }}
      onModifiedAfterChange={(value) => {
        setModifiedAfter(value)
        setOffset(0)
      }}
      onModifiedBeforeChange={(value) => {
        setModifiedBefore(value)
        setOffset(0)
      }}
      onMinRatingChange={(value) => {
        setMinRating(value)
        setOffset(0)
      }}
      onFavoriteOnlyChange={(value) => {
        setFavoriteOnly(value)
        setOffset(0)
      }}
      onSetSelectedRating={(rating) => setSelectedUserMetadata({ rating })}
      onSetSelectedFavorite={(favorite) => setSelectedUserMetadata({ favorite })}
      onSortChange={setSort}
      onSelectPage={() => setSelectedIds(new Set(assets.map((item) => item.asset.id)))}
      onClearSelection={() => setSelectedIds(new Set())}
      onRestoreSelected={restoreSelected}
      onArchiveSelected={archiveSelected}
      onUndoArchive={undoLastArchive}
      onBatchCategoryChange={setBatchCategoryId}
      onAssignCategory={assignCategory}
      onAddReferences={addReferences}
      onImportReferences={importLocalReferences}
      onPasteReference={pasteReferenceImage}
      onBatchTagChange={setBatchTagId}
      onAssignTag={assignTag}
      onSetSelected={setSelectionForIds}
      onOpenAsset={(assetId) => void window.electronAPI.assetLibrary.openAsset(assetId)}
      onRevealAsset={(assetId) => void window.electronAPI.assetLibrary.revealAsset(assetId)}
      onReloadAssets={() => void loadAssets()}
      onPreviousPage={() => setOffset(Math.max(0, offset - pageSize))}
      onNextPage={() => setOffset(offset + pageSize)}
      smartAlbums={smartAlbums}
      selectedSmartAlbumId={selectedSmartAlbumId}
      smartAlbumName={smartAlbumName}
      smartAlbumBusy={smartAlbumBusy}
      onSmartAlbumSelect={selectSmartAlbum}
      onSmartAlbumNameChange={setSmartAlbumName}
      onSmartAlbumCreate={() => void createSmartAlbum()}
      onSmartAlbumUpdate={() => void updateSelectedSmartAlbum()}
      onSmartAlbumDelete={() => void deleteSelectedSmartAlbum()}
    />
  )

  const renderSampleSearch = () => (
    <AssetLibrarySearchResultsView
      mode="samples"
      categoryId={sampleSearchCategoryId}
      rows={rows}
      categories={categories}
      tags={tags}
      topK={sampleSearchTopK}
      includeReviewed={sampleSearchIncludeReviewed}
      activeTask={activeTask}
      selectedIds={selectedIds}
      result={sampleSearchResult}
      items={sampleSearchPage.map((hit) => hit.item)}
      scores={sampleSearchScores}
      offset={sampleSearchOffset}
      pageSize={sampleSearchPageSize}
      onCategoryChange={setSampleSearchCategoryId}
      onTopKChange={setSampleSearchTopK}
      onIncludeReviewedChange={setSampleSearchIncludeReviewed}
      onSearch={() => startSampleSearch()}
      onClear={clearSampleSearch}
      onRelevant={() => reviewSampleSearchSelection(true)}
      onNotRelevant={() => reviewSampleSearchSelection(false)}
      onSetSelected={setSelectionForIds}
      onOpen={(assetId) => void window.electronAPI.assetLibrary.openAsset(assetId)}
      onReveal={(assetId) => void window.electronAPI.assetLibrary.revealAsset(assetId)}
      onSimilar={(assetId) => startSimilarSearch(assetId, sampleSearchCategoryId)}
      onPreviousPage={() =>
        setSampleSearchOffset(Math.max(0, sampleSearchOffset - sampleSearchPageSize))
      }
      onNextPage={() => setSampleSearchOffset(sampleSearchOffset + sampleSearchPageSize)}
    />
  )

  const renderSimilarSearch = () => (
    <AssetLibrarySearchResultsView
      mode="similar"
      categoryId={similarTargetCategoryId}
      rows={rows}
      categories={categories}
      tags={tags}
      topK={sampleSearchTopK}
      includeReviewed={sampleSearchIncludeReviewed}
      activeTask={activeTask}
      selectedIds={selectedIds}
      result={similarSearchResult}
      items={similarSearchPage.map((hit) => hit.item)}
      scores={similarSearchScores}
      offset={similarSearchOffset}
      pageSize={sampleSearchPageSize}
      onCategoryChange={setSimilarTargetCategoryId}
      onTopKChange={setSampleSearchTopK}
      onIncludeReviewedChange={setSampleSearchIncludeReviewed}
      onSearch={() => {
        if (similarSearchResult)
          startSimilarSearch(similarSearchResult.queryAssetId, similarTargetCategoryId)
      }}
      onClear={clearSimilarSearch}
      onRelevant={() => reviewSimilarSearchSelection(true)}
      onNotRelevant={() => reviewSimilarSearchSelection(false)}
      onSetSelected={setSelectionForIds}
      onOpen={(assetId) => void window.electronAPI.assetLibrary.openAsset(assetId)}
      onReveal={(assetId) => void window.electronAPI.assetLibrary.revealAsset(assetId)}
      onSimilar={(assetId) => startSimilarSearch(assetId, similarTargetCategoryId)}
      onPreviousPage={() =>
        setSimilarSearchOffset(Math.max(0, similarSearchOffset - sampleSearchPageSize))
      }
      onNextPage={() => setSimilarSearchOffset(similarSearchOffset + sampleSearchPageSize)}
    />
  )

  const renderCategories = () => (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(210px, 0.8fr) minmax(330px, 1.4fr)',
        gap: 8,
        flex: 1,
        minHeight: 0,
      }}
    >
      <AssetLibraryCategorySidebar
        categories={categories}
        rows={rows}
        selectedCategoryId={selectedCategoryId}
        recentCategoryIds={recentCategoryIds}
        deletionHistoryOpen={deletionHistoryOpen}
        deletionHistory={deletionHistory}
        deletionHistoryOffset={deletionHistoryOffset}
        deletionHistoryPageSize={deletionHistoryPageSize}
        deleteArmed={deleteArmed}
        draggedCategoryId={draggedCategoryId}
        dropTargetCategoryId={dropTargetCategoryId}
        newCategoryName={newCategoryName}
        newCategoryColor={newCategoryColor}
        newCategoryParent={newCategoryParent}
        onToggleHistory={toggleDeletionHistory}
        onUndoLastDeletion={undoLastDeletion}
        onExportHistory={exportDeletionHistory}
        onPurgeRestored={purgeRestoredDeletions}
        onPurgeAll={purgeAllDeletions}
        onRestoreDeletion={restoreDeletion}
        onHistoryOffsetChange={setDeletionHistoryOffset}
        onSelectCategory={setSelectedCategoryId}
        onDeleteCategory={deleteCategory}
        onDraggedCategoryChange={setDraggedCategoryId}
        onDropTargetChange={setDropTargetCategoryId}
        onReparentCategory={reparentCategory}
        onNewCategoryNameChange={setNewCategoryName}
        onNewCategoryColorChange={setNewCategoryColor}
        onNewCategoryParentChange={setNewCategoryParent}
        onCreateCategory={createCategory}
      />
      <div
        style={{ minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 9 }}
      >
        <AssetLibraryCategoryDetailView
          category={selectedCategory}
          references={references}
          editName={editCategoryName}
          editColor={editCategoryColor}
          referenceThreshold={referenceThreshold}
          activeTask={activeTask}
          categoryAssets={categoryAssets}
          categoryAssetTotal={categoryAssetTotal}
          categoryAssetsLoading={categoryAssetsLoading}
          onEditNameChange={setEditCategoryName}
          onEditColorChange={setEditCategoryColor}
          onReferenceThresholdChange={setReferenceThreshold}
          onSave={saveCategory}
          onImportLocalReferences={() =>
            selectedCategory && importLocalReferences(selectedCategory.id)
          }
          onPasteReference={() => selectedCategory && pasteReferenceImage(selectedCategory.id)}
          onBuildReferenceSuggestions={buildReferenceSuggestions}
          onSearchAcceptedSamples={() => selectedCategory && startSampleSearch(selectedCategory.id)}
          onRemoveReference={removeReference}
          onRefreshAssets={() => void loadCategoryAssets()}
          onViewAllAssets={() => {
            if (!selectedCategory) return
            setCategoryFilter(selectedCategory.id)
            setUnclassifiedOnly(false)
            setArchivedOnly(false)
            setOffset(0)
            setLibraryMode('assets')
            setView('library')
          }}
          onOpenAsset={(id) => void window.electronAPI.assetLibrary.openAsset(id)}
          onRevealAsset={(id) => void window.electronAPI.assetLibrary.revealAsset(id)}
        />
        <AssetLibraryTagsView
          tags={tags}
          newTagName={newTagName}
          newTagColor={newTagColor}
          tagThreshold={tagThreshold}
          activeTask={activeTask}
          editingTagId={editingTagId}
          editingTagName={editingTagName}
          editingTagColor={editingTagColor}
          deleteArmed={deleteArmed}
          onNewTagNameChange={setNewTagName}
          onNewTagColorChange={setNewTagColor}
          onTagThresholdChange={setTagThreshold}
          onCreateTag={createTag}
          onBuildTagSuggestions={buildTagSuggestions}
          onStartTagEdit={startTagEdit}
          onEditingTagNameChange={setEditingTagName}
          onEditingTagColorChange={setEditingTagColor}
          onSaveTagEdit={saveTagEdit}
          onCancelTagEdit={cancelTagEdit}
          onDeleteTag={deleteTag}
        />
      </div>
    </div>
  )

  const renderSuggestions = () => (
    <AssetLibrarySuggestionsView
      status={suggestionStatus}
      source={suggestionSource}
      items={suggestions}
      total={suggestionTotal}
      offset={suggestionOffset}
      pageSize={suggestionPageSize}
      busyId={suggestionMutationId}
      onStatusChange={(status) => {
        setSuggestionStatus(status)
        setSuggestionOffset(0)
      }}
      onSourceChange={(source) => {
        setSuggestionSource(source)
        setSuggestionOffset(0)
      }}
      onRefresh={() => void loadSuggestions()}
      onReview={reviewSuggestion}
      onUndo={undoSuggestion}
      onOpen={(assetId) => void window.electronAPI.assetLibrary.openAsset(assetId)}
      onSimilar={(assetId, categoryId) => startSimilarSearch(assetId, categoryId || 0)}
      onPreviousPage={() => setSuggestionOffset(Math.max(0, suggestionOffset - suggestionPageSize))}
      onNextPage={() => setSuggestionOffset(suggestionOffset + suggestionPageSize)}
    />
  )

  const renderLibrary = () => (
    <AssetLibraryModeTabs
      value={libraryMode}
      tabs={[
        ['assets', t('Assets')],
        ['categories', t('Categories & Tags')],
      ]}
      onChange={(id: LibraryMode) => {
        setLibraryMode(id)
        setSelectedIds(new Set())
        setError('')
      }}
    >
      {libraryMode === 'assets' ? renderAssets() : renderCategories()}
    </AssetLibraryModeTabs>
  )

  const renderReview = () => (
    <AssetLibraryModeTabs
      value={reviewMode}
      tabs={[
        ['suggestions', `${t('AI Suggestions')} (${formatNumber(stats.suggestedCount)})`],
        ['sampleSearch', t('Sample Search')],
        ['similar', t('Similar Results')],
      ]}
      onChange={(id: ReviewMode) => {
        setReviewMode(id)
        setSelectedIds(new Set())
        if (id === 'sampleSearch' && !sampleSearchCategoryId && selectedCategoryId)
          setSampleSearchCategoryId(selectedCategoryId)
        setError('')
      }}
    >
      {reviewMode === 'suggestions' && renderSuggestions()}
      {reviewMode === 'sampleSearch' && renderSampleSearch()}
      {reviewMode === 'similar' && renderSimilarSearch()}
    </AssetLibraryModeTabs>
  )

  const renderClusters = () => (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <AssetLibraryClusterControls
        rows={rows}
        activeTask={activeTask}
        totalAssets={stats.totalAssets}
        clusterTotal={clusters.length}
        clusteredAssetCount={clusteredAssetCount}
        selectedClusterCount={selectedClusterIds.size}
        categoryId={clusterCategoryId}
        categoryTopK={clusterCategoryTopK}
        categoryMinScore={clusterCategoryMinScore}
        categoryIncludeReviewed={clusterCategoryIncludeReviewed}
        autoCount={clusterAutoCount}
        count={clusterCount}
        minSize={clusterMinSize}
        minSimilarity={clusterMinSimilarity}
        semanticRefine={clusterSemanticRefine}
        semanticSimilarity={clusterSemanticSimilarity}
        semanticMaxSplits={clusterSemanticMaxSplits}
        typeFilter={clusterTypeFilter}
        scopePaths={clusterScopePaths}
        onCategoryIdChange={setClusterCategoryId}
        onCategoryTopKChange={setClusterCategoryTopK}
        onCategoryMinScoreChange={setClusterCategoryMinScore}
        onCategoryIncludeReviewedChange={setClusterCategoryIncludeReviewed}
        onAutoCountChange={setClusterAutoCount}
        onCountChange={setClusterCount}
        onMinSizeChange={setClusterMinSize}
        onMinSimilarityChange={setClusterMinSimilarity}
        onSemanticRefineChange={setClusterSemanticRefine}
        onSemanticSimilarityChange={setClusterSemanticSimilarity}
        onSemanticMaxSplitsChange={setClusterSemanticMaxSplits}
        onTypeFilterChange={setClusterTypeFilter}
        onBuildCategoryGroup={() =>
          void runTask(() =>
            window.electronAPI.assetLibrary.buildCategoryCluster({
              categoryId: clusterCategoryId,
              topK: clusterCategoryTopK,
              minScore: clusterCategoryMinScore,
              includeReviewed: clusterCategoryIncludeReviewed,
              ...(clusterScopePaths.length > 0 ? { scopePaths: clusterScopePaths } : {}),
            }),
          )
        }
        onBuildClusters={() =>
          void runTask(() =>
            window.electronAPI.assetLibrary.buildClusters({
              maxClusters: clusterCount,
              autoClusters: clusterAutoCount,
              minClusterSize: clusterMinSize,
              minSimilarity: clusterMinSimilarity,
              semanticRefine: clusterSemanticRefine,
              semanticSimilarity: clusterSemanticSimilarity,
              semanticMaxSplits: clusterSemanticMaxSplits,
              ...(clusterScopePaths.length > 0 ? { scopePaths: clusterScopePaths } : {}),
            }),
          )
        }
        onRefreshLabels={() =>
          void runTask(() => window.electronAPI.assetLibrary.refreshClusterLabels())
        }
        onBuildPeopleGroups={() =>
          void runTask(() =>
            window.electronAPI.assetLibrary.buildPeopleClusters({
              minClusterSize: 2,
              ...(clusterScopePaths.length > 0 ? { scopePaths: clusterScopePaths } : {}),
            }),
          )
        }
        onBuildDuplicates={() =>
          void runTask(() => window.electronAPI.assetLibrary.buildDuplicateGroups())
        }
        onBuildNearDuplicates={() =>
          void runTask(() => window.electronAPI.assetLibrary.buildNearDuplicateGroups())
        }
        onMergeSelected={() =>
          void runMutation(async () => {
            const result = await window.electronAPI.assetLibrary.mergeClusters([
              ...selectedClusterIds,
            ])
            if (!result.ok) throw new Error(result.error)
            setSelectedClusterIds(new Set())
            await loadClusters()
          }, true)
        }
        onRefresh={() => void loadClusters()}
        onSelectPaths={() =>
          void (async () => {
            try {
              const result = await window.electronAPI.assetLibrary.selectClusterPaths()
              if (result.canceled || result.paths.length === 0) return
              setClusterScopePaths((current) => [...new Set([...current, ...result.paths])])
            } catch (selectError) {
              setError(errorMessage(selectError))
            }
          })()
        }
        onClearPaths={() => setClusterScopePaths([])}
        onRemovePath={(scopePath) =>
          setClusterScopePaths((current) => current.filter((candidate) => candidate !== scopePath))
        }
      />
      <AssetLibraryClusterGrid
        clusters={clusters}
        filteredClusters={filteredClusters}
        selectedClusterIds={selectedClusterIds}
        memberSelection={memberSelection}
        armedDuplicateId={armedDuplicateId}
        onClusterSelected={(id, selected) =>
          setSelectedClusterIds((current) => {
            const next = new Set(current)
            if (selected) next.add(id)
            else next.delete(id)
            return next
          })
        }
        onMemberToggled={(groupId, assetId) =>
          setMemberSelection((current) => {
            const base =
              current?.groupId === groupId ? current : { groupId, assetIds: new Set<number>() }
            const assetIds = new Set(base.assetIds)
            if (assetIds.has(assetId)) assetIds.delete(assetId)
            else assetIds.add(assetId)
            return assetIds.size > 0 ? { groupId, assetIds } : null
          })
        }
        onRename={(id, name) =>
          void runMutation(async () => {
            await window.electronAPI.assetLibrary.updateCluster(id, { name })
            await loadClusters()
          })
        }
        onSplit={(groupId, assetIds) =>
          void runMutation(async () => {
            const result = await window.electronAPI.assetLibrary.splitCluster(groupId, assetIds)
            if (!result.ok) throw new Error(result.error)
            setMemberSelection(null)
            await loadClusters()
          }, true)
        }
        onMove={(groupId, targetGroupId, assetIds) =>
          void runMutation(async () => {
            const result = await window.electronAPI.assetLibrary.moveClusterMembers(
              groupId,
              targetGroupId,
              assetIds,
            )
            if (!result.ok) throw new Error(result.error)
            setMemberSelection(null)
            await loadClusters()
          }, true)
        }
        onClearMemberSelection={() => setMemberSelection(null)}
        onApplyDuplicate={(id) => {
          if (armedDuplicateId !== id) {
            setArmedDuplicateId(id)
            setTimeout(
              () => setArmedDuplicateId((current) => (current === id ? null : current)),
              5000,
            )
            return
          }
          setArmedDuplicateId(null)
          void runMutation(async () => {
            const result = await window.electronAPI.assetLibrary.applyDuplicateGroup(id)
            if (!result.ok) throw new Error(result.error)
            await loadClusters()
            await refreshBase()
          }, true)
        }}
        onPromote={({ group }) =>
          void runMutation(async () => {
            const result = await window.electronAPI.assetLibrary.promoteCluster(
              group.id,
              group.algorithm === 'category_feedback' ? group.sourceCategoryId : undefined,
            )
            if (!result.ok) throw new Error(result.error)
            if (result.category) setSelectedCategoryId(result.category.id)
            await loadClusters()
            setLibraryMode('categories')
            setView('library')
          }, true)
        }
        onIgnore={(id) =>
          void runMutation(async () => {
            await window.electronAPI.assetLibrary.updateCluster(id, { status: 'ignored' })
            await loadClusters()
          })
        }
      />
    </div>
  )

  return (
    <DraggablePanel
      panelId="assetLibrary"
      title="NekoSearch"
      displayTitle={t('Library')}
      dataPanel="neko-search"
      x={assetLibraryPos.x}
      y={assetLibraryPos.y}
      w={assetLibrarySize.w}
      h={assetLibrarySize.h}
      defaultX={190}
      defaultY={160}
      defaultW={DEFAULT_ASSET_LIBRARY_W}
      defaultH={DEFAULT_ASSET_LIBRARY_H}
      minW={640}
      minH={420}
      onMove={handleMove}
      onResize={setAssetLibrarySize}
      locked={locked}
      onToggleLock={() => togglePanelLocked('assetLibrary')}
      visibilityLocked={visibilityLocked}
      onToggleVisibilityLock={() => toggleVisibilityLock('assetLibrary')}
    >
      <div
        className="asset-library-shell"
        style={{
          height: '100%',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          fontSize: 10,
        }}
      >
        <AssetLibraryHeader
          activeTask={activeTask}
          backupOpen={backupOpen}
          backupCount={backups.length}
          view={view}
          stats={stats}
          feedbackStatus={feedbackStatus}
          task={task}
          error={error}
          onSync={() =>
            void runTask(() =>
              window.electronAPI.assetLibrary.syncFromImageIndex(manifestPath || undefined),
            )
          }
          onRefresh={() => {
            void refreshBase()
            if (view === 'library' && libraryMode === 'assets') void loadAssets()
            if (view === 'review' && reviewMode === 'sampleSearch') void loadSampleSearchResults()
            if (view === 'review' && reviewMode === 'similar') void loadSimilarSearchResults()
            if (view === 'review' && reviewMode === 'suggestions') void loadSuggestions()
            if (view === 'clusters') void loadClusters()
          }}
          onToggleBackups={toggleBackups}
          onExportReport={() =>
            void runMutation(async () => {
              const result = await window.electronAPI.assetLibrary.exportLibraryReport()
              if (result.canceled) return { ok: true }
              if (!result.ok) throw new Error(result.error)
              return result
            }, true)
          }
          onRebuildLearning={() =>
            void runTask(() => window.electronAPI.assetLibrary.rebuildFeedbackModel())
          }
          onLearningEnabledChange={(enabled) =>
            void runMutation(async () => {
              const nextStatus = await window.electronAPI.assetLibrary.setFeedbackEnabled(enabled)
              setFeedbackStatus(nextStatus)
            })
          }
          onStop={() => void window.electronAPI.assetLibrary.stopTask(task?.taskId)}
          onViewChange={selectTab}
        />
        {backupOpen && (
          <AssetLibraryBackupView
            activeTask={activeTask}
            backups={backups}
            busy={backupBusy}
            message={backupMessage}
            passphrase={backupPassphrase}
            passphraseConfirmation={backupPassphraseConfirmation}
            restoreArmedId={backupRestoreArmed}
            deleteArmedId={backupDeleteArmed}
            verification={backupVerification}
            onCreate={() => void createBackup()}
            onRefresh={() => void loadBackups()}
            onOpenFolder={() => void window.electronAPI.assetLibrary.openBackupFolder()}
            onPassphraseChange={setBackupPassphrase}
            onPassphraseConfirmationChange={setBackupPassphraseConfirmation}
            onImport={() => void importBackup()}
            onVerify={(backupId) => void verifyBackup(backupId)}
            onExport={(backupId) => void exportBackup(backupId)}
            onDelete={(backupId) => void deleteBackup(backupId)}
            onRestore={(backupId) => void restoreBackup(backupId)}
          />
        )}
        {!backupOpen && view === 'library' && renderLibrary()}
        {!backupOpen && view === 'review' && renderReview()}
        {!backupOpen && view === 'clusters' && renderClusters()}
      </div>
    </DraggablePanel>
  )
}

export default AssetLibraryPanel
