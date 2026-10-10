import React, { useRef } from 'react'
import type { SearchExperienceMode, SetupWorkflowSnapshot } from '../services/searchSetupWorkflow'
import { useTranslation } from '../i18n/useTranslation'
import { nextRovingIndex } from '../services/productInformationArchitecture'

interface SearchExperienceModeBarProps {
  mode: SearchExperienceMode
  workflow: SetupWorkflowSnapshot
  onModeChange: (mode: SearchExperienceMode) => void
}

const SearchExperienceModeBar: React.FC<SearchExperienceModeBarProps> = ({
  mode,
  workflow,
  onModeChange,
}) => {
  const { t } = useTranslation()
  const running = workflow.state === 'running'
  const modes = ['simple', 'advanced'] as const
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([])

  const moveModeFocus = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const nextIndex = nextRovingIndex(index, modes.length, event.key)
    if (nextIndex === null) return
    event.preventDefault()
    const nextMode = modes[nextIndex]
    onModeChange(nextMode)
    requestAnimationFrame(() => buttonRefs.current[nextIndex]?.focus())
  }

  return (
    <div className="search-experience-mode">
      <div
        className="search-experience-mode__options"
        role="radiogroup"
        aria-label={t('Search interface mode')}
      >
        {modes.map((value, index) => (
          <button
            key={value}
            ref={(element) => {
              buttonRefs.current[index] = element
            }}
            data-testid={`search-mode-${value}`}
            type="button"
            disabled={running}
            role="radio"
            aria-checked={mode === value}
            aria-pressed={mode === value}
            tabIndex={mode === value ? 0 : -1}
            onClick={() => onModeChange(value)}
            onKeyDown={(event) => moveModeFocus(event, index)}
          >
            {t(value === 'simple' ? 'Simple' : 'Advanced')}
          </button>
        ))}
      </div>
      <span className="search-experience-mode__status" aria-live="polite">
        {t(mode === 'simple' ? 'AUTO' : 'MANUAL')}
      </span>
    </div>
  )
}

export default SearchExperienceModeBar
