export interface SessionSearchResultIdentity {
  taskId: string
  resultId: string
}

export interface SessionSearchResultQuery {
  taskId?: string
  resultId?: string
}

/** Bounded insertion-ordered result history for one process session. */
export class SessionSearchResultCache<T extends SessionSearchResultIdentity> {
  private readonly results = new Map<string, T>()
  private readonly resultIdByTask = new Map<string, string>()

  constructor(private readonly limit = 10) {}

  clear(): void {
    this.results.clear()
    this.resultIdByTask.clear()
  }

  put(result: T): void {
    const previousResultId = this.resultIdByTask.get(result.taskId)
    if (previousResultId) this.results.delete(previousResultId)
    this.results.set(result.resultId, result)
    this.resultIdByTask.set(result.taskId, result.resultId)
    while (this.results.size > Math.max(1, this.limit)) {
      const oldestResultId = this.results.keys().next().value as string | undefined
      if (!oldestResultId) break
      const oldest = this.results.get(oldestResultId)
      this.results.delete(oldestResultId)
      if (oldest && this.resultIdByTask.get(oldest.taskId) === oldestResultId) {
        this.resultIdByTask.delete(oldest.taskId)
      }
    }
  }

  get(query: SessionSearchResultQuery = {}): T | null {
    if (query.resultId) {
      const result = this.results.get(query.resultId)
      return result && (!query.taskId || result.taskId === query.taskId) ? result : null
    }
    if (query.taskId) {
      const resultId = this.resultIdByTask.get(query.taskId)
      return resultId ? this.results.get(resultId) || null : null
    }
    const latestResultId = [...this.results.keys()].at(-1)
    return latestResultId ? this.results.get(latestResultId) || null : null
  }
}
