import { useCallback, useEffect, useState } from 'react'
import type { AssetCollection } from '../../shared/ipc-contract'

const COLLECTIONS_CHANGED_EVENT = 'asset-collections-changed'

export function notifyAssetCollectionsChanged(): void {
  window.dispatchEvent(new Event(COLLECTIONS_CHANGED_EVENT))
}

export function useAssetCollections() {
  const [collections, setCollections] = useState<AssetCollection[]>([])
  const [collectionId, setCollectionId] = useState(0)
  const refreshCollections = useCallback(async () => {
    const list = await window.electronAPI.assetLibrary.listCollections()
    setCollections(list)
    setCollectionId((current) =>
      current && list.some((item) => item.id === current) ? current : (list[0]?.id ?? 0),
    )
  }, [])

  useEffect(() => {
    const refresh = () => void refreshCollections().catch(() => {})
    refresh()
    window.addEventListener(COLLECTIONS_CHANGED_EVENT, refresh)
    window.addEventListener('focus', refresh)
    return () => {
      window.removeEventListener(COLLECTIONS_CHANGED_EVENT, refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [refreshCollections])

  return { collectionId, collections, refreshCollections, setCollectionId }
}
