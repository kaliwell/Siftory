import React from 'react'
import WorkspaceIcon from './WorkspaceIcon'

interface SearchEmptyStateProps {
  description: string
  testId: string
  title: string
  children?: React.ReactNode
}

const SearchEmptyState: React.FC<SearchEmptyStateProps> = ({
  description,
  testId,
  title,
  children,
}) => (
  <section className="search-empty-state" data-testid={testId} role="status" aria-live="polite">
    <span className="search-empty-state__mark" aria-hidden="true">
      <WorkspaceIcon name="search" />
    </span>
    <strong>{title}</strong>
    <span>{description}</span>
    {children && <div className="search-empty-state__actions">{children}</div>}
  </section>
)

export default SearchEmptyState
