import React, { Component } from 'react'
import { useTranslation } from '../i18n/useTranslation'

interface Props {
  name: string
  children: React.ReactNode
}

interface State {
  error: Error | null
}

const ErrorFallback: React.FC<{ error: Error; name: string; onRetry: () => void }> = ({
  error,
  name,
  onRetry,
}) => {
  const { t } = useTranslation()
  return (
    <div
      data-testid="error-boundary"
      data-boundary-name={name}
      style={{
        position: 'absolute',
        left: 200,
        top: 200,
        padding: 12,
        background: 'rgba(var(--bg), 0.95)',
        border: '1px solid rgba(255,80,80,0.5)',
        borderRadius: 4,
        fontSize: 12,
        color: 'rgb(var(--fg))',
        minWidth: 280,
        zIndex: 9999,
      }}
    >
      <div style={{ marginBottom: 8, fontWeight: 500, color: 'rgb(255,100,100)' }}>
        ⚠ {name} {t('crashed')}
      </div>
      <div style={{ fontSize: 10, opacity: 0.6, marginBottom: 10, wordBreak: 'break-all' }}>
        {error.message}
      </div>
      <button
        onClick={onRetry}
        style={{
          fontSize: 11,
          padding: '3px 10px',
          background: 'rgba(var(--fg), 0.15)',
          border: '1px solid rgba(var(--date), 0.4)',
          borderRadius: 3,
          cursor: 'pointer',
          color: 'inherit',
        }}
      >
        {t('Reload')}
      </button>
    </div>
  )
}

/**
 * Per-panel ErrorBoundary — prevents a single panel crash from
 * unmounting the entire React tree (leaving a blank transparent window).
 *
 * On error: renders a collapsed placeholder with the error message
 * and a "Reload" button that remounts the children.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[ErrorBoundary] ${this.props.name} crashed:`, error, info.componentStack)
  }

  handleRetry = () => {
    this.setState({ error: null })
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorFallback error={this.state.error} name={this.props.name} onRetry={this.handleRetry} />
      )
    }
    return this.props.children
  }
}
