import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AssetCategory,
  AssetLibraryAssetItem,
  AssetLibraryReferenceItem,
  AssetLibraryTaskResult,
  AssetMetadataDeletionListResponse,
} from '../../../shared/ipc-contract'
import { assetLibraryErrorMessage as errorMessage } from './assetLibraryViewUtils'

type RunMutation = (operation: () => Promise<unknown>, refreshAssets?: boolean) => Promise<void>

type RunTask = (
  operation: () => Promise<AssetLibraryTaskResult>,
) => Promise<AssetLibraryTaskResult | null>

interface Options {
  categories: AssetCategory[]
  selectedIds: Set<number>
  batchCategoryId: number
  active: boolean
  setError: (message: string) => void
  runMutation: RunMutation
  runTask: RunTask
}

const deletionHistoryPageSize = 8

export default function useAssetLibraryTaxonomy({
  categories,
  selectedIds,
  batchCategoryId,
  active,
  setError,
  runMutation,
  runTask,
}: Options) {
  const [selectedCategoryId, setSelectedCategoryId] = useState(0)
  const [references, setReferences] = useState<AssetLibraryReferenceItem[]>([])
  const [categoryAssets, setCategoryAssets] = useState<AssetLibraryAssetItem[]>([])
  const [categoryAssetTotal, setCategoryAssetTotal] = useState(0)
  const [categoryAssetsLoading, setCategoryAssetsLoading] = useState(false)
  const [newCategoryName, setNewCategoryName] = useState('')
  const [newCategoryColor, setNewCategoryColor] = useState('#53c7a2')
  const [newCategoryParent, setNewCategoryParent] = useState(0)
  const [editCategoryName, setEditCategoryName] = useState('')
  const [editCategoryColor, setEditCategoryColor] = useState('#53c7a2')
  const [referenceThreshold, setReferenceThreshold] = useState(0.82)
  const [newTagName, setNewTagName] = useState('')
  const [newTagColor, setNewTagColor] = useState('#f0b35d')
  const [tagThreshold, setTagThreshold] = useState(0.7)
  const [editingTagId, setEditingTagId] = useState<number | null>(null)
  const [editingTagName, setEditingTagName] = useState('')
  const [editingTagColor, setEditingTagColor] = useState('#f0b35d')
  const [draggedCategoryId, setDraggedCategoryId] = useState<number | null>(null)
  const [dropTargetCategoryId, setDropTargetCategoryId] = useState<number | null | 'root'>(null)
  const [recentCategoryIds, setRecentCategoryIds] = useState<number[]>([])
  const [deleteArmed, setDeleteArmed] = useState('')
  const [deletionHistoryOpen, setDeletionHistoryOpen] = useState(false)
  const [deletionHistoryOffset, setDeletionHistoryOffset] = useState(0)
  const [deletionHistory, setDeletionHistory] = useState<AssetMetadataDeletionListResponse | null>(
    null,
  )
  const referenceRequestId = useRef(0)
  const categoryAssetRequestId = useRef(0)

  const selectedCategory = categories.find((category) => category.id === selectedCategoryId)

  const loadDeletionHistory = useCallback(async () => {
    try {
      setDeletionHistory(
        await window.electronAPI.assetLibrary.listMetadataDeletions({
          offset: deletionHistoryOffset,
          limit: deletionHistoryPageSize,
          status: 'all',
        }),
      )
    } catch (loadError) {
      setError(errorMessage(loadError))
    }
  }, [deletionHistoryOffset, setError])

  const loadReferences = useCallback(
    async (categoryId = selectedCategoryId) => {
      const requestId = ++referenceRequestId.current
      try {
        const nextReferences = await window.electronAPI.assetLibrary.listReferences(
          categoryId > 0 ? categoryId : undefined,
        )
        if (requestId !== referenceRequestId.current) return
        setReferences(nextReferences)
      } catch (loadError) {
        if (requestId === referenceRequestId.current) setError(errorMessage(loadError))
      }
    },
    [selectedCategoryId, setError],
  )

  const loadCategoryAssets = useCallback(async () => {
    const requestId = ++categoryAssetRequestId.current
    if (selectedCategoryId <= 0) {
      setCategoryAssets([])
      setCategoryAssetTotal(0)
      setCategoryAssetsLoading(false)
      return
    }
    setCategoryAssetsLoading(true)
    try {
      const response = await window.electronAPI.assetLibrary.listAssets({
        offset: 0,
        limit: 12,
        categoryId: selectedCategoryId,
        sort: 'updated_desc',
      })
      if (requestId !== categoryAssetRequestId.current) return
      setCategoryAssets(response.items)
      setCategoryAssetTotal(response.total)
    } catch (loadError) {
      if (requestId === categoryAssetRequestId.current) setError(errorMessage(loadError))
    } finally {
      if (requestId === categoryAssetRequestId.current) setCategoryAssetsLoading(false)
    }
  }, [selectedCategoryId, setError])

  useEffect(() => {
    if (!deleteArmed) return
    const timer = window.setTimeout(() => setDeleteArmed(''), 5000)
    return () => window.clearTimeout(timer)
  }, [deleteArmed])

  useEffect(() => {
    if (deletionHistoryOpen) void loadDeletionHistory()
  }, [deletionHistoryOpen, loadDeletionHistory])

  useEffect(() => {
    if (selectedCategoryId <= 0) return
    setRecentCategoryIds((current) =>
      [selectedCategoryId, ...current.filter((id) => id !== selectedCategoryId)].slice(0, 5),
    )
  }, [selectedCategoryId])

  useEffect(() => {
    if (!active) {
      referenceRequestId.current += 1
      categoryAssetRequestId.current += 1
      setCategoryAssetsLoading(false)
      return
    }
    void loadReferences()
    void loadCategoryAssets()
  }, [active, loadCategoryAssets, loadReferences])

  useEffect(() => {
    if (!selectedCategory) return
    setEditCategoryName(selectedCategory.name)
    setEditCategoryColor(selectedCategory.color)
    setReferenceThreshold(selectedCategory.referenceThreshold ?? 0.82)
  }, [selectedCategory])

  const createCategory = useCallback(() => {
    if (!newCategoryName.trim()) return
    void runMutation(async () => {
      const category = await window.electronAPI.assetLibrary.createCategory({
        name: newCategoryName,
        color: newCategoryColor,
        parentId: newCategoryParent || null,
      })
      setNewCategoryName('')
      setSelectedCategoryId(category.id)
    })
  }, [newCategoryColor, newCategoryName, newCategoryParent, runMutation])

  const createTag = useCallback(() => {
    if (!newTagName.trim()) return
    void runMutation(async () => {
      await window.electronAPI.assetLibrary.createTag({
        name: newTagName,
        color: newTagColor,
      })
      setNewTagName('')
    })
  }, [newTagColor, newTagName, runMutation])

  const startTagEdit = useCallback((tag: { id: number; name: string; color: string }) => {
    setEditingTagId(tag.id)
    setEditingTagName(tag.name)
    setEditingTagColor(tag.color)
  }, [])

  const saveTagEdit = useCallback(() => {
    if (editingTagId === null || !editingTagName.trim()) return
    const tagId = editingTagId
    void runMutation(async () => {
      await window.electronAPI.assetLibrary.updateTag(tagId, {
        name: editingTagName.trim(),
        color: editingTagColor,
      })
      setEditingTagId(null)
    })
  }, [editingTagColor, editingTagId, editingTagName, runMutation])

  const reparentCategory = useCallback(
    (draggedId: number, targetId: number | null) => {
      if (draggedId === targetId) return
      const byId = new Map(categories.map((category) => [category.id, category]))
      let current = targetId === null ? undefined : byId.get(targetId)
      const seen = new Set<number>()
      while (current && current.parentId != null) {
        if (current.parentId === draggedId) {
          setError('Cannot move a category into its own descendant')
          return
        }
        if (seen.has(current.id)) return
        seen.add(current.id)
        current = byId.get(current.parentId)
      }
      void runMutation(() =>
        window.electronAPI.assetLibrary.updateCategory(draggedId, { parentId: targetId }),
      )
    },
    [categories, runMutation, setError],
  )

  const addReferences = useCallback(() => {
    const categoryId = batchCategoryId || selectedCategoryId
    if (!categoryId || selectedIds.size === 0) return
    void runMutation(async () => {
      await window.electronAPI.assetLibrary.addReferences(categoryId, [...selectedIds])
      setSelectedCategoryId(categoryId)
      await loadReferences(categoryId)
    })
  }, [batchCategoryId, loadReferences, runMutation, selectedCategoryId, selectedIds])

  const importLocalReferences = useCallback(
    (categoryId: number) => {
      if (!categoryId) return
      void runMutation(async () => {
        const result = await window.electronAPI.assetLibrary.selectReferenceImages(categoryId)
        if (!result.ok) throw new Error(result.error || 'Could not import reference images')
        setSelectedCategoryId(categoryId)
        setReferences(await window.electronAPI.assetLibrary.listReferences(categoryId))
        return result
      }, true)
    },
    [runMutation],
  )

  const pasteReferenceImage = useCallback(
    (categoryId: number) => {
      if (!categoryId) return
      void runMutation(async () => {
        const result = await window.electronAPI.assetLibrary.pasteReferenceImage(categoryId)
        if (!result.ok) throw new Error(result.error || 'Could not paste reference image')
        setSelectedCategoryId(categoryId)
        setReferences(await window.electronAPI.assetLibrary.listReferences(categoryId))
        return result
      }, true)
    },
    [runMutation],
  )

  const saveCategory = useCallback(() => {
    if (!selectedCategory) return
    void runMutation(() =>
      window.electronAPI.assetLibrary.updateCategory(selectedCategory.id, {
        name: editCategoryName,
        color: editCategoryColor,
        referenceThreshold,
      }),
    )
  }, [editCategoryColor, editCategoryName, referenceThreshold, runMutation, selectedCategory])

  const removeReference = useCallback(
    (id: number) => {
      void runMutation(async () => {
        await window.electronAPI.assetLibrary.removeReference(id)
        await loadReferences()
      })
    },
    [loadReferences, runMutation],
  )

  const buildReferenceSuggestions = useCallback(() => {
    if (!selectedCategory) return
    void runTask(() =>
      window.electronAPI.assetLibrary.buildReferenceSuggestions({
        categoryId: selectedCategory.id,
        threshold: referenceThreshold,
      }),
    )
  }, [referenceThreshold, runTask, selectedCategory])

  const buildTagSuggestions = useCallback(() => {
    void runTask(() =>
      window.electronAPI.assetLibrary.buildTagSuggestions({ threshold: tagThreshold }),
    )
  }, [runTask, tagThreshold])

  const toggleDeletionHistory = useCallback(() => {
    setDeletionHistoryOffset(0)
    setDeletionHistoryOpen((open) => !open)
  }, [])

  const undoLastDeletion = useCallback(() => {
    void runMutation(async () => {
      const result = await window.electronAPI.assetLibrary.undoLastMetadataDeletion()
      if (!result.ok) throw new Error(result.error)
      setSelectedCategoryId(0)
      setDeleteArmed('')
      if (deletionHistoryOpen) await loadDeletionHistory()
      return result
    }, true)
  }, [deletionHistoryOpen, loadDeletionHistory, runMutation])

  const exportDeletionHistory = useCallback(() => {
    void runMutation(async () => {
      const result = await window.electronAPI.assetLibrary.exportMetadataDeletions()
      if (result.canceled) return { ok: true }
      if (!result.ok) throw new Error(result.error)
      return result
    }, true)
  }, [runMutation])

  const purgeRestoredDeletions = useCallback(() => {
    void runMutation(async () => {
      const result = await window.electronAPI.assetLibrary.purgeMetadataDeletions({
        restoredOnly: true,
      })
      if (!result.ok) throw new Error(result.error)
      if (deletionHistoryOpen) await loadDeletionHistory()
      return result
    }, true)
  }, [deletionHistoryOpen, loadDeletionHistory, runMutation])

  const purgeAllDeletions = useCallback(() => {
    const key = 'purge-deletions'
    if (deleteArmed !== key) {
      setDeleteArmed(key)
      return
    }
    void runMutation(async () => {
      const result = await window.electronAPI.assetLibrary.purgeMetadataDeletions({
        confirm: true,
      })
      if (!result.ok) throw new Error(result.error)
      setDeleteArmed('')
      if (deletionHistoryOpen) await loadDeletionHistory()
      return result
    }, true)
  }, [deleteArmed, deletionHistoryOpen, loadDeletionHistory, runMutation])

  const restoreDeletion = useCallback(
    (id: number) => {
      void runMutation(async () => {
        const result = await window.electronAPI.assetLibrary.restoreMetadataDeletion(id)
        if (!result.ok) throw new Error(result.error)
        setSelectedCategoryId(0)
        await loadDeletionHistory()
        return result
      }, true)
    },
    [loadDeletionHistory, runMutation],
  )

  const deleteCategory = useCallback(
    (id: number) => {
      const key = `category-${id}`
      if (deleteArmed !== key) {
        setDeleteArmed(key)
        return
      }
      void runMutation(async () => {
        const result = await window.electronAPI.assetLibrary.deleteCategory(id)
        if (!result.ok) throw new Error(result.error)
        setSelectedCategoryId(0)
        setDeleteArmed('')
        if (deletionHistoryOpen) await loadDeletionHistory()
      }, true)
    },
    [deleteArmed, deletionHistoryOpen, loadDeletionHistory, runMutation],
  )

  const deleteTag = useCallback(
    (id: number) => {
      const key = `tag-${id}`
      if (deleteArmed !== key) {
        setDeleteArmed(key)
        return
      }
      void runMutation(async () => {
        const result = await window.electronAPI.assetLibrary.deleteTag(id)
        if (!result.ok) throw new Error(result.error)
        setDeleteArmed('')
        if (deletionHistoryOpen) await loadDeletionHistory()
        return result
      }, true)
    },
    [deleteArmed, deletionHistoryOpen, loadDeletionHistory, runMutation],
  )

  return {
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
    loadDeletionHistory,
    loadReferences,
    loadCategoryAssets,
    createCategory,
    createTag,
    startTagEdit,
    saveTagEdit,
    cancelTagEdit: () => setEditingTagId(null),
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
  }
}
