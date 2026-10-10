import { getVectorAnnRuntimeMemorySnapshot } from './vectorAnnWorkerHost'
import { getMediaSearchImageDataUrlCacheStats } from './mediaSearchImageCache'
import { getUserModelRuntimeMemorySnapshot } from './userModelRuntimeHost'
import {
  captureRegisteredRuntimeCacheBudgets,
  registerRuntimeCacheBudgetProvider,
  RUNTIME_MEMORY_PROVIDER_NAME_MAX_LENGTH,
  type RuntimeCacheBudgetSnapshot,
} from './runtimeMemoryCacheRegistry'

export { registerRuntimeCacheBudgetProvider, RUNTIME_MEMORY_PROVIDER_NAME_MAX_LENGTH }
export type { RuntimeCacheBudgetSnapshot }

export interface RendererDebuggerLike {
  isAttached(): boolean
  attach(protocolVersion?: string): void
  detach(): void
  sendCommand(method: string): Promise<Record<string, unknown>>
}

export interface RendererMemoryTarget {
  id: number
  isDestroyed(): boolean
  debugger: RendererDebuggerLike
}

export interface RendererRuntimeMemorySnapshot {
  id: number
  status: 'ok' | 'unavailable' | 'destroyed'
  heapUsedBytes?: number
  heapTotalBytes?: number
  embedderHeapUsedBytes?: number
  backingStorageBytes?: number
  documents?: number
  nodes?: number
  jsEventListeners?: number
  errorType?: string
}

export interface RuntimeMemoryTelemetrySnapshot {
  schema: 'siftory-runtime-memory-telemetry/v1'
  sampledAt: string
  main: {
    heapUsedBytes: number
    heapTotalBytes: number
    externalBytes: number
    arrayBuffersBytes: number
    rssBytes: number
    nativePrivateBytes?: number
    nativeResidentSetBytes?: number
  }
  ann: ReturnType<typeof getVectorAnnRuntimeMemorySnapshot>
  renderers: RendererRuntimeMemorySnapshot[]
  cacheBudgets: Record<string, RuntimeCacheBudgetSnapshot>
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

function captureCacheBudgets(): Record<string, RuntimeCacheBudgetSnapshot> {
  const mediaImageCache = getMediaSearchImageDataUrlCacheStats()
  const userModelRuntime = getUserModelRuntimeMemorySnapshot()
  const snapshots: Record<string, RuntimeCacheBudgetSnapshot> = {
    'media-search-data-url': {
      entries: mediaImageCache.entries,
      ownedBytesApprox: mediaImageCache.totalWeight,
      budgetBytes: mediaImageCache.maxWeight,
    },
    'media-frame-index': {
      entries: 0,
      ownedBytesApprox: 0,
      budgetBytes: 256 * 1024 * 1024,
    },
    'user-model-runtime': {
      entries: userModelRuntime.sessionCount,
      activeEntries: userModelRuntime.activeRequest ? 1 : 0,
      ownedBytesApprox: userModelRuntime.ownedBytesApprox,
      budgetBytes: userModelRuntime.budgetBytes,
    },
  }
  Object.assign(snapshots, captureRegisteredRuntimeCacheBudgets())
  return snapshots
}

async function captureRendererMemory(
  target: RendererMemoryTarget,
): Promise<RendererRuntimeMemorySnapshot> {
  if (target.isDestroyed()) return { id: target.id, status: 'destroyed' }
  const alreadyAttached = target.debugger.isAttached()
  let attachedHere = false
  try {
    if (!alreadyAttached) {
      target.debugger.attach('1.3')
      attachedHere = true
    }
    const [heap, dom] = await Promise.all([
      target.debugger.sendCommand('Runtime.getHeapUsage'),
      target.debugger.sendCommand('Memory.getDOMCounters'),
    ])
    return {
      id: target.id,
      status: 'ok',
      heapUsedBytes: nonNegativeInteger(heap.usedSize),
      heapTotalBytes: nonNegativeInteger(heap.totalSize),
      embedderHeapUsedBytes: nonNegativeInteger(heap.embedderHeapUsedSize),
      backingStorageBytes: nonNegativeInteger(heap.backingStorageSize),
      documents: nonNegativeInteger(dom.documents),
      nodes: nonNegativeInteger(dom.nodes),
      jsEventListeners: nonNegativeInteger(dom.jsEventListeners),
    }
  } catch (error) {
    return {
      id: target.id,
      status: 'unavailable',
      errorType: error instanceof Error ? error.name.slice(0, 64) : 'UnknownError',
    }
  } finally {
    if (attachedHere && target.debugger.isAttached()) target.debugger.detach()
  }
}

type ElectronProcessMemory = NodeJS.Process & {
  getProcessMemoryInfo?: () => Promise<{ private: number; residentSet: number }>
}

export async function captureRuntimeMemoryTelemetry(
  rendererTargets: readonly RendererMemoryTarget[] = [],
): Promise<RuntimeMemoryTelemetrySnapshot> {
  const usage = process.memoryUsage()
  const electronProcess = process as ElectronProcessMemory
  const nativeMemory = await (async () => {
    try {
      return electronProcess.getProcessMemoryInfo
        ? await electronProcess.getProcessMemoryInfo()
        : null
    } catch {
      return null
    }
  })()
  const renderers = await Promise.all(
    rendererTargets
      .filter((target) => Number.isInteger(target.id) && target.id >= 0)
      .slice(0, 32)
      .map(captureRendererMemory),
  )
  return {
    schema: 'siftory-runtime-memory-telemetry/v1',
    sampledAt: new Date().toISOString(),
    main: {
      heapUsedBytes: usage.heapUsed,
      heapTotalBytes: usage.heapTotal,
      externalBytes: usage.external,
      arrayBuffersBytes: usage.arrayBuffers,
      rssBytes: usage.rss,
      ...(nativeMemory
        ? {
            nativePrivateBytes: nativeMemory.private * 1024,
            nativeResidentSetBytes: nativeMemory.residentSet * 1024,
          }
        : {}),
    },
    ann: getVectorAnnRuntimeMemorySnapshot(),
    renderers,
    cacheBudgets: captureCacheBudgets(),
  }
}
