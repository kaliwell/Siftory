/** Coordinates query responses and library browsing across asynchronous refreshes. */
export class MediaSearchRequestState {
  private revision = 0
  private mounted = true
  private mode: 'browse' | 'query' = 'browse'
  private requestId: string | null = null
  private readonly prefix = `media-query-${Date.now()}-${Math.random().toString(36).slice(2)}`

  activate(): void {
    this.mounted = true
  }

  dispose(): void {
    this.mounted = false
    this.revision += 1
    this.requestId = null
  }

  beginQuery(): string {
    this.mode = 'query'
    this.requestId = `${this.prefix}-${++this.revision}`
    return this.requestId
  }

  isCurrent(requestId: string): boolean {
    return this.mounted && this.requestId === requestId
  }

  finishQuery(requestId: string): boolean {
    if (!this.isCurrent(requestId)) return false
    this.requestId = null
    return true
  }

  beginBrowse(): void {
    this.revision += 1
    this.mode = 'browse'
    this.requestId = null
  }

  browseRevision(): number | null {
    return this.mounted && this.mode === 'browse' ? this.revision : null
  }

  acceptsBrowse(revision: number | null): boolean {
    return revision !== null && this.browseRevision() === revision
  }
}
