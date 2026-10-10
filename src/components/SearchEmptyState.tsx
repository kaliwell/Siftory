import React from 'react'

interface SearchEmptyStateProps {
  description: string
  testId: string
  title: string
}

const SearchEmptyState: React.FC<SearchEmptyStateProps> = ({ description, testId, title }) => (
  <section className="search-empty-state" data-testid={testId} role="status" aria-live="polite">
    <span className="search-empty-state__mark" aria-hidden="true">
      ⌕
    </span>
    <strong>{title}</strong>
    <span>{description}</span>
  </section>
)

export default SearchEmptyState
