// harness/types.ts — AgentHarness interface + AgentRequest + AgentResponse
// This file is the SINGLE SOURCE OF TRUTH for these types.
// sdk-ts/src/types.ts must be kept byte-identical to this file.
// sdk-py/agent_gateway/types.py must be kept in sync (camelCase ↔ snake_case).

// Re-export MediaItem from connectors so harness authors have a single import point.
export type { MediaItem, Mention } from '../connectors/types.js'

export interface AgentRequest {
  // ── Routing ──────────────────────────────────────────────────────────────
  /** Stable session key — harness uses this for history / state storage. */
  sessionKey: string

  // ── Message ──────────────────────────────────────────────────────────────
  /** Clean user text: mentions stripped, bot @mention removed. */
  message: string
  /** Original unmodified text from the platform (for harness audit/debug). */
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
  /** Harness should honour this in its tool loop and return early when fired. */
  abortSignal: AbortSignal

  // ── Callbacks ────────────────────────────────────────────────────────────
  /**
   * Harness calls this during tool execution for live progress display.
   * MUST NOT throw — gateway absorbs all delivery errors silently (TODO-9).
   */
  progressCallback: (toolName: string, preview: string) => void

  /**
   * Harness calls this to request user approval before executing a dangerous tool.
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

export interface AgentHarness {
  run(request: AgentRequest): Promise<AgentResponse>

  /**
   * Optional lifecycle hook called when wasAutoReset = true.
   * Harness should clear its per-session state.
   */
  onSessionReset?: (sessionKey: string) => Promise<void>
}
