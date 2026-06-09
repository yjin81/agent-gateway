// adapter/types.ts — AgentAdapter interface + AgentRequest + AgentResponse + StreamChunk
// This file is the SINGLE SOURCE OF TRUTH for these types.
// sdk-ts/src/types.ts must be kept byte-identical to this file.
// sdk-py/agent_gateway/types.py must be kept in sync (camelCase ↔ snake_case).

// Re-export MediaItem from connectors so adapter authors have a single import point.
export type { MediaItem, Mention } from '../connectors/types.js'

export interface AgentRequest {
  // ── Routing ──────────────────────────────────────────────────────────────
  /** Stable session key — adapter uses this for history / state storage. */
  sessionKey: string

  // ── Message ──────────────────────────────────────────────────────────────
  /** Clean user text: mentions stripped, bot @mention removed. */
  message: string
  /** Original unmodified text from the platform (for adapter audit/debug). */
  messageRaw: string
  /** Inbound attachments (gateway downloads if the platform provides a URL). */
  media: import('../connectors/types.js').MediaItem[]

  // ── Session state flags ───────────────────────────────────────────────────
  /** True on the first message ever sent in this session. */
  isNew: boolean
  /** True if the session idle-timeout fired since the last turn. */
  wasAutoReset: boolean

  // ── Platform context — structured facts, not prose ────────────────────────
  platform: {
    name: string
    chatKind: 'dm' | 'group' | 'channel' | 'thread'
    userId: string
    userName: string
    accountId: string
    mentions: import('../connectors/types.js').Mention[]
  }

  // ── Gateway-enforced tool policy ──────────────────────────────────────────
  toolPolicy: {
    /** Explicit allowlist. Empty array = all tools allowed. */
    allowedTools: string[]
    /** Explicit blocklist. */
    disabledTools: string[]
  }

  // ── Interruption ──────────────────────────────────────────────────────────
  /** Adapter should honour this in its tool loop and return early when fired. */
  abortSignal: AbortSignal

  // ── Callbacks ────────────────────────────────────────────────────────────
  /**
   * Adapter calls this during tool execution for live progress display.
   * MUST NOT throw — gateway absorbs all delivery errors silently (TODO-9).
   */
  progressCallback: (toolName: string, preview: string) => void

  /**
   * Adapter calls this to request user approval before executing a dangerous tool.
   * Resolves 'approved' | 'denied' — denied includes timeout.
   */
  approvalCallback: (prompt: string) => Promise<'approved' | 'denied'>
}

export interface AgentResponse {
  /** Response text — clean, no platform-specific syntax. CommonMark (TODO-8). */
  text: string
  /** Explicit media items to deliver. Gateway does not parse text for URLs. */
  media: import('../connectors/types.js').MediaItem[]
  /** True if abortSignal fired and the turn was cut short. */
  interrupted: boolean
}

/**
 * A single streaming chunk emitted by adapter.stream().
 *
 * The gateway appends delta values to build the full response text as chunks
 * arrive. The final chunk carries done: true and the completed media/interrupted
 * flags — all earlier chunks have these fields absent or false.
 */
export interface StreamChunk {
  /** Token text to append to the accumulated response. May be empty string on the final chunk. */
  delta: string
  /** True on the last chunk — no further chunks will follow. */
  done: boolean
  /**
   * Populated only on the final chunk (done: true).
   * True if abortSignal fired and the turn was cut short.
   */
  interrupted?: boolean
  /**
   * Media items to deliver. Populated only on the final chunk (done: true).
   * Absent or empty on intermediate chunks.
   */
  media?: import('../connectors/types.js').MediaItem[]
}

export interface AgentAdapter {
  /**
   * Run one agent turn and return the complete response.
   * Always required — used as fallback when stream() is absent or the connector
   * does not support streaming.
   */
  run(request: AgentRequest): Promise<AgentResponse>

  /**
   * Optional streaming path. When present, the pipeline calls stream() in
   * preference to run() and routes chunks to the connector.
   *
   * The async iterable MUST:
   *   - yield one or more chunks with done: false
   *   - yield exactly one final chunk with done: true
   *   - honour request.abortSignal: stop yielding when it fires and set
   *     interrupted: true on the final chunk
   *
   * The pipeline assembles AgentResponse from the accumulated chunks and uses it
   * for audit logging, regardless of how the connector delivers the content.
   */
  stream?(request: AgentRequest): AsyncIterable<StreamChunk>

  /**
   * Optional lifecycle hook called when wasAutoReset = true.
   * Adapter should clear its per-session state.
   */
  onSessionReset?: (sessionKey: string) => Promise<void>
}
