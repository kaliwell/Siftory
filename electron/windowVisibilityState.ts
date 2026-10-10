export type WindowVisibilityState = 'visible' | 'preparing-hide' | 'hidden' | 'preparing-show'

export type WindowVisibilityReason =
  | 'hotkey'
  | 'settings'
  | 'second-instance'
  | 'ai-control'
  | 'recovery'

export interface WindowVisibilitySnapshot {
  state: WindowVisibilityState
  generation: number
  reason: WindowVisibilityReason
  changedAt: number
}

export class WindowVisibilityMachine {
  private requestedVisible = true
  private suspended = false
  private snapshot: WindowVisibilitySnapshot = {
    state: 'visible',
    generation: 0,
    reason: 'recovery',
    changedAt: Date.now(),
  }

  current(): WindowVisibilitySnapshot {
    return { ...this.snapshot }
  }

  wantsVisible(): boolean {
    return this.requestedVisible
  }

  begin(visible: boolean, reason: WindowVisibilityReason): WindowVisibilitySnapshot | null {
    if (visible === this.wantsVisible()) return null
    this.requestedVisible = visible
    this.snapshot = {
      state: visible && !this.suspended ? 'preparing-show' : 'preparing-hide',
      generation: this.snapshot.generation + 1,
      reason,
      changedAt: Date.now(),
    }
    return this.current()
  }

  /** Retire geometry and outstanding renderer work without changing user intent. */
  invalidate(): WindowVisibilitySnapshot {
    this.snapshot = {
      state: this.requestedVisible && !this.suspended ? 'preparing-show' : 'hidden',
      generation: this.snapshot.generation + 1,
      reason: 'recovery',
      changedAt: Date.now(),
    }
    return this.current()
  }

  suspend(): WindowVisibilitySnapshot | null {
    if (this.suspended) return null
    this.suspended = true
    return this.invalidate()
  }

  resume(): WindowVisibilitySnapshot | null {
    if (!this.suspended) return null
    this.suspended = false
    return this.invalidate()
  }

  restartVisible(reason: WindowVisibilityReason): WindowVisibilitySnapshot | null {
    if (this.snapshot.state !== 'visible') return null
    this.snapshot = {
      state: 'preparing-show',
      generation: this.snapshot.generation + 1,
      reason,
      changedAt: Date.now(),
    }
    return this.current()
  }

  completeHidden(generation: number): WindowVisibilitySnapshot | null {
    if (this.snapshot.state !== 'preparing-hide' || generation !== this.snapshot.generation) {
      return null
    }
    this.snapshot = { ...this.snapshot, state: 'hidden', changedAt: Date.now() }
    return this.current()
  }

  completeVisible(generation: number): WindowVisibilitySnapshot | null {
    if (this.snapshot.state !== 'preparing-show' || generation !== this.snapshot.generation) {
      return null
    }
    this.snapshot = { ...this.snapshot, state: 'visible', changedAt: Date.now() }
    return this.current()
  }

  acceptsRendererMutation(generation: number): boolean {
    return (
      generation === this.snapshot.generation &&
      (this.snapshot.state === 'visible' || this.snapshot.state === 'preparing-show')
    )
  }
}
