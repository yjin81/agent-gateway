// adapter/langgraph/state.ts
// GatewayState — the state annotation passed to the LangGraph.js StateGraph.
//
// The graph author declares their state as extending (or being compatible with)
// GatewayState. LangGraphAdapter populates the gateway-specific fields before
// each invocation so the graph always has full context without managing it
// itself.

import { Annotation, MessagesAnnotation } from '@langchain/langgraph'
import type { AgentRequest } from '../types.js'

/**
 * Base state annotation for gateway-managed LangGraph agents.
 *
 * Extend this in your graph definition:
 *
 *   const MyState = Annotation.Root({
 *     ...GatewayStateAnnotation.spec,
 *     myField: Annotation<string>(),
 *   })
 *
 * Or use it directly if you only need messages + gateway metadata.
 */
export const GatewayStateAnnotation = Annotation.Root({
  // Standard LangChain messages array with append-only reducer.
  ...MessagesAnnotation.spec,

  // ── Gateway metadata (read-only from the graph's perspective) ────────────

  /** Stable session key — use as the key for any per-session side-effects. */
  sessionKey: Annotation<string>(),

  /** True on the first message ever in this session. */
  isNew: Annotation<boolean>(),

  /** True if the session idle-timeout fired since the last turn. */
  wasAutoReset: Annotation<boolean>(),

  /** Platform context injected by the gateway. */
  platform: Annotation<AgentRequest['platform']>(),

  /** Gateway-enforced tool policy. */
  toolPolicy: Annotation<AgentRequest['toolPolicy']>(),
})

export type GatewayState = typeof GatewayStateAnnotation.State
