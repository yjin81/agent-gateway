# Agent Gateway — v0 Planning

## Table of Contents

1. [Goal](#1-goal)
2. [What Is In Scope](#2-what-is-in-scope)
3. [Reference Agent](#3-reference-agent----packages-agent-reference)
4. [End-to-End Topology](#4-end-to-end-topology)
5. [What Is Out of Scope](#5-what-is-explicitly-out-of-scope)
6. [Acceptance Criteria](#6-acceptance-criteria)

---

## 1. Goal

v0 is the first end-to-end working version of Agent Gateway. Its goal is to validate the full stack — platform connector → turn pipeline → harness → response delivery — with the minimal surface area needed to be genuinely useful and to serve as a trustworthy foundation for subsequent connectors and harness implementations.

v0 is **not** a demo. It must be correct within its declared scope: correct concurrency, reliable delivery, clean error handling, and a reference agent that harness authors can copy and extend.

---

## 2. What Is In Scope

### Layer 1 — Connectors (2)

**Connector 1: Telegram**
- Connection mechanism: long polling (`getUpdates`) — no public URL required, works on a developer laptop
- Supported chat types: DM and group (with @mention detection)
- Session key formulas: `v1:telegram:{accountId}:{conversation.id}` (DM), `v1:telegram:{accountId}:{conversation.id}:{sender.id}` (group)
- Media: inbound images and voice messages passed through to harness as `MediaItem[]`; outbound text only (no media send in v0)
- Library: `grammY`

**Connector 2: OpenAI API Compatibility Layer**
- Endpoint: `POST /v1/chat/completions` only
- Input: standard OpenAI `messages[]` array; the last `user` message becomes `AgentRequest.message`; all prior `messages[]` entries are passed as `messageRaw` for the harness to use if it wishes; the `model` field is passed through in `platform.name`
- Session key: `v1:openai-api:{accountId}:{clientSessionId}` where `clientSessionId` is taken from a custom request header `X-Session-Id` if provided, otherwise a random UUID generated per request
- **Session continuity**: the OpenAI `/v1/chat/completions` protocol is inherently stateless — clients send the full message history in every request. For v0, the compat connector makes no attempt to reconstruct session continuity from request content. Clients that want persistent history across requests must supply a stable `X-Session-Id` header. Clients that do not will receive a fresh session on each request (consistent with how the OpenAI API itself behaves).
- Output: non-streaming JSON response (`choices[0].message.content`) populated from `AgentResponse.text`; streaming (`stream: true`) is out of scope for v0
- Auth: optional bearer token via `gateway.config.yaml` `bearerToken` field
- Purpose: allows any OpenAI SDK client (Python `openai`, TypeScript `openai`, `curl`) to talk to the gateway without a messaging app — primary developer testing surface

### Layer 2 — Gateway Core

All six pipeline stages are implemented in full. No shortcuts.

| Component | v0 status |
|---|---|
| Turn pipeline (all 6 stages) | ✅ Full implementation |
| Session registry (SQLite WAL) | ✅ Full implementation |
| Serial-per-session concurrency (RunSlot + AbortController) | ✅ Full implementation |
| Pending queue with overflow + supersede notification | ✅ Full implementation |
| Typing indicators (`keep_typing` loop) | ✅ Full implementation |
| `send_with_retry` + `chunk_message` | ✅ Full implementation |
| Approval flow (`/approve`, `/deny`, `approvalTimeoutMs`) | ✅ Full implementation |
| Idle-timeout reset (`wasAutoReset`) | ✅ Full implementation |
| Audit log (SQLite, append-only) | ✅ Full implementation |
| Graceful shutdown (SIGTERM + drain) | ✅ Full implementation |
| Reconnect with exponential backoff | ✅ Full implementation |
| Priority commands: `/stop`, `/new`, `/approve`, `/deny` | ✅ Full implementation |
| Utility commands: `/help`, `/status` | ✅ Full implementation |
| Session commands: `/retry` | ✅ Full implementation |
| Remaining session + config commands | ❌ Post-v0 |
| Cron turn source | ❌ Post-v0 |
| Process completion turn source | ❌ Post-v0 |
| ACP server (`/acp/*`) | ❌ Post-v0 |

### Layer 3 — Harness

**`HTTPHarness`**: full implementation. This is the primary integration path for all Python harnesses.

**`EmbeddedHarness`**: full implementation. Used in tests and for TypeScript-native harnesses.

---

## 3. Reference Agent — `packages/agent-reference`

v0 ships a working reference agent in the monorepo at `packages/agent-reference`. It is implemented in Python using LangGraph and LangChain, exposes an HTTP endpoint consumed by `HTTPHarness`, and is designed to be the canonical starting point for harness authors.

### What it is

A LangGraph `StateGraph` agent with:
- A configurable system prompt
- Persisted conversation history per `sessionKey` (SQLite via LangChain's `SQLiteChatMessageHistory`)
- Two built-in tools (no authentication required — works out of the box):
  - **`get_current_time`** — returns the current UTC date and time; validates that tool calling and response injection work
  - **`calculator`** — evaluates a safe arithmetic expression; validates that multi-turn tool use and history persistence work
- `isNew` / `wasAutoReset` awareness — clears history and greets the user when the session is new or reset
- Respects `abortSignal` by checking a cancellation flag between LangGraph node steps

### What it is not

- Not a production agent. System prompt, tools, and model are configurable but the agent itself has no domain knowledge.
- Not a demonstration of all gateway features. It does not use the approval flow (that requires a tool that needs approval — out of scope for the reference agent in v0).

### Structure

```
packages/agent-reference/
├── agent_reference/
│   ├── __init__.py
│   ├── agent.py              # LangGraph StateGraph definition
│   ├── tools.py              # get_current_time, calculator
│   ├── history.py            # SQLiteChatMessageHistory wrapper keyed on sessionKey
│   ├── server.py             # FastAPI app: POST /run → AgentRequest → AgentResponse
│   └── config.py             # Pydantic settings: model name, system prompt, db path, port
├── tests/
│   ├── test_agent.py         # Unit tests: tool execution, history load/save, isNew handling
│   └── test_server.py        # Integration test: POST /run round-trip
├── pyproject.toml            # dependencies: langgraph, langchain, langchain-openai, fastapi, uvicorn, httpx, pydantic
└── README.md                 # How to run the reference agent standalone and with the gateway
```

### HTTP contract

The reference agent implements the `AgentHarness` HTTP contract (design spec Section 6):

```
POST /run
Content-Type: application/json
Authorization: Bearer <token>   (optional)

Body: AgentRequest (snake_case JSON)

Response 200:
Body: AgentResponse (snake_case JSON)

Response 400: malformed request (Pydantic validation error)
Response 500: unhandled agent error
```

### Configuration

Via environment variables (loaded by `config.py` using Pydantic `BaseSettings`):

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | required | OpenAI API key (or compatible endpoint key) |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Override for Azure OpenAI or local models |
| `AGENT_MODEL` | `gpt-4o-mini` | Model name passed to `ChatOpenAI` |
| `AGENT_SYSTEM_PROMPT` | `"You are a helpful assistant."` | System prompt injected at the start of every conversation |
| `AGENT_DB_PATH` | `./data/agent.db` | SQLite file for conversation history |
| `AGENT_PORT` | `8080` | Port the FastAPI server listens on |
| `AGENT_BEARER_TOKEN` | _(none)_ | If set, all requests must supply `Authorization: Bearer <token>` |

---

## 4. End-to-End Topology

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: Connectors                                        │
│                                                             │
│  Telegram (grammY, long poll)                               │
│  OpenAI API compat (Hono, POST /v1/chat/completions)        │
└────────────────────────┬────────────────────────────────────┘
                         │ NormalizedMessage
┌────────────────────────▼────────────────────────────────────┐
│  Layer 2: Gateway Core (TypeScript / Node.js)               │
│                                                             │
│  Turn pipeline → SessionRegistry (SQLite)                   │
│  RunSlot concurrency → HTTPHarness                          │
└────────────────────────┬────────────────────────────────────┘
                         │ POST /run  (AgentRequest JSON)
                         │ ◄────────  (AgentResponse JSON)
┌────────────────────────▼────────────────────────────────────┐
│  Layer 3: Reference Agent (Python / FastAPI)                │
│                                                             │
│  LangGraph StateGraph                                       │
│  Tools: get_current_time, calculator                        │
│  History: SQLiteChatMessageHistory (per sessionKey)         │
└─────────────────────────────────────────────────────────────┘
```

Both connectors share the same gateway core and harness process. A message from Telegram and a request from the OpenAI API compat layer go through identical pipeline stages and reach the same agent — differentiated only by `AgentRequest.platform.name` and their `sessionKey` prefix.

---

## 5. What Is Explicitly Out of Scope

| Feature | Reason deferred |
|---|---|
| Slack connector | Requires a public URL (Socket Mode needs an App-level token with specific setup); Telegram long polling is simpler for initial validation |
| MS Teams connector | CJS interop complexity; requires Azure Bot registration — deferred to v1 |
| Discord connector | Low priority relative to Telegram for initial validation |
| `POST /v1/responses` (OpenAI Responses protocol) | Streaming and stateful response objects add complexity; `/v1/chat/completions` covers the majority of clients |
| Streaming responses (`stream: true`) | Requires SSE / chunked transfer; significant added complexity in both gateway and harness |
| Media send (outbound) | Gateway receives and forwards inbound media to harness; harness returning `media[]` in response is not delivered in v0 |
| Approval flow in reference agent | Reference agent tools are safe; no approval-triggering tool is included |
| Cron and process completion turn sources | No scheduler needed for v0 validation |
| `/model`, `/voice`, `/resume`, `/title`, `/background` commands | Session and config commands are post-v0 |
| ACP server | VS Code / Zed / JetBrains integration — post-v0 |
| `sdk-py` publication to PyPI | The package exists in the monorepo; publishing is deferred until the API stabilises post-v0 |
| Multi-profile / multi-instance | Single instance only for v0 |
| Health check endpoint (`GET /healthz`) | Added in v1 before AKS/ACA deployment |

---

## 6. Acceptance Criteria

v0 is considered complete when all of the following pass:

### Gateway core

- [ ] A message sent to the Telegram bot in a DM is routed to the harness and the response is delivered back to the same chat
- [ ] A message sent to the Telegram bot in a group (with @mention) is routed correctly; a message without @mention is silently observed (not dispatched)
- [ ] A `POST /v1/chat/completions` request returns a valid OpenAI-format JSON response populated from the harness
- [ ] Sending a second message while the harness is processing the first aborts the first and queues the second
- [ ] Sending a third message while the second is pending replaces the pending item and sends the supersede notification to the user
- [ ] `/stop` aborts an active run; the user receives no response for the aborted turn
- [ ] `/new` resets the session; the next turn has `isNew: true` and `wasAutoReset: true`
- [ ] A session idle for longer than `idleTimeoutMs` sets `wasAutoReset: true` on the next turn
- [ ] Typing indicator is active during harness processing and stops when the response is delivered
- [ ] Gateway restarts Telegram long polling after a simulated network disconnect

### Reference agent

- [ ] Agent responds to a plain message with a contextually appropriate reply
- [ ] Agent correctly uses `get_current_time` tool when asked for the current time
- [ ] Agent correctly uses `calculator` tool for arithmetic
- [ ] Agent greets the user on `isNew: true` and acknowledges a reset on `wasAutoReset: true`
- [ ] Conversation history is persisted: a follow-up message referencing a prior turn is answered correctly after a gateway restart
- [ ] History is cleared when `isNew: true` (new session starts fresh)

### Error handling

- [ ] An invalid `gateway.config.yaml` causes a startup error with a clear message and exit code 1
- [ ] A harness that returns a 500 results in an error message to the user, not a silent failure
- [ ] A harness that takes longer than `harnessTimeoutMs` results in a timeout message to the user and the session slot is released
