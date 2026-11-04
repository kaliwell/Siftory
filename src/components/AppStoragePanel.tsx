import StorageLocationSettings from './StorageLocationSettings'
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
  const [message, setMessage] = useState('')
  const [sourcesExpanded, setSourcesExpanded] = useState(false)
  const [locationExpanded, setLocationExpanded] = useState(false)
  const [automaticExpanded, setAutomaticExpanded] = useState(false)
  const [indexExpanded, setIndexExpanded] = useState(false)
  const expandAll = (expanded: boolean) => {
    setSourcesExpanded(expanded)
    setLocationExpanded(expanded)
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
    window.addEventListener('workspace-maintenance-sources-focus', focusSources)
    return () => window.removeEventListener('workspace-maintenance-sources-focus', focusSources)
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
        <p className="workspace-maintenance-intro">
          {t('Manage Siftory indexes and generated caches. Original assets are kept.')}
        </p>
        {message && <p role="status">{message}</p>}
        <SearchControlSectionsToolbar
          panelId="maintenance"
          onExpandAll={() => expandAll(true)}
          onCollapseAll={() => expandAll(false)}
        />
        <CollapsibleSearchSection
          id="maintenance-sources-section"
          step="01"
          title={t('Data sources and collections')}
          description={t(
            'Register storage locations, organize collections, and check connectivity.',
          )}
          expanded={sourcesExpanded}
          onToggle={() => setSourcesExpanded((expanded) => !expanded)}
          tone="sources"
          testId="maintenance-sources-section"
        >
          <DiscoverySourcesSection hostPanel="appStorage" />
        </CollapsibleSearchSection>
        <CollapsibleSearchSection
          id="maintenance-location-section"
          step="02"
          tone="library"
          testId="maintenance-location-section"
          title={t('Application data location')}
          description={t(
            'Move indexes, vectors, library metadata and generated caches together. Original media stays in place.',
          )}
          expanded={locationExpanded}
          onToggle={() => setLocationExpanded((expanded) => !expanded)}
        >
          <StorageLocationSettings />
        </CollapsibleSearchSection>
        <CollapsibleSearchSection
          id="maintenance-automatic-section"
          step="03"
          tone="maintenance"
          testId="maintenance-automatic-section"
          title={t('Automatic maintenance')}
          description={t(
            'Checks daily while idle. Missing files are observed for 24 hours. Recovery backups are kept for 7 days.',
          )}
          expanded={automaticExpanded}
          onToggle={() => setAutomaticExpanded((expanded) => !expanded)}
        >
          <AutomaticMaintenancePanel suggestedScopes={scanPaths} />
        </CollapsibleSearchSection>
        <CollapsibleSearchSection
          id="maintenance-index-section"
          step="04"
          tone="maintenance"
          testId="maintenance-index-section"
          title={t('Image Search Data Overview')}
          description={t('Review index health, storage, rebuild tools, and diagnostics.')}
          expanded={indexExpanded}
          onToggle={() => setIndexExpanded((expanded) => !expanded)}
        >
          <ImageSearchDataManager
            standalone
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
