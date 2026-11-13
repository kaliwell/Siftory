import React, { useCallback, useEffect, useState } from 'react'
import DraggablePanel from './DraggablePanel'
import ImageSearchDataManager from './ImageSearchDataManager'
import AutomaticMaintenancePanel from './AutomaticMaintenancePanel'
import DiscoverySourcesSection from './DiscoverySourcesSection'
import CollapsibleSearchSection, { SearchControlSectionsToolbar } from './CollapsibleSearchSection'
import { useStore } from '../stores/useStore'
import { useTranslation } from '../i18n/useTranslation'

const AppStoragePanel: React.FC = () => {
  const { t } = useTranslation()
  const scanPaths = useStore((state) => state.imageSearchScanPaths)
  const isVisible = useStore((state) => state.showAppStorage && !state.workspaceTaskPageOpen)
  const [message, setMessage] = useState('')
  const [sourcesExpanded, setSourcesExpanded] = useState(false)
  const [automaticExpanded, setAutomaticExpanded] = useState(false)
  const [indexExpanded, setIndexExpanded] = useState(false)
  const [folderToolsRequest, setFolderToolsRequest] = useState(0)
  const expandAll = (expanded: boolean) => {
    setSourcesExpanded(expanded)
    setAutomaticExpanded(expanded)
    setIndexExpanded(expanded)
  }
  useEffect(() => {
    const focusSources = () => {
      setSourcesExpanded(true)
      requestAnimationFrame(() =>
        document.getElementById('maintenance-sources-section')?.scrollIntoView({ block: 'start' }),
      )
    }
    const focusFolderTools = () => {
      setIndexExpanded(true)
      setFolderToolsRequest((value) => value + 1)
    }
    window.addEventListener('workspace-maintenance-folder-tools', focusFolderTools)
    window.addEventListener('workspace-maintenance-sources-focus', focusSources)
    return () => {
      window.removeEventListener('workspace-maintenance-sources-focus', focusSources)
      window.removeEventListener('workspace-maintenance-folder-tools', focusFolderTools)
    }
  }, [])
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
      <div className="workspace-maintenance-page">
        {message && <p role="status">{message}</p>}
        <SearchControlSectionsToolbar
          panelId="maintenance"
          showLabel={false}
          onExpandAll={() => expandAll(true)}
          onCollapseAll={() => expandAll(false)}
        />
        <CollapsibleSearchSection
          id="maintenance-sources-section"
          step="01"
          title={t('Data sources and collections')}
          expanded={sourcesExpanded}
          onToggle={() => setSourcesExpanded((expanded) => !expanded)}
          tone="sources"
          testId="maintenance-sources-section"
        >
          <DiscoverySourcesSection hostPanel="appStorage" enabled={sourcesExpanded} />
        </CollapsibleSearchSection>
        <CollapsibleSearchSection
          id="maintenance-automatic-section"
          step="02"
          tone="maintenance"
          testId="maintenance-automatic-section"
          title={t('Automatic maintenance')}
          expanded={automaticExpanded}
          onToggle={() => setAutomaticExpanded((expanded) => !expanded)}
        >
          <AutomaticMaintenancePanel
            suggestedScopes={scanPaths}
            active={isVisible && automaticExpanded}
          />
        </CollapsibleSearchSection>
        <CollapsibleSearchSection
          id="maintenance-index-section"
          step="03"
          tone="maintenance"
          testId="maintenance-index-section"
          title={t('Image Search Data Overview')}
          expanded={indexExpanded}
          onToggle={() => setIndexExpanded((expanded) => !expanded)}
        >
          <ImageSearchDataManager
            standalone
            folderToolsRequest={folderToolsRequest}
            scanPaths={scanPaths}
            showToast={showToast}
            onChanged={() => setMessage(t('Updated'))}
          />
        </CollapsibleSearchSection>
      </div>
    </DraggablePanel>
  )
}
export default AppStoragePanel
