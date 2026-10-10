import React from 'react'
import type { AssetLibraryBackupSummary } from '../../../shared/ipc-contract'
import { useTranslation } from '../../i18n/useTranslation'
import {
  assetLibraryButtonStyle,
  formatAssetLibraryBytes,
  formatAssetLibraryNumber,
} from './assetLibraryViewUtils'

interface AssetLibraryBackupViewProps {
  activeTask: boolean
  backups: AssetLibraryBackupSummary[]
  busy: string
  message: string
  passphrase: string
  passphraseConfirmation: string
  restoreArmedId: string
  deleteArmedId: string
  verification: Record<string, boolean>
  onCreate(): void
  onRefresh(): void
  onOpenFolder(): void
  onPassphraseChange(value: string): void
  onPassphraseConfirmationChange(value: string): void
  onImport(): void
  onVerify(backupId: string): void
  onExport(backupId: string): void
  onDelete(backupId: string): void
  onRestore(backupId: string): void
}

const AssetLibraryBackupView: React.FC<AssetLibraryBackupViewProps> = ({
  activeTask,
  backups,
  busy,
  message,
  passphrase,
  passphraseConfirmation,
  restoreArmedId,
  deleteArmedId,
  verification,
  onCreate,
  onRefresh,
  onOpenFolder,
  onPassphraseChange,
  onPassphraseConfirmationChange,
  onImport,
  onVerify,
  onExport,
  onDelete,
  onRestore,
}) => {
  const { t } = useTranslation()

  return (
    <div
      data-testid="asset-backup-view"
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
        gap: 5,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          flexWrap: 'wrap',
          paddingBottom: 5,
          borderBottom: '1px solid rgba(var(--date),0.16)',
        }}
      >
        <input
          aria-label={t('Backup password')}
          autoComplete="new-password"
          disabled={Boolean(busy)}
          maxLength={256}
          minLength={12}
          onChange={(event) => onPassphraseChange(event.target.value)}
          placeholder={t('Backup password (at least 12 characters)')}
          type="password"
          value={passphrase}
          style={{
            ...assetLibraryButtonStyle,
            width: 220,
            textAlign: 'left',
          }}
        />
        <input
          aria-label={t('Confirm backup password')}
          autoComplete="new-password"
          disabled={Boolean(busy)}
          maxLength={256}
          minLength={12}
          onChange={(event) => onPassphraseConfirmationChange(event.target.value)}
          placeholder={t('Confirm backup password')}
          type="password"
          value={passphraseConfirmation}
          style={{
            ...assetLibraryButtonStyle,
            width: 190,
            textAlign: 'left',
            ...(passphraseConfirmation && passphrase !== passphraseConfirmation
              ? { borderColor: 'rgba(255,105,105,0.65)' }
              : {}),
          }}
        />
        <button
          disabled={Boolean(busy) || activeTask}
          onClick={onCreate}
          style={assetLibraryButtonStyle}
        >
          {t('Back up now')}
        </button>
        <button disabled={Boolean(busy)} onClick={onRefresh} style={assetLibraryButtonStyle}>
          {t('Refresh')}
        </button>
        <button onClick={onOpenFolder} style={assetLibraryButtonStyle}>
          {t('Open folder')}
        </button>
        <button
          disabled={Boolean(busy) || activeTask}
          onClick={onImport}
          style={assetLibraryButtonStyle}
        >
          {t('Import')}
        </button>
        {busy && <span style={{ opacity: 0.65 }}>{t('Working...')}</span>}
        {message && <span style={{ color: 'rgb(75,220,155)' }}>{message}</span>}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {backups.map((backup) => {
          const verified = verification[backup.id]
          const invalid = !backup.manifestValid || verified === false
          return (
            <div
              key={backup.id}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(170px,1fr) 90px 70px 70px auto',
                alignItems: 'center',
                gap: 6,
                minHeight: 34,
                borderBottom: '1px solid rgba(var(--date),0.1)',
                color: invalid ? 'rgb(255,110,110)' : undefined,
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {new Date(backup.createdAt).toLocaleString()}
              </span>
              <span>{backup.reason.replace('_', ' ')}</span>
              <span>
                {formatAssetLibraryNumber(backup.fileCount)} {t('files')}
              </span>
              <span>{formatAssetLibraryBytes(backup.totalBytes)}</span>
              <div style={{ display: 'flex', gap: 3, justifyContent: 'flex-end' }}>
                <button
                  disabled={Boolean(busy) || !backup.manifestValid}
                  onClick={() => onVerify(backup.id)}
                  style={assetLibraryButtonStyle}
                >
                  {verified === true ? t('Verified') : t('Verify')}
                </button>
                <button
                  disabled={
                    Boolean(busy) ||
                    !backup.manifestValid ||
                    passphrase.length < 12 ||
                    passphrase !== passphraseConfirmation
                  }
                  onClick={() => onExport(backup.id)}
                  style={assetLibraryButtonStyle}
                >
                  {t('Export')}
                </button>
                <button
                  disabled={Boolean(busy) || activeTask}
                  onClick={() => onDelete(backup.id)}
                  style={{
                    ...assetLibraryButtonStyle,
                    color: deleteArmedId === backup.id ? 'rgb(255,105,105)' : 'rgb(var(--date))',
                  }}
                >
                  {deleteArmedId === backup.id ? t('Confirm delete') : t('Delete')}
                </button>
                <button
                  disabled={Boolean(busy) || invalid || activeTask}
                  onClick={() => onRestore(backup.id)}
                  style={{
                    ...assetLibraryButtonStyle,
                    color: restoreArmedId === backup.id ? 'rgb(255,105,105)' : 'rgb(var(--date))',
                  }}
                >
                  {restoreArmedId === backup.id ? t('Confirm restore') : t('Restore')}
                </button>
              </div>
            </div>
          )
        })}
        {backups.length === 0 && (
          <div style={{ opacity: 0.45, padding: 8 }}>{t('No completed metadata backups.')}</div>
        )}
      </div>
    </div>
  )
}

export default AssetLibraryBackupView
