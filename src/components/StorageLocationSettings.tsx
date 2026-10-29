import React, { useEffect, useState } from 'react'
import type {
  StorageLocationStatus,
  StorageMigrationSelection,
} from '../../shared/ipc/storage-location'
import { useTranslation } from '../i18n/useTranslation'

export default function StorageLocationSettings() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<StorageLocationStatus | null>(null)
  const [selection, setSelection] = useState<StorageMigrationSelection | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let mounted = true
    const api = window.electronAPI.storageLocation
    if (!api) return
    void api
      .getStatus()
      .then((value) => {
        if (mounted) setStatus(value)
      })
      .catch(() => {
        if (mounted) setError(t('Data location is unavailable'))
      })
    return () => {
      mounted = false
    }
  }, [t])
  const choose = async () => {
    setBusy(true)
    setError('')
    setSelection(null)
    try {
      setSelection(await window.electronAPI.storageLocation.selectDestination())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('The operation failed.'))
    } finally {
      setBusy(false)
    }
  }
  const migrate = async () => {
    if (!selection) return
    setBusy(true)
    setError('')
    try {
      const result = await window.electronAPI.storageLocation.startMigration(selection.token)
      if (result.scheduled) return
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('The operation failed.'))
    }
    setSelection(null)
    setBusy(false)
  }
  return (
    <section className="automatic-maintenance" data-testid="storage-location-settings">
      <h3>{t('Application data location')}</h3>
      <p>
        {t(
          'Move indexes, vectors, library metadata and generated caches together. Original media stays in place.',
        )}
      </p>
      {status && (
        <>
          <p style={{ overflowWrap: 'anywhere' }} data-testid="storage-location-current">
            {status.root}
          </p>
          {status.previousRoot && (
            <p style={{ overflowWrap: 'anywhere' }}>
              {t('Previous data directory retained')}: {status.previousRoot}
            </p>
          )}
          {status.lastMigration?.state === 'failed' && (
            <p role="status">
              {t('The last migration stopped. The original data is still active.')}
            </p>
          )}
          {status.externalMediaDirectory && (
            <p role="status">
              {t('Remove the custom video cache environment override before migrating data')}
            </p>
          )}
          <button
            data-testid="storage-location-choose"
            disabled={busy || status.pending || status.externalMediaDirectory}
            onClick={() => void choose()}
          >
            {t('Choose new data location')}
          </button>
        </>
      )}
      {selection && (
        <div>
          <p style={{ overflowWrap: 'anywhere' }} data-testid="storage-location-destination">
            {selection.destination}
          </p>
          <p>
            {t(
              'Siftory will restart, copy and verify the data, then switch locations. The old directory is kept.',
            )}
          </p>
          <button
            data-testid="storage-location-migrate"
            disabled={busy}
            onClick={() => void migrate()}
          >
            {t('Restart and migrate')}
          </button>
          <button disabled={busy} onClick={() => setSelection(null)}>
            {t('Cancel')}
          </button>
        </div>
      )}
      {busy && <p role="status">{t('Please wait...')}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
