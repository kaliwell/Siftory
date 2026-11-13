import React, { useEffect, useRef, useState } from 'react'
import type { DataSource } from '../../shared/ipc/discovery-catalog'
import { useTranslation } from '../i18n/useTranslation'

/** Reuse registered filesystem roots without starting a second catalog scan. */
export default function RegisteredSourcePicker({
  onPick,
  disabled = false,
}: {
  onPick: (root: string) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const [sources, setSources] = useState<DataSource[]>([])
  const mounted = useRef(false)
  const pending = useRef(false)
  const refresh = async () => {
    if (pending.current) return
    pending.current = true
    try {
      const list = await window.electronAPI.discoveryCatalog.listSources()
      if (mounted.current) {
        const local = list.filter(
          (source) =>
            !['sftp', 'nas-agent'].includes(source.type) &&
            /^(?:[a-z]:[\\/]|\\\\|\/)/i.test(source.rootLocator),
        )
        setSources(
          [
            ...new Map(
              local.map((source) => [source.rootLocator.replace(/\\/g, '/').toLowerCase(), source]),
            ).values(),
          ].sort((a, b) =>
            a.rootLocator.localeCompare(b.rootLocator, undefined, { numeric: true }),
          ),
        )
      }
    } catch {
      /* Folder browsing remains available when the catalog is unavailable. */
    } finally {
      pending.current = false
    }
  }
  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
    }
  }, [])
  return (
    <select
      className="registered-source-picker"
      aria-label={t('Registered folders')}
      value=""
      disabled={disabled}
      onFocus={() => void refresh()}
      onChange={(event) => {
        if (event.target.value) onPick(event.target.value)
      }}
    >
      <option value="">{t('Registered folders')}</option>
      {sources.map((source) => (
        <option
          key={source.id}
          value={source.rootLocator}
          disabled={source.availability === 'offline'}
        >
          {source.displayName} · {source.rootLocator}
        </option>
      ))}
    </select>
  )
}
