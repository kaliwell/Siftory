import React from 'react'
import type { RemoteTerminalProfile } from '../../../shared/ipc-contract'
import { useTranslation } from '../../i18n/useTranslation'

interface Props {
  editingProfile: RemoteTerminalProfile | null
  showEditor: boolean
  newName: string
  newHost: string
  newPort: string
  newUser: string
  newAuthType: 'password' | 'privateKey'
  newKeyPath: string
  newHostFingerprint: string
  setNewName: (v: string) => void
  setNewHost: (v: string) => void
  setNewPort: (v: string) => void
  setNewUser: (v: string) => void
  setNewAuthType: (v: 'password' | 'privateKey') => void
  setNewKeyPath: (v: string) => void
  setNewHostFingerprint: (v: string) => void
  setShowEditor: (v: boolean) => void
  handleSaveProfile: () => void
}

const fieldStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  fontSize: 11,
  padding: '3px 6px',
  background: 'rgba(var(--bg), 0.8)',
  border: '1px solid rgba(var(--date), 0.3)',
  color: 'rgb(var(--date))',
  borderRadius: 3,
  outline: 'none',
  marginTop: 2,
}

const ProfileEditor: React.FC<Props> = ({
  editingProfile,
  showEditor,
  newName,
  newHost,
  newPort,
  newUser,
  newAuthType,
  newKeyPath,
  newHostFingerprint,
  setNewName,
  setNewHost,
  setNewPort,
  setNewUser,
  setNewAuthType,
  setNewKeyPath,
  setNewHostFingerprint,
  setShowEditor,
  handleSaveProfile,
}) => {
  const { t } = useTranslation()
  if (!showEditor) return null

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10,
      }}
      onClick={() => setShowEditor(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'rgba(var(--bg), 0.97)',
          border: '1px solid rgba(var(--date), 0.3)',
          borderRadius: 6,
          padding: 16,
          minWidth: 300,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          fontSize: 11,
        }}
      >
        <div style={{ fontWeight: 500, marginBottom: 4 }}>
          {editingProfile ? t('Edit Profile') : t('New Profile')}
        </div>

        <label>
          {t('Name')}
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t('My Server')}
            style={fieldStyle}
          />
        </label>

        <label>
          {t('Host')}
          <input
            value={newHost}
            onChange={(e) => setNewHost(e.target.value)}
            placeholder="192.168.1.100"
            style={fieldStyle}
          />
        </label>

        <div style={{ display: 'flex', gap: 8 }}>
          <label style={{ flex: 1 }}>
            {t('Port')}
            <input
              value={newPort}
              onChange={(e) => setNewPort(e.target.value)}
              placeholder="22"
              style={fieldStyle}
            />
          </label>
          <label style={{ flex: 2 }}>
            {t('Username')}
            <input
              value={newUser}
              onChange={(e) => setNewUser(e.target.value)}
              placeholder="root"
              style={fieldStyle}
            />
          </label>
        </div>

        <label>
          {t('Auth')}
          <select
            value={newAuthType}
            onChange={(e) => setNewAuthType(e.target.value as 'password' | 'privateKey')}
            style={fieldStyle}
          >
            <option value="password">{t('Password')}</option>
            <option value="privateKey">{t('Private Key')}</option>
          </select>
        </label>

        {newAuthType === 'privateKey' && (
          <label>
            {t('Key Path (on remote host main process)')}
            <input
              value={newKeyPath}
              onChange={(e) => setNewKeyPath(e.target.value)}
              placeholder="C:\Users\...\.ssh\id_rsa"
              style={fieldStyle}
            />
          </label>
        )}

        {newHostFingerprint && (
          <label>
            {t('Trusted Host Fingerprint')}
            <div style={{ display: 'flex', gap: 4 }}>
              <input value={newHostFingerprint} readOnly style={{ ...fieldStyle, flex: 1 }} />
              <button
                type="button"
                onClick={() => setNewHostFingerprint('')}
                title={t(
                  'Clear only after independently verifying that the server host key changed.',
                )}
              >
                {t('Clear')}
              </button>
            </div>
          </label>
        )}

        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 6 }}>
          <button
            onClick={() => setShowEditor(false)}
            style={{ fontSize: 11, padding: '4px 12px' }}
          >
            {t('Cancel')}
          </button>
          <button
            onClick={handleSaveProfile}
            disabled={!newName.trim() || !newHost.trim() || !newUser.trim()}
            style={{
              fontSize: 11,
              padding: '4px 12px',
              opacity: !newName.trim() || !newHost.trim() || !newUser.trim() ? 0.4 : 1,
            }}
          >
            {t('Save')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ProfileEditor
