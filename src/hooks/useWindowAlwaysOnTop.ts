import { useCallback, useEffect, useState } from 'react'

let cachedAlwaysOnTop = true
let initialQuery: Promise<boolean> | null = null
const listeners = new Set<(value: boolean) => void>()

function publish(value: boolean): void {
  cachedAlwaysOnTop = value
  listeners.forEach((listener) => listener(value))
}

function queryAlwaysOnTop(): Promise<boolean> {
  if (!initialQuery) {
    initialQuery = window.electronAPI
      .getWindowAlwaysOnTop()
      .then((value) => {
        publish(value)
        return value
      })
      .catch(() => cachedAlwaysOnTop)
  }
  return initialQuery
}

export function useWindowAlwaysOnTop() {
  const [alwaysOnTop, setAlwaysOnTop] = useState(cachedAlwaysOnTop)

  useEffect(() => {
    listeners.add(setAlwaysOnTop)
    void queryAlwaysOnTop()
    return () => {
      listeners.delete(setAlwaysOnTop)
    }
  }, [])

  const toggleAlwaysOnTop = useCallback(() => {
    const next = !cachedAlwaysOnTop
    void window.electronAPI
      .setWindowAlwaysOnTop(next)
      .then(publish)
      .catch(() => undefined)
  }, [])

  return { alwaysOnTop, toggleAlwaysOnTop }
}
