// adapter/index.ts — barrel: re-exports all adapter implementations and shared types.
// Import from here when you need multiple adapters, or import directly from a subfolder
// (e.g. '../adapter/http') for a single adapter.

export { EmbeddedAdapter } from './embedded/index.js'
export { HttpAdapter } from './http/index.js'
export type { HttpAdapterOptions, HttpAdapterProtocol } from './http/index.js'
export { LangGraphAdapter } from './langgraph/index.js'
export type { LangGraphAdapterOptions } from './langgraph/index.js'
export { GatewayAbortError, checkAbort } from './langgraph/index.js'
export { GatewayStateAnnotation } from './langgraph/state.js'
export type { GatewayState } from './langgraph/state.js'
export type {
  AgentAdapter,
  AgentRequest,
  AgentResponse,
  StreamChunk,
} from './types.js'
