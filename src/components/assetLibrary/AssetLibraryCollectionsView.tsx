import AssetLibraryControls from './AssetLibraryControls'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AssetCollectionItem } from '../../../shared/ipc-contract'
import { useAssetCollections } from '../../hooks/useAssetCollections'
import { useTranslation } from '../../i18n/useTranslation'
import ThumbnailImage from '../filemanager/ThumbnailImage'
import AssetCollectionCreateForm from './AssetCollectionCreateForm'

const PAGE_SIZE = 60

export default function AssetLibraryCollectionsView({
  onBrowseAssets,
}: {
  onBrowseAssets: () => void
}) {
  const { t } = useTranslation()
  const {
    collections,
    collectionId,
    setCollectionId,
    refreshCollections,
    error: collectionsError,
  } = useAssetCollections()
  const [snapshot, setSnapshot] = useState<{ id: number; items: AssetCollectionItem[] }>({
    id: 0,
    items: [],
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const request = useRef(0)
  const load = useCallback(async () => {
    const generation = ++request.current
    setLoading(true)
    setError('')
    try {
      const items = collectionId
        ? await window.electronAPI.assetLibrary.listCollectionItems(collectionId)
        : []
      if (generation !== request.current) return
      setSnapshot({ id: collectionId, items })
    } catch (failure) {
      if (generation === request.current)
        setError(failure instanceof Error ? t(failure.message) : t('The operation failed.'))
    } finally {
      if (generation === request.current) setLoading(false)
    }
  }, [collectionId, t])
  useEffect(() => {
    void load()
    return () => {
      request.current += 1
    }
  }, [load])
  const items = useMemo(
    () => (snapshot.id === collectionId ? snapshot.items : []),
    [snapshot, collectionId],
  )
  const filtered = useMemo(
    () =>
      items.filter(
        (item) =>
          (kind === 'all' ||
            (kind === 'image' ? item.mediaType === 'image' : item.mediaType !== 'image')) &&
          `${item.displayName} ${item.displayPath}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
      ),
    [items, kind, query],
  )
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1))
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
  const changeCollection = (id: number) => {
    setCollectionId(id)
    setSelected(new Set())
    setPage(0)
  }
  const fileAction = async (item: AssetCollectionItem, reveal = false) => {
    setError('')
    try {
      const result = reveal
        ? await window.electronAPI.assetIdentity.revealOriginal(item.assetId || item.displayPath)
        : item.videoId
          ? await window.electronAPI.mediaSearch.openMediaAtTime({
              videoId: item.videoId,
              timestampMs: item.videoHitMs ?? 0,
            })
          : await window.electronAPI.assetIdentity.openOriginal(item.assetId || item.displayPath)
      if (!result.ok) throw new Error(result.error || t('The operation failed.'))
    } catch (failure) {
      setError(failure instanceof Error ? t(failure.message) : t('The operation failed.'))
    }
  }
  const removeSelected = async () => {
    if (pending.current) return
    const ids = items.filter((item) => selected.has(item.id)).map((item) => item.id)
    if (!ids.length) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      for (const id of ids) {
        const result = await window.electronAPI.assetLibrary.removeCollectionItem(id)
        if (!result.ok) throw new Error(result.error || t('The operation failed.'))
        setSnapshot((value) => ({ ...value, items: value.items.filter((item) => item.id !== id) }))
        setSelected((value) => {
          const next = new Set(value)
          next.delete(id)
          return next
        })
      }
    } catch (failure) {
      setError(failure instanceof Error ? t(failure.message) : t('The operation failed.'))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <section className="asset-library-collections" data-testid="asset-library-collections-view">
      <AssetLibraryControls>
        <div className="asset-library-collection-toolbar">
          <select
            data-testid="collection-browse-select"
            aria-label={t('Choose collection')}
            disabled={busy}
            value={collectionId}
            onChange={(event) => changeCollection(Number(event.target.value))}
          >
            <option value={0}>{t('Choose collection')}</option>
            {collections.map((collection) => (
              <option key={collection.id} value={collection.id}>
                {collection.name}
              </option>
            ))}
          </select>
          <button
            className="workspace-button-primary"
            data-testid="collection-create"
            onClick={() => setCreating((value) => !value)}
            disabled={busy}
          >
            {t('New collection')}
          </button>
          <button onClick={() => void load()} disabled={busy || loading}>
            {t('Refresh')}
          </button>
        </div>
        {creating && (
          <AssetCollectionCreateForm
            onCancel={() => setCreating(false)}
            onCreated={async (collection) => {
              await refreshCollections()
              changeCollection(collection.id)
              setCreating(false)
            }}
          />
        )}
        <div className="asset-library-query-bar">
          <input
            data-testid="collection-filter-query"
            aria-label={t('Find in collection')}
            placeholder={t('Find in collection')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setPage(0)
              setSelected(new Set())
            }}
          />
          <details className="workspace-disclosure">
            <summary>{t('Library filters')}</summary>
            <select
              aria-label={t('Media type')}
              value={kind}
              onChange={(event) => {
                setKind(event.target.value)
                setPage(0)
                setSelected(new Set())
              }}
            >
              <option value="all">{t('All media types')}</option>
              <option value="image">{t('Images')}</option>
              <option value="video">{t('Videos and frames')}</option>
            </select>
          </details>
          {(query || kind !== 'all') && (
            <button
              onClick={() => {
                setQuery('')
                setKind('all')
                setPage(0)
                setSelected(new Set())
              }}
            >
              {t('Clear filters')}
            </button>
          )}
        </div>
        {(error || collectionsError) && (
          <div role="alert" className="asset-library-error">
            {error || t(collectionsError)}
            <button
              onClick={() =>
                void refreshCollections()
                  .then(load)
                  .catch(() => {})
              }
            >
              {t('Retry')}
            </button>
          </div>
        )}
        {selected.size > 0 && (
          <div className="asset-library-selection-bar">
            <strong>{t('{count} selected', { count: selected.size })}</strong>
            <button
              data-testid="collection-remove-selected"
              disabled={busy}
              onClick={() => void removeSelected()}
            >
              {t('Remove from collection')}
            </button>
            <span>{t('Original files are kept.')}</span>
            <button disabled={busy} onClick={() => setSelected(new Set())}>
              {t('Clear selection')}
            </button>
          </div>
        )}
      </AssetLibraryControls>
      {loading || !visible.length ? (
        <div className="asset-library-empty">
          <strong>
            {t(
              loading
                ? 'Loading'
                : !collectionId
                  ? 'Create a collection for your references'
                  : items.length === 0
                    ? 'This collection is empty'
                    : 'No assets match the current filters.',
            )}
          </strong>
          {!loading && (
            <p>
              {t(
                !collectionId || items.length === 0
                  ? 'Select assets and add them to a collection. Original files stay in place.'
                  : 'Try another keyword or clear the filters.',
              )}
            </p>
          )}
          {!loading && (!collectionId || items.length === 0) && (
            <button onClick={onBrowseAssets}>{t('Browse assets to collect')}</button>
          )}
        </div>
      ) : (
        <div className="asset-library-collection-grid">
          {visible.map((item) => (
            <article
              key={item.id}
              className="asset-library-collection-card"
              data-selected={selected.has(item.id)}
            >
              <div className="asset-library-collection-preview">
                <ThumbnailImage
                  filePath={item.displayPath}
                  ext={'.' + (item.displayPath.split('.').pop() || '')}
                  isDirectory={false}
                  viewMode="xlarge-icon"
                  targetSize={256}
                  style={{ width: '100%', height: '100%' }}
                  imgStyle={{ width: '100%', height: '100%', objectFit: 'contain' }}
                />
                <input
                  data-testid="collection-item-select"
                  type="checkbox"
                  disabled={busy}
                  checked={selected.has(item.id)}
                  aria-label={t('Select {name}', { name: item.displayName })}
                  onChange={(event) => {
                    const checked = event.target.checked
                    setSelected((value) => {
                      const next = new Set(value)
                      if (checked) next.add(item.id)
                      else next.delete(item.id)
                      return next
                    })
                  }}
                />
              </div>
              <strong title={item.displayPath}>{item.displayName}</strong>
              <small>{item.source.name}</small>
              <div className="asset-library-card-actions">
                <button onClick={() => void fileAction(item)}>{t('Open')}</button>
                <button onClick={() => void fileAction(item, true)}>{t('Folder')}</button>
              </div>
            </article>
          ))}
        </div>
      )}
      <div className="asset-library-pagination">
        <span>{t('{count} items', { count: filtered.length })}</span>
        <div>
          <button
            disabled={currentPage === 0 || loading}
            onClick={() => {
              setPage(currentPage - 1)
              setSelected(new Set())
            }}
          >
            {t('Previous')}
          </button>
          <button
            disabled={(currentPage + 1) * PAGE_SIZE >= filtered.length || loading}
            onClick={() => {
              setPage(currentPage + 1)
              setSelected(new Set())
            }}
          >
            {t('Next')}
          </button>
        </div>
      </div>
    </section>
  )
}
