# Agent Gateway — v1 Planning

## Table of Contents

1. [Goal](#1-goal)
2. [Theme A — LangGraph.js Adapter](#2-theme-a--langgraphjs-adapter)
3. [Theme B — Streaming Responses](#3-theme-b--streaming-responses)
4. [Theme C — Remote Configuration Dashboard](#4-theme-c--remote-configuration-dashboard)
5. [What Is Out of Scope](#5-what-is-explicitly-out-of-scope)
6. [Feature Priority List](#6-feature-priority-list)
7. [Acceptance Criteria](#7-acceptance-criteria)

---

## 1. Goal

v1 extends the gateway in three directions that together make it substantially more useful for real agent deployments:

1. **A first-class in-process TypeScript adapter for LangGraph.js** — so a TypeScript agent author can write a `StateGraph`, pass it to the gateway, and have it work without a separate HTTP server, a `pyproject.toml`, or a deployment topology to manage.

2. **Streaming response delivery** — so long-running LLM generations are visible to users as they arrive, not as a single message that appears only after the full response is complete.

3. **A remote configuration dashboard** — so an operator can inspect and change the gateway's connectors, adapter, and policies from a browser, and have those changes applied to the running instance without a redeploy or an SSH session to hand-edit YAML.

Themes A and B are designed to compose: the LangGraph.js adapter will be the canonical streaming producer; the streaming delivery layer will be the canonical consumer. Together they eliminate the two most significant UX friction points identified during v0 validation. Theme C is the operational counterpart: once the gateway is deployed as a single Docker image (see `docs/` deployment notes), its entire configuration surface — which is otherwise a static YAML file baked into a volume — becomes editable at runtime through an authenticated control plane.

v1 keeps the same correctness bar as v0: no shortcuts on concurrency, session isolation, or error handling. Theme C additionally holds a **safety bar**: a configuration change must never corrupt a running gateway — every apply is validated, atomic, and rollback-protected.

---

## 2. Theme A — LangGraph.js Adapter

### What it is

A new `LangGraphAdapter` class (implementing `AgentAdapter`) that wraps a compiled LangGraph.js `StateGraph` and runs it **in-process** inside the same Node.js gateway instance. No HTTP hop, no separate Python process, no port to configure.

```
┌──────────────────────────────────────────┐
│  Gateway Core (TypeScript / Node.js)     │
│                                          │
│  Turn pipeline                           │
│      └── LangGraphAdapter               │
│              └── StateGraph (compiled)  │
│                     tools[], llm         │
└──────────────────────────────────────────┘
```

### Why LangGraph.js over LangChain.js

LangGraph.js models the agent as a directed graph of nodes with explicit edges and checkpoints. This maps cleanly onto the gateway's concurrency model (one `RunSlot` per session = one active graph invocation per session). It also produces a natural streaming surface: `graph.streamEvents()` emits `on_llm_stream` and `on_tool_end` events that the gateway can forward as token chunks.

LangChain.js chains are supported as a subset — any `Runnable` can be a LangGraph node — so LangChain.js users are not excluded.

### Location: `packages/gateway/src/adapter/`

Each adapter lives in its own subfolder. `LangGraphAdapter` follows the same layout convention as `HttpAdapter` and `EmbeddedAdapter`:

```
packages/gateway/src/adapter/
├── index.ts                   # re-exports all adapters; factory used by GatewayRunner
├── types.ts                   # AgentAdapter interface, AgentRequest, AgentResponse, StreamChunk
├── embedded/
│   └── index.ts               # (v0) EmbeddedAdapter — in-process fn, used in tests
├── http/
│   └── index.ts               # (v0) HttpAdapter — agent-request + openai-responses protocols
└── langgraph/
    ├── index.ts               # (v1) NEW — LangGraphAdapter entry point
    ├── state.ts               # GatewayState: MessagesAnnotation + session metadata
    ├── history.ts             # SQLite message history (better-sqlite3)
    ├── streaming.ts           # streamEvents() → AsyncIterable<StreamChunk> bridge
    ├── adapter.test.ts        # unit: invoke, isNew, wasAutoReset, abort, tool call
    └── streaming.test.ts      # unit: chunk ordering, abort mid-stream
```

`@langchain/langgraph` is added as an **optional peer dependency** of the gateway package so it is not installed unless used. The adapter is imported lazily; if `@langchain/langgraph` is absent at runtime and the user configures `adapter.type: embedded-langgraph`, the gateway exits with a clear error at startup.

Future adapters (e.g. a CrewAI adapter, a Semantic Kernel adapter) follow the same convention: a new subfolder under `src/adapter/` implementing `AgentAdapter`, registered in `src/adapter/index.ts`.

### `LangGraphAdapter` API

```typescript
import { LangGraphAdapter } from '@agent-gateway/gateway/adapter/langgraph'
import { CompiledStateGraph } from '@langchain/langgraph'

const adapter = new LangGraphAdapter(compiledGraph, {
  // Optional: override the SQLite db path for conversation history.
  dbPath: './data/agent.db',
  // Optional: called before each turn so the graph can receive gateway metadata.
  buildConfig?: (request: AgentRequest) => Record<string, unknown>,
})
```

The gateway config (`gateway.config.yaml`) gains a new adapter type:

```yaml
adapter:
  type: embedded-langgraph
  # no url — runs in-process
  dbPath: ./data/agent.db
```

The entry point (`src/index.ts`) accepts an optional `agent` field:

```typescript
startGateway({
  config,
  agent: compiledGraph,   // injected when adapter.type = 'embedded-langgraph'
})
```

### `GatewayState` annotation

The adapter wraps the graph's state with gateway-provided metadata. The graph receives:

```typescript
interface GatewayState {
  messages: BaseMessage[]   // MessagesAnnotation — loaded from history
  sessionKey: string
  isNew: boolean
  wasAutoReset: boolean
  platform: AgentRequest['platform']
  toolPolicy: AgentRequest['toolPolicy']
}
```

The graph author does not need to manage history loading or `isNew`/`wasAutoReset` — `LangGraphAdapter` handles both before invoking the graph.

### Abort handling

`LangGraphAdapter` uses LangChain's `RunnableConfig.signal` field (passed to `graph.streamEvents({ signal: request.abortSignal })`). LangGraph.js respects `AbortSignal` on all built-in nodes. Custom tool nodes should check `config.signal?.aborted` between steps — the SDK exports a `checkAbort(config)` helper for this.

### History

Conversation history is persisted to SQLite using a `MessageHistory` class backed by `better-sqlite3` (same dependency already in the gateway). Each row stores `session_key`, `role`, `content`, and `timestamp`. On `isNew` or `wasAutoReset`, the adapter clears the session's history before invoking the graph — consistent with the Python reference agent.

---

## 3. Theme B — Streaming Responses

### Design principle

Streaming is a **built-in capability of modern agent frameworks** — LangGraph.js, LangChain.js, and the OpenAI SDK all produce token chunks natively via async generators. The gateway should consume this stream as a first-class path, not treat it as an add-on.

Whether that stream reaches the end user in real time depends entirely on the **connector (platform)**, not the adapter. Some platforms support progressive delivery (Slack message edits, SSE over HTTP); others do not (WeChat iLink API). The adapter always streams; the connector declares what it can do with that stream. When the connector cannot deliver chunks progressively, the gateway buffers them and delivers the fully assembled response as a single message — identical to v0 behaviour, with no regression and no wasted work on the adapter side.

```
Adapter                 Pipeline                 Connector
  │                        │                         │
  │──stream(request)──────►│                         │
  │  (always available)    │                         │
  │◄── chunk 1 ────────────│                         │
  │◄── chunk 2 ────────────│  connector supports     │
  │◄── chunk n ────────────│  streaming?             │
  │◄── done ───────────────│                         │
  │                        │  YES → send each chunk ►│  (Slack, OpenAI API compat)
  │                        │  NO  → buffer + send ──►│  (WeChat)
```

The session slot is held for the full duration of the stream in all cases. Abort (`/stop`, new message supersede) fires the `AbortSignal` mid-stream, causing the adapter to stop yielding.

### Adapter contract extension

`AgentAdapter` gains an optional `stream()` method. Adapters that implement it are treated as streaming-capable. The `run()` method remains required as a fallback — for adapters that don't stream, and for connectors that buffer.

```typescript
export interface AgentAdapter {
  /** Always required. Used when the connector cannot consume a stream. */
  run(request: AgentRequest): Promise<AgentResponse>

  /**
   * Optional. When present, the pipeline calls stream() in preference to run()
   * and routes chunks to the connector's streaming or buffering path.
   *
   * Implementors MUST honour request.abortSignal: stop yielding when it fires
   * and yield a final chunk with interrupted: true.
   */
  stream?(request: AgentRequest): AsyncIterable<StreamChunk>

  onSessionReset?: (sessionKey: string) => Promise<void>
}

export interface StreamChunk {
  /** Token text to append to the response so far. */
  delta: string
  /** True on the last chunk — no more deltas will follow. */
  done?: boolean
  /** Populated only on the final chunk. True if abortSignal fired. */
  interrupted?: boolean
  /** Media attachments — populated only on the final chunk. */
  media?: MediaItem[]
}
```

`LangGraphAdapter` implements `stream()` natively via `graph.streamEvents()`. `HttpAdapter` will gain a `stream()` implementation in v1 using the upstream server's SSE response when available. `EmbeddedAdapter` gains an optional stream handler for use in tests.

### Connector streaming capability

Each connector declares whether it can deliver chunks progressively. This is a static property on the connector class, not a per-message decision:

```typescript
export interface ConnectorInterface {
  // ... existing methods ...

  /**
   * True if this connector can deliver stream chunks to the user progressively.
   * When false, the pipeline buffers all chunks and calls send() once on done.
   * Defaults to false if absent.
   */
  readonly supportsStreaming?: boolean

  /**
   * Deliver one stream chunk. Called only when supportsStreaming is true.
   * The connector is responsible for its own rate-limiting and edit debouncing.
   */
  sendChunk?(target: DeliveryTarget, chunk: StreamChunk, accumulated: string): Promise<void>
}
```

### Per-connector streaming behaviour

| Connector | `supportsStreaming` | Delivery model |
|---|---|---|
| **OpenAI API compat** | `true` | True SSE token streaming. `stream: true` in the request body activates the SSE path; the connector holds the HTTP response open and writes each `StreamChunk.delta` as a `data:` line in `chat.completion.chunk` format, terminating with `data: [DONE]`. Non-streaming requests (`stream: false` or absent) are unaffected. |
| **Slack** | `true` | Progressive message edit. First chunk calls `chat.postMessage` to create the message. Each subsequent `sendChunk` call updates the message content with the accumulated text via `chat.update`. Edit calls are debounced inside the connector to ≤2 per second to respect Slack's Tier 3 rate limit. The final assembled text is delivered on `done: true`. |
| **WeChat** | `false` | Buffered — pipeline assembles all chunks and calls `send()` once. iLink API does not support message editing. Typing indicator remains active for the full stream duration. This is identical to v0 behaviour. |

### Pipeline routing logic

```
Stage 5 (runAdapter):

  if adapter.stream exists:
    chunks = []
    async for chunk of adapter.stream(request):
      chunks.push(chunk)
      if connector.supportsStreaming:
        await connector.sendChunk(target, chunk, assembled(chunks))
    if NOT connector.supportsStreaming:
      await connector.send(target, assembled(chunks))
  else:
    response = await adapter.run(request)
    await connector.send(target, response.text)
```

### OpenAI API compat — SSE format

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

### `chunk_message` interaction

v0's `chunk_message` splits long completed responses across multiple messages. For streaming, `chunk_message` applies only to the final assembled text (after `done: true`) — not to individual deltas. This preserves existing message-length limits without interfering with progressive delivery.

---

## 4. Theme C — Remote Configuration Dashboard

### What it is

A browser-based admin dashboard, plus the **management API** that backs it, that lets an operator view and change a running gateway's configuration remotely. The gateway's configuration today is a static `gateway.config.yaml` loaded once at boot and validated by `GatewayConfigSchema` (Zod). Theme C turns that file into a live, editable surface: connectors can be added, edited, enabled/disabled, and restarted; the adapter and policies can be retuned — all from a web UI, with changes **hot-applied to only the connectors that changed**, no process restart and no dropped sessions on unaffected connectors.

Three design decisions frame the work:

- **Apply model: hot-reload affected connectors.** On apply, the gateway diffs the new config against the running config and stops/starts only the connectors whose configuration changed, draining their in-flight sessions first. Unaffected connectors keep running untouched.
- **Hosting: embedded SPA.** The dashboard is a single-page app (`packages/dashboard`, Vite + React + TypeScript) compiled to static assets and served by the gateway's existing Hono server under `/admin`. One deployable, one origin, no CORS.
- **Auth: admin bearer token → session cookie.** A configured admin token bootstraps login; the server issues a short-lived, signed, HttpOnly session cookie. Secure by default: if no admin token is configured, the entire `/admin` surface is disabled (returns 404).

```
                          Browser
                             │  HTTPS (cookie-authenticated)
                             ▼
┌──────────────────────────────────────────────────────────┐
│  Gateway Core (existing shared Hono server, one port)     │
│                                                            │
│  GET  /health                  (v0)                        │
│  /v1, /connectors/teams, …     (connector webhook mounts)  │
│                                                            │
│  NEW  /admin/*                 → static SPA assets         │
│  NEW  /admin/api/*             → management API            │
│            │                                               │
│            ▼                                               │
│   ConfigStore ──validate(Zod)──► atomic write + backup     │
│            │                                               │
│            ├──► ConnectorSupervisor ──diff──► stop/start    │
│            │        only the changed connectors            │
│            │                                               │
│            └──► AdapterManager ──► hot-swap http adapter,   │
│                     or report requiresRestart for code     │
│                                                            │
│   SessionRegistry / AuditLog (SQLite, read surfaces)       │
└──────────────────────────────────────────────────────────┘
```

### Why a control plane, not just a config file

v0 treats configuration as immutable for the lifetime of the process: change anything and you must edit the YAML on the host and restart. Once the gateway ships as a portable Docker image deployed to platforms where the filesystem is ephemeral and SSH is unavailable, hand-editing is no longer practical. A control plane makes the running instance the source of truth for *operational* state while keeping the YAML as the persisted, version-controllable representation.

The management API is the contract; the SPA is one client of it. Keeping them separate means the same API can later back a CLI (`gateway-admin`) or automation without rework.

### Location: `packages/gateway/src/admin/` and `packages/dashboard/`

The server-side control plane lives inside the gateway package; the frontend is a new sibling workspace package.

```
packages/gateway/src/admin/
├── index.ts                # mounts /admin (static) + /admin/api (routes) onto the shared Hono app
├── auth.ts                 # admin-token login, signed session cookie issue/verify, middleware
├── routes/
│   ├── config.ts           # GET/PUT config, POST validate (dry-run), with secret redaction
│   ├── connectors.ts       # list status, per-connector restart/enable/disable
│   ├── adapter.ts          # get adapter status, test connectivity, restart code-bound adapter
│   └── status.ts           # health summary, sessions (read-only), recent audit entries
├── config-store.ts         # load/validate/persist gateway.config.yaml; atomic write + .bak rollback
├── supervisor.ts           # ConnectorSupervisor: per-accountId lifecycle + config-diff hot-reload
├── adapter-manager.ts      # AdapterManager: hot-swap http adapter; requiresRestart for code-bound
├── redact.ts               # mask secret-typed fields; never return resolved secret values
├── auth.test.ts
├── config-store.test.ts
├── supervisor.test.ts
└── adapter-manager.test.ts

packages/dashboard/                 # NEW workspace package — the SPA
├── package.json            # @agent-gateway/dashboard; Vite build → dist/ (static assets)
├── vite.config.ts
├── index.html
└── src/
    ├── main.tsx
    ├── api/                # typed client for /admin/api/* (shares Zod types from gateway)
    ├── pages/              # Overview, Connectors, Adapter, Raw YAML, Sessions, Audit
    └── components/         # schema-driven forms generated from the gateway Zod schema
```

The dashboard's compiled `dist/` is copied into the gateway image at build time (a new stage in the existing multi-stage `Dockerfile`) and served from `/admin`. The gateway never depends on `packages/dashboard` at runtime — it only serves the pre-built static files, so the SPA toolchain stays out of the production image's `node_modules`.

### Management API

All routes are under `/admin/api`. Every route except `POST /login` and the static assets requires a valid session cookie. The API is JSON; the config payload is the same shape as `GatewayConfigSchema`, with secret-typed fields redacted on read.

| Method & path | Purpose |
|---|---|
| `POST /admin/api/login` | Body `{ token }`. Verifies against the configured admin token; on success sets a signed HttpOnly session cookie and returns `{ ok: true }`. Rate-limited. |
| `POST /admin/api/logout` | Clears the session cookie. |
| `GET /admin/api/config` | Returns the current config with secret fields masked (see *Secrets*). |
| `POST /admin/api/config/validate` | Dry-run: validates a candidate config against `GatewayConfigSchema` and returns structured errors. No persistence, no apply. |
| `PUT /admin/api/config` | Validate → persist (atomic) → hot-apply via the supervisor → on failure, roll back. Returns the diff that was applied and per-connector apply results. |
| `GET /admin/api/connectors` | Per-`accountId` status: `running` / `stopped` / `error` (+ last error), connector `type`, and `supportsStreaming`. |
| `POST /admin/api/connectors/:accountId/restart` | Gracefully stop and restart a single connector (drains in-flight sessions first). |
| `GET /admin/api/adapter` | Current adapter `type` and config (secrets redacted), live status, and whether the active type is hot-swappable (`hotSwappable: true` for `http`). |
| `POST /admin/api/adapter/test` | Connectivity check for an `http` adapter candidate: validates the URL/auth and probes the upstream without persisting. Returns reachability + protocol detection. |
| `POST /admin/api/adapter/restart` | Re-instantiate the current adapter (rebuilds the `http` adapter live; for code-bound adapters returns `requiresRestart: true`). |
| `GET /admin/api/status` | Boot time, version, active session count, connector summary — the data behind the Overview page. |
| `GET /admin/api/sessions` | Read-only view of the session registry (no ability to terminate sessions in v1). |
| `GET /admin/api/audit` | Recent entries from the existing audit log, including config-change events written by `PUT /config`. |

### Hot-reload: `ConnectorSupervisor`

Today `GatewayRunner` starts every connector once at boot. Theme C extracts connector lifecycle into a `ConnectorSupervisor` that owns connectors keyed by `accountId` and can mutate the running set safely:

```
applyConfig(next: GatewayConfig):
  diff = diffConnectors(current, next)      # by accountId + deep-equal of connector config
  for accountId in diff.removed:  await stop(accountId)        # drain, then dispose
  for accountId in diff.changed:  await restart(accountId, next)   # stop (drain) → start
  for accountId in diff.added:    await start(accountId, next)
  # http.port / gateway.* changes that cannot be hot-applied are reported
  # as "requires restart" rather than silently ignored.
  # adapter changes are delegated to the AdapterManager (see below).
```

Rules that preserve the v0 correctness bar:
- **Draining:** stopping a connector waits for its active `RunSlot`s to finish (bounded by `gateway.shutdownTimeoutMs`), exactly like graceful shutdown — no session is cut mid-turn.
- **Isolation:** a failure starting one connector does not affect others; it is surfaced as that connector's `error` status.
- **Atomic apply + rollback:** config is persisted with an atomic temp-write-and-rename and a `.bak` of the previous good config. If applying the new config leaves any *previously-running* connector unable to start, the supervisor restores the previous config and the previous running set, and the API returns the failure.
- **Not hot-reloadable:** `http.port` and `gateway.*` (data dir, timeouts) changes require a process restart in v1; the API reports this explicitly (`requiresRestart: true`) instead of pretending to apply them.

### Hot-reload: `AdapterManager` (agent adapter)

The agent adapter is a single, process-wide instance shared by the pipeline (one adapter, vs. many connectors). The `AdapterManager` owns that instance behind an indirection so the pipeline always resolves the *current* adapter at the start of each turn, and the manager can replace it safely. How far an apply goes depends on the adapter type:

| Adapter `type` | Apply model | Why |
|---|---|---|
| **`http`** | **Hot-swapped live.** On apply, quiesce: stop admitting new turns to the adapter, wait for in-flight turns to drain (bounded by `gateway.adapterTimeoutMs`), build the new `HttpAdapter` from the new config, atomically swap the reference, resume. Roll back to the previous adapter if construction or a post-swap connectivity probe fails. | Stateless config only (`url`, `bearerTokenEnv`, `protocol`, `model`); no long-lived connections, so a swap is safe and fast. |
| **`embedded` / `embedded-langgraph`** | **`requiresRestart: true`.** The dashboard edits and persists tunable fields (e.g. `dbPath`), but the change is applied on the next process restart. The injected `StateGraph` / module is **code**, not config, and is not editable or swappable from the dashboard. | The agent is supplied in-process via `startGateway({ agent })`; you cannot author or rebuild a compiled graph from a web form, and an in-process swap of a live graph is unsafe. |

```
applyAdapter(next.adapter):
  if next.adapter.type == 'http' and current is http:
    quiesce()                       # drain in-flight turns (adapterTimeoutMs)
    candidate = new HttpAdapter(next.adapter)
    if not await candidate.probe(): rollback(); return { error }
    swap(candidate)                 # atomic reference swap
    resume()
    return { applied: true }
  else:
    return { requiresRestart: true }   # code-bound, or a type change
```

Rules mirror the connector supervisor: **quiesce-and-drain** (no turn is cut mid-flight), **atomic swap**, **rollback on failure**, and **explicit `requiresRestart`** rather than silent no-ops. Changing the adapter *type* (e.g. `http` → `embedded-langgraph`) always reports `requiresRestart`, since code-bound adapters require process-level wiring.

### Auth and security

- **Bootstrap token:** the admin token is supplied via env (`GATEWAY_ADMIN_TOKEN`) and referenced from config like any other secret. No token configured ⇒ `/admin` and `/admin/api` return 404 (feature off by default).
- **Session cookie:** on successful login the server issues an HMAC-signed cookie (server signing key derived from the admin token or a separate `GATEWAY_ADMIN_SESSION_SECRET`), `HttpOnly`, `SameSite=Strict`, `Secure`, with a short TTL and sliding renewal. No session state is stored server-side beyond the signing key.
- **Login hardening:** constant-time token comparison and per-IP rate limiting on `POST /login`.
- **Transport:** the dashboard assumes TLS termination in front of the gateway (ingress/proxy or platform-provided). This is documented, not enforced, consistent with how connector webhooks already rely on the platform for TLS.

### Secrets handling

The dashboard must never leak resolved secret values. Two-part rule:

1. **Read is redacted.** `GET /admin/api/config` masks every secret-typed field (`token`, `botToken`, `appToken`, `signingSecret`, `appPassword`, `bearerToken`, adapter `bearerTokenEnv` target, …). Fields written as `${ENV_VAR}` placeholders are returned as the placeholder reference (not the resolved value); fields holding literal secrets are returned masked (`"••••"`).
2. **Write is explicit.** A secret field is only changed when the operator submits a new value; submitting the mask leaves it unchanged. New literal secrets are written to the gitignored secrets file (e.g. `data/.env`) and referenced from the YAML as `${ENV_VAR}`, keeping `gateway.config.yaml` free of plaintext secrets and preserving the existing `${...}` interpolation contract.

### Schema-driven forms

The connector and adapter editors are generated from the **same Zod schema** the gateway validates against (`config/schema.ts`) — a single source of truth. The build exports the Zod schema to JSON Schema (`zod-to-json-schema`) which drives form rendering and inline field validation in the SPA, so a new connector field added to the Zod schema automatically appears in the dashboard with the correct type, enum options, and defaults. A raw-YAML editor with the same server-side validation is offered as an escape hatch for power users.

### What the dashboard surfaces

| Page | Content |
|---|---|
| **Overview** | Gateway version/uptime, connector health grid, active session count, recent audit events. |
| **Connectors** | List with status; add/edit/remove via schema-driven forms; per-connector enable/disable and restart. |
| **Adapter** | View/edit adapter config; `http` adapters apply live with a one-click connectivity test; `embedded`/`embedded-langgraph` expose editable fields flagged `requiresRestart`, with the injected agent shown read-only. |
| **Raw YAML** | Full-config editor with validate-before-save. |
| **Sessions** | Read-only registry view (session key, platform, last activity). |
| **Audit** | Recent audit log, including who changed config and when. |

---

## 5. What Is Explicitly Out of Scope

| Feature | Reason deferred |
|---|---|
| LangChain.js adapter (non-graph) | Covered as a subset of LangGraph.js — any `Runnable` works as a graph node; a standalone `LangChainAdapter` is not needed |
| Python LangGraph adapter | The Python reference agent (`packages/agent-reference`) already serves this role via `HttpAdapter`; an in-process Python adapter would require embedding a Python runtime |
| Streaming to WeChat (real-time) | iLink API does not support message editing; buffered delivery is the correct model |
| Telegram connector | Deferred from v0; still low priority |
| MS Teams connector | CJS interop + Azure Bot registration — deferred |
| Multi-adapter routing | Post-v1 |
| Approval flow in `LangGraphAdapter` | Requires a tool that needs approval; deferred to after the adapter is stable |
| `sdk-py` publication to PyPI | API still stabilising |
| ACP server | Post-v1 |
| Cron and process completion turn sources | Post-v1 |
| Live hot-swap of code-bound adapters (dashboard) | The `http` adapter hot-reloads in v1; `embedded`/`embedded-langgraph` and adapter **type** changes report `requiresRestart`. In-process swap of a live `StateGraph` is deferred post-v1 |
| Multi-gateway / fleet management (dashboard) | v1 manages exactly one gateway instance; a control plane over many gateways is post-v1 |
| RBAC / multiple admin users (dashboard) | v1 has a single admin role via one shared token; per-user accounts and roles are post-v1 |
| OIDC / Entra ID SSO (dashboard) | Admin-token + session cookie is the v1 auth model; external IdP integration deferred |
| Terminating / editing live sessions from the dashboard | Sessions are read-only in v1; mutation surfaces are post-v1 |
| Secret vault integration (Key Vault, etc.) | v1 stores secrets in the gitignored env file via `${ENV_VAR}`; external secret backends deferred |
| Config version history / diff UI (dashboard) | v1 keeps a single `.bak` rollback; full versioned history and visual diffs are post-v1 |

---

## 6. Feature Priority List

Features are ordered by the sequence in which they must be built. P0 items are
contracts and pipeline infrastructure that every other feature depends on. P1
delivers the two core themes. P2 completes coverage. P3 is test and
infrastructure work that gates the v1 release.

### P0 — Contracts and pipeline routing (blockers)

| # | Feature | What it is | Why first | Status |
|---|---|---|---|---|
| 1 | **`StreamChunk` type + `stream()` on `AgentAdapter`** | Add `StreamChunk` interface and optional `stream()` method to `adapter/types.ts` | Every adapter and every pipeline change depends on this interface being frozen first | ✅ Done |
| 2 | **`supportsStreaming` + `sendChunk()` on `ConnectorInterface`** | Add the two optional streaming members to `connectors/types.ts` | All three connectors implement or opt out of this — must be defined before connector work starts | ✅ Done |
| 3 | **Pipeline streaming path (`runAdapter` Stage 5)** | Route `adapter.stream()` chunks to `sendChunk()` (if connector supports it) or buffer-then-`send()` (if not); fall back to `adapter.run()` when `stream()` is absent | All streaming acceptance criteria pass through here — build and unit-test with a fake streaming adapter before touching LangGraph or Slack | ✅ Done |

### P1 — Core deliverables

| # | Feature | What it is | Depends on | Status |
|---|---|---|---|---|
| 4 | **`LangGraphAdapter` — core invoke path** | `state.ts`, `history.ts`, `langgraph/index.ts`: `GatewayState` annotation, SQLite history, `isNew`/`wasAutoReset` clearing, basic `run()` invocation | P0 | ✅ Done |
| 5 | **`LangGraphAdapter` — streaming path** | `streaming.ts`: bridge `graph.streamEvents()` → `AsyncIterable<StreamChunk>` | #4, P0 pipeline | ✅ Done |
| 6 | **OpenAI API compat — SSE streaming** | `stream: true` in request body → `Content-Type: text/event-stream`; write `chat.completion.chunk` events; terminate with `data: [DONE]` | P0 pipeline | ✅ Done |

### P2 — Complete coverage

| # | Feature | What it is | Depends on | Status |
|---|---|---|---|---|
| 7 | **Slack progressive message edit** | `chat.postMessage` on first chunk; `chat.update` on subsequent chunks debounced to ≤2/s; 429 retry | P0 pipeline | ✅ Done |
| 8 | **`HttpAdapter` streaming path** | Consume SSE from upstream agent server; yield `StreamChunk` deltas | P0 pipeline | ✅ Done |
| 9 | **`LangGraphAdapter` abort / `checkAbort` helper** | Pass `abortSignal` via `RunnableConfig.signal`; export `checkAbort(config)` helper for tool nodes | #4 | ✅ Done |

### P3 — Tests (required before v1 release)

| # | Feature | What it is | Depends on | Status |
|---|---|---|---|---|
| 10 | **Pipeline streaming unit tests** | Buffer path + progressive path in `runTurn.test.ts`; fake streaming adapter + fake streaming connector | #3 | ✅ Done |
| 11 | **`LangGraphAdapter` unit tests** | `adapter.test.ts` + `streaming.test.ts`; mock LLM via `buildConfig`; no live API calls | #4, #5 | ✅ Done |
| 12 | **Slack streaming unit tests** | Debounce with fake clock; 429 backoff-and-retry | #7 | ✅ Done (debounce covered; 429 retry deferred) |
| 13 | **WeChat buffered-stream regression test** | Confirm exactly one `send()` call per turn when adapter streams; no partial messages | P0 pipeline | ✅ Done (covered in `runTurn.test.ts` buffer-path tests) |

### P4 — Theme C: Remote Configuration Dashboard

P4 is net-new in this revision and ordered like the rest of the doc: contracts and the server-side control plane first (every UI feature depends on the API and the supervisor), then the SPA, then tests. The dashboard is **disabled by default** (no `GATEWAY_ADMIN_TOKEN` ⇒ no `/admin` surface), so P4 ships without changing the behaviour of existing deployments.

| # | Feature | What it is | Depends on | Status |
|---|---|---|---|---|
| 14 | **`ConnectorSupervisor` — per-connector lifecycle** | Extract connector start/stop out of `GatewayRunner` into a supervisor keyed by `accountId`, with graceful drain (`shutdownTimeoutMs`) and per-connector status | v0 connector lifecycle | ✅ Done |
| 15 | **`ConfigStore` — load/validate/persist** | Reuse `GatewayConfigSchema`; atomic temp-write + rename, `.bak` of previous good config, structured validation errors | #14 | ✅ Done |
| 16 | **Hot-reload apply + rollback** | `applyConfig()`: diff old/new by `accountId`, stop/start only changed connectors, restore previous config + running set on failure; flag non-hot-reloadable changes `requiresRestart` | #14, #15 | ✅ Done |
| 17 | **`AdapterManager` — adapter hot-reload** | Indirection so the pipeline resolves the current adapter per turn; quiesce-drain + atomic swap + rollback for the `http` adapter; `requiresRestart` for `embedded`/`embedded-langgraph` and type changes; connectivity probe | #15, v0 adapter wiring | ✅ Done |
| 18 | **Admin auth** | `GATEWAY_ADMIN_TOKEN` bootstrap → signed HttpOnly session cookie; constant-time compare; per-IP login rate limit; secure-by-default 404 when unset | none | ✅ Done |
| 19 | **Management API routes** | `/admin/api/*`: login/logout, config get/validate/put, connectors list/restart, adapter get/test/restart, status/sessions/audit; secret redaction on read | #15, #16, #17, #18 | ✅ Done |
| 20 | **Dashboard UI (embedded HTML)** | ~~Vite + React + TS SPA in `packages/dashboard`~~ → **revised:** a single self-contained `admin/dashboard.ts` (vanilla HTML+JS) served by the gateway at `/admin`; pages for Overview, Connectors, Adapter, Raw config, Sessions, Audit. Avoids the React/Vite toolchain for a config dashboard | #19 | ✅ Done (embedded HTML) |
| 21 | **Schema-driven config forms** | Export Zod → JSON Schema (`zod-to-json-schema`); render connector/adapter forms + inline validation from the single source of truth | #19, #20 | ⬜ Deferred — embedded UI ships a validated raw-config editor; generated forms post-v1 |
| 22 | **Dockerfile dashboard build stage** | New build stage compiles `packages/dashboard`; copy static `dist/` into the runtime image; no SPA toolchain in production `node_modules` | #20 | ➖ N/A — embedded HTML ships inside the gateway bundle; no separate build stage needed |
| 23 | **Theme C tests** | Supervisor diff/apply/rollback + drain; AdapterManager swap/rollback/requiresRestart; ConfigStore atomic write + validation errors; auth (cookie issue/verify, rate limit, secure-by-default 404); secret redaction round-trip; management API auth gate | #14–#19 | ✅ Done |

### Recommended build order

```
P0:  #1 → #2 → #3        contracts + pipeline routing
P1:  #4 → #5 → #6        LangGraph core, LangGraph streaming, OpenAI SSE
P2:  #7 / #8 / #9        can be parallelised; Slack (#7) is the most complex
P3:  #10–#13             tests woven in alongside each feature above
P4:  #14 → #15 → #16     supervisor → config store → connector hot-reload
     #17                 adapter hot-reload (AdapterManager)
     #18 → #19           auth → management API
     #20 → #21 → #22     SPA → schema forms → Docker stage
     #23                 tests woven in alongside #14–#19
```

---

## 7. Acceptance Criteria

v1 is considered complete when all of the following pass:

### LangGraph.js adapter

- [ ] A compiled LangGraph.js `StateGraph` passed to `LangGraphAdapter` responds to a plain message with a contextually appropriate reply
- [ ] `isNew: true` is reflected in `GatewayState`; the graph can detect it and greet the user
- [ ] `wasAutoReset: true` is reflected in `GatewayState`; the graph can detect it and acknowledge the reset
- [ ] Conversation history is loaded from SQLite before each turn and saved after; a follow-up message referencing a prior turn is answered correctly
- [ ] History is cleared when `isNew: true` or `wasAutoReset: true`
- [ ] When `abortSignal` fires mid-graph (e.g. via `/stop`), the graph stops executing and the pipeline receives `interrupted: true`
- [ ] A tool node that calls `checkAbort(config)` returns early cleanly when the signal fires
- [ ] All adapter unit tests pass with no live LLM calls (mock LLM injected via `buildConfig`)

### Streaming — OpenAI API compat

- [ ] A `POST /v1/chat/completions` request with `"stream": true` returns `Content-Type: text/event-stream` and streams token chunks in OpenAI `chat.completion.chunk` format
- [ ] The stream terminates with `data: [DONE]`
- [ ] A request without `"stream": true` behaves identically to v0 (single JSON response)
- [ ] If the adapter does not implement `stream()`, a streaming request falls back to the non-streaming path and returns a single SSE event followed by `[DONE]`
- [ ] Aborting the request mid-stream (client closes connection) fires `abortSignal` in the adapter

### Streaming — Slack progressive edit

- [x] A Slack DM response from a streaming adapter produces a visible message that is updated in place as chunks arrive
- [x] The edit rate does not exceed 2 updates/second (debounce verified in unit tests with a fake clock)
- [x] The final message content equals the fully assembled response text
- [ ] If `chat.update` returns a rate-limit error (HTTP 429), the gateway backs off and retries without dropping the buffered content

### Streaming — WeChat buffered

- [x] A WeChat DM response from a streaming adapter delivers the fully assembled response as a single message (no partial messages, no edits)
- [x] Typing indicator remains active for the full duration of the stream

### Automated tests

- [x] `packages/gateway`: `LangGraphAdapter` unit tests at `src/adapter/langgraph/adapter.test.ts` and `src/adapter/langgraph/streaming.test.ts` pass with no live LLM calls (mock LLM injected via `buildConfig`)
- [x] `packages/gateway`: existing 90 tests continue to pass; streaming pipeline tests added to `src/core/pipeline/runTurn.test.ts` covering the buffer path and the progressive-delivery path (now 143 tests total across 12 test files)
- [x] All tests run in CI via the existing GitHub Actions `test-typescript` job — no workflow changes needed

### Remote configuration dashboard

- [ ] With no `GATEWAY_ADMIN_TOKEN` set, `/admin` and `/admin/api/*` return 404 and the gateway behaves exactly as v0 (feature off by default)
- [ ] With an admin token set, `POST /admin/api/login` with the correct token issues a signed HttpOnly session cookie; an incorrect token is rejected and the endpoint is rate-limited per IP
- [ ] All `/admin/api/*` routes except `login` reject requests without a valid session cookie
- [ ] `GET /admin/api/config` returns the current configuration with every secret-typed field masked or shown as its `${ENV_VAR}` reference — no resolved secret value is ever returned
- [ ] `POST /admin/api/config/validate` returns structured `GatewayConfigSchema` errors for an invalid config and does not persist or apply anything
- [ ] `PUT /admin/api/config` with a valid change to one connector hot-applies it: only that connector is restarted (draining its in-flight sessions), and all other connectors keep running uninterrupted
- [ ] Adding a new connector via `PUT /admin/api/config` starts it without restarting the process; removing one stops and disposes it after draining
- [ ] A valid change to an `http` adapter's config (`url`, `protocol`, `model`, `bearerTokenEnv`) is hot-applied live: in-flight turns drain, the adapter is rebuilt and swapped, and the next turn uses the new config — no process restart
- [ ] `POST /admin/api/adapter/test` reports reachability of an `http` adapter candidate without persisting or swapping the live adapter
- [ ] If a new `http` adapter fails to construct or fails its post-swap connectivity probe, the gateway rolls back to the previous adapter and reports the failure
- [ ] A change to an `embedded`/`embedded-langgraph` adapter, a change to the adapter **type**, or a change to `http.port` is reported with `requiresRestart: true` rather than being silently ignored; the injected agent graph is shown read-only
- [ ] If applying a new config leaves a previously-running connector unable to start, the gateway rolls back to the previous config and the previous running connector set, and the API reports the failure
- [ ] Config is persisted atomically (temp-write + rename) with a `.bak` of the previous good config; a crash mid-write never leaves a corrupt `gateway.config.yaml`
- [ ] Submitting a secret field's mask leaves the stored secret unchanged; submitting a new value updates it without writing plaintext into `gateway.config.yaml`
- [ ] Every config change is recorded in the audit log and visible via `GET /admin/api/audit`
- [ ] The dashboard SPA is served from `/admin`, lets the operator edit connectors **and the adapter** via schema-driven forms, validates before save, and reflects live connector and adapter status
- [ ] The dashboard's static assets are built into the Docker image via a dedicated build stage; the production image's `node_modules` contains no SPA build tooling

### Automated tests — dashboard

- [ ] `packages/gateway`: `ConnectorSupervisor` tests cover the add/change/remove diff, graceful drain on stop, per-connector error isolation, and rollback on failed apply
- [ ] `packages/gateway`: `AdapterManager` tests cover live `http` swap with in-flight drain, rollback on probe failure, and `requiresRestart` for code-bound adapters and type changes
- [ ] `packages/gateway`: `ConfigStore` tests cover atomic write, `.bak` rollback, and validation-error reporting
- [ ] `packages/gateway`: admin-auth tests cover cookie issue/verify, login rate limiting, constant-time token comparison, and secure-by-default 404 when no token is configured
- [ ] `packages/gateway`: a secret-redaction round-trip test confirms `GET` never returns a resolved secret and that re-submitting a masked field is a no-op
- [ ] All dashboard tests run in CI via the existing GitHub Actions `test-typescript` job
