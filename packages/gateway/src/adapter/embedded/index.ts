// adapter/embedded/index.ts — EmbeddedAdapter: wraps an in-process AgentAdapter implementation

import type { AgentAdapter, AgentRequest, AgentResponse, StreamChunk } from '../types.js'

/**
 * Wraps an in-process agent that implements AgentAdapter.
 * Primarily useful for TypeScript/JavaScript agents co-located in the same process.
 * For Python agents, use HttpAdapter pointing at a separate FastAPI process.
 */
export class EmbeddedAdapter implements AgentAdapter {
  stream?: (request: AgentRequest) => AsyncIterable<StreamChunk>

  constructor(private readonly inner: AgentAdapter) {
    // Only expose stream() if the inner adapter implements it.
    // The pipeline checks `adapter.stream != null` — if we always define the
    // method, it would be called even when the inner has no streaming support.
    if (inner.stream != null) {
      this.stream = (request: AgentRequest) => inner.stream!(request)
    }
  }

  run(request: AgentRequest): Promise<AgentResponse> {
    return this.inner.run(request)
  }

  async onSessionReset(sessionKey: string): Promise<void> {
    await this.inner.onSessionReset?.(sessionKey)
  }
}
