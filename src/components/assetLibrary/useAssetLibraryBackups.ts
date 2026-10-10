import { useCallback, useEffect, useState } from 'react'
import type { AssetLibraryBackupSummary } from '../../../shared/ipc-contract'
import {
  assetLibraryErrorMessage as errorMessage,
  formatAssetLibraryBytes as formatBytes,
} from './assetLibraryViewUtils'

interface RestoreResult {
  restoredFiles?: number
  protectiveBackupId?: string
}

interface Options {
  setError: (message: string) => void
  onRestored: (result: RestoreResult) => Promise<void>
}

export default function useAssetLibraryBackups({ setError, onRestored }: Options) {
  const [open, setOpen] = useState(false)
  const [backups, setBackups] = useState<AssetLibraryBackupSummary[]>([])
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [backupPassphrase, setBackupPassphrase] = useState('')
  const [backupPassphraseConfirmation, setBackupPassphraseConfirmation] = useState('')
  const [restoreArmedId, setRestoreArmedId] = useState('')
  const [deleteArmedId, setDeleteArmedId] = useState('')
  const [verification, setVerification] = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    try {
      setBackups(await window.electronAPI.assetLibrary.listBackups())
    } catch (loadError) {
      setError(errorMessage(loadError))
    }
  }, [setError])

  useEffect(() => {
    if (open) void load()
  }, [load, open])

  useEffect(() => {
    if (!open) {
      setBackupPassphrase('')
      setBackupPassphraseConfirmation('')
    }
  }, [open])

  useEffect(() => {
    if (!restoreArmedId) return
    const timer = window.setTimeout(() => setRestoreArmedId(''), 5000)
    return () => window.clearTimeout(timer)
  }, [restoreArmedId])

  useEffect(() => {
    if (!deleteArmedId) return
    const timer = window.setTimeout(() => setDeleteArmedId(''), 5000)
    return () => window.clearTimeout(timer)
  }, [deleteArmedId])

  const toggle = useCallback(() => {
    setOpen((current) => !current)
    setError('')
    setMessage('')
  }, [setError])

  const create = useCallback(async () => {
    setBusy('create')
    setMessage('')
    setError('')
    try {
      const result = await window.electronAPI.assetLibrary.createBackup()
      if (!result.ok || !result.backup) throw new Error(result.error || 'Backup was not created')
      setMessage(`Created ${new Date(result.backup.createdAt).toLocaleString()}`)
      await load()
    } catch (backupError) {
      setError(errorMessage(backupError))
    } finally {
      setBusy('')
    }
  }, [load, setError])

  const verify = useCallback(
    async (backupId: string) => {
      setBusy(`verify:${backupId}`)
      setMessage('')
      setError('')
      try {
        const result = await window.electronAPI.assetLibrary.verifyBackup(backupId)
        setVerification((current) => ({ ...current, [backupId]: result.ok }))
        if (!result.ok) throw new Error(result.error || 'Backup verification failed')
        setMessage(`Verified ${result.fileCount} files (${formatBytes(result.totalBytes)})`)
      } catch (backupError) {
        setError(errorMessage(backupError))
      } finally {
        setBusy('')
      }
    },
    [setError],
  )

  const restore = useCallback(
    async (backupId: string) => {
      if (restoreArmedId !== backupId) {
        setRestoreArmedId(backupId)
        return
      }
      setRestoreArmedId('')
      setBusy(`restore:${backupId}`)
      setMessage('')
      setError('')
      try {
        const result = await window.electronAPI.assetLibrary.restoreBackup(backupId)
        if (!result.ok) throw new Error(result.error || 'Backup restore failed')
        await onRestored(result)
        await load()
        setMessage(
          `Restored ${result.restoredFiles || 0} files; protection ${result.protectiveBackupId || '-'}`,
        )
      } catch (backupError) {
        setError(errorMessage(backupError))
      } finally {
        setBusy('')
      }
    },
    [load, onRestored, restoreArmedId, setError],
  )

  const exportBackup = useCallback(
    async (backupId: string) => {
      if (backupPassphrase !== backupPassphraseConfirmation) {
        setError('Backup passwords do not match')
        return
      }
      setBusy(`export:${backupId}`)
      setMessage('')
      setError('')
      try {
        const result = await window.electronAPI.assetLibrary.exportBackup(
          backupId,
          backupPassphrase,
        )
        if (result.canceled) return
        if (!result.ok || !result.path) throw new Error(result.error || 'Backup export failed')
        setMessage(`Exported to ${result.path}`)
        setBackupPassphrase('')
        setBackupPassphraseConfirmation('')
      } catch (backupError) {
        setError(errorMessage(backupError))
      } finally {
        setBusy('')
      }
    },
    [backupPassphrase, backupPassphraseConfirmation, setError],
  )

  const importBackup = useCallback(async () => {
    setBusy('import')
    setMessage('')
    setError('')
    try {
      const result = await window.electronAPI.assetLibrary.importBackup(backupPassphrase)
      if (result.canceled) return
      if (!result.ok || !result.backupId) throw new Error(result.error || 'Backup import failed')
      setMessage(`Imported ${result.backupId}`)
      setBackupPassphrase('')
      setBackupPassphraseConfirmation('')
      await load()
    } catch (backupError) {
      setError(errorMessage(backupError))
    } finally {
      setBusy('')
    }
  }, [backupPassphrase, load, setError])

  const deleteBackup = useCallback(
    async (backupId: string) => {
      if (deleteArmedId !== backupId) {
        setDeleteArmedId(backupId)
        return
      }
      setDeleteArmedId('')
      setBusy(`delete:${backupId}`)
      setMessage('')
      setError('')
      try {
        const result = await window.electronAPI.assetLibrary.deleteBackup(backupId)
        if (!result.ok) throw new Error(result.error || 'Backup delete failed')
        setVerification((current) => {
          const next = { ...current }
          delete next[backupId]
          return next
        })
        setMessage(`Deleted ${backupId}`)
        await load()
      } catch (backupError) {
        setError(errorMessage(backupError))
      } finally {
        setBusy('')
      }
    },
    [deleteArmedId, load, setError],
  )

  return {
    open,
    backups,
    busy,
    message,
    restoreArmedId,
    deleteArmedId,
    verification,
    backupPassphrase,
    backupPassphraseConfirmation,
    setBackupPassphrase,
    setBackupPassphraseConfirmation,
    setOpen,
    toggle,
    load,
    create,
    verify,
    restore,
    export: exportBackup,
    import: importBackup,
    delete: deleteBackup,
  }
}
