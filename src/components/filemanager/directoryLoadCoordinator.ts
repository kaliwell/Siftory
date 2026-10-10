export type DirectoryLoadMode = boolean | 'silent'

export interface DirectoryLoadTicket {
  generation: number
  kind: 'replace' | 'append'
}

/**
 * Coordinates async directory loads so an older sort, navigation, or watcher
 * response can never overwrite the latest listing.
 */
export class DirectoryLoadCoordinator {
  private generation = 0
  private replaceInFlightGeneration: number | null = null
  private appendInFlightGeneration: number | null = null

  begin(mode: DirectoryLoadMode): DirectoryLoadTicket | null {
    const replacesListing = mode === true || mode === 'silent'
    if (replacesListing) {
      this.generation += 1
      this.replaceInFlightGeneration = this.generation
      this.appendInFlightGeneration = null
      return { generation: this.generation, kind: 'replace' }
    }

    if (
      this.replaceInFlightGeneration === this.generation ||
      this.appendInFlightGeneration === this.generation
    ) {
      return null
    }

    this.appendInFlightGeneration = this.generation
    return { generation: this.generation, kind: 'append' }
  }

  isCurrent(ticket: DirectoryLoadTicket): boolean {
    return ticket.generation === this.generation
  }

  finish(ticket: DirectoryLoadTicket): void {
    if (ticket.kind === 'replace' && this.replaceInFlightGeneration === ticket.generation) {
      this.replaceInFlightGeneration = null
    }
    if (ticket.kind === 'append' && this.appendInFlightGeneration === ticket.generation) {
      this.appendInFlightGeneration = null
    }
  }

  invalidate(): void {
    this.generation += 1
    this.replaceInFlightGeneration = null
    this.appendInFlightGeneration = null
  }
}
