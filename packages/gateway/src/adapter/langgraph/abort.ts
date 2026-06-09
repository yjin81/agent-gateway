// adapter/langgraph/abort.ts
//
// Helpers for abort / cancellation support in LangGraph tool nodes.
//
// The gateway passes an AbortSignal to the graph via RunnableConfig.signal.
// LangGraph's built-in nodes (ChatModel invocations, tool execution) honour
// it automatically. Custom tool nodes that run long-lived work should call
// checkAbort() at safe checkpoints to exit early when the user issues /stop.
//
// Usage inside a tool node:
//
//   import { checkAbort } from '@agent-gateway/gateway/adapter/langgraph'
//
//   async function myToolNode(state: GatewayState, config: RunnableConfig) {
//     checkAbort(config)          // throws GatewayAbortError if signal fired
//     const result = await doWork()
//     checkAbort(config)          // check again after async work
//     return { messages: [...] }
//   }

import type { RunnableConfig } from '@langchain/core/runnables'

/**
 * Thrown by checkAbort() when the gateway's AbortSignal has fired.
 * LangGraphAdapter.run() and stream() catch this and return interrupted: true
 * instead of propagating it as an adapter error.
 */
export class GatewayAbortError extends Error {
  constructor() {
    super('Turn aborted by gateway signal')
    this.name = 'GatewayAbortError'
  }
}

/**
 * Check whether the gateway has cancelled this turn.
 *
 * Call this at safe checkpoints inside custom tool nodes or long-running
 * graph nodes. Throws GatewayAbortError if the AbortSignal has fired.
 *
 * @param config  The RunnableConfig passed by LangGraph to your node function.
 *                The gateway injects the AbortSignal via config.signal.
 */
export function checkAbort(config: RunnableConfig): void {
  if ((config as { signal?: AbortSignal }).signal?.aborted) {
    throw new GatewayAbortError()
  }
}
