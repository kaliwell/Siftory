import React, { useEffect, useRef } from 'react'
import { useTranslation } from '../i18n/useTranslation'
import '../styles/workspace-task-page.css'

interface WorkspaceTasksPageProps {
  children: React.ReactNode
  onGettingStarted: () => void
  onReady: () => void
}

export default function WorkspaceTasksPage({
  children,
  onGettingStarted,
  onReady,
}: WorkspaceTasksPageProps) {
  const { t } = useTranslation()
  const page = useRef<HTMLElement>(null)
  useEffect(() => {
    page.current?.focus({ preventScroll: true })
    onReady()
  }, [onReady])
  return (
    <main
      ref={page}
      tabIndex={-1}
      data-portal=""
      id="workspace-task-summary"
      data-testid="workspace-task-summary"
      className="workspace-task-page"
      aria-label={t('Tasks')}
    >
      <header>
        <div>
          <h1>{t('Tasks')}</h1>
          <p>{t('Track progress, resolve failures, and review completed work.')}</p>
        </div>
        <div className="workspace-task-header-actions">
          <button data-testid="workspace-first-run-guide" onClick={onGettingStarted}>
            {t('Getting started')}
          </button>
        </div>
      </header>
      <div className="workspace-task-page__body">{children}</div>
    </main>
  )
}
