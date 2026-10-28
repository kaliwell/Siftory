import { useRef, useState } from 'react'
import type { AssetCollection } from '../../../shared/ipc-contract'
import { notifyAssetCollectionsChanged } from '../../hooks/useAssetCollections'
import { useTranslation } from '../../i18n/useTranslation'

export default function AssetCollectionCreateForm({
  onCreated,
  onCancel,
}: {
  onCreated: (collection: AssetCollection) => Promise<void>
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  return (
    <form
      className="asset-library-create-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (pending.current || !name.trim()) return
        pending.current = true
        setBusy(true)
        setError('')
        void (async () => {
          try {
            const collection = await window.electronAPI.assetLibrary.createCollection(name.trim())
            notifyAssetCollectionsChanged()
            await onCreated(collection)
          } catch (failure) {
            setError(failure instanceof Error ? t(failure.message) : t('The operation failed.'))
          } finally {
            pending.current = false
            setBusy(false)
          }
        })()
      }}
    >
      <input
        autoFocus
        data-testid="collection-name"
        maxLength={120}
        value={name}
        disabled={busy}
        aria-label={t('Collection name')}
        placeholder={t('Collection name')}
        onChange={(event) => setName(event.target.value)}
      />
      <button type="submit" disabled={busy || !name.trim()}>
        {t('Create')}
      </button>
      <button type="button" disabled={busy} onClick={onCancel}>
        {t('Cancel')}
      </button>
      {error && <span role="alert">{error}</span>}
    </form>
  )
}
