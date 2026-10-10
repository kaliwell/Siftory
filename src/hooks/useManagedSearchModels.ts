import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ModelStatus } from '../../shared/vectorTypes'
import {
  createInitialManagedSearchModelStatuses,
  isManagedSearchModelName,
  isManagedSearchModelReady,
  MANAGED_SEARCH_MODEL_NAMES,
  resolveManagedSearchModelReadiness,
  type ManagedSearchModelName,
  type ManagedSearchModelStatuses,
} from '../services/managedSearchModelReadiness'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useManagedSearchModels() {
  const [statuses, setStatuses] = useState<ManagedSearchModelStatuses>(
    createInitialManagedSearchModelStatuses,
  )
  const [checking, setChecking] = useState(true)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null)
  const requestIdRef = useRef(0)

  const refresh = useCallback(async (): Promise<ManagedSearchModelStatuses | null> => {
    const requestId = ++requestIdRef.current
    const api = window.electronAPI?.vector
    setChecking(true)
    setCheckError(null)
    if (!api?.getModelStatus) {
      if (requestId === requestIdRef.current) {
        setChecking(false)
        setCheckError('Vector API is unavailable')
      }
      return null
    }

    try {
      const results = await Promise.all(
        MANAGED_SEARCH_MODEL_NAMES.map((name) => api.getModelStatus(name)),
      )
      if (requestId !== requestIdRef.current) return null
      const next = Object.fromEntries(
        MANAGED_SEARCH_MODEL_NAMES.map((name, index) => [name, results[index]]),
      ) as ManagedSearchModelStatuses
      setStatuses(next)
      setLastCheckedAt(Date.now())
      setChecking(false)
      return next
    } catch (error) {
      if (requestId === requestIdRef.current) {
        setChecking(false)
        setCheckError(errorMessage(error))
      }
      return null
    }
  }, [])

  useEffect(() => {
    void refresh()
    const api = window.electronAPI?.vector
    if (!api?.onModelStatusChanged) return
    return api.onModelStatusChanged((status: ModelStatus) => {
      if (!isManagedSearchModelName(status.name)) return
      requestIdRef.current += 1
      setStatuses((current) => ({ ...current, [status.name]: status }))
      setLastCheckedAt(Date.now())
      setChecking(false)
      setCheckError(null)
    })
  }, [refresh])

  const readiness = useMemo(
    () => resolveManagedSearchModelReadiness(statuses, checking, checkError),
    [checkError, checking, statuses],
  )
  const isModelReady = useCallback(
    (name: ManagedSearchModelName) => isManagedSearchModelReady(statuses[name]),
    [statuses],
  )

  return {
    statuses,
    checking,
    checkError,
    lastCheckedAt,
    readiness,
    isModelReady,
    refresh,
  }
}
