import React, { useCallback, useState } from 'react'
import DraggablePanel from './DraggablePanel'
import ImageSearchDataManager from './ImageSearchDataManager'
import { useStore } from '../stores/useStore'
import { useTranslation } from '../i18n/useTranslation'

const AppStoragePanel: React.FC = () => {
  const { t } = useTranslation()
  const scanPaths = useStore((state) => state.imageSearchScanPaths)
  const [message, setMessage] = useState('')
  const showToast = useCallback((text: string) => setMessage(text), [])
  return (
    <DraggablePanel
      panelId="appStorage"
      title="App Storage"
      displayTitle={t('Index and maintenance')}
      defaultX={0}
      defaultY={0}
      defaultW={1000}
      defaultH={700}
    >
      <div style={{ padding: 20, overflow: 'auto', minHeight: 0 }}>
        <p>{t('Manage Siftory indexes and generated caches. Original assets are kept.')}</p>
        {message && <p role="status">{message}</p>}
        <ImageSearchDataManager
          scanPaths={scanPaths}
          showToast={showToast}
          onChanged={() => setMessage(t('Updated'))}
        />
      </div>
    </DraggablePanel>
  )
}
export default AppStoragePanel
