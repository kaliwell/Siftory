export const assetMetadataDeletionHistoryLimits = {
  maxRecords: 50,
  maxBytes: 32 * 1024 * 1024,
} as const

export interface AssetMetadataDeletionHistoryRecord {
  id?: number
  deletedAt: number
  restoredAt?: number
}

export function assetMetadataDeletionRecordBytes(record: unknown): number {
  return Buffer.byteLength(JSON.stringify(record), 'utf8') + 1
}

export function selectRetainedAssetMetadataDeletions<T extends AssetMetadataDeletionHistoryRecord>(
  records: readonly T[],
  limits: { maxRecords: number; maxBytes: number } = assetMetadataDeletionHistoryLimits,
): T[] {
  const maxRecords = Math.max(1, Math.floor(limits.maxRecords))
  const maxBytes = Math.max(1, Math.floor(limits.maxBytes))
  const prioritized = [...records].sort(
    (left, right) =>
      Number(Boolean(left.restoredAt)) - Number(Boolean(right.restoredAt)) ||
      right.deletedAt - left.deletedAt ||
      (right.id || 0) - (left.id || 0),
  )
  const retained = new Set<T>()
  let retainedBytes = 0
  for (const record of prioritized) {
    if (retained.size >= maxRecords) break
    const bytes = assetMetadataDeletionRecordBytes(record)
    if (retained.size > 0 && retainedBytes + bytes > maxBytes) continue
    retained.add(record)
    retainedBytes += bytes
  }
  return records.filter((record) => retained.has(record))
}
