import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AudioSemanticUiStatus, VideoSemanticUiStatus } from '../../shared/ipc-contract'
import type { UserModelRuntimeStatus, UserModelSlotStatus } from '../../shared/userModelPlatform'
import type { ModelStatus } from '../../shared/vectorTypes'
import {
  buildGlobalModelReadiness,
  GLOBAL_MANAGED_MODEL_NAMES,
  type GlobalManagedModelName,
} from '../services/globalModelReadiness'

interface GlobalModelData {
  managedStatuses: Partial<Record<GlobalManagedModelName, ModelStatus | null>>
  userSlots: UserModelSlotStatus[] | null
  userRuntimeStatuses: UserModelRuntimeStatus[] | null
  videoSemantic: VideoSemanticUiStatus | null
  audioSemantic: AudioSemanticUiStatus | null
  issues: string[]
}

interface ReadResult<T> {
  ok: boolean
  value?: T
  issue?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readStatus<T>(label: string, operation: () => Promise<T>): Promise<ReadResult<T>> {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    return { ok: false, issue: `${label}: ${errorMessage(error)}` }
  }
}

const INITIAL_DATA: GlobalModelData = {
  managedStatuses: {},
  userSlots: null,
  userRuntimeStatuses: null,
  videoSemantic: null,
  audioSemantic: null,
  issues: [],
}

export interface GlobalModelRefreshOptions {
  deep?: boolean
}

export function useGlobalModelReadiness() {
  const [data, setData] = useState<GlobalModelData>(INITIAL_DATA)
  const [checking, setChecking] = useState(true)
  const [deepChecking, setDeepChecking] = useState(false)
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const requestIdRef = useRef(0)
  const deepRequestIdRef = useRef(0)
  const deepInFlightRef = useRef(false)

  const refresh = useCallback(async (options: GlobalModelRefreshOptions = {}): Promise<void> => {
    const deep = options.deep === true
    // A full isolated-runtime pass can legitimately take longer than the
    // lightweight polling interval. Do not let a scheduled shallow refresh
    // supersede and discard that more authoritative result.
    if (!deep && deepInFlightRef.current) return
    const requestId = ++requestIdRef.current
    const deepRequestId = deep ? ++deepRequestIdRef.current : 0
    if (deep) deepInFlightRef.current = true
    const api = window.electronAPI
    setChecking(true)
    if (deep) setDeepChecking(true)

    const managedPromise = Promise.all(
      GLOBAL_MANAGED_MODEL_NAMES.map(async (name) => ({
        name,
        result: await readStatus(name, () => api.vector.getModelStatus(name)),
      })),
    )
    const userSlotsPromise = readStatus('user-model-slots', () => api.vector.listUserModelSlots())
    const userRuntimePromise = deep
      ? readStatus('user-model-runtime', () => api.vector.checkUserModelSlots())
      : Promise.resolve<ReadResult<UserModelRuntimeStatus[]>>({ ok: true })
    const videoPromise = readStatus('video-semantic-runtime', () =>
      api.mediaSearch.getVideoSemanticStatus(undefined, deep),
    )
    const audioPromise = readStatus('audio-semantic-runtime', () =>
      api.mediaSearch.getAudioSemanticStatus(deep),
    )

    const [managed, userSlots, userRuntime, videoSemantic, audioSemantic] = await Promise.all([
      managedPromise,
      userSlotsPromise,
      userRuntimePromise,
      videoPromise,
      audioPromise,
    ])
    if (requestId !== requestIdRef.current) {
      if (deep && deepRequestId === deepRequestIdRef.current) {
        deepInFlightRef.current = false
        setDeepChecking(false)
      }
      return
    }

    const issues = [
      ...managed.flatMap(({ result }) => (result.issue ? [result.issue] : [])),
      ...(userSlots.issue ? [userSlots.issue] : []),
      ...(userRuntime.issue ? [userRuntime.issue] : []),
      ...(videoSemantic.issue ? [videoSemantic.issue] : []),
      ...(audioSemantic.issue ? [audioSemantic.issue] : []),
    ]
    setData((current) => {
      const managedStatuses = { ...current.managedStatuses }
      for (const { name, result } of managed) {
        if (result.ok) managedStatuses[name] = result.value ?? null
      }
      return {
        managedStatuses,
        userSlots: userSlots.ok ? (userSlots.value ?? []) : current.userSlots,
        userRuntimeStatuses:
          deep && userRuntime.ok ? (userRuntime.value ?? []) : current.userRuntimeStatuses,
        videoSemantic: videoSemantic.ok ? (videoSemantic.value ?? null) : current.videoSemantic,
        audioSemantic: audioSemantic.ok ? (audioSemantic.value ?? null) : current.audioSemantic,
        issues,
      }
    })
    setCheckedAt(Date.now())
    setChecking(false)
    if (deep && deepRequestId === deepRequestIdRef.current) {
      deepInFlightRef.current = false
      setDeepChecking(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 30_000)
    const unsubscribe = window.electronAPI.vector.onModelStatusChanged((status) => {
      if (!GLOBAL_MANAGED_MODEL_NAMES.includes(status.name as GlobalManagedModelName)) return
      setData((current) => ({
        ...current,
        managedStatuses: {
          ...current.managedStatuses,
          [status.name]: status,
        },
      }))
      setCheckedAt(Date.now())
      setChecking(false)
    })
    const refreshAfterMutation = () => void refresh({ deep: true })
    window.addEventListener('workspace-models-changed', refreshAfterMutation)
    return () => {
      window.clearInterval(timer)
      unsubscribe()
      window.removeEventListener('workspace-models-changed', refreshAfterMutation)
    }
  }, [refresh])

  const snapshot = useMemo(
    () =>
      buildGlobalModelReadiness({
        ...data,
        checking,
        checkedAt,
      }),
    [checkedAt, checking, data],
  )

  return {
    snapshot,
    checking,
    deepChecking,
    refresh,
  }
}
