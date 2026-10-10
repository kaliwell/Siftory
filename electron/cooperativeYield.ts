const DEFAULT_BATCH_SIZE = 512

export function shouldYieldToEventLoop(processed: number, batchSize = DEFAULT_BATCH_SIZE): boolean {
  return processed > 0 && processed % batchSize === 0
}

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
