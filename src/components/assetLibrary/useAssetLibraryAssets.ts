import { useCallback, useEffect, useRef, useState } from 'react'
import type { AssetLibraryAssetItem, AssetSmartAlbumRules } from '../../../shared/ipc-contract'
import { assetLibraryErrorMessage as errorMessage } from './assetLibraryViewUtils'

interface Options {
  active: boolean
  selectedIds: Set<number>
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<number>>>
  setError: (message: string) => void
  refreshBase: () => Promise<void>
}

const pageSize = 100

export default function useAssetLibraryAssets({
  active,
  selectedIds,
  setSelectedIds,
  setError,
  refreshBase,
}: Options) {
  const [assets, setAssets] = useState<AssetLibraryAssetItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState(0)
  const [tagFilter, setTagFilter] = useState(0)
  const [unclassifiedOnly, setUnclassifiedOnly] = useState(false)
  const [archivedOnly, setArchivedOnly] = useState(false)
  const [sourceFilter, setSourceFilter] = useState<'all' | 'image_search' | 'manual'>('all')
  const [kindFilter, setKindFilter] = useState<'all' | 'image' | 'video_frame'>('all')
  const [modifiedAfter, setModifiedAfter] = useState(0)
  const [modifiedBefore, setModifiedBefore] = useState(0)
  const [minRating, setMinRating] = useState(0)
  const [favoriteOnly, setFavoriteOnly] = useState(false)
  const [sort, setSort] = useState<'updated_desc' | 'name_asc' | 'size_desc'>('updated_desc')
  const [offset, setOffset] = useState(0)
  const [batchCategoryId, setBatchCategoryId] = useState(0)
  const [batchTagId, setBatchTagId] = useState(0)
  const [lastArchivedIds, setLastArchivedIds] = useState<number[]>([])
  const requestId = useRef(0)

  const load = useCallback(async () => {
    const currentRequestId = ++requestId.current
    setLoading(true)
    try {
      const response = await window.electronAPI.assetLibrary.listAssets({
        offset,
        limit: pageSize,
        query: debouncedQuery,
        sort,
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
      })
      if (currentRequestId !== requestId.current) return
      setAssets(response.items)
      setTotal(response.total)
      setSelectedIds(new Set())
    } catch (loadError) {
      if (currentRequestId === requestId.current) setError(errorMessage(loadError))
    } finally {
      if (currentRequestId === requestId.current) setLoading(false)
    }
  }, [
    archivedOnly,
    categoryFilter,
    debouncedQuery,
    offset,
    sourceFilter,
    kindFilter,
    modifiedAfter,
    modifiedBefore,
    minRating,
    favoriteOnly,
    setError,
    setSelectedIds,
    sort,
    tagFilter,
    unclassifiedOnly,
  ])

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 200)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    if (active) void load()
    else {
      requestId.current += 1
      setLoading(false)
    }
  }, [active, load])

  const runMutation = useCallback(
    async (operation: () => Promise<unknown>) => {
      setError('')
      try {
        const result = await operation()
        if (
          result &&
          typeof result === 'object' &&
          'ok' in result &&
          (result as { ok?: unknown }).ok === false
        )
          throw new Error(String((result as { error?: unknown }).error || 'Operation failed'))
        await refreshBase()
        await load()
      } catch (mutationError) {
        setError(errorMessage(mutationError))
      }
    },
    [load, refreshBase, setError],
  )

  const setSelectionForIds = useCallback(
    (ids: number[], selected: boolean) => {
      setSelectedIds((current) => {
        const next = new Set(current)
        for (const id of ids) {
          if (selected) next.add(id)
          else next.delete(id)
        }
        return next
      })
    },
    [setSelectedIds],
  )

  const assignCategory = useCallback(() => {
    if (!batchCategoryId || selectedIds.size === 0) return
    void runMutation(() =>
      window.electronAPI.assetLibrary.assignCategory([...selectedIds], batchCategoryId),
    )
  }, [batchCategoryId, runMutation, selectedIds])

  const assignTag = useCallback(() => {
    if (!batchTagId || selectedIds.size === 0) return
    void runMutation(() => window.electronAPI.assetLibrary.assignTag([...selectedIds], batchTagId))
  }, [batchTagId, runMutation, selectedIds])

  const archiveSelected = useCallback(() => {
    const assetIds = [...selectedIds]
    if (assetIds.length === 0) return
    void runMutation(async () => {
      const result = await window.electronAPI.assetLibrary.archiveAssets(assetIds)
      if (!result.ok) throw new Error(result.error || 'Could not remove selected assets')
      setLastArchivedIds(assetIds)
      return result
    })
  }, [runMutation, selectedIds])

  const restoreSelected = useCallback(() => {
    const assetIds = [...selectedIds]
    if (assetIds.length === 0) return
    void runMutation(async () => {
      const result = await window.electronAPI.assetLibrary.restoreAssets(assetIds)
      if (!result.ok) throw new Error(result.error || 'Could not restore selected assets')
      const restored = new Set(assetIds)
      setLastArchivedIds((current) => current.filter((id) => !restored.has(id)))
      return result
    })
  }, [runMutation, selectedIds])

  const undoLastArchive = useCallback(() => {
    if (lastArchivedIds.length === 0) return
    const assetIds = [...lastArchivedIds]
    void runMutation(async () => {
      const result = await window.electronAPI.assetLibrary.restoreAssets(assetIds)
      if (!result.ok) throw new Error(result.error || 'Could not undo the last removal')
      setLastArchivedIds([])
      return result
    })
  }, [lastArchivedIds, runMutation])

  const setSelectedUserMetadata = useCallback(
    (patch: { rating?: number; favorite?: boolean }) => {
      if (selectedIds.size === 0) return
      void runMutation(() =>
        window.electronAPI.assetLibrary.setUserMetadata([...selectedIds], patch),
      )
    },
    [runMutation, selectedIds],
  )

  const reset = useCallback(() => {
    requestId.current += 1
    setOffset(0)
    setLastArchivedIds([])
  }, [])

  const applySmartAlbum = useCallback((rules: AssetSmartAlbumRules) => {
    requestId.current += 1
    setQuery(rules.query || '')
    setDebouncedQuery(rules.query || '')
    setCategoryFilter(rules.categoryId || 0)
    setTagFilter(rules.tagId || 0)
    setUnclassifiedOnly(rules.unclassified === true)
    setArchivedOnly(rules.archivedOnly === true)
    setSourceFilter(rules.source || 'all')
    setKindFilter(rules.kind || 'all')
    setModifiedAfter(rules.modifiedAfter || 0)
    setModifiedBefore(rules.modifiedBefore || 0)
    setMinRating(rules.minRating || 0)
    setFavoriteOnly(rules.favoriteOnly === true)
    setSort(rules.sort)
    setOffset(0)
    setLastArchivedIds([])
  }, [])

  return {
    pageSize,
    assets,
    total,
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
    load,
    setSelectionForIds,
    assignCategory,
    assignTag,
    archiveSelected,
    restoreSelected,
    undoLastArchive,
    setSelectedUserMetadata,
    applySmartAlbum,
    reset,
  }
}
