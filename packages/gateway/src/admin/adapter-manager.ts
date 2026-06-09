// admin/adapter-manager.ts — Indirection over the process-wide agent adapter so
// the pipeline always resolves the *current* adapter per turn, and the manager
// can hot-swap it safely (quiesce-drain → atomic swap → rollback on failure).

import type { AgentAdapter, AgentRequest, AgentResponse, StreamChunk } from '../adapter/types.js'
import { logger } from '../lib/logger.js'

const DRAIN_POLL_MS = 50

export class AdapterManager implements AgentAdapter {
  /** Defined only when the initial adapter supports streaming (type is stable per process). */
  stream?: (request: AgentRequest) => AsyncIterable<StreamChunk>

  private current: AgentAdapter
  private active = 0
  /** Set while a swap is quiescing; new turns wait on this before admitting. */
  private swapGate: Promise<void> | null = null

  constructor(initial: AgentAdapter) {
    this.current = initial
    if (initial.stream != null) {
      this.stream = (request: AgentRequest) => this.streamImpl(request)
    }
  }

  /** The adapter currently serving turns. */
  getCurrent(): AgentAdapter {
    return this.current
  }

  async run(request: AgentRequest): Promise<AgentResponse> {
    await this.admit()
    const adapter = this.current
    this.active += 1
    try {
      return await adapter.run(request)
    } finally {
      this.active -= 1
    }
  }

  private async *streamImpl(request: AgentRequest): AsyncIterable<StreamChunk> {
    await this.admit()
    const adapter = this.current
    if (adapter.stream == null) {
      // Current adapter has no streaming path — fall back to run().
      const resp = await adapter.run(request)
      yield { delta: resp.text, done: false }
      yield { delta: '', done: true, interrupted: resp.interrupted, media: resp.media }
      return
    }
    this.active += 1
    try {
      yield* adapter.stream(request)
    } finally {
      this.active -= 1
    }
  }

  async onSessionReset(sessionKey: string): Promise<void> {
    await this.current.onSessionReset?.(sessionKey)
  }

  /**
   * Quiesce-and-drain, then atomically swap to `next`.
   *
   * Blocks new turns from admitting, waits for in-flight turns to drain
   * (bounded by `drainTimeoutMs`), swaps the reference, then resumes. If the
   * drain times out the swap still proceeds — in-flight turns hold their own
   * adapter reference and complete against the old instance.
   */
  async swap(next: AgentAdapter, drainTimeoutMs: number): Promise<void> {
    if (this.swapGate != null) {
      // A swap is already in progress — wait for it before starting ours.
      await this.swapGate
    }
    let release!: () => void
    this.swapGate = new Promise<void>((r) => {
      release = r
    })
    try {
      await this.waitForDrain(drainTimeoutMs)
      this.current = next
      logger.info('AdapterManager: adapter swapped')
    } finally {
      this.swapGate = null
      release()
    }
  }

  /** Block until any in-progress swap completes. */
  private async admit(): Promise<void> {
    while (this.swapGate != null) {
      await this.swapGate
    }
  }

  private async waitForDrain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.active > 0 && Date.now() < deadline) {
      await sleep(DRAIN_POLL_MS)
    }
    if (this.active > 0) {
      logger.warn({ active: this.active }, 'AdapterManager: drain timed out — swapping anyway')
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
