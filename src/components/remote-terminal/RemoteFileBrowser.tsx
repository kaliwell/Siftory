import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  RemoteFileEntry,
  RemoteTerminalProfile,
  RemoteTransferTask,
} from '../../../shared/ipc-contract'
import { useTranslation } from '../../i18n/useTranslation'

interface Props {
  profile: RemoteTerminalProfile
  credential?: string
  authKind: 'password' | 'passphrase' | 'none'
  refreshToken: number
  onClose: () => void
  onCredentialRequired: () => void
  onAuthenticated: (secret: string) => void
  onProfilesChanged: () => void
}

/** Quick-access Linux directories shown below the path bar. */
const LINUX_QUICK_DIRS = [
  { label: '/', path: '/' },
  { label: '/home', path: '/home' },
  { label: '/var/log', path: '/var/log' },
  { label: '/etc', path: '/etc' },
  { label: '/tmp', path: '/tmp' },
  { label: '/var/www', path: '/var/www' },
  { label: '/opt', path: '/opt' },
  { label: '/root', path: '/root' },
  { label: '/usr', path: '/usr' },
]

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function parentPath(remotePath: string): string {
  if (remotePath === '/' || remotePath === '.') return remotePath
  const trimmed = remotePath.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  if (index < 0) return '.'
  return index === 0 ? '/' : trimmed.slice(0, index)
}

export default function RemoteFileBrowser({
  profile,
  credential,
  authKind,
  refreshToken,
  onClose,
  onCredentialRequired,
  onAuthenticated,
  onProfilesChanged,
}: Props) {
  const { t } = useTranslation()
  const [remotePath, setRemotePath] = useState('.')
  const [pathInput, setPathInput] = useState('.')
  const [entries, setEntries] = useState<RemoteFileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [transfers, setTransfers] = useState<RemoteTransferTask[]>([])

  const credentialRequest = useMemo(
    () =>
      authKind === 'password'
        ? { password: credential }
        : authKind === 'passphrase'
          ? { passphrase: credential }
          : undefined,
    [authKind, credential],
  )

  const loadDirectory = useCallback(
    async (nextPath: string) => {
      setLoading(true)
      setError('')
      let result = await window.electronAPI.remoteTerminal.listRemoteDirectory(
        profile.id,
        nextPath,
        credentialRequest,
      )

      if (result.hostFingerprint && !profile.hostFingerprint) {
        const accepted = confirm(
          t(
            'First SFTP connection to {host}:{port}.\n\nVerify this SSH host fingerprint with the server administrator:\n{fingerprint}\n\nTrust and save this fingerprint?',
            {
              host: profile.host,
              port: profile.port || 22,
              fingerprint: result.hostFingerprint,
            },
          ),
        )
        if (accepted) {
          const saved = await window.electronAPI.remoteTerminal.saveProfile({
            ...profile,
            hostFingerprint: result.hostFingerprint,
          })
          if (saved.ok) {
            onProfilesChanged()
            result = await window.electronAPI.remoteTerminal.listRemoteDirectory(
              profile.id,
              nextPath,
              credentialRequest,
            )
          }
        }
      }

      setLoading(false)
      if (!result.ok) {
        setEntries([])
        setError(result.error || t('Remote directory read failed'))
        if (/password|passphrase is required/i.test(result.error || '')) onCredentialRequired()
        return
      }
      setEntries(result.entries)
      setRemotePath(result.path)
      setPathInput(result.path)
      if (credential) onAuthenticated(credential)
    },
    [
      credential,
      credentialRequest,
      onAuthenticated,
      onCredentialRequired,
      onProfilesChanged,
      profile,
      t,
    ],
  )

  const remotePathRef = useRef(remotePath)
  remotePathRef.current = remotePath
  const loadDirectoryRef = useRef(loadDirectory)
  loadDirectoryRef.current = loadDirectory

  useEffect(() => {
    loadDirectoryRef.current(remotePathRef.current)
    // refreshToken intentionally triggers a reload after credential entry.
  }, [profile.id, refreshToken])

  useEffect(() => {
    window.electronAPI.remoteTerminal.listTransfers().then(setTransfers)
    return window.electronAPI.remoteTerminal.onTransferChanged((changedTask) => {
      setTransfers((current) => {
        const next = current.filter((task) => task.id !== changedTask.id)
        next.unshift(changedTask)
        return next
      })
    })
  }, [])

  const handleUpload = async () => {
    const selection = await window.electronAPI.remoteTerminal.chooseUploadFile()
    if (!selection.ok || !selection.token) return
    const result = await window.electronAPI.remoteTerminal.enqueueUpload(
      profile.id,
      remotePath,
      selection.token,
      credentialRequest,
    )
    if (!result.ok) setError(result.error || t('Upload could not be queued'))
  }

  const handleDownload = async (entry: RemoteFileEntry) => {
    const selection = await window.electronAPI.remoteTerminal.chooseDownloadDirectory()
    if (!selection.ok || !selection.token) return
    const result = await window.electronAPI.remoteTerminal.enqueueDownload(
      profile.id,
      entry.path,
      entry.size,
      selection.token,
      credentialRequest,
    )
    if (!result.ok) setError(result.error || t('Download could not be queued'))
  }

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        background: 'rgba(var(--bg), 0.97)',
        color: 'rgb(var(--date))',
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 3,
          alignItems: 'center',
          padding: '3px 5px',
          borderBottom: '1px solid rgba(var(--date), 0.15)',
          flexWrap: 'wrap',
        }}
      >
        <button onClick={onClose} style={{ fontSize: 10, padding: '2px 5px', flexShrink: 0 }}>
          ←
        </button>
        <button
          onClick={() => loadDirectory(parentPath(remotePath))}
          disabled={loading || remotePath === '/' || remotePath === '.'}
          style={{ fontSize: 10, padding: '2px 5px', flexShrink: 0 }}
        >
          ↑
        </button>
        <input
          value={pathInput}
          onChange={(event) => setPathInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') loadDirectory(pathInput)
          }}
          aria-label={t('Remote path')}
          style={{
            flex: 1,
            minWidth: 60,
            fontSize: 10,
            padding: '2px 5px',
            background: 'rgba(var(--bg), 0.8)',
            border: '1px solid rgba(var(--date), 0.25)',
            color: 'rgb(var(--date))',
            borderRadius: 3,
            outline: 'none',
          }}
        />
        <button
          onClick={() => loadDirectory(pathInput)}
          disabled={loading}
          style={{ fontSize: 10, padding: '2px 5px', flexShrink: 0 }}
        >
          {loading ? '···' : '↻'}
        </button>
        <button
          onClick={handleUpload}
          disabled={loading}
          style={{ fontSize: 10, padding: '2px 6px', flexShrink: 0 }}
        >
          ↑ {t('Upload')}
        </button>
      </div>

      {/* Quick-access Linux directories */}
      <div
        style={{
          display: 'flex',
          gap: 3,
          padding: '2px 6px',
          flexWrap: 'wrap',
          borderBottom: '1px solid rgba(var(--date), 0.06)',
        }}
      >
        {LINUX_QUICK_DIRS.map((d) => (
          <button
            key={d.path}
            onClick={() => loadDirectory(d.path)}
            disabled={loading}
            title={d.path}
            style={{
              fontSize: 9,
              padding: '1px 6px',
              background:
                remotePath === d.path ? 'rgba(var(--date), 0.14)' : 'rgba(var(--date), 0.06)',
              border: '1px solid rgba(var(--date), 0.12)',
              borderRadius: 3,
              cursor: 'pointer',
              color: 'rgb(var(--date))',
              whiteSpace: 'nowrap',
            }}
          >
            {d.label}
          </button>
        ))}
      </div>

      <div style={{ padding: '3px 6px', fontSize: 9, opacity: 0.7 }}>
        {t('SFTP')} · {profile.username}@{profile.host}:{profile.port || 22} · {entries.length}{' '}
        {t('items')}
      </div>

      {error && (
        <div style={{ padding: '5px 8px', color: 'rgb(255,140,120)', fontSize: 10 }}>{error}</div>
      )}

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {entries.map((entry) => (
          <div
            key={entry.path}
            onDoubleClick={() => {
              if (entry.type === 'directory') loadDirectory(entry.path)
            }}
            title={entry.path}
            style={{
              display: 'grid',
              gridTemplateColumns: '22px minmax(120px, 1fr) 90px 130px 70px',
              gap: 4,
              padding: '3px 7px',
              fontSize: 10,
              cursor: entry.type === 'directory' ? 'pointer' : 'default',
              borderBottom: '1px solid rgba(var(--date), 0.05)',
            }}
          >
            <span>
              {entry.type === 'directory' ? '📁' : entry.type === 'symlink' ? '🔗' : '📄'}
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {entry.name}
            </span>
            <span style={{ textAlign: 'right', opacity: 0.72 }}>
              {entry.type === 'directory' ? '' : formatBytes(entry.size)}
            </span>
            <span style={{ opacity: 0.62 }}>
              {entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : ''}
            </span>
            <span style={{ textAlign: 'right' }}>
              {entry.type === 'file' && (
                <button
                  onClick={(event) => {
                    event.stopPropagation()
                    handleDownload(entry)
                  }}
                  style={{ fontSize: 9, padding: '1px 5px' }}
                >
                  {t('Download')}
                </button>
              )}
            </span>
          </div>
        ))}
        {!loading && !error && entries.length === 0 && (
          <div style={{ padding: 12, textAlign: 'center', opacity: 0.55 }}>
            {t('Empty directory')}
          </div>
        )}
      </div>
      <div
        style={{
          maxHeight: 150,
          overflow: 'auto',
          borderTop: '1px solid rgba(var(--date), 0.14)',
          padding: '3px 6px',
        }}
      >
        <div
          style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, opacity: 0.72 }}
        >
          <span>{t('Transfers')}</span>
          <button
            onClick={async () => {
              await window.electronAPI.remoteTerminal.clearTransferHistory()
              setTransfers(await window.electronAPI.remoteTerminal.listTransfers())
            }}
            style={{ fontSize: 8, padding: '0 4px' }}
          >
            {t('Clear finished')}
          </button>
        </div>
        {transfers
          .filter((task) => task.profileId === profile.id)
          .slice(0, 20)
          .map((task) => {
            const percent = task.totalBytes
              ? Math.min(100, Math.round((task.transferredBytes / task.totalBytes) * 100))
              : 0
            return (
              <div key={task.id} style={{ marginTop: 3, fontSize: 9 }}>
                <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                  <span>{task.direction === 'upload' ? '↑' : '↓'}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {task.sourceDisplayName}
                  </span>
                  <span>{task.state}</span>
                  {(task.state === 'queued' ||
                    task.state === 'preparing' ||
                    task.state === 'running') && (
                    <button
                      onClick={() => window.electronAPI.remoteTerminal.cancelTransfer(task.id)}
                      style={{ fontSize: 8, padding: '0 4px' }}
                    >
                      {t('Cancel')}
                    </button>
                  )}
                </div>
                <div style={{ height: 2, background: 'rgba(var(--date), 0.12)', marginTop: 1 }}>
                  <div
                    style={{
                      width: `${percent}%`,
                      height: '100%',
                      background: task.state === 'failed' ? 'rgb(255,100,100)' : 'rgb(100,200,255)',
                    }}
                  />
                </div>
                <div style={{ opacity: 0.58 }}>
                  {percent}% · {formatBytes(task.speedBytesPerSecond)}/s
                  {task.etaSeconds !== undefined ? ` · ${task.etaSeconds}s` : ''}
                  {task.error ? ` · ${task.error}` : ''}
                </div>
              </div>
            )
          })}
      </div>
    </div>
  )
}
