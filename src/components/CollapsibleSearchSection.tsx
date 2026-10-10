import React from 'react'
import { useTranslation } from '../i18n/useTranslation'

export type SearchControlSectionTone = 'sources' | 'library' | 'query' | 'maintenance'

interface CollapsibleSearchSectionProps {
  id: string
  step: string
  title: string
  description: string
  expanded: boolean
  onToggle?: () => void
  tone: SearchControlSectionTone
  testId: string
  summary?: React.ReactNode
  collapsible?: boolean
  pinned?: boolean
  children: React.ReactNode
}

const SearchControlSectionIcon: React.FC<{ tone: SearchControlSectionTone }> = ({ tone }) => {
  const paths: Record<SearchControlSectionTone, React.ReactNode> = {
    sources: (
      <>
        <ellipse cx="12" cy="5" rx="7" ry="2.5" />
        <path d="M5 5v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V5" />
        <path d="M5 11v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-6" />
      </>
    ),
    library: (
      <>
        <path d="M3.5 7.5V6A1.5 1.5 0 0 1 5 4.5h4l2 2h8A1.5 1.5 0 0 1 20.5 8v9A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17Z" />
        <path d="m9 13.5 2 2 4-4" />
      </>
    ),
    query: (
      <>
        <circle cx="10.5" cy="10.5" r="5.5" />
        <path d="m15 15 5 5" />
      </>
    ),
    maintenance: (
      <>
        <path d="M4 6h5m4 0h7M4 12h9m4 0h3M4 18h3m4 0h9" />
        <circle cx="11" cy="6" r="2" />
        <circle cx="15" cy="12" r="2" />
        <circle cx="9" cy="18" r="2" />
      </>
    ),
  }

  return (
    <svg
      className="search-control-section__icon-svg"
      data-section-icon={tone}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      aria-hidden="true"
    >
      {paths[tone]}
    </svg>
  )
}

const CollapsibleSearchSection: React.FC<CollapsibleSearchSectionProps> = ({
  id,
  step,
  title,
  description,
  expanded,
  onToggle,
  tone,
  testId,
  summary,
  collapsible = true,
  pinned = false,
  children,
}) => {
  const contentId = `${id}-content`
  const isCollapsible = collapsible && !pinned
  const effectiveExpanded = isCollapsible ? expanded : true
  const initialMountFrames = React.useRef(
    effectiveExpanded && isCollapsible ? Math.max(0, (Number.parseInt(step, 10) || 1) - 1) : 0,
  )
  const [bodyMounted, setBodyMounted] = React.useState(
    effectiveExpanded && initialMountFrames.current === 0,
  )

  React.useEffect(() => {
    if (!effectiveExpanded || bodyMounted) return
    let cancelled = false
    let frameId = 0
    let framesRemaining = initialMountFrames.current
    initialMountFrames.current = 0
    const reveal = () => {
      if (cancelled) return
      if (framesRemaining <= 0) {
        setBodyMounted(true)
        return
      }
      framesRemaining -= 1
      frameId = window.requestAnimationFrame(reveal)
    }
    reveal()
    return () => {
      cancelled = true
      if (frameId) window.cancelAnimationFrame(frameId)
    }
  }, [bodyMounted, effectiveExpanded])

  const headerContent = (
    <>
      <span className="search-control-section__icon" aria-hidden="true">
        <SearchControlSectionIcon tone={tone} />
      </span>
      <span className="search-control-section__copy">
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      {summary !== undefined && summary !== null && (
        <span className="search-control-section__summary">{summary}</span>
      )}
      {isCollapsible && (
        <span className="search-control-section__chevron" aria-hidden="true">
          {effectiveExpanded ? '▾' : '▸'}
        </span>
      )}
    </>
  )

  return (
    <section
      className={`search-control-section search-control-section--${tone}`}
      data-testid={testId}
      data-collapsed={effectiveExpanded ? 'false' : 'true'}
      data-pinned={pinned ? 'true' : undefined}
    >
      {isCollapsible ? (
        <button
          type="button"
          className="search-control-section__header"
          aria-expanded={effectiveExpanded}
          aria-controls={contentId}
          onClick={onToggle}
        >
          {headerContent}
        </button>
      ) : (
        <div className="search-control-section__header" data-static="true">
          {headerContent}
        </div>
      )}
      <div id={contentId} className="search-control-section__body" hidden={!effectiveExpanded}>
        {bodyMounted ? children : null}
      </div>
    </section>
  )
}

interface SearchControlSectionsToolbarProps {
  panelId: string
  leadingControl?: React.ReactNode
  onExpandAll: () => void
  onCollapseAll: () => void
}

export const SearchControlSectionsToolbar: React.FC<SearchControlSectionsToolbarProps> = ({
  panelId,
  leadingControl,
  onExpandAll,
  onCollapseAll,
}) => {
  const { t } = useTranslation()

  return (
    <div
      className="search-control-sections-toolbar"
      data-testid={`${panelId}-sections-toolbar`}
      aria-label={t('Section display controls')}
    >
      {leadingControl ? (
        <div className="search-control-sections-toolbar__primary">{leadingControl}</div>
      ) : (
        <span className="search-control-sections-toolbar__label">{t('Panel sections')}</span>
      )}
      <button type="button" data-testid={`${panelId}-sections-expand-all`} onClick={onExpandAll}>
        {t('Expand all')}
      </button>
      <button
        type="button"
        data-testid={`${panelId}-sections-collapse-all`}
        onClick={onCollapseAll}
      >
        {t('Collapse all')}
      </button>
    </div>
  )
}

export default React.memo(CollapsibleSearchSection)
