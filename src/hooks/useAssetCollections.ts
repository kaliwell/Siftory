import { useCallback, useEffect, useRef, useState } from 'react'
import type { AssetCollection } from '../../shared/ipc-contract'

const COLLECTIONS_CHANGED_EVENT = 'asset-collections-changed'

export function notifyAssetCollectionsChanged(): void {
  window.dispatchEvent(new Event(COLLECTIONS_CHANGED_EVENT))
}

export function useAssetCollections() {
  const [collections, setCollections] = useState<AssetCollection[]>([])
  const [collectionId, setCollectionId] = useState(0)
  const [error, setError] = useState('')
  const request = useRef(0)
  const active = useRef(true)
  const refreshCollections = useCallback(async () => {
    if (!active.current) return
    const generation = ++request.current
    let list: AssetCollection[]
    try {
      list = await window.electronAPI.assetLibrary.listCollections()
      if (!active.current || generation !== request.current) return
      setError('')
    } catch (failure) {
      if (active.current && generation === request.current)
        setError(failure instanceof Error ? failure.message : 'The operation failed.')
      throw failure
    }
    setCollections(list)
    setCollectionId((current) =>
      current && list.some((item) => item.id === current) ? current : (list[0]?.id ?? 0),
    )
  }, [])

  useEffect(() => {
    active.current = true
    const refresh = () => void refreshCollections().catch(() => {})
    refresh()
    window.addEventListener(COLLECTIONS_CHANGED_EVENT, refresh)
    window.addEventListener('focus', refresh)
    return () => {
      active.current = false
      request.current += 1
      window.removeEventListener(COLLECTIONS_CHANGED_EVENT, refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [refreshCollections])

  return { collectionId, collections, refreshCollections, setCollectionId, error }
}
