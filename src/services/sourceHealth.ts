import type {
  DiscoveryProbeResult,
  DiscoveryScanStatus,
  DiscoverySourceListItem,
  SourceAvailability,
  SourceScanCapability,
  SourceType,
} from '../../shared/ipc-contract'

export type SourceHealthPrimaryAction = 'probe' | 'reconnect'

export interface SourceHealthItem {
  id: string
  type: SourceType
  availability: SourceAvailability
  scanCapability: SourceScanCapability
  displayName: string
  displayLocator: string
  fileCount: number
  totalBytes: number
  lastAttemptAt?: number
  lastSuccessfulScanAt?: number
  incrementalWatch?: DiscoverySourceListItem['incrementalWatch']
  running: boolean
  scanState?: 'running' | 'cancelled' | 'completed' | 'error'
  detail?: string
  primaryAction: SourceHealthPrimaryAction
  canRepairRoot: boolean
}

export function buildSourceHealthItems(
  sources: readonly DiscoverySourceListItem[],
  statuses: Readonly<Record<string, DiscoveryScanStatus | undefined>>,
  probes: Readonly<Record<string, DiscoveryProbeResult | undefined>> = {},
): SourceHealthItem[] {
  return sources.map((source) => {
    const status = statuses[source.id]
    const session = status?.session ?? null
    const probe = probes[source.id]
    const availability = probe?.availability ?? source.availability
    const detail =
      probe?.error ||
      probe?.detail ||
      (session?.state === 'error' ? session.error : undefined) ||
      session?.fallbackReason

    return {
      id: source.id,
      type: source.type,
      availability,
      scanCapability: probe?.scanCapability ?? source.scanCapability,
      displayName: source.displayName,
      displayLocator: source.displayLocator || source.rootLocator,
      fileCount: Math.max(0, source.fileCount),
      totalBytes: Math.max(0, source.totalBytes),
      ...(source.lastAttemptAt ? { lastAttemptAt: source.lastAttemptAt } : {}),
      ...(source.lastSuccessfulScanAt ? { lastSuccessfulScanAt: source.lastSuccessfulScanAt } : {}),
      ...(source.incrementalWatch ? { incrementalWatch: source.incrementalWatch } : {}),
      running: status?.running === true,
      ...(session ? { scanState: session.state } : {}),
      ...(detail || source.incrementalWatch?.lastError
        ? { detail: detail || source.incrementalWatch?.lastError }
        : {}),
      primaryAction: availability === 'online' ? 'probe' : 'reconnect',
      canRepairRoot: source.type === 'mounted-network',
    }
  })
}
