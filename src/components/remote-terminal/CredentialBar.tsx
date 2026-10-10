import React from 'react'
import type { RemoteTerminalProfile } from '../../../shared/ipc-contract'
import { useTranslation } from '../../i18n/useTranslation'

export type RemoteTerminalPendingAction = 'connect' | 'test' | 'metrics' | 'files'

interface CredentialBarProps {
  busy: boolean
  password: string
  pendingAction: RemoteTerminalPendingAction
  pendingProfile: RemoteTerminalProfile | null
  rememberForSession: boolean
  rememberOnDevice: boolean
  onForget: () => void
  onPasswordChange: (value: string) => void
  onRememberForSessionChange: (value: boolean) => void
  onRememberOnDeviceChange: (value: boolean) => void
  onSubmit: () => void
}

function actionLabel(action: RemoteTerminalPendingAction): string {
  if (action === 'files') return 'Browse'
  if (action === 'metrics') return 'Mon'
  if (action === 'test') return 'Test'
  return 'Connect'
}

const CredentialBar: React.FC<CredentialBarProps> = ({
  busy,
  password,
  pendingAction,
  pendingProfile,
  rememberForSession,
  rememberOnDevice,
  onForget,
  onPasswordChange,
  onRememberForSessionChange,
  onRememberOnDeviceChange,
  onSubmit,
}) => {
  const { t } = useTranslation()
  if (!pendingProfile) return null

  return (
    <div
      className="rt-credential-bar"
      style={{
        display: 'flex',
        gap: 4,
        padding: '2px 4px',
        fontSize: 10,
        alignItems: 'center',
        borderBottom: '1px solid rgba(var(--date), 0.08)',
        flexShrink: 0,
        position: 'relative',
        zIndex: 30,
        background: 'rgba(var(--bg), 0.98)',
      }}
    >
      <input
        type="password"
        placeholder={t(pendingProfile.authType === 'privateKey' ? 'Passphrase...' : 'Password...')}
        value={password}
        onChange={(event) => onPasswordChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onSubmit()
        }}
        style={{
          width: 100,
          fontSize: 10,
          padding: '1px 4px',
          background: 'rgba(var(--bg), 0.8)',
          border: '1px solid rgba(var(--date), 0.3)',
          color: 'rgb(var(--date))',
          borderRadius: 3,
          outline: 'none',
        }}
      />
      <button onClick={onSubmit} disabled={busy} style={{ fontSize: 10, padding: '1px 8px' }}>
        {t(actionLabel(pendingAction))}
      </button>
      <label
        title={t('Store only in current app memory. Cleared when the app exits.')}
        style={{ display: 'flex', alignItems: 'center', gap: 3, opacity: 0.72 }}
      >
        <input
          type="checkbox"
          checked={rememberForSession}
          onChange={(event) => onRememberForSessionChange(event.target.checked)}
          style={{ width: 12, height: 12, padding: 0 }}
        />
        {t('Session')}
      </label>
      <label
        title={t(
          'Encrypt with Windows DPAPI for this Windows user. The renderer never receives the saved secret.',
        )}
        style={{ display: 'flex', alignItems: 'center', gap: 3, opacity: 0.72 }}
      >
        <input
          type="checkbox"
          checked={rememberOnDevice}
          onChange={(event) => onRememberOnDeviceChange(event.target.checked)}
          style={{ width: 12, height: 12, padding: 0 }}
        />
        {t('Protected')}
      </label>
      <button onClick={onForget} style={{ fontSize: 10, padding: '1px 6px', opacity: 0.65 }}>
        {t('Forget')}
      </button>
    </div>
  )
}

export default CredentialBar
