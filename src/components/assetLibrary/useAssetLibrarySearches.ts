import { useCallback, useMemo, useRef, useState } from 'react'
import type {
  AssetLibraryCategorySampleSearchResponse,
  AssetLibrarySimilarSearchResponse,
  AssetLibraryTaskProgress,
  AssetLibraryTaskResult,
} from '../../../shared/ipc-contract'
import { assetLibraryErrorMessage as errorMessage } from './assetLibraryViewUtils'

type RunTask = (
  operation: () => Promise<AssetLibraryTaskResult>,
) => Promise<AssetLibraryTaskResult | null>

type RunMutation = (operation: () => Promise<unknown>, refreshAssets?: boolean) => Promise<void>

interface Options {
  selectedIds: Set<number>
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<number>>>
  setError: (message: string) => void
  runTask: RunTask
  runMutation: RunMutation
  openSampleSearch: () => void
  openSimilarSearch: () => void
}

const pageSize = 100

export default function useAssetLibrarySearches({
  selectedIds,
  setSelectedIds,
  setError,
  runTask,
  runMutation,
  openSampleSearch,
  openSimilarSearch,
}: Options) {
  const [sampleResult, setSampleResult] = useState<AssetLibraryCategorySampleSearchResponse | null>(
    null,
  )
  const [similarResult, setSimilarResult] = useState<AssetLibrarySimilarSearchResponse | null>(null)
  const [sampleCategoryId, setSampleCategoryId] = useState(0)
  const [topK, setTopK] = useState(100)
  const [includeReviewed, setIncludeReviewed] = useState(false)
  const [sampleOffset, setSampleOffset] = useState(0)
  const [similarOffset, setSimilarOffset] = useState(0)
  const [similarCategoryId, setSimilarCategoryId] = useState(0)
  const sampleRequestId = useRef(0)
  const similarRequestId = useRef(0)
  const sampleTaskId = useRef('')
  const similarTaskId = useRef('')

  const samplePage = useMemo(
    () => sampleResult?.hits.slice(sampleOffset, sampleOffset + pageSize) || [],
    [sampleOffset, sampleResult],
  )
  const sampleScores = useMemo(
    () =>
      new Map(
        samplePage.map((hit) => [
          hit.item.asset.id,
          {
            score: hit.score,
            positiveScore: hit.positiveScore,
            negativeScore: hit.negativeScore,
            reviewState: hit.reviewState,
          },
        ]),
      ),
    [samplePage],
  )
  const similarPage = useMemo(
    () => similarResult?.hits.slice(similarOffset, similarOffset + pageSize) || [],
    [similarOffset, similarResult],
  )
  const similarScores = useMemo(
    () =>
      new Map(
        similarPage.map((hit) => [
          hit.item.asset.id,
          {
            score: hit.score,
            positiveScore: hit.positiveScore,
            negativeScore: hit.negativeScore,
            reviewState: hit.reviewState,
          },
        ]),
      ),
    [similarPage],
  )

  const loadSampleResults = useCallback(
    async (taskId = sampleTaskId.current) => {
      const requestId = ++sampleRequestId.current
      try {
        const response = await window.electronAPI.assetLibrary.getCategorySampleSearchResults(
          taskId ? { taskId } : undefined,
        )
        if (requestId !== sampleRequestId.current || (taskId && taskId !== sampleTaskId.current))
          return
        setSampleResult(response)
        setSampleOffset(0)
        setSelectedIds(new Set())
      } catch (loadError) {
        if (requestId === sampleRequestId.current) setError(errorMessage(loadError))
      }
    },
    [setError, setSelectedIds],
  )

  const loadSimilarResults = useCallback(
    async (taskId = similarTaskId.current) => {
      const requestId = ++similarRequestId.current
      try {
        const response = await window.electronAPI.assetLibrary.getSimilarSearchResults(
          taskId ? { taskId } : undefined,
        )
        if (requestId !== similarRequestId.current || (taskId && taskId !== similarTaskId.current))
          return
        setSimilarResult(response)
        setSimilarOffset(0)
        setSelectedIds(new Set())
      } catch (loadError) {
        if (requestId === similarRequestId.current) setError(errorMessage(loadError))
      }
    },
    [setError, setSelectedIds],
  )

  const trackTask = useCallback((progress: AssetLibraryTaskProgress | null) => {
    if (!progress) return
    if (
      progress.type === 'category_sample_search' &&
      (!sampleTaskId.current || sampleTaskId.current === '__pending__')
    )
      sampleTaskId.current = progress.taskId
    if (
      progress.type === 'asset_similar_search' &&
      (!similarTaskId.current || similarTaskId.current === '__pending__')
    )
      similarTaskId.current = progress.taskId
  }, [])

  const handleTaskProgress = useCallback(
    (progress: AssetLibraryTaskProgress) => {
      trackTask(progress)
      if (
        progress.state === 'done' &&
        progress.type === 'category_sample_search' &&
        progress.taskId === sampleTaskId.current
      )
        void loadSampleResults(progress.taskId)
      if (
        progress.state === 'done' &&
        progress.type === 'asset_similar_search' &&
        progress.taskId === similarTaskId.current
      )
        void loadSimilarResults(progress.taskId)
    },
    [loadSampleResults, loadSimilarResults, trackTask],
  )

  const startSample = useCallback(
    (categoryId = sampleCategoryId) => {
      if (!categoryId) {
        setError('Choose a category before starting sample search')
        return
      }
      setSampleCategoryId(categoryId)
      setSampleResult(null)
      setSampleOffset(0)
      setSelectedIds(new Set())
      openSampleSearch()
      sampleTaskId.current = '__pending__'
      sampleRequestId.current += 1
      void runTask(() =>
        window.electronAPI.assetLibrary.startCategorySampleSearch({
          categoryId,
          topK,
          includeReviewed,
        }),
      ).then((result) => {
        sampleTaskId.current = result?.taskId || ''
      })
    },
    [includeReviewed, openSampleSearch, runTask, sampleCategoryId, setError, setSelectedIds, topK],
  )

  const startSimilar = useCallback(
    (assetId: number, categoryId = similarCategoryId) => {
      setSimilarResult(null)
      setSimilarOffset(0)
      setSelectedIds(new Set())
      setSimilarCategoryId(categoryId || 0)
      openSimilarSearch()
      similarTaskId.current = '__pending__'
      similarRequestId.current += 1
      void runTask(() =>
        window.electronAPI.assetLibrary.startSimilarSearch({
          assetId,
          topK,
          ...(categoryId > 0 ? { categoryId } : {}),
          includeReviewed,
        }),
      ).then((result) => {
        similarTaskId.current = result?.taskId || ''
      })
    },
    [includeReviewed, openSimilarSearch, runTask, setSelectedIds, similarCategoryId, topK],
  )

  const reviewSelection = useCallback(
    <T extends AssetLibraryCategorySampleSearchResponse | AssetLibrarySimilarSearchResponse>(
      positive: boolean,
      categoryId: number,
      setResult: React.Dispatch<React.SetStateAction<T | null>>,
    ) => {
      const assetIds = [...selectedIds]
      void runMutation(async () => {
        const result = await window.electronAPI.assetLibrary.setCategorySampleFeedback(
          assetIds,
          categoryId,
          positive,
        )
        if (!result.ok) {
          throw new Error(
            result.error ||
              (positive ? 'Could not save relevant samples' : 'Could not save negative samples'),
          )
        }
        const reviewedIds = new Set(assetIds)
        setResult((current) =>
          current
            ? {
                ...current,
                hits: current.hits.map((hit) =>
                  reviewedIds.has(hit.item.asset.id)
                    ? { ...hit, reviewState: positive ? 'positive' : 'negative' }
                    : hit,
                ),
              }
            : current,
        )
        setSelectedIds(new Set())
        return result
      })
    },
    [runMutation, selectedIds, setSelectedIds],
  )

  const setSampleCategory = useCallback((categoryId: number) => {
    setSampleCategoryId(categoryId)
    setSampleResult(null)
    setSampleOffset(0)
  }, [])

  const clearSample = useCallback(() => {
    setSampleResult(null)
    setSampleOffset(0)
    setSelectedIds(new Set())
  }, [setSelectedIds])

  const clearSimilar = useCallback(() => {
    setSimilarResult(null)
    setSimilarOffset(0)
    setSelectedIds(new Set())
  }, [setSelectedIds])

  const reset = useCallback(() => {
    sampleRequestId.current += 1
    similarRequestId.current += 1
    sampleTaskId.current = ''
    similarTaskId.current = ''
    setSampleResult(null)
    setSimilarResult(null)
    setSampleOffset(0)
    setSimilarOffset(0)
  }, [])

  return {
    pageSize,
    sampleResult,
    sampleCategoryId,
    sampleOffset,
    samplePage,
    sampleScores,
    similarResult,
    similarCategoryId,
    similarOffset,
    similarPage,
    similarScores,
    topK,
    includeReviewed,
    setSampleCategory,
    setSimilarCategoryId,
    setTopK,
    setIncludeReviewed,
    setSampleOffset,
    setSimilarOffset,
    loadSampleResults,
    loadSimilarResults,
    trackTask,
    handleTaskProgress,
    startSample,
    startSimilar,
    reviewSample: (positive: boolean) =>
      reviewSelection(positive, sampleCategoryId, setSampleResult),
    reviewSimilar: (positive: boolean) =>
      reviewSelection(positive, similarCategoryId, setSimilarResult),
    clearSample,
    clearSimilar,
    reset,
  }
}
