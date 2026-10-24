import React, { useEffect, useRef, useState } from 'react'
import '../styles/automatic-maintenance.css'
import type { AutomaticMaintenanceStatus } from '../../shared/ipc-contract'
import { useTranslation } from '../i18n/useTranslation'

export default function AutomaticMaintenancePanel({
  suggestedScopes,
}: {
  suggestedScopes: string[]
}) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<AutomaticMaintenanceStatus | null>(null)
  const [scopes, setScopes] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    let first = true
    const refresh = async () => {
      try {
        const value = await window.electronAPI.sourceDerivedData.autoStatus()
        if (!value?.config || !Array.isArray(value.config.scopes))
          throw new Error(t('Automatic maintenance is unavailable'))
        if (!mounted.current) return
        setStatus(value)
        if (first) {
          first = false
          setScopes(value.config.scopes.length ? value.config.scopes : suggestedScopes)
        }
      } catch (reason) {
        if (mounted.current)
          setError(reason instanceof Error ? reason.message : t('The operation failed.'))
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => {
      mounted.current = false
      window.clearInterval(timer)
    }
  }, [suggestedScopes, t])
  const save = async (enabled: boolean, nextScopes = scopes) => {
    setBusy(true)
    setError('')
    try {
      const value = await window.electronAPI.sourceDerivedData.setAutomaticMaintenance({
        enabled,
        scopes: nextScopes,
      })
      if (mounted.current) {
        setStatus(value)
        setScopes(value.config.scopes)
      }
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : t('The operation failed.'))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const running = status && ['checking', 'syncing', 'recycling'].includes(status.phase)
  const phases = {
    disabled: 'Disabled',
    waiting: 'Waiting for idle time',
    checking: 'Checking missing files',
    syncing: 'Updating indexes',
    recycling: 'Recycling vectors',
    completed: 'Last check completed',
    error: 'Needs attention',
  }
  return (
    <section className="automatic-maintenance-card" data-testid="automatic-maintenance">
      <div className="automatic-maintenance-heading">
        <div>
          <h3>{t('Automatic maintenance')}</h3>
          <p>
            {t(
              'Checks daily while idle. Missing files are observed for 24 hours. Recovery backups are kept for 7 days.',
            )}
          </p>
        </div>
        <label>
          <input
            data-testid="automatic-maintenance-enabled"
            type="checkbox"
            checked={status?.config.enabled ?? false}
            disabled={!status}
            onChange={(event) => void save(event.target.checked)}
          />
          {t('Enable automatic maintenance')}
        </label>
      </div>
      <div className="automatic-maintenance-scopes">
        <span>{t('Watched folders')}</span>
        {scopes.map((scope) => (
          <span className="automatic-maintenance-scope" key={scope} title={scope}>
            {scope}
            <button
              aria-label={t('Remove {name}', { name: scope })}
              disabled={busy || Boolean(running)}
              onClick={() => {
                const next = scopes.filter((value) => value !== scope)
                if (status?.config.enabled) void save(next.length > 0, next)
                else setScopes(next)
              }}
            >
              ×
            </button>
          </span>
        ))}
        <button
          disabled={busy || Boolean(running)}
          onClick={() =>
            void window.electronAPI
              .browseFolder()
              .then((folder) => {
                if (!folder || !mounted.current || scopes.includes(folder)) return
                const next = [...scopes, folder]
                if (status?.config.enabled) void save(true, next)
                else setScopes(next)
              })
              .catch(() => setError(t('The operation failed.')))
          }
        >
          {t('Add folder')}
        </button>
      </div>
      <div className="automatic-maintenance-status" role="status">
        <strong>{status ? t(phases[status.phase]) : t('Loading')}</strong>
        {status?.lastCheckAt && (
          <span>
            {t('Last check')}: {new Date(status.lastCheckAt).toLocaleString()}
          </span>
        )}
        {status?.nextCheckAt && status.config.enabled && (
          <span>
            {t('Next check')}: {new Date(status.nextCheckAt).toLocaleString()}
          </span>
        )}
        {status && (
          <span>
            {t('Observed missing')}: {status.pendingMissing} · {t('Updated images')}:{' '}
            {status.removedImages} · {t('Updated videos')}: {status.missingVideos}
          </span>
        )}
        {Boolean(status?.recoveredBytes) && (
          <span>
            {t('Freed space')}:{' '}
            {t('{size} MiB', { size: (status!.recoveredBytes / 1024 ** 2).toFixed(1) })}
          </span>
        )}
        {Boolean(status?.pendingReleaseBytes) && (
          <span>
            {t('Recovery backups pending release')}:{' '}
            {t('{size} MiB', { size: (status!.pendingReleaseBytes / 1024 ** 2).toFixed(1) })}
          </span>
        )}
        {status?.message && <p>{t(status.message)}</p>}
        {error && <p role="alert">{t(error)}</p>}
      </div>
      <div className="automatic-maintenance-actions">
        <small>
          {t(
            'Offline folders and inaccessible files are preserved. Large deletion batches require manual review.',
          )}
        </small>
        <button
          data-testid="automatic-maintenance-check"
          disabled={busy || !status?.config.enabled || Boolean(running)}
          onClick={() => {
            setBusy(true)
            setError('')
            void window.electronAPI.sourceDerivedData
              .startAutomaticMaintenanceCheck()
              .then((value) => {
                if (mounted.current) setStatus(value)
              })
              .catch((reason) => {
                if (mounted.current)
                  setError(reason instanceof Error ? reason.message : t('The operation failed.'))
              })
              .finally(() => {
                if (mounted.current) setBusy(false)
              })
          }}
        >
          {t('Check now')}
        </button>
      </div>
    </section>
  )
}
