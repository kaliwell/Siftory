export interface RendererDataUrlCacheStats {
  entries: number
  totalWeight: number
  maxEntries: number
  maxWeight: number
}

export function estimateRendererDataUrlWeight(key: string, value: string): number {
  // Data URLs are ASCII today, but two bytes per code unit is a conservative
  // cross-engine bound and includes key/object bookkeeping.
  return key.length * 2 + value.length * 2 + 96
}

export class RendererDataUrlLru {
  private readonly values = new Map<string, { value: string; weight: number }>()
  private totalWeightValue = 0

  constructor(
    private readonly maxEntries: number,
    private readonly maxWeight: number,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new Error('Renderer data URL entry budget is invalid')
    }
    if (!Number.isSafeInteger(maxWeight) || maxWeight <= 0) {
      throw new Error('Renderer data URL byte budget is invalid')
    }
  }

  get(key: string): string | undefined {
    const entry = this.values.get(key)
    if (!entry) return undefined
    this.values.delete(key)
    this.values.set(key, entry)
    return entry.value
  }

  set(key: string, value: string): boolean {
    const weight = estimateRendererDataUrlWeight(key, value)
    const previous = this.values.get(key)
    if (previous) {
      this.values.delete(key)
      this.totalWeightValue -= previous.weight
    }
    if (weight > this.maxWeight) return false
    while (this.values.size >= this.maxEntries || this.totalWeightValue + weight > this.maxWeight) {
      const oldestKey = this.values.keys().next().value as string | undefined
      if (oldestKey === undefined) break
      const oldest = this.values.get(oldestKey)
      this.values.delete(oldestKey)
      if (oldest) this.totalWeightValue -= oldest.weight
    }
    this.values.set(key, { value, weight })
    this.totalWeightValue += weight
    return true
  }

  clear(): void {
    this.values.clear()
    this.totalWeightValue = 0
  }

  entries(): Array<[string, string]> {
    return [...this.values].map(([key, entry]) => [key, entry.value])
  }

  stats(): RendererDataUrlCacheStats {
    return {
      entries: this.values.size,
      totalWeight: this.totalWeightValue,
      maxEntries: this.maxEntries,
      maxWeight: this.maxWeight,
    }
  }
}

export function setBoundedDataUrlRecord(
  previous: Readonly<Record<string, string>>,
  key: string,
  value: string,
  maxEntries: number,
  maxWeight: number,
): Record<string, string> {
  const cache = new RendererDataUrlLru(maxEntries, maxWeight)
  for (const [existingKey, existingValue] of Object.entries(previous)) {
    cache.set(existingKey, existingValue)
  }
  cache.set(key, value)
  return Object.fromEntries(cache.entries())
}
