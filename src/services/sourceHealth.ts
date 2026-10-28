import type {
  DiscoveryProbeResult,
  DiscoveryScanStatus,
  DiscoverySourceListItem,
  SourceAvailability,
  SourceScanCapability,
  SourceType,
} from '../../shared/ipc-contract'

export type SourceHealthPrimaryAction = 'probe' | 'reconnect'
const directoryOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const directoryParts = (path: string) =>
  path
    .replace(/^\\\\\?\\/, '')
    .replace(/\\/g, '/')
    .split('/')
function compareSourceDirectories(a: SourceHealthItem, b: SourceHealthItem) {
  const left = directoryParts(a.displayLocator)
  const right = directoryParts(b.displayLocator)
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const order = directoryOrder.compare(left[i], right[i])
    if (order) return order
  }
  return left.length - right.length || directoryOrder.compare(a.id, b.id)
}

export function groupSourceHealthItems(items: readonly SourceHealthItem[]) {
  const groups = new Map<string, SourceHealthItem[]>()
  for (const item of items) {
    const locator = item.displayLocator.replace(/^\\\\\?\\/, '')
    const drive = /^([a-z]):[\\/]/i.exec(locator)
    const key =
      item.type === 'sftp'
        ? 'SFTP'
        : drive
          ? `${drive[1].toUpperCase()}:`
          : /^(?:\\\\|\/\/|UNC\\)/i.test(locator)
            ? 'UNC'
            : 'Other'
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }
  return [...groups]
    .sort(([a], [b]) => {
      const driveA = /^[A-Z]:$/.test(a)
      const driveB = /^[A-Z]:$/.test(b)
      return driveA !== driveB ? (driveA ? -1 : 1) : a.localeCompare(b)
    })
    .map(([key, sources]) => ({ key, sources: sources.sort(compareSourceDirectories) }))
}

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
