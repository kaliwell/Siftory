export const IPC_PAYLOAD_LIMITS = Object.freeze({
  arguments: 64,
  depth: 12,
  collectionItems: 10_000,
  stringLength: 1024 * 1024,
  binaryBytes: 64 * 1024 * 1024,
})

function assertBoundedValue(value: unknown, depth: number, seen: Set<object>): void {
  if (depth > IPC_PAYLOAD_LIMITS.depth) throw new Error('IPC payload nesting limit exceeded')
  if (value === null || value === undefined || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('IPC payload contains a non-finite number')
    return
  }
  if (typeof value === 'string') {
    if (value.length > IPC_PAYLOAD_LIMITS.stringLength)
      throw new Error('IPC string payload is too large')
    return
  }
  if (typeof value !== 'object') throw new Error('IPC payload contains an unsupported value')
  if (ArrayBuffer.isView(value)) {
    if (value.byteLength > IPC_PAYLOAD_LIMITS.binaryBytes)
      throw new Error('IPC binary payload is too large')
    return
  }
  if (value instanceof ArrayBuffer) {
    if (value.byteLength > IPC_PAYLOAD_LIMITS.binaryBytes)
      throw new Error('IPC binary payload is too large')
    return
  }
  if (seen.has(value)) throw new Error('IPC payload contains a cycle')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (value.length > IPC_PAYLOAD_LIMITS.collectionItems)
        throw new Error('IPC array payload is too large')
      for (const item of value) assertBoundedValue(item, depth + 1, seen)
      return
    }
    const entries = Object.entries(value)
    if (entries.length > IPC_PAYLOAD_LIMITS.collectionItems)
      throw new Error('IPC object payload is too large')
    for (const [key, item] of entries) {
      if (key.length > 256) throw new Error('IPC object key is too large')
      assertBoundedValue(item, depth + 1, seen)
    }
  } finally {
    seen.delete(value)
  }
}

export function validateIpcPayloadArguments(args: readonly unknown[]): void {
  if (args.length > IPC_PAYLOAD_LIMITS.arguments) throw new Error('Too many IPC arguments')
  const seen = new Set<object>()
  for (const value of args) assertBoundedValue(value, 0, seen)
}
