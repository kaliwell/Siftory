import React, { useState } from 'react'
import { useTranslation } from '../i18n/useTranslation'
import { openWorkspacePanel } from '../services/openWorkspace'
import SourceDerivedDataCleanup from './SourceDerivedDataCleanup'

export default function DataCleanupCenter({ onClearAll }: { onClearAll: () => void }) {
  const { t } = useTranslation()
  const [scope, setScope] = useState('source')
  return (
    <section className="data-cleanup-center" data-testid="data-cleanup-center">
      <strong>{t('Data cleanup')}</strong>
      <label className="settings-row">
        <span>{t('Scope')}</span>
        <select
          data-testid="cleanup-scope"
          value={scope}
          onChange={(event) => setScope(event.target.value)}
        >
          <option value="source">{t('Drive or folder')}</option>
          <option value="layer">{t('Folder index layers')}</option>
          <option value="all">{t('All processed image data')}</option>
        </select>
      </label>
      <div hidden={scope !== 'source'}>
        <SourceDerivedDataCleanup />
      </div>
      {scope === 'layer' && (
        <button
          type="button"
          data-testid="cleanup-open-folder-layers"
          onClick={() => openWorkspacePanel('appStorage', 'workspace-maintenance-folder-tools')}
        >
          {t('Choose folder and index layers')}
        </button>
      )}
      {scope === 'all' && (
        <button type="button" data-testid="clear-processed-image-data" onClick={onClearAll}>
          {t('Clear Processed Image Data')}
        </button>
      )}
    </section>
  )
}
