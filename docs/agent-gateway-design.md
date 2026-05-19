# Agent Gateway — Product & Technical Design

## Table of Contents

1. [Product Overview](#1-product-overview)
2. [Positioning & Value Proposition](#2-positioning--value-proposition)
3. [Architecture Overview](#3-architecture-overview)
4. [Layer 1 — Platform Connectors](#4-layer-1--platform-connectors)
5. [Layer 2 — Agent Gateway Core](#5-layer-2--agent-gateway-core)
6. [Layer 3 — Agent Harness Interface](#6-layer-3--agent-harness-interface)
7. [Data Models](#7-data-models)
8. [Turn Sources](#8-turn-sources)
9. [Deployment Considerations](#9-deployment-considerations)
10. [Comparison with Alternatives](#10-comparison-with-alternatives)
11. [Roadmap Considerations](#11-roadmap-considerations)
12. [Reference Implementations](#12-reference-implementations)
13. [Post-v0 Design Todos](#13-post-v0-design-todos)
14. [Technology Stack](#14-technology-stack)
15. [Folder & Package Structure](#15-folder--package-structure)
16. [Configuration Schema](#16-configuration-schema)
17. [Error Handling Strategy](#17-error-handling-strategy)

---

## 1. Product Overview

**Agent Gateway** is a self-hostable runtime that connects any AI agent to any messaging platform. It handles all the infrastructure concerns that are common across every agent deployment — platform connectivity, session routing, message concurrency, typing indicators, response delivery — so that agent developers can focus exclusively on agent logic.

The core insight is that building an agent for Telegram, Discord, Slack, or WhatsApp requires solving two fundamentally different problems:

1. **Platform integration**: Each messaging platform has a private, incompatible protocol, message schema, and identity system. These cannot be unified; they must each be implemented individually.
2. **Agent integration**: Every AI agent, regardless of framework, needs the same runtime infrastructure: a stable session identity, concurrency protection, interrupt handling, and reliable response delivery.

Agent Gateway solves both problems in a layered architecture. The gateway is a pure message router — it does not manage conversation history, compose prompts, or make reasoning decisions. Those belong to the agent harness.

---

## 2. Positioning & Value Proposition

### Target Users

- **Agent developers** who have built an agent using any framework (LangGraph, AutoGen, CrewAI, custom harness, or a hosted endpoint like Foundry Invocations) and want to deploy it to messaging platforms without building platform integrations themselves.
- **Platform teams** who want to expose a shared agent infrastructure to multiple teams, each with their own agent implementation.
- **Enterprise deployments** that need to support multiple messaging channels from a single agent backend.

### Core Value

| Without Agent Gateway | With Agent Gateway |
|---|---|
| Build Telegram, Discord, Slack adapters separately for each agent | Implement one `AgentHarness`, get 20+ platforms |
| Re-implement session routing, typing, interrupts per agent | Platform-agnostic infrastructure handled once |
| Each platform requires custom mention parsing and chat-type logic | Unified `NormalizedMessage` contract |
| Approval flows require platform-specific UI code | Gateway handles `/approve`/`/deny` natively |
| Agent must handle concurrent messages from same chat | Gateway enforces serial-per-session execution |

### Differentiation from Existing Solutions

| Solution | Why Insufficient |
|---|---|
| Microsoft Bot Framework (retired 2026) | Attempted protocol unification at the wrong layer; abandoned |
| Botpress / Rasa | Opinionated all-in-one platforms, not agent-framework-agnostic |
| Cognigy / Kore.ai | Enterprise SaaS, not self-hostable, not framework-agnostic |
| Direct platform SDKs | Per-platform, per-agent duplication; no shared infrastructure |

Agent Gateway is **self-hostable and framework-agnostic**. It does not dictate how agents think — only how messages flow.

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                   Layer 1: Platform Connectors                  │
│                                                                 │
│  Telegram  Discord  Slack  WhatsApp  Signal  WeCom  Feishu      │
│  DingTalk  Matrix  Mattermost  Teams  Email  SMS  QQBot  ...    │
│                                                                 │
│  Each connector implements:                                     │
│    startAccount() / stopAccount()  — connection lifecycle       │
│    normalize(raw) → NormalizedMessage | null                    │
│    isAgentAddressed(msg) → bool    — platform mention rules     │
│    deriveSessionKey(msg) → string  — platform isolation policy  │
│    send(target, text, media)       — outbound delivery          │
│                                                                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │  NormalizedMessage
                           │  (platform-specific syntax resolved,
                           │   mentions stripped to structured facts,
                           │   chat type normalized)
┌──────────────────────────┴──────────────────────────────────────┐
│                   Layer 2: Agent Gateway Core                   │
│                                                                 │
│  Turn Pipeline                    Session Registry              │
│  ├── Stage 1: NORMALIZE           ├── sessionKey → RunSlot      │
│  ├── Stage 2: CLASSIFY            ├── idle-timeout reset        │
│  ├── Stage 3: IDENTIFY            └── audit log (append-only)   │
│  ├── Stage 4: CONCURRENCY GATE                                  │
│  ├── Stage 5: DISPATCH            Reliability                   │
│  └── Stage 6: FINALIZE            ├── send_with_retry()         │
│                                   ├── chunking                  │
│  Typing & Presence                └── plain-text fallback       │
│  ├── keep_typing() loop                                         │
│  ├── pause / resume (approval)    Command System                │
│  └── stop on finalize             └── /stop /new /approve ...   │
│                                                                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │  AgentRequest
                           │  { sessionKey, message, media[],
                           │    platform: PlatformContext,
                           │    isNew, wasAutoReset,
                           │    toolPolicy, abortSignal }
┌──────────────────────────┴──────────────────────────────────────┐
│                   Layer 3: Agent Harness                        │
│                                                                 │
│  EmbeddedHarness   LangGraphHarness   HTTPHarness   ...         │
│                                                                 │
│  Harness owns:                                                  │
│    load history for sessionKey                                  │
│    compose system prompt                                        │
│    run model + tools                                            │
│    context compression                                          │
│    persist state                                                │
│    return AgentResponse { text, media[] }                       │
└─────────────────────────────────────────────────────────────────┘
```

**Key boundary**: The gateway passes structured facts to the harness. The harness decides how to express them as prompts. The gateway never writes prose into the model's context.

---

## 4. Layer 1 — Platform Connectors

### Purpose

Each connector translates between one platform's private protocol and the gateway's `NormalizedMessage` contract. This layer is inherently heterogeneous — no two platforms share a wire format, identity model, or conversation structure.

### Connector Interface

Every connector implements exactly four functions:

```
normalize(raw: unknown) → NormalizedMessage | null
```
Parses the platform's raw event payload into a `NormalizedMessage`. Returns `null` for events that are not messages (typing notifications, read receipts, member joins, etc.) — the gateway drops these immediately without further processing.

```
isAgentAddressed(msg: NormalizedMessage) → bool
```
Returns true if the agent was explicitly addressed in this message. The rule differs by platform and chat type:
- DM: always `true`
- Group / channel: `true` only if the bot was @mentioned or the message is a direct reply to the bot
- The connector knows the bot's own user ID and the platform's mention syntax

```
deriveSessionKey(msg: NormalizedMessage) → string
```
Returns a deterministic string that identifies the session this message belongs to. The connector decides the isolation formula — the gateway core treats it as an opaque routing key.

The key must be:
- **Deterministic** — same inputs always produce the same key
- **Stable** — does not change across process restarts
- **Unique within the gateway** — no two distinct conversations produce the same key
- **Versioned** — prefixed with a schema version token so formula changes can be detected and migrated

All session keys are prefixed with a version token: `v1:`. If the formula for a connector changes (e.g., a bug fix, isolation policy change), the version must be incremented to `v2:`. The gateway will not silently reuse an old session under a different formula.

Example formulas by platform and chat type:

| Platform | Chat type | Formula | Rationale |
|---|---|---|---|
| Telegram | DM | `v1:telegram:{accountId}:{conversation.id}` | One user per DM |
| Telegram | Group | `v1:telegram:{accountId}:{conversation.id}:{sender.id}` | Isolate per user in shared chat |
| Slack | DM | `v1:slack:{accountId}:{conversation.id}` | Direct message |
| Slack | Channel | `v1:slack:{accountId}:{conversation.id}:{threadId}` | Threads are first-class |
| Discord | Server | `v1:discord:{accountId}:{conversation.id}:{threadId}` | Same as Slack |
| WhatsApp | Group | `v1:whatsapp:{accountId}:{conversation.id}:{sender.id}` | Per-user isolation |
| Email | Any | `v1:email:{accountId}:{threadId}` | Email threads are natural sessions |

#### Session Key Migration

When a connector's key formula changes (version bump from `v1:` to `v2:`):

1. **Old sessions are not automatically migrated.** They remain in the `SessionRegistry` under their `v1:` keys and will idle-timeout naturally.
2. **No history is lost** — history is owned by the harness, keyed on `sessionKey`. If the harness needs to carry history forward, it must implement its own migration by reading old keys and writing new ones before the gateway restarts.
3. **The migration procedure**:
   - Bump the version prefix in the connector's `deriveSessionKey()` implementation.
   - Optionally, run a one-time migration script before restart:  
     `gateway migrate-sessions --connector telegram --from v1 --to v2`  
     This command re-keys `SessionRecord` rows in SQLite from `v1:telegram:...` to `v2:telegram:...`.
   - Restart the gateway. New messages create `v2:` sessions; old `v1:` sessions expire via idle-timeout.
4. **Connector changelog** must document every version bump with the reason and date.

```
send(target: DeliveryTarget, text: string, media: MediaItem[]) → DeliveryResult
```
Delivers a reply to the platform. `DeliveryTarget` carries the platform address resolved during normalization (chat ID, thread ID, account ID). The gateway core calls this after the agent responds.

### Connection Lifecycle

Each connector also implements:

```
startAccount(ctx: ConnectorContext) → void   — connect, start listeners
stopAccount(ctx: ConnectorContext)  → void   — graceful disconnect
```

The gateway's `ConnectorManager` calls these at startup and shutdown. It manages per-account restart backoff (exponential, initial 5s delay, 5-minute cap) and passes a `ConnectorContext` that gives the connector access to the gateway's `normalize` pipeline entry point — so the connector can push received events into the gateway without importing gateway internals.

### Connection Mechanism Categories

Connectors fall into four categories based on how they receive messages:

#### Category A — Persistent Outbound Connection
The gateway initiates and maintains a long-lived connection. The platform pushes events in real time.

| Platform | Mechanism |
|---|---|
| Telegram | Long polling (`getUpdates`) or Webhook |
| Discord | WebSocket (Discord Gateway protocol) |
| Slack | WebSocket (Socket Mode) |
| WhatsApp | Long polling via WAHA/WPPConnect bridge |
| Matrix | SSE long poll (`/sync`) |
| QQBot | WebSocket (QQ Bot Gateway v2) |
| WeCom | WebSocket (`aibot_subscribe`) |
| Feishu/Lark | WebSocket or Webhook |
| DingTalk | WebSocket (Stream Mode) |
| Mattermost | WebSocket (REST API v4) |

**Requirement**: Must run as a persistent process. Requires reconnect logic per platform.

#### Category B — Inbound Webhook Server
The platform pushes messages to an HTTP endpoint the gateway exposes.

| Platform | Mechanism |
|---|---|
| SMS (Twilio/Vonage) | HTTP POST webhook |
| MS Teams | Bot Framework Activity webhook |
| BlueBubbles | iMessage bridge webhook |
| WeCom (webhook mode) | HTTP POST + HMAC verification |
| Generic Webhook | HTTP POST, configurable field mapping |

**Requirement**: Public HTTPS endpoint. Platform-specific signature verification.

#### Category C — Protocol Bridge
The gateway connects to a local intermediary rather than a cloud API.

| Platform | Mechanism |
|---|---|
| Signal | signal-cli over Unix socket or TCP |
| Email | IMAP polling + SMTP sending |
| Home Assistant | Local WebSocket API |

#### Category D — API Compatibility Layer
The gateway exposes a standard API; any HTTP client can connect.

| Endpoint | Notes |
|---|---|
| `POST /v1/chat/completions` | OpenAI-compatible |
| `POST /v1/responses` | OpenAI Responses protocol |
| ACP server (`/acp/*`) | Agent Client Protocol (VS Code, Zed, JetBrains) |

### NormalizedMessage

The single structure all connectors must produce. It is the contract between Layer 1 and Layer 2.

```
NormalizedMessage {

  // Identity
  id:          string        platform message ID — used for dedup and reply threading
  timestamp:   number        unix ms

  // Sender
  sender: {
    id:        string        platform user ID
    name:      string        display name
    username:  string?       handle / @username
    isBot:     bool          is this sender a bot account
    isSelf:    bool          is this the gateway's own account
  }

  // Conversation
  conversation: {
    id:        string        platform chat / channel ID
    kind:      "dm" | "group" | "channel" | "thread"
    name:      string?       human-readable chat name
    threadId:  string?       thread ID (present when kind = "thread")
    parentId:  string?       parent channel ID for threads
  }

  // Content
  content: {
    text:      string?       clean message text —
                             bot mention stripped,
                             other mentions replaced with display names
    textRaw:   string?       original unmodified text (for audit/debug)
    media:     MediaItem[]   attached files, images, audio, video
    replyToId: string?       message ID being replied to
    isEdited:  bool          was this an edit of an existing message
    mentions:  Mention[]     all mentions found in the message
  }

  // Routing hints (connector-resolved, used by Stage 2)
  routing: {
    isAgentAddressed: bool   connector resolved this via isAgentAddressed()
    accountId:        string which bot account received this message
  }

  // Passthrough
  raw: unknown               original platform payload — opaque to gateway core
}
```

**`MediaItem`**:
```
MediaItem {
  kind:       "image" | "audio" | "video" | "document" | "sticker"
  url:        string?    remote URL if platform provides one
  localPath:  string?    local path if gateway downloaded it
  mimeType:   string?
  fileName:   string?
  durationMs: number?    for audio/video
  isVoice:    bool       true if audio was recorded as a voice message
}
```

**`Mention`**:
```
Mention {
  userId:   string   platform user ID of the mentioned person
  name:     string   display name (connector resolves this)
  isSelf:   bool     true if this is the bot's own mention
}
```

**What is explicitly excluded from `NormalizedMessage`**:

| Field | Why excluded |
|---|---|
| `sessionKey` | Derived by connector's `deriveSessionKey()`, consumed by Layer 2 |
| `isCommand` / `commandName` | Decided by Layer 2 (gateway knows its own command registry) |
| `system_context` string | Assembled by agent harness — not a message field |
| `history` | Loaded by agent harness — not in the message |
| Platform capability flags | Belong on connector account config, not individual messages |

---

## 5. Layer 2 — Agent Gateway Core

The gateway core is a **pure message router**. It does not manage conversation history, compose prompts, inject skills, or make reasoning decisions. Those belong to the agent harness.

What it owns:
- Routing messages from platforms to the right session
- Enforcing serial-per-session execution
- Typing indicators and response delivery
- Built-in commands (`/stop`, `/new`, `/approve`, etc.)
- Audit logging (append-only record of what flowed through)

### 5.1 Turn Pipeline

A **turn** is one inbound message processed through to agent response and delivery. The pipeline has 6 stages.

```
NormalizedMessage (from connector)
        │
        ▼
┌───────────────────────────────────────────────────────┐
│  Stage 1: NORMALIZE                                   │
│  Owner: platform connector                            │
│  Connector parses raw payload → NormalizedMessage     │
│  null → drop immediately                              │
└───────────────────┬───────────────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────────────┐
│  Stage 2: CLASSIFY                                    │
│  Owner: gateway core (uses connector-resolved hints)  │
│                                                       │
│  Reads sender.isSelf   → drop (bot-loop)              │
│  Reads sender.id null  → drop (no identifiable user)  │
│  Reads routing.isAgentAddressed                       │
│  Parses text for gateway commands (starts with "/")   │
│                                                       │
│  Output: TurnClass {                                  │
│    kind: "message"|"command"|"reaction"|"system"      │
│    isPriorityCommand: bool                            │
│    commandName: string?                               │
│  }                                                    │
│                                                       │
│  isPriorityCommand → bypass Stage 4, dispatch inline  │
│  !isAgentAddressed + not command → outcome: observed  │
└───────────────────┬───────────────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────────────┐
│  Stage 3: IDENTIFY                                    │
│  Owner: gateway core                                  │
│                                                       │
│  sessionKey = connector.deriveSessionKey(msg)         │
│  session    = SessionRegistry.getOrCreate(sessionKey) │
│  isNew          — first message ever in this session  │
│  wasAutoReset   — session reset since last turn       │
└───────────────────┬───────────────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────────────┐
│  Stage 4: CONCURRENCY GATE                            │
│  Owner: gateway core (SessionRunRegistry)             │
│                                                       │
│  RunSlot { state, abortCtrl, pendingQueue }           │
│                                                       │
│  idle    → acquire slot, continue                     │
│  running + media burst  → enqueue, yield              │
│  running + any message  → abort signal + enqueue      │
└───────────────────┬───────────────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────────────┐
│  Stage 5: DISPATCH                                    │
│  Owner: gateway core                                  │
│                                                       │
│  5a. start keep_typing loop                           │
│  5b. build AgentRequest (structured facts, no prose)  │
│  5c. call AgentHarness.run(request)                   │
│  5d. stop typing (in finally)                         │
│  5e. send response text via send_with_retry           │
│  5f. send response media[] via connector.send         │
└───────────────────┬───────────────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────────────┐
│  Stage 6: FINALIZE                                    │
│  Owner: gateway core                                  │
│                                                       │
│  Release RunSlot                                      │
│  Append to audit log                                  │
│  Emit TurnResult                                      │
│  Drain pendingQueue → re-enter Stage 4                │
└───────────────────────────────────────────────────────┘
```

#### Stage ownership

| Stage | Owner | Platform-specific? |
|---|---|---|
| 1 — NORMALIZE | Platform connector | Yes — 100% per-platform |
| 2 — CLASSIFY | Gateway core (reads connector-resolved hints) | Partially — `isAgentAddressed` is connector-resolved; command detection is core |
| 3 — IDENTIFY | Gateway core | No — `deriveSessionKey` is called but formula lives in connector |
| 4 — CONCURRENCY GATE | Gateway core | No |
| 5 — DISPATCH | Gateway core | No |
| 6 — FINALIZE | Gateway core | No |

#### Turn outcomes

| Outcome | When | Typing? | Harness called? | Audit logged? |
|---|---|---|---|---|
| `dropped` | `normalize` null, `isSelf`, null sender | No | No | No |
| `handled` | Priority or non-priority command | No | No | Yes |
| `observed` | Not agent-addressed (group, no mention) | No | No | Yes |
| `dispatched` | Normal agent turn | Yes | Yes | Yes |
| `error` | Unhandled exception | Stopped | Possibly partial | Yes |

#### Concurrency model

`SessionRunRegistry` maps `sessionKey → RunSlot`:

```
RunSlot {
  state:        "idle" | "running"
  abortCtrl:    AbortController | null
  pendingQueue: PendingTurn[]        — capped (default 1)
}
```

Rules:
- **Priority commands** (`/stop`, `/approve`, `/deny`, `/new`, `/reset`): classified at Stage 2 as `isPriorityCommand`; bypass Stage 4 entirely; dispatch inline; return `handled`.
- **Busy + media burst**: enqueue to `pendingQueue` without signaling interrupt; processed as batch when run completes.
- **Busy + normal message**: call `abortCtrl.abort()` to signal the harness; enqueue to `pendingQueue`.
- **Queue overflow (queue at cap and new message arrives)**: the existing pending item is **replaced** by the new message. The sender of the superseded message receives a platform notification: `"⚠ Your previous message was not processed because a newer message arrived. Please resend if needed."` This keeps behavior simple and predictable for v0 — the user always sees the freshest intent processed next.
- **Race prevention**: `RunSlot.state` set to `"running"` synchronously before any async work — same event-loop tick as the idle check.
- **Pending drain**: at Stage 6, if `pendingQueue` non-empty, dequeue next and re-enter Stage 4. Loop, not recursion.

#### Approval flow

When the agent harness requests approval mid-turn (e.g. before executing a dangerous tool):

1. Harness signals gateway via `approvalCallback(prompt)`
2. Gateway pauses the typing indicator (so the user can type)
3. Gateway sends approval request message to the platform chat
4. Stage 5 suspends in-place awaiting an `ApprovalEvent`, subject to `approvalTimeoutMs`
5. User sends `/approve` or `/deny` — classified as priority command at Stage 2, dispatched inline
6. Command handler resolves the `ApprovalEvent`
7. Stage 5 resumes; harness continues or aborts the tool

If the user does not respond within `approvalTimeoutMs`, the `ApprovalEvent` is resolved as `denied`. The gateway sends `"Approval request expired — action was not taken."` to the platform chat, releases the `RunSlot`, and records the turn as `outcome: handled`.

The `RunSlot` remains `"running"` throughout an active approval wait. The session is not released between the request and the response.

**Gateway configuration** (global, overridable per connector):

```
approvalTimeoutMs: number   — default: 300000 (5 minutes)
```

### 5.2 Session Registry

The gateway maintains a `SessionRegistry` mapping `sessionKey → SessionRecord`.

```
SessionRecord {
  sessionKey:    string
  createdAt:     number
  lastTouchedAt: number
  isNew:         bool
  wasAutoReset:  bool
  runSlot:       RunSlot
}
```

**What the gateway tracks**: session existence, timing, and the active run slot.

**What the gateway does NOT track**: conversation history, message content, model state. Those belong to the harness.

#### Idle-timeout reset

Configurable per connector (or globally). When `now - lastTouchedAt > idleTimeout`:
- `SessionRecord.wasAutoReset` is set to `true`
- `isNew` is set to `true`
- `lastTouchedAt` is reset
- The harness is informed via `wasAutoReset: true` on the next `AgentRequest` — it decides what to do (clear history, notify user, etc.)

The gateway does not clear history itself — it doesn't own history.

### 5.3 Typing & Presence

AI inference takes seconds to minutes. Typing indicators must persist and refresh continuously.

- **`keep_typing(sessionKey, interval=2s)`**: Continuously calls `connector.sendTyping()` until cancelled. Most platforms expire the typing status after 3–10 seconds.
- **`pause_typing(sessionKey)`** / **`resume_typing(sessionKey)`**: Pauses without cancelling — used during approval flows so the user can type `/approve`.
- **`stop_typing(sessionKey)`**: Called in `finally` at Stage 5d — always runs regardless of success or error.

Typing is skipped for cron and process-completion turns (no human is watching).

### 5.4 Reliability

#### `send_with_retry(target, text, max_retries=2)`

1. Attempt delivery
2. Retryable error (network timeout, rate limit): retry with exponential backoff + jitter
3. Timeout error: do not retry (message may have been delivered)
4. All retries exhausted: send plain-text fallback to user so they are not left waiting
5. Platform formatting error: strip formatting, retry as plain text

#### `chunk_message(text, maxLength, lengthFn) → string[]`

Splits long responses into platform-compliant chunks:
- Never splits inside a fenced code block — closes and reopens the fence across boundaries
- Prefers splitting on newlines, then spaces, then hard-cut
- Appends `(1/3)`, `(2/3)` indicators
- Supports custom length functions (e.g. UTF-16 length for Telegram)

### 5.5 Command System

The gateway intercepts slash commands before they reach the harness. Commands are resolved by canonical name with aliases.

#### Priority commands (bypass concurrency gate)

| Command | Action |
|---|---|
| `/stop` | Abort the active run via `abortCtrl.abort()` |
| `/new`, `/reset` | Set `wasAutoReset = true`, `isNew = true` on session; harness clears its own state on next turn |
| `/approve` | Resolve pending `ApprovalEvent` with `approved` |
| `/deny` | Resolve pending `ApprovalEvent` with `denied` |

#### Session commands

| Command | Action |
|---|---|
| `/retry` | Re-send last user message |
| `/resume [name]` | Switch active session by name |
| `/title [name]` | Set or show session title |
| `/background <prompt>` | Run prompt in isolated parallel session |

#### Agent configuration commands

| Command | Action |
|---|---|
| `/model [name]` | Set model preference for this session |
| `/voice [on\|off]` | Toggle voice response mode |

#### Utility commands

| Command | Action |
|---|---|
| `/status` | Show session info and connected platforms |
| `/help` | List available commands |
| `/restart` | Drain active runs and restart gateway |

#### Extensibility

Commands are defined in a central `COMMAND_REGISTRY`. The registry propagates automatically to: help text, Telegram BotCommand menu, Slack subcommand routing, autocomplete.

### 5.6 Audit Log

The gateway maintains an append-only audit log of every turn that was dispatched. It records:

```
AuditEntry {
  timestamp:   number
  sessionKey:  string
  platform:    string
  outcome:     TurnOutcome
  messageId:   string     — platform message ID
  durationMs:  number
  error?:      string
}
```

The audit log records **what went through the gateway**, not message content. It is not conversation history and is not fed back to the harness.

### 5.7 Gateway Lifecycle

#### Startup
1. Load configuration
2. Initialize `SessionRegistry`
3. Start connectors (`startAccount` per configured account)
4. Start cron scheduler
5. Start reconnect monitor, process watcher

#### Graceful shutdown (SIGTERM)
1. Stop accepting new messages from connectors
2. Drain active runs up to configured timeout (default 60s)
3. Stop connectors (`stopAccount` per account)
4. Flush audit log

#### Reconnect
Per-connector watcher detects `isHealthy() = false` and reconnects with exponential backoff. Fatal errors (invalid token) are not retried.

---

## 6. Layer 3 — Agent Harness Interface

### Purpose

The `AgentHarness` interface is the contract between the gateway and any agent implementation. The gateway calls `run()` once per turn and delivers whatever the harness returns. Everything inside `run()` — history loading, prompt assembly, model calls, tool execution, state persistence — belongs entirely to the harness.

### Interface

```typescript
interface AgentHarness {
  run(request: AgentRequest): Promise<AgentResponse>

  // Optional lifecycle hooks
  onSessionReset?(sessionKey: string): Promise<void>
    // Called when wasAutoReset = true — harness should clear its state
}
```

### AgentRequest

The gateway passes only what it knows. It does not compose prose or load history.

```typescript
type AgentRequest = {
  // Routing
  sessionKey:   string         // stable key — harness uses this for storage lookup

  // Message
  message:      string         // clean user text (mentions stripped, bot mention removed)
  messageRaw:   string         // original unmodified text from the platform (for harness audit/debug use)
  media:        MediaItem[]    // inbound attachments (gateway downloaded if needed)

  // Session state flags
  isNew:        bool           // first message in this session
  wasAutoReset: bool           // session was reset since last turn

  // Platform context — structured facts, not prose
  platform: {
    name:       string         // "telegram" | "discord" | "slack" | ...
    chatKind:   "dm" | "group" | "channel" | "thread"
    userId:     string         // sender's platform user ID
    userName:   string         // sender's display name
    mentions:   Mention[]      // other users mentioned in the message
  }

  // Gateway-enforced constraints
  toolPolicy: {
    allowedTools:    string[]  // explicit allowlist (empty = all allowed)
    disabledTools:   string[]  // explicit blocklist
  }

  // Interruption
  abortSignal:  AbortSignal    // harness should check this in its tool loop

  // Callbacks
  progressCallback: (toolName: string, preview: string) => void
    // harness calls this during tool execution for live progress display
}
```

### AgentResponse

```typescript
type AgentResponse = {
  text:        string       // response text — clean, no platform-specific syntax
  media:       MediaItem[]  // explicit media to deliver (gateway routes by kind)
  interrupted: bool         // true if abortSignal fired and turn was cut short
}
```

**Media is declared explicitly** — the gateway does not parse `text` for image URLs or `MEDIA:` tags. The harness signals what it wants delivered via `media[]`. The gateway routes by `MediaItem.kind`.

**`messageRaw` is passed for transparency** — the harness may use it for audit, debug, or to infer addressing style (e.g., direct mention vs. reply). The gateway makes no decisions based on it.

### What the harness owns

| Concern | Harness responsibility |
|---|---|
| Conversation history | Load for `sessionKey`, save after turn |
| System prompt | Compose from `PlatformContext` facts + own config |
| Skills / personality | Inject into system prompt as harness sees fit |
| Context compression | Run when approaching context limit |
| Model selection | Use `AgentRequest` facts to choose; gateway passes `toolPolicy` constraints only |
| Tool execution | Full tool loop, respecting `abortSignal` and `toolPolicy` |
| State persistence | After turn — keyed on `sessionKey` |
| Onboarding / reset notices | Harness decides how to express `isNew`/`wasAutoReset` to the model |

### Built-in Harness Implementations

#### `EmbeddedHarness`
Wraps an in-process agent (any Python/JS framework). Maintains a per-`sessionKey` agent cache to preserve prompt caching. Runs synchronous agents in a thread pool executor.

#### `HTTPHarness`
Forwards `AgentRequest` to any HTTP endpoint. Enables Foundry Invocations, ACA/AKS hosted agents, or any microservice.

```typescript
class HTTPHarness implements AgentHarness {
  constructor(private endpointUrl: string, private getToken?: () => Promise<string>) {}

  async run(request: AgentRequest): Promise<AgentResponse> {
    const token = await this.getToken?.()
    const resp = await fetch(this.endpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(request),
      signal: request.abortSignal,
    })
    return resp.json()
  }
}
```

#### `LangGraphHarness` (example)
```typescript
class LangGraphHarness implements AgentHarness {
  constructor(private graph: CompiledGraph, private store: HistoryStore) {}

  async run(request: AgentRequest): Promise<AgentResponse> {
    const history = await this.store.load(request.sessionKey)
    const result  = await this.graph.invoke({
      messages: [...history, { role: "user", content: request.message }],
    })
    await this.store.save(request.sessionKey, result.messages)
    return { text: result.output, media: [] }
  }
}
```

### Registration

```typescript
const gateway = new GatewayRunner({
  harness: new MyHarness(),
  connectors: [telegramConnector, slackConnector],
})
await gateway.start()
```

---

## 7. Data Models

### `NormalizedMessage`
Produced by each connector's `normalize()`. Full definition in Section 4.

### `TurnClass`
Produced by Stage 2 (CLASSIFY).

| Field | Type | Description |
|---|---|---|
| `kind` | `"message" \| "command" \| "reaction" \| "system"` | Event kind |
| `isPriorityCommand` | `bool` | One of: stop, new, reset, approve, deny |
| `commandName` | `string?` | Canonical command name if `kind = "command"` |

### `SessionRecord`
Maintained by `SessionRegistry`.

| Field | Type | Description |
|---|---|---|
| `sessionKey` | `string` | Routing key (connector-derived) |
| `createdAt` | `number` | Unix ms of first message |
| `lastTouchedAt` | `number` | Unix ms of last dispatched turn |
| `isNew` | `bool` | True until first dispatched turn completes |
| `wasAutoReset` | `bool` | Set by idle-timeout; cleared after harness acknowledges |
| `runSlot` | `RunSlot` | Concurrency state |

### `RunSlot`

| Field | Type | Description |
|---|---|---|
| `state` | `"idle" \| "running"` | Current execution state |
| `abortCtrl` | `AbortController?` | Set when running; used for interrupt |
| `pendingQueue` | `PendingTurn[]` | Messages queued during active run |

### `AgentRequest` / `AgentResponse`
Full definitions in Section 6.

### `TurnResult`

| Field | Type | Description |
|---|---|---|
| `outcome` | `"dropped" \| "handled" \| "observed" \| "dispatched" \| "error"` | Final outcome |
| `sessionKey` | `string?` | Session that processed the turn |
| `durationMs` | `number` | Total pipeline duration |
| `reason` | `string?` | For dropped/error outcomes |

### `DeliveryResult`

| Field | Type | Description |
|---|---|---|
| `success` | `bool` | Whether delivery succeeded |
| `messageId` | `string?` | Platform-assigned ID of sent message |
| `error` | `string?` | Error description on failure |
| `retryable` | `bool` | Whether failure is transient |

---

## 8. Turn Sources

A **turn** is any event that causes the harness to be invoked. There are four sources, entering the pipeline at different stages.

| Source | Enters at | Has sender? | Session key source | Delivery target |
|---|---|---|---|---|
| **Platform message** | Stage 1 (NORMALIZE) | Yes | `connector.deriveSessionKey(msg)` | Same chat |
| **Command** | Stage 1, exits Stage 2 as `handled` | Yes | Same | Same chat |
| **Cron job** | Stage 3 (IDENTIFY) | No | `cron:{jobId}` | Configured address |
| **Process completion** | Stage 3 (IDENTIFY) | No (system) | Owning session's key | Same chat as owning session |

**Cron**: enters at Stage 3 with a pre-built `sessionKey` and `AgentRequest`. Skips Stages 1–2 (no sender, no classification needed). Skips Stage 4 (cron sessions are isolated — no concurrency conflict with platform sessions). Delivers result via the platform connector's `send()` to a configured `channel + to + accountId`.

**Process completion**: a background process the agent launched has finished. The gateway synthesizes an `AgentRequest` with the completion status as the `message`, borrows the owning session's `sessionKey`, and enters at Stage 3. Enters Stage 4 normally — the owning session may be busy.

---

## 9. Deployment Considerations

### Process Model

The gateway must run as a **persistent process** — not serverless. Category A platforms require persistent WebSocket/polling connections. Approval flows suspend a run while waiting for user input. Cron scheduling and reconnect loops require continuous execution.

**Recommended hosting**: AKS (StatefulSet), ACA (`minReplicas: 1`), or any container runtime that supports persistent processes with a persistent volume.

### Storage

- **SQLite** (WAL mode): session registry, audit log
- **Filesystem**: config, connector credentials, image/audio cache
- Persistent volume required for container deployments

The gateway does **not** own conversation history storage. That is the harness's responsibility.

### Multi-Instance

Isolated instances via configurable data directory:

```bash
gateway --profile work
gateway --profile personal
```

Each instance has its own config, session registry, and connector credentials. Connectors acquire scoped locks to prevent two instances from using the same bot token.

### Proxy Mode

Split-process deployment:
- **Gateway process**: platform connectivity, runs in Docker
- **Harness process**: full filesystem access, runs locally or on a separate host
- Connected via `HTTPHarness` pointing at the harness's HTTP endpoint

---

## 10. Comparison with Alternatives

### vs. Foundry Hosted Agent (Invocations Protocol)

| | Agent Gateway | Foundry Invocations |
|---|---|---|
| Platform connectors | 20+ (Telegram, Discord, Slack, WhatsApp, ...) | None — HTTP only |
| Teams / M365 | Via MS Teams connector | Native |
| Persistent connections | Yes (always-on) | No (15 min idle timeout) |
| Approval flows | Native | Not supported |
| Agent framework | Any (via `AgentHarness`) | Any (via `invoke_handler`) |
| Concurrent sessions | Unlimited (single node) | 50 (preview quota) |
| Hosting | Self-managed | Managed (Foundry) |

**Recommended split**: Gateway handles platform connectivity; `HTTPHarness` forwards to a Foundry Invocations endpoint for agent reasoning. Gateway's platform breadth + Foundry's managed hosting.

### vs. Microsoft Bot Framework (retired)

Bot Framework attempted to unify the platform layer with a common Activity schema. It failed because platform-specific rich UI (Embeds, Block Kit, Feishu Cards) could not be abstracted, and platform API churn outpaced the framework.

Agent Gateway does not attempt to abstract the platform layer — heterogeneity is irreducible and is isolated in per-platform connectors. The abstraction boundary is at the agent interface, not the platform interface.

---

## 11. Roadmap Considerations

### Near-term
- **`agent-gateway-sdk` package**: Extract `AgentHarness` interface + built-in implementations into a standalone installable package — no dependency on any specific gateway deployment
- **`HTTPHarness` + Foundry integration**: First-class Entra token refresh for Foundry Invocations endpoints
- **Connector registry**: Configuration-driven connector activation without code changes

### Medium-term
- **Connector expansion**: WeChat public account, Messenger, LINE, Viber
- **Multi-harness routing**: Route different commands or chat types to different `AgentHarness` implementations within the same gateway instance
- **Structured streaming**: Harness emits structured delta events (text chunk, tool start, tool result) rather than a final `AgentResponse` — gateway streams to platform in real time

### Long-term
- **Foundry Connector integration**: If Foundry adds native Telegram/Slack/Discord connectors, `HTTPHarness` becomes the bridge — platform → Foundry → any harness

---

## 12. Reference Implementations

Agent Gateway is derived from two production systems that independently converged on the same core architecture.

### hermes-agent (Python)

**Repository**: `hermes-agent/gateway/`

- **Connector base**: `gateway/platforms/base.py` — `BasePlatformAdapter`
- **Gateway runner**: `gateway/run.py` — `GatewayRunner`
- **Session store**: `gateway/session.py` — `SessionStore` with SQLite + FTS5
- **20+ connectors**: `gateway/platforms/` — Telegram, Discord, Slack, WhatsApp, Signal, Email, Feishu, DingTalk, WeCom, Matrix, Mattermost, QQBot, Teams, SMS, Home Assistant, BlueBubbles, and more
- **API compatibility**: `gateway/platforms/api_server.py` — OpenAI-compatible endpoint
- **ACP adapter**: `acp_adapter/server.py`

hermes-agent's `AIAgent` (`run_agent.py`) is the embedded agent that acts as an `EmbeddedHarness`. It owns history, prompt assembly, tools, and context compression.

### OpenClaw (TypeScript)

**Repository**: `openclaw/src/`

- **Connector plugin model**: `src/channels/plugins/types.plugin.ts` — `ChannelPlugin<ResolvedAccount>` — adapter slices (gateway, config, outbound, messaging, heartbeat, commands, lifecycle)
- **Turn pipeline**: `src/channels/turn/kernel.ts` — `runChannelTurn()` — stateless stage-driven kernel
- **Channel manager**: `src/gateway/server-channels.ts` — per-account `AbortController`, exponential backoff restart
- **Session model**: `src/acp/session.ts` — `AcpSessionStore`; `cancelActiveRun()` is the interrupt point
- **Agent invocation**: `src/agents/agent-command.ts` — `runAgentCommand(AgentCommandOpts)` — single entry point
- **Cron**: `src/cron/service-contract.ts` — `CronServiceContract`

### Architectural Convergence

Both systems independently arrived at:

1. A **per-platform connector** isolating heterogeneous protocol details behind a common contract
2. A **session key** as the fundamental routing primitive, derived deterministically from platform identity facts by the connector
3. A **serial-per-session concurrency model** with an abort controller per active run
4. A **single agent invocation entry point** that all dispatch paths funnel through
5. A **cron service** using isolated sessions, separate from platform sessions
6. The **agent harness owning history** — the gateway passes a session key, not history

The convergence on these six decisions validates them as load-bearing architectural choices.

---

## 13. Post-v0 Design Todos

The following design questions are deferred until the v0 codebase is built and usable. They represent known gaps that do not block initial implementation but must be resolved before the gateway is considered production-ready for general use.

### TODO-5: HTTPHarness Interrupt Semantics

**Issue**: `HTTPHarness` forwards `abortSignal` to `fetch()`, which cancels the HTTP connection. However, the remote agent process continues executing after the connection is dropped — it may waste compute and commit tool side effects that the gateway has already abandoned.

**Work needed**:
- Define an interrupt protocol for remote harnesses. Options:
  - (a) A companion `DELETE /session/{sessionKey}/run` endpoint the gateway calls on `abortSignal` fire.
  - (b) Server-sent events (SSE) streaming response — gateway closes the stream; remote respects `Connection: close` as abort signal.
- Update `HTTPHarness` implementation spec and the `AgentHarness` interface documentation.
- Decide whether interrupt support is required or optional for conforming harness implementations.

**Blocking**: Not blocking for v0 (single-process `EmbeddedHarness` handles abort correctly). Becomes critical before `HTTPHarness` is used with long-running or side-effectful agents.

---

### TODO-6: Cron vs. Process Completion Stage 4 Asymmetry

**Issue**: Both cron and process-completion turns enter the pipeline at Stage 3, but have different Stage 4 behavior — cron skips it (isolated session key); process completion enters it (shares the owning session's key). This asymmetry is implicit and easy to misimplement.

**Work needed**:
- Add an explicit `entersConcurrencyGate: bool` column to the Turn Sources table in Section 8.
- Add inline commentary in the Stage 4 pipeline diagram explaining why cron bypasses it.
- Consider whether the distinction should be encoded in a `TurnSource` enum passed through the pipeline rather than being implicit in the session key format.

**Blocking**: Not blocking. Becomes a correctness risk during implementation of the cron scheduler.

---

### TODO-7: Multi-Instance and Webhook Load Balancing

**Issue**: The multi-instance model uses per-profile SQLite isolation. This works cleanly when each instance has a unique bot token. It does not address webhook-based platforms (e.g., MS Teams via Bot Framework) where a load balancer may distribute requests across multiple gateway replicas that share the same bot identity.

**Work needed**:
- Explicitly declare the constraint: one gateway instance per bot token is required for stateful session consistency.
- Document the architectural consequence: webhook platforms behind a load balancer must use sticky sessions (route by conversation ID) or a single gateway instance.
- Add a roadmap item for a distributed `SessionRegistry` backend (e.g., Redis, Postgres) to support horizontal scaling if demand arises.

**Blocking**: Not blocking for single-instance deployments. Must be addressed before multi-replica deployment is supported.

---

### TODO-8: `AgentResponse.text` Markup Ownership

**Issue**: `AgentResponse.text` is specified as "clean, no platform-specific syntax" but the canonical markup format is undefined. If the harness returns CommonMark, the connector must translate it to the platform's syntax (Telegram MarkdownV2, Discord Markdown, Slack mrkdwn). If translation is the harness's responsibility, cross-platform harnesses must know all platform syntaxes.

**Work needed**:
- Declare a canonical markup format for `AgentResponse.text` (recommendation: CommonMark).
- Assign translation responsibility explicitly: connector translates CommonMark → platform syntax on outbound, mirroring the inbound convention (connector strips platform syntax → clean text in `NormalizedMessage`).
- Update `send()` in the connector interface spec to include a `renderMarkdown(text: string) → string` step before delivery.
- Document platform-specific limitations (e.g., Telegram MarkdownV2 does not support tables).

**Blocking**: Not blocking for plain-text responses. Becomes necessary before rich formatting is used in production harnesses.

---

### TODO-9: `progressCallback` Error Contract

**Issue**: `progressCallback` is a fire-and-forget call from the harness to the gateway for live progress display during tool execution. The error handling contract is unspecified: if the gateway fails to deliver the progress update (rate limit, network error), it is unclear whether the callback throws into the harness tool loop.

**Work needed**:
- Specify that `progressCallback` must never throw — the gateway absorbs all delivery errors silently.
- Document this contract in the `AgentRequest` type definition and in the harness implementation guide.
- Consider whether `progressCallback` should return a `Promise<void>` (awaitable) or be synchronous fire-and-forget. Awaitable is safer; synchronous is simpler.

**Blocking**: Not blocking. Becomes a correctness issue once harnesses use `progressCallback` in tool loops without defensive wrapping.

---

### TODO-10: SDK Versioning Strategy for `AgentRequest` / `AgentResponse`

**Issue**: The roadmap includes extracting `AgentHarness` + built-in implementations into an `agent-gateway-sdk` package. `AgentRequest` and `AgentResponse` are currently defined in the gateway spec without a versioning strategy. Breaking changes to these types would silently break all external harness implementations.

**Work needed**:
- Define a versioning strategy before the SDK is published. Options:
  - (a) Semantic versioning on the SDK package with a changelog for breaking changes to `AgentRequest`/`AgentResponse`.
  - (b) A `version` field in `AgentRequest` so harnesses can assert compatibility at runtime.
- Establish a deprecation policy: fields may be added (non-breaking); fields may not be removed or renamed without a major version bump.
- Create a `CHANGELOG.md` for the SDK from day one.

**Blocking**: Not blocking until the SDK is published. Must be resolved before any external harness author takes a dependency on the package.

---

## 14. Technology Stack

### 14.1 Gateway Runtime Language — TypeScript / Node.js

The gateway runtime is implemented in **TypeScript on Node.js 22 LTS**.

#### Rationale

All target harness frameworks (LangGraph, CrewAI, AutoGen/Microsoft Agent Framework, OpenAI Agents SDK) are Python-first. This means the harness will almost always run as a separate process connected to the gateway via `HTTPHarness`. The gateway language is therefore invisible to harness authors — the HTTP boundary makes it irrelevant.

Given that, the gateway language choice is driven entirely by which language best serves the gateway's own responsibilities: platform connectivity, event-loop efficiency, and type-safe contract enforcement at layer boundaries.

| Concern | TypeScript / Node.js | Python |
|---|---|---|
| Async I/O model | Native event loop; `AbortController`, `Promise`, `EventEmitter` are first-class — the spec's concurrency model maps directly | `asyncio` works but mixing sync/async libraries (common in agent frameworks) requires careful thread-pool management |
| Idle WebSocket connections (Telegram, Slack, Discord) | Node's single-threaded event loop handles thousands of idle connections efficiently | Comparable with `asyncio`; heavier per-connection overhead under `threading` |
| Type safety at boundaries | `NormalizedMessage`, `AgentRequest`, `AgentResponse` are TS interfaces with compile-time enforcement | `dataclass` / `TypedDict` / Pydantic enforce types at runtime, not compile time |
| Platform connector SDKs | `grammY` (Telegram), `@slack/bolt`, `discord.js` are TypeScript-first | Equivalent SDKs exist; quality varies |
| SDK dual-publish | TS compiles to JS → npm package is the primary artifact; Python SDK is a separately maintained thin wrapper | Python-first gateway would require a full TS SDK maintained in parallel from day one |

#### Toolchain

| Tool | Choice |
|---|---|
| Runtime | Node.js 22 LTS |
| Language | TypeScript 5.x (strict mode, `noUncheckedIndexedAccess`) |
| Module system | ESM (`"type": "module"`) |
| Package manager | pnpm |
| Dev execution | `tsx` (fast TS execution without a build step during development) |
| Production build | `tsc` (emits ESM JS, no bundler needed for a server runtime) |
| Test runner | Vitest |
| Linter / formatter | ESLint + Prettier |

---

### 14.2 Layer 1 — Platform Connector Libraries

The table below covers all planned connectors across v0 and v1. v0 builds Telegram and the OpenAI API compatibility layer only; Slack and MS Teams are v1.

| Connector | Library | Connection mechanism | Version |
|---|---|---|---|
| **Telegram** | [`grammY`](https://grammy.dev) | Long polling (`getUpdates`) or webhook; TypeScript-first; strong plugin ecosystem | v0 |
| **OpenAI API compat** | [`hono`](https://hono.dev) | HTTP server exposing `POST /v1/chat/completions` and `POST /v1/responses` | v0 |
| **Slack** | [`@slack/bolt`](https://slack.dev/bolt-js/) | Socket Mode (WebSocket); official Slack SDK | v1 |
| **MS Teams** | [`@microsoft/botbuilder`](https://www.npmjs.com/package/botbuilder) | Bot Framework Activity webhook; the only supported path for Teams message delivery | v1 |

> **Teams / `@microsoft/botbuilder` note**: The spec's comparison table (Section 10) notes that the Bot Framework *Service* (cloud relay) is retired in 2026. The SDK itself is not retired and remains the only supported way to receive and send Teams messages via webhook. This is a known dependency risk; it is tracked as a maintenance concern, not a blocker.

> **`@microsoft/botbuilder` is CommonJS**. It requires CJS interop in the ESM project. This is contained by isolating all Teams code inside `packages/gateway/src/connectors/teams/` behind the standard connector interface. No CJS leaks across the boundary.

---

### 14.3 Layer 2 — Gateway Core Libraries

| Concern | Library | Notes |
|---|---|---|
| HTTP server (webhooks + ACP + OpenAI API compat) | **`hono`** | Single HTTP server for all inbound webhook connectors and API compatibility endpoints; lightweight, typed, Edge-compatible |
| SQLite (session registry, audit log) | **`better-sqlite3`** | Synchronous API; WAL mode as specified; sub-millisecond for registry reads/writes; must not be used for large queries in the turn hot path |
| Schema validation | **`zod`** | Parse-and-validate at all layer boundaries (`NormalizedMessage`, `AgentRequest`, `AgentResponse`, config); types derived via `z.infer<>` |
| Logging | **`pino`** | Structured JSON logging; low overhead; suited for containerized deployments |
| Configuration | **`zod` + `dotenv`** | Type-safe config parsing from env vars and config files |
| Cron scheduling | **`croner`** | Lightweight, TypeScript-native, no native binary dependencies |
| Process lifecycle | Node built-ins (`process.on('SIGTERM')`) | No library needed |

---

### 14.4 Layer 3 — Built-in Harness Implementations

| Harness | Implementation |
|---|---|
| **`HTTPHarness`** | Pure Node.js built-in `fetch` + `AbortController`. No third-party HTTP client library. |
| **`EmbeddedHarness`** | Wraps any in-process TypeScript/JavaScript agent. Python harnesses are not embedded — they run as separate processes connected via `HTTPHarness`. |

---

### 14.5 SDK Packages

The `agent-gateway-sdk` is published in two languages. Both expose the same logical surface: the `AgentHarness` contract, `AgentRequest`/`AgentResponse` types, and the `HTTPHarness` built-in implementation.

| Package | Language | Registry | Contents |
|---|---|---|---|
| `@agent-gateway/sdk` | TypeScript | npm | `AgentHarness` interface, `AgentRequest`/`AgentResponse` types, `HTTPHarness`, `EmbeddedHarness` — compiled directly from the gateway's own type definitions |
| `agent-gateway-sdk` | Python | PyPI | `AgentHarness` abstract base class, `AgentRequest`/`AgentResponse` as Pydantic `BaseModel`, `HttpHarness` using `httpx` |

The Python SDK is the primary integration surface for harness authors. It is intentionally minimal: types and `HttpHarness` only. It does not re-implement the gateway.

**Sync strategy (v0)**: The Python SDK types are manually kept in sync with the TypeScript definitions. A code-generation step (e.g., `quicktype` from a shared JSON Schema) is deferred post-v0 and tracked in TODO-10.

---

### 14.6 Monorepo Structure

The repository is a **pnpm workspace monorepo**.

```
agent-gateway/
├── packages/
│   ├── gateway/                   # Core runtime (TypeScript)
│   │   ├── src/
│   │   │   ├── connectors/
│   │   │   │   ├── telegram/
│   │   │   │   ├── slack/
│   │   │   │   ├── teams/
│   │   │   │   └── openai-api/
│   │   │   ├── core/
│   │   │   │   ├── pipeline/
│   │   │   │   ├── session/
│   │   │   │   ├── commands/
│   │   │   │   └── reliability/
│   │   │   └── harness/
│   │   │       ├── http.ts
│   │   │       └── embedded.ts
│   │   └── package.json
│   ├── sdk-ts/                    # npm: @agent-gateway/sdk
│   │   └── src/
│   │       ├── types.ts           # AgentRequest, AgentResponse, AgentHarness
│   │       └── harness/
│   │           ├── http.ts
│   │           └── embedded.ts
│   ├── sdk-py/                    # PyPI: agent-gateway-sdk
│   │   └── agent_gateway/
│   │       ├── types.py           # Pydantic models — kept in sync with sdk-ts/src/types.ts
│   │       └── harness.py         # HttpHarness using httpx
│   └── agent-reference/           # Reference LangGraph agent (Python) — v0 harness example
│       └── agent_reference/
│           ├── agent.py
│           ├── tools.py
│           ├── history.py
│           └── server.py
├── docs/
│   ├── agent-gateway-design.md
│   └── v0-planning.md
├── pnpm-workspace.yaml
└── package.json
```

The Python SDK (`sdk-py`) lives in the same monorepo so that type changes in `sdk-ts/src/types.ts` are immediately visible when updating the Python counterpart, reducing drift risk.

---

### 14.7 Known Constraints

| Constraint | Impact | Mitigation |
|---|---|---|
| `better-sqlite3` is synchronous | Blocks the event loop if queries are slow | Acceptable for sub-millisecond registry reads/writes; must not be used for large scans in the turn hot path |
| `@microsoft/botbuilder` is CommonJS | Requires CJS interop in an ESM project | Contained entirely inside `packages/gateway/src/connectors/teams/`; no CJS leaks beyond the connector boundary |
| Python SDK types are manually synced | Types can drift between `sdk-ts` and `sdk-py` | Mitigated by co-location in the same monorepo; automated code-gen deferred to post-v0 (TODO-10) |
| Teams Bot Framework Service retirement (2026) | `@microsoft/botbuilder` may lose cloud relay support | Teams connector uses the SDK for webhook handling only, not the cloud relay — impact is low; monitor Microsoft announcements |

---

## 15. Folder & Package Structure

### 15.1 Monorepo Layout

The repository is a **pnpm workspace monorepo** with three packages: the gateway runtime, the TypeScript SDK, and the Python SDK. Section 14.6 shows the top-level sketch; this section specifies every directory's purpose and the rules governing what may and may not cross each boundary.

```
agent-gateway/
├── packages/
│   ├── gateway/                        # Runnable gateway process
│   ├── sdk-ts/                         # npm: @agent-gateway/sdk
│   ├── sdk-py/                         # PyPI: agent-gateway-sdk
│   └── agent-reference/                # Reference LangGraph agent (Python) — v0 harness example
├── docs/
│   ├── agent-gateway-design.md
│   └── v0-planning.md
├── pnpm-workspace.yaml
├── package.json                        # Root: shared dev tooling only (eslint, prettier, vitest)
└── tsconfig.base.json                  # Shared TS compiler options inherited by all packages
```

---

### 15.2 `packages/gateway` — Gateway Runtime

```
packages/gateway/
├── src/
│   ├── index.ts                        # Entry point: load config, wire connectors + harness, call gateway.start()
│   │
│   ├── connectors/                     # Layer 1 — one directory per platform
│   │   ├── types.ts                    # ConnectorInterface, NormalizedMessage, MediaItem, Mention, DeliveryTarget, DeliveryResult
│   │   ├── telegram/
│   │   │   ├── index.ts                # Exports TelegramConnector implementing ConnectorInterface
│   │   │   ├── normalize.ts            # Raw grammY update → NormalizedMessage
│   │   │   ├── session-key.ts          # deriveSessionKey logic for all Telegram chat types
│   │   │   ├── send.ts                 # connector.send() implementation
│   │   │   └── telegram.test.ts        # Unit tests with mocked grammY payloads
│   │   ├── slack/
│   │   │   ├── index.ts
│   │   │   ├── normalize.ts
│   │   │   ├── session-key.ts
│   │   │   ├── send.ts
│   │   │   └── slack.test.ts
│   │   ├── teams/
│   │   │   ├── index.ts                # CJS interop boundary — botbuilder import contained here
│   │   │   ├── normalize.ts
│   │   │   ├── session-key.ts
│   │   │   ├── send.ts
│   │   │   └── teams.test.ts
│   │   └── openai-api/
│   │       ├── index.ts                # Hono HTTP server exposing /v1/chat/completions and /v1/responses
│   │       ├── normalize.ts            # HTTP request body → NormalizedMessage
│   │       ├── session-key.ts
│   │       ├── send.ts                 # HTTP response (streaming or batch)
│   │       └── openai-api.test.ts
│   │
│   ├── core/                           # Layer 2 — platform-agnostic gateway logic
│   │   ├── pipeline/
│   │   │   ├── index.ts                # runTurn(msg, connector, harness) — the 6-stage pipeline
│   │   │   ├── classify.ts             # Stage 2: NormalizedMessage → TurnClass
│   │   │   ├── identify.ts             # Stage 3: sessionKey + SessionRecord resolution
│   │   │   ├── concurrency.ts          # Stage 4: RunSlot acquire / queue / abort
│   │   │   ├── dispatch.ts             # Stage 5: AgentRequest build + harness.run() + send
│   │   │   ├── finalize.ts             # Stage 6: slot release, audit log, pending drain
│   │   │   └── pipeline.test.ts        # Unit tests using MockConnector + MockHarness
│   │   ├── session/
│   │   │   ├── registry.ts             # SessionRegistry (better-sqlite3, WAL)
│   │   │   ├── run-slot.ts             # RunSlot, SessionRunRegistry
│   │   │   ├── idle-timeout.ts         # Idle-timeout reset logic
│   │   │   └── session.test.ts
│   │   ├── commands/
│   │   │   ├── registry.ts             # COMMAND_REGISTRY — canonical names, aliases, priority flag
│   │   │   ├── handlers.ts             # /stop, /new, /approve, /deny, /retry, /status, /help, ...
│   │   │   └── commands.test.ts
│   │   ├── typing.ts                   # keep_typing / pause_typing / resume_typing / stop_typing
│   │   ├── reliability.ts              # send_with_retry, chunk_message
│   │   ├── audit.ts                    # AuditLog (append-only, better-sqlite3)
│   │   └── gateway.ts                  # GatewayRunner: start(), stop(), ConnectorManager, reconnect loop
│   │
│   ├── harness/                        # Layer 3 — built-in AgentHarness implementations
│   │   ├── types.ts                    # AgentHarness interface, AgentRequest, AgentResponse (source of truth)
│   │   ├── http.ts                     # HTTPHarness
│   │   ├── embedded.ts                 # EmbeddedHarness
│   │   └── harness.test.ts
│   │
│   ├── config/
│   │   ├── schema.ts                   # Zod schema for gateway.config.yaml (see Section 16)
│   │   ├── loader.ts                   # Load + validate config from file path or env vars
│   │   └── config.test.ts
│   │
│   └── lib/
│       ├── logger.ts                   # Pino instance with standard fields; exported for all modules
│       └── errors.ts                   # GatewayError hierarchy (see Section 17)
│
├── tests/
│   └── integration/
│       ├── pipeline-integration.test.ts   # Full pipeline with real SQLite (tmp file), MockConnector, MockHarness
│       └── approval-flow.test.ts          # Approval suspend/resume/timeout
│
├── package.json
└── tsconfig.json                       # Extends ../../tsconfig.base.json
```

#### Boundary rules

| Rule | Rationale |
|---|---|
| `connectors/*` must not import from `core/*` or `harness/*` | Connectors are platform adapters; they must not depend on gateway internals |
| `core/*` must not import from `connectors/*` | The core pipeline is platform-agnostic; platform types must not leak in |
| `core/*` must not import from `harness/*` except via the `AgentHarness` interface | The core calls `harness.run()` against the interface only |
| `harness/types.ts` is the **source of truth** for `AgentRequest`/`AgentResponse` | `sdk-ts` re-exports from this file; `sdk-py` is synced against it |
| `connectors/types.ts` is the **source of truth** for `NormalizedMessage` | No platform-specific fields may appear here |
| CJS imports (`@microsoft/botbuilder`) are confined to `connectors/teams/index.ts` | Prevents CJS from propagating into ESM modules |

---

### 15.3 `packages/sdk-ts` — TypeScript SDK

```
packages/sdk-ts/
├── src/
│   ├── index.ts                        # Public API re-exports
│   ├── types.ts                        # Re-exports AgentHarness, AgentRequest, AgentResponse from gateway/harness/types.ts
│   └── harness/
│       ├── http.ts                     # HTTPHarness (copy, not symlink — sdk is standalone)
│       └── embedded.ts                 # EmbeddedHarness
├── package.json                        # name: "@agent-gateway/sdk"
└── tsconfig.json
```

The SDK does **not** import from `packages/gateway` at runtime. Types are duplicated (not symlinked) so the SDK can be published and consumed independently. A CI check enforces that `sdk-ts/src/types.ts` is byte-identical to `gateway/src/harness/types.ts`.

---

### 15.4 `packages/sdk-py` — Python SDK

```
packages/sdk-py/
├── agent_gateway/
│   ├── __init__.py                     # Public API exports
│   ├── types.py                        # AgentRequest, AgentResponse as Pydantic BaseModel; AgentHarness as ABC
│   └── harness.py                      # HttpHarness using httpx (async)
├── tests/
│   └── test_types.py                   # Validate Pydantic models round-trip with sample AgentRequest JSON
├── pyproject.toml                      # name: "agent-gateway-sdk"; dependencies: pydantic>=2, httpx
└── README.md
```

Field naming convention: **`snake_case`** in Python, **`camelCase`** in TypeScript/JSON wire format. Pydantic's `model_config = ConfigDict(populate_by_name=True)` with explicit `alias` declarations handles the mapping transparently.

---

### 15.5 File Naming Conventions

| Convention | Rule |
|---|---|
| One export per file (preferred) | Each file exports one primary class, function, or schema |
| Test files co-located | `foo.ts` is tested by `foo.test.ts` in the same directory |
| Integration tests in `tests/integration/` | Tests that require real I/O (SQLite, network) are separated from unit tests |
| `index.ts` for public surface only | Each directory's `index.ts` re-exports only what is part of the public API of that module; internal files are imported directly |
| No barrel files in `core/` internals | Prevents accidental circular imports across pipeline stages |

---

## 16. Configuration Schema

### 16.1 Format and Loading

Configuration is a **single YAML file** (`gateway.config.yaml`) located in the gateway's data directory (defaults to `./data/`, overridable via `--data-dir` CLI flag or `GATEWAY_DATA_DIR` env var).

Secrets (tokens, signing secrets) are **never stored in the config file**. They are read exclusively from environment variables referenced by name in the config. This keeps the config file safe to commit to version control for non-secret fields.

```
gateway/
└── data/
    ├── gateway.config.yaml     # Structure and connector declarations — safe to commit
    ├── .env                    # Secret values — never committed; loaded at startup
    └── gateway.db              # SQLite database (session registry, audit log)
```

Config is loaded and validated at startup using the Zod schema in `config/schema.ts`. Any validation error is a hard crash with a clear message — the gateway does not start with an invalid config.

---

### 16.2 Full Configuration Schema

```yaml
# gateway.config.yaml

# ─── Gateway-wide settings ───────────────────────────────────────────────────

gateway:
  # Data directory for SQLite database and cache files.
  # Can be overridden with --data-dir CLI flag or GATEWAY_DATA_DIR env var.
  dataDir: ./data

  # Maximum time (ms) to wait for active runs to drain on SIGTERM before force-exit.
  # Default: 60000 (60 seconds)
  shutdownTimeoutMs: 60000

  # How long (ms) a session can be idle before wasAutoReset = true on next message.
  # Can be overridden per connector. Default: 3600000 (1 hour)
  idleTimeoutMs: 3600000

  # Pending queue cap per session RunSlot (see Section 5.1).
  # When the queue is full, the oldest pending item is replaced and the sender notified.
  # Default: 1
  pendingQueueCap: 1

  # How long (ms) to wait for /approve or /deny before resolving ApprovalEvent as denied.
  # Default: 300000 (5 minutes)
  approvalTimeoutMs: 300000

  # Maximum time (ms) to wait for harness.run() to return before throwing HarnessTimeoutError.
  # Default: 300000 (5 minutes)
  harnessTimeoutMs: 300000

  # Log level: "fatal" | "error" | "warn" | "info" | "debug" | "trace"
  # Default: "info"
  logLevel: info

# ─── Connector declarations ──────────────────────────────────────────────────
# Each entry activates one connector instance.
# "type" maps to a connector implementation in packages/gateway/src/connectors/.
# Secret values use ${ENV_VAR_NAME} interpolation — resolved from environment at load time.

connectors:
  - type: telegram
    accountId: my-telegram-bot          # Stable identifier used in session keys (v1:telegram:{accountId}:...)
    token: ${TELEGRAM_BOT_TOKEN}        # Secret: bot token from @BotFather
    # Optional overrides:
    # idleTimeoutMs: 7200000            # Override global idle timeout for this connector
    # mode: webhook                     # "poll" (default) | "webhook"
    # webhookUrl: https://example.com/telegram/webhook   # Required if mode: webhook

  - type: slack
    accountId: my-slack-workspace
    botToken: ${SLACK_BOT_TOKEN}        # Secret: xoxb- token
    appToken: ${SLACK_APP_TOKEN}        # Secret: xapp- token (required for Socket Mode)
    signingSecret: ${SLACK_SIGNING_SECRET}

  - type: teams
    accountId: my-teams-bot
    appId: ${TEAMS_APP_ID}
    appPassword: ${TEAMS_APP_PASSWORD}  # Secret
    # Teams connector exposes an inbound webhook. The public URL must be registered
    # in the Azure Bot resource as the messaging endpoint.
    webhookPath: /connectors/teams      # Path on the gateway's HTTP server

  - type: openai-api
    accountId: openai-compat
    # Exposes POST /v1/chat/completions and POST /v1/responses.
    # Optional bearer token authentication:
    # bearerToken: ${OPENAI_API_COMPAT_TOKEN}
    listenPath: /v1                     # Mount path prefix on the gateway's HTTP server

# ─── HTTP server ─────────────────────────────────────────────────────────────
# Used by webhook connectors (Teams, OpenAI API compat, future Category B connectors).

http:
  port: 3000
  # Optional: TLS termination (recommended to use a reverse proxy instead)
  # tlsCert: /etc/certs/tls.crt
  # tlsKey: /etc/certs/tls.key

# ─── Harness ─────────────────────────────────────────────────────────────────
# Exactly one harness is active per gateway instance.

harness:
  type: http                            # "http" | "embedded"
  url: http://localhost:8080/run        # Required for type: http
  # Optional bearer token for harness endpoint authentication:
  # bearerTokenEnv: HARNESS_BEARER_TOKEN   # Name of the env var holding the token

  # type: embedded
  # module: ./my-agent/index.ts        # Path to a TS/JS module exporting a default AgentHarness
```

---

### 16.3 Environment Variables

All secrets use `${ENV_VAR_NAME}` interpolation in the config file. At startup, the loader substitutes values from `process.env`. A missing referenced env var is a hard startup error.

Additionally, a small set of env vars can override config file fields entirely (useful for container deployments where config is injected via env):

| Env var | Overrides | Notes |
|---|---|---|
| `GATEWAY_DATA_DIR` | `gateway.dataDir` | Path to data directory |
| `GATEWAY_LOG_LEVEL` | `gateway.logLevel` | Runtime log level override |
| `GATEWAY_CONFIG_PATH` | — | Path to config file (default: `{dataDir}/gateway.config.yaml`) |
| `PORT` | `http.port` | Conventional override for container platforms (ACA, AKS) |

---

### 16.4 Config Validation Rules

Enforced by the Zod schema in `config/schema.ts` at startup. Violations are hard crashes.

| Rule | Error |
|---|---|
| Each `connectors[].accountId` must be unique across all connectors | Duplicate `accountId` would corrupt session keys |
| `connectors[].type` must match a registered connector implementation | Unknown connector type — check spelling or confirm connector is built |
| `harness.type = "http"` requires `harness.url` | Missing harness URL |
| `harness.type = "embedded"` requires `harness.module` | Missing module path |
| `http.port` must be 1–65535 | Invalid port |
| Any `${ENV_VAR_NAME}` reference with no matching env var | Secret not found in environment |
| `gateway.pendingQueueCap` must be ≥ 1 | Invalid queue cap |
| `gateway.harnessTimeoutMs` must be ≥ 1000 | Timeout too low to be meaningful |

---

## 17. Error Handling Strategy

### 17.1 Principles

1. **Fail fast at startup, never at runtime for config errors.** Invalid configuration is a hard crash before any connector starts. A misconfigured gateway that starts and silently drops messages is worse than one that refuses to start.
2. **Isolate connector failures from the turn pipeline.** A connector that crashes or disconnects must not affect other connectors or ongoing sessions on other connectors.
3. **Users must never be silently abandoned mid-turn.** If Stage 5 (DISPATCH) throws, the user receives an error acknowledgement. Silent failures are not acceptable.
4. **The harness is untrusted.** The gateway treats the harness as an external process. Exceptions thrown from `harness.run()`, malformed `AgentResponse`, and timeouts are all handled defensively.
5. **Errors are structured and logged at the boundary where they are caught.** An error is logged once, at the boundary where it is first caught. It is not re-logged as it propagates.

---

### 17.2 Error Hierarchy

All gateway-internal errors extend a base `GatewayError` class defined in `lib/errors.ts`.

```typescript
// lib/errors.ts

export class GatewayError extends Error {
  constructor(message: string, public readonly context?: Record<string, unknown>) {
    super(message)
    this.name = this.constructor.name
  }
}

// ── Startup errors (always fatal) ──────────────────────────────────────────

export class ConfigValidationError extends GatewayError {}   // Invalid gateway.config.yaml
export class ConnectorStartupError extends GatewayError {}   // startAccount() failed fatally (e.g. invalid token)

// ── Connector runtime errors (isolated, not fatal to gateway) ──────────────

export class ConnectorReceiveError extends GatewayError {}   // Error in normalize() or event dispatch
export class ConnectorSendError extends GatewayError {}      // Error in connector.send() after retries exhausted

// ── Pipeline errors ────────────────────────────────────────────────────────

export class HarnessError extends GatewayError {}            // harness.run() threw or returned malformed response
export class HarnessTimeoutError extends HarnessError {}     // harness.run() did not return within deadline
export class ApprovalTimeoutError extends GatewayError {}    // Approval not received within approvalTimeoutMs

// ── Session errors ─────────────────────────────────────────────────────────

export class SessionRegistryError extends GatewayError {}    // SQLite read/write failure
```

---

### 17.3 Error Handling by Location

#### Startup (`gateway.ts` — `GatewayRunner.start()`)

| Condition | Behavior |
|---|---|
| `ConfigValidationError` | Log error with full Zod issue list, exit with code 1 |
| `ConnectorStartupError` (invalid token, auth failure) | Log error with `accountId` and reason, exit with code 1 |
| `ConnectorStartupError` (network — e.g. Telegram unreachable) | Log warning, enter reconnect loop with exponential backoff — do not exit |
| Any other unexpected throw during startup | Log error + stack trace, exit with code 1 |

The distinction between auth failures (fatal) and network failures (retryable) is connector-specific. Each connector's `startAccount()` must throw `ConnectorStartupError` with a `retryable: boolean` field set appropriately.

---

#### Connector receive path (`connectors/*/index.ts`)

| Condition | Behavior |
|---|---|
| `normalize()` returns `null` | Drop silently — this is normal (non-message events) |
| `normalize()` throws | Log warning with raw payload (truncated), drop the event — do not crash the connector |
| `isAgentAddressed()` throws | Log warning, treat as `false` — do not crash the connector |
| `deriveSessionKey()` throws | Log error with message ID, drop the event — session key is required |
| WebSocket / polling disconnects | Connector reports unhealthy → `ConnectorManager` triggers reconnect with backoff |

---

#### Turn pipeline — Stage 5 DISPATCH (`core/dispatch.ts`)

This is the most critical error boundary. A user has sent a message and is waiting.

| Condition | User sees | Logged as | Turn outcome |
|---|---|---|---|
| `harness.run()` throws `HarnessError` | `"Something went wrong processing your message. Please try again."` | `error` with stack trace and `sessionKey` | `error` |
| `harness.run()` throws `HarnessTimeoutError` | `"The agent took too long to respond. Please try again."` | `error` with `durationMs` | `error` |
| `harness.run()` returns malformed `AgentResponse` (fails Zod parse) | `"The agent returned an invalid response."` | `error` with raw response (truncated) | `error` |
| `abortSignal` fires and harness returns `interrupted: true` | No message sent (user interrupted the turn themselves) | `dispatched` with `interrupted: true` | `dispatched` |
| `connector.send()` fails after all retries (`ConnectorSendError`) | Plain-text fallback attempted; if that also fails, logged only — user may not see any response | `error` | `error` |
| `ApprovalTimeoutError` | `"Approval request expired — action was not taken."` | `handled` | `handled` |

Error messages sent to the user are plain text only — no formatting that could itself fail to render.

The `finally` block in Stage 5 **always** calls `stop_typing()` and releases the `RunSlot`, regardless of outcome. A stuck typing indicator or orphaned `RunSlot` is never acceptable.

---

#### Connector send path — `send_with_retry` (`core/reliability.ts`)

| Condition | Behavior |
|---|---|
| Network timeout | Do not retry (message may have been delivered — idempotency concern). Log warning. |
| Rate limit (HTTP 429) | Retry with exponential backoff + jitter, up to `max_retries` |
| Platform formatting error (e.g. invalid MarkdownV2) | Strip all formatting, retry as plain text once |
| All retries exhausted | Throw `ConnectorSendError`; Stage 5 handles as described above |

---

#### Session registry (`core/session/registry.ts`)

| Condition | Behavior |
|---|---|
| SQLite read failure on `getOrCreate` | Throw `SessionRegistryError`; turn is dropped (cannot identify session safely) |
| SQLite write failure on `touch` / `update` | Log error, continue — session state may be stale but the turn proceeds |
| SQLite write failure on audit log | Log error, continue — audit log loss is acceptable; turn outcome is not affected |

The principle: **session reads are hard failures** (routing depends on them); **session writes and audit writes are soft failures** (logged but non-blocking).

---

### 17.4 Logging Contract

Every error log entry must carry a standard set of structured fields. The Pino logger in `lib/logger.ts` enforces this via a typed `log.error(context, message)` wrapper.

| Field | Type | Present when |
|---|---|---|
| `level` | string | Always |
| `time` | ISO timestamp | Always |
| `sessionKey` | string | Whenever a session has been identified (Stage 3+) |
| `platform` | string | Whenever a connector is known |
| `accountId` | string | Whenever a connector is known |
| `messageId` | string | Whenever a platform message ID is available |
| `durationMs` | number | For `error` turn outcomes |
| `err.message` | string | On all error logs |
| `err.stack` | string | On all error logs (omitted in production if `logLevel` is above `debug`) |

Log levels:
- `fatal` — startup failures that exit the process
- `error` — turn pipeline errors, connector send failures after all retries
- `warn` — dropped events, retryable connector errors, non-critical write failures
- `info` — connector start/stop, turn outcomes (`dispatched`, `handled`), graceful shutdown progress
- `debug` — per-stage pipeline tracing, retry attempts
- `trace` — raw platform payloads (never enabled in production)
