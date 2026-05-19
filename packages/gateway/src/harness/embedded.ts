// harness/embedded.ts — EmbeddedHarness: wraps an in-process AgentHarness implementation

import type { AgentHarness, AgentRequest, AgentResponse } from './types.js'

/**
 * Wraps an in-process agent that implements AgentHarness.
 * Primarily useful for TypeScript/JavaScript agents co-located in the same process.
 * For Python agents, use HTTPHarness pointing at a separate FastAPI process.
 */
export class EmbeddedHarness implements AgentHarness {
  constructor(private readonly inner: AgentHarness) {}

  run(request: AgentRequest): Promise<AgentResponse> {
    return this.inner.run(request)
  }

  async onSessionReset(sessionKey: string): Promise<void> {
    await this.inner.onSessionReset?.(sessionKey)
  }
}
