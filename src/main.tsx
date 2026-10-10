import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles/global.css'

const application = (
  <ErrorBoundary name="Application">
    <App />
  </ErrorBoundary>
)

// Heavy desktop panels own subscriptions and native IPC. React's development
// StrictMode intentionally mounts them twice, which makes `npm run dev` feel
// substantially slower than the packaged application. Keep it available as an
// explicit diagnostics switch without imposing double mounts on normal use.
const renderer =
  import.meta.env.VITE_REACT_STRICT_MODE === '1' ? (
    <React.StrictMode>{application}</React.StrictMode>
  ) : (
    application
  )

ReactDOM.createRoot(document.getElementById('root')!).render(renderer)
