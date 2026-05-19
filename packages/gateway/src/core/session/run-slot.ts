// core/session/run-slot.ts — RunSlot and SessionRunRegistry (Section 5.1 concurrency model)

import type { NormalizedMessage } from '../../connectors/types.js'

export interface PendingTurn {
  msg: NormalizedMessage
  /** Resolve this promise to signal the waiting enqueue call to proceed. */
  resolve: () => void
}

export interface RunSlot {
  state: 'idle' | 'running'
  abortCtrl: AbortController | null
  pendingQueue: PendingTurn[]
}

/**
 * In-memory map of sessionKey → RunSlot.
 * A single GatewayRunner owns one SessionRunRegistry instance.
 */
export class SessionRunRegistry {
  private slots = new Map<string, RunSlot>()

  /**
   * Get or lazily create the RunSlot for a session.
   */
  getOrCreate(sessionKey: string): RunSlot {
    let slot = this.slots.get(sessionKey)
    if (slot == null) {
      slot = { state: 'idle', abortCtrl: null, pendingQueue: [] }
      this.slots.set(sessionKey, slot)
    }
    return slot
  }

  /**
   * Acquire the slot for a new run.
   * MUST be called synchronously (same event-loop tick as the idle check) to prevent races.
   * Caller is responsible for releasing via release().
   */
  acquire(sessionKey: string): { slot: RunSlot; abortCtrl: AbortController } {
    const slot = this.getOrCreate(sessionKey)
    if (slot.state !== 'idle') {
      throw new Error(`BUG: acquire() called on non-idle slot for ${sessionKey}`)
    }
    const abortCtrl = new AbortController()
    slot.state = 'running'
    slot.abortCtrl = abortCtrl
    return { slot, abortCtrl }
  }

  /**
   * Release the slot after a run completes (always called in finally).
   */
  release(sessionKey: string): void {
    const slot = this.slots.get(sessionKey)
    if (slot == null) return
    slot.state = 'idle'
    slot.abortCtrl = null
  }

  /**
   * Abort the active run for a session (called by /stop and new-message-while-running).
   * Does nothing if idle.
   */
  abort(sessionKey: string): void {
    const slot = this.slots.get(sessionKey)
    if (slot?.abortCtrl != null) {
      slot.abortCtrl.abort()
    }
  }

  /**
   * Enqueue a pending turn, respecting pendingQueueCap.
   * If the queue is at cap, the oldest entry is superseded and its resolve() is called
   * (so the caller is unblocked) — the caller must then deliver the overflow notification.
   *
   * Returns the superseded turn (if any) so the caller can notify the user.
   */
  enqueue(
    sessionKey: string,
    pendingTurn: PendingTurn,
    cap: number,
  ): PendingTurn | null {
    const slot = this.getOrCreate(sessionKey)
    let superseded: PendingTurn | null = null
    if (slot.pendingQueue.length >= cap) {
      // Replace the oldest (first) pending item.
      const oldest = slot.pendingQueue.shift()
      if (oldest != null) {
        superseded = oldest
        oldest.resolve() // unblock the waiter so it can send the overflow message
      }
    }
    slot.pendingQueue.push(pendingTurn)
    return superseded
  }

  /**
   * Dequeue the next pending turn, or null if the queue is empty.
   */
  dequeue(sessionKey: string): PendingTurn | null {
    const slot = this.slots.get(sessionKey)
    if (slot == null || slot.pendingQueue.length === 0) return null
    return slot.pendingQueue.shift() ?? null
  }
}
