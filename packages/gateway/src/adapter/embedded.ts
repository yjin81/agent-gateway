// adapter/embedded.ts — EmbeddedAdapter: wraps an in-process AgentAdapter implementation

import type { AgentAdapter, AgentRequest, AgentResponse } from './types.js'

/**
 * Wraps an in-process agent that implements AgentAdapter.
 * Primarily useful for TypeScript/JavaScript agents co-located in the same process.
 * For Python agents, use HttpAdapter pointing at a separate FastAPI process.
 */
export class EmbeddedAdapter implements AgentAdapter {
  constructor(private readonly inner: AgentAdapter) {}

  run(request: AgentRequest): Promise<AgentResponse> {
    return this.inner.run(request)
  }

  async onSessionReset(sessionKey: string): Promise<void> {
    await this.inner.onSessionReset?.(sessionKey)
  }
}
