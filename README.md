# Agent Gateway

A self-hostable runtime that connects any AI agent to any messaging platform. It handles all the platform infrastructure once — session routing, concurrency, typing indicators, commands, reliable delivery — so you can focus on agent logic.

Inspired by the architectural convergence of two production systems (hermes-agent and OpenClaw) that independently arrived at the same six load-bearing decisions. See [`docs/agent-gateway-design.md`](docs/agent-gateway-design.md) for the full design.

---

## How it works

```
Platform (WeChat / Telegram / OpenAI API / ...)
  → Connector        normalize raw event → NormalizedMessage
  → Core Pipeline    session · concurrency · commands · audit log
  → AgentAdapter     run(request) → response
  → Connector        deliver response back to platform
```

Three layers:

1. **Connectors** — one per platform. Translate the platform's raw events into `NormalizedMessage` and handle outbound delivery. v0 ships three: WeChat (iLink), Telegram, and an OpenAI API compatibility endpoint.

2. **Core** — platform-agnostic. Owns the 6-stage turn pipeline, session registry (SQLite WAL), serial-per-session concurrency (one turn at a time per chat), typing indicators, built-in commands, and an append-only audit log.

3. **Adapter** — the agent. Anything that implements `run(request) → response`. Built-ins: `HttpAdapter` (forward to any HTTP endpoint) and `EmbeddedAdapter` (in-process).

---

## Repository structure

```
agent-gateway/
├── packages/
│   ├── gateway/              # Runtime (TypeScript / Node.js 22)
│   │   └── src/
│   │       ├── connectors/   # wechat/, telegram/, openai-api/
│   │       ├── core/         # pipeline/, session/, commands/
│   │       ├── adapter/      # http.ts, embedded.ts, types.ts
│   │       ├── admin/        # config dashboard + hot-reload control plane
│   │       └── config/       # schema.ts, loader.ts
│   ├── sdk-ts/               # npm: @agent-gateway/sdk
│   ├── sdk-py/               # PyPI: agent-gateway-sdk
│   └── agent-reference/      # Reference LangGraph agent (Python / FastAPI)
├── docs/
│   ├── agent-gateway-design.md   # Full architecture and pipeline spec
│   ├── v0-planning.md            # v0 scope and acceptance criteria
│   ├── connectors/               # Per-connector setup guides
│   │   ├── wechat.md
│   │   ├── telegram.md
│   │   └── openai-api.md
│   └── adapters/                 # Per-adapter setup guides
│       ├── http.md
│       ├── embedded.md
│       └── reference-agent.md
├── data/                         # Runtime data (gitignored)
│   ├── .env                      # Secrets — never committed
│   └── gateway.config.yaml       # Active config
└── wechat_login.py               # WeChat iLink QR login script
```

---

## Turn pipeline

A **turn** is one inbound message processed through to response delivery. The pipeline has 6 stages — all platform-agnostic after Stage 1:

| Stage | Name | What it does |
|---|---|---|
| 1 | NORMALIZE | Connector parses raw event → `NormalizedMessage`; null → drop |
| 2 | CLASSIFY | Detect bot-loop, commands, whether the agent was addressed |
| 3 | IDENTIFY | Resolve or create `SessionRecord` for `sessionKey` |
| 4 | CONCURRENCY GATE | Serial-per-session; abort active run if new message arrives |
| 5 | DISPATCH | Build `AgentRequest`, call adapter, deliver response |
| 6 | FINALIZE | Release run slot, write audit log, drain pending queue |

---

## Prerequisites

- Node.js 22+
- pnpm 10+
- Python 3.11+ (for the reference agent or `wechat_login.py`)

---

## Setup

### 1. Install

```sh
pnpm install
```

### 2. Create the data directory

```sh
mkdir data
```

### 3. Configure the gateway

Create `data/gateway.config.yaml`. The file uses `${ENV_VAR}` interpolation — secrets are never stored in it directly.

**Minimal example — WeChat + Azure Foundry agent:**

```yaml
gateway:
  logLevel: info
  adapterTimeoutMs: 60000

http:
  port: 3000

connectors:
  - type: wechat
    accountId: wechat-personal
    token: ${WECHAT_TOKEN}
    ilinkBotId: ${WECHAT_ILINK_BOT_ID}
    baseUrl: ${WECHAT_BASE_URL}
    dmPolicy: open
    groupPolicy: disabled

adapter:
  type: http
  url: ${ADAPTER_URL}
  bearerTokenEnv: AGENT_TOKEN
  protocol: openai-responses
  model: gpt-4.1
```

**Minimal example — Telegram + reference agent:**

```yaml
connectors:
  - type: telegram
    accountId: telegram-personal
    token: ${TELEGRAM_BOT_TOKEN}

adapter:
  type: http
  url: ${ADAPTER_URL}
```

All supported config fields are documented in [`packages/gateway/src/config/schema.ts`](packages/gateway/src/config/schema.ts).

### 4. Create `data/.env`

All secrets go here. You will load this file manually into your shell before starting the gateway (Step 7).

```env
# WeChat iLink (obtain via wechat_login.py — see docs/connectors/wechat.md)
WECHAT_TOKEN=your-ilink-bot-token
WECHAT_ILINK_BOT_ID=your-ilink-bot-id@im.bot
WECHAT_BASE_URL=https://ilinkai.weixin.qq.com

# Azure Foundry / Azure OpenAI — endpoint URL (token is fetched at startup, not stored here)
AGENT_ENDPOINT=https://<resource>.services.ai.azure.com/api/projects/<project>/applications/<app>/protocols/openai/responses?api-version=2025-11-15-preview

# Telegram
TELEGRAM_BOT_TOKEN=your-telegram-bot-token

# Slack (see docs/connectors/slack.md)
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
```

**Do not put `AGENT_TOKEN` in `.env`.** It is a short-lived Azure AD JWT fetched automatically by `start-gateway.ps1` on every startup. Storing it here causes 401s when it expires between restarts.

### 5. Connector-specific setup

Each connector has its own credentials and login flow:

| Connector | Setup guide |
|---|---|
| WeChat (iLink) | [`docs/connectors/wechat.md`](docs/connectors/wechat.md) |
| Telegram | [`docs/connectors/telegram.md`](docs/connectors/telegram.md) |
| OpenAI API compat | [`docs/connectors/openai-api.md`](docs/connectors/openai-api.md) |

### 6. Start the reference agent (optional)

If you are using `HttpAdapter` pointed at the reference LangGraph agent:

```sh
cd packages/agent-reference
pip install -e ".[dev]"
python -m agent_reference.server
# Listening on http://localhost:8080
```

### 7. Start the gateway

A startup script handles env loading and token refresh automatically:

```powershell
.\start-gateway.ps1
```

What it does:
1. Loads `data/.env` into the process environment
2. Fetches a fresh `AGENT_TOKEN` from Azure AD (`az account get-access-token`) — skips gracefully if `az` is unavailable
3. Sets `GATEWAY_DATA_DIR` to the absolute path of `data/`
4. Starts `pnpm exec tsx src/index.ts` from `packages/gateway`

**Requirements**: `az` CLI installed and signed in (`az login`). Only needed for Azure Foundry/Azure OpenAI adapters.

#### Manual startup (if you prefer)

The gateway does **not** auto-load `.env`. You must load it into the shell first, then set `GATEWAY_DATA_DIR` so the gateway can locate the config file regardless of working directory.

**PowerShell:**

```powershell
# Run all of this in one shell session from the repo root
Get-Content data\.env | Where-Object { $_ -match '^[A-Z_]+=.' } | ForEach-Object {
    $parts = $_ -split '=', 2; Set-Item "env:$($parts[0])" $parts[1]
}
$env:AGENT_TOKEN = az account get-access-token --resource https://ai.azure.com --query accessToken -o tsv
$env:GATEWAY_DATA_DIR = "$PWD\data"
cd packages\gateway && pnpm exec tsx src/index.ts
```

**bash:**

```sh
set -a && source data/.env && set +a
export AGENT_TOKEN=$(az account get-access-token --resource https://ai.azure.com --query accessToken -o tsv)
export GATEWAY_DATA_DIR="$PWD/data"
cd packages/gateway && pnpm exec tsx src/index.ts
```

The gateway resolves its config from `$GATEWAY_DATA_DIR/gateway.config.yaml`. Alternatively, set `GATEWAY_CONFIG_PATH` to an absolute path to the config file directly.

---

## Running with Docker

The repo ships a multi-stage [`Dockerfile`](Dockerfile) that produces a small, self-contained runtime image (Node 22, `better-sqlite3` prebuilt) plus a [`docker-compose.yml`](docker-compose.yml) for single-host runs.

The image expects the same two inputs as a local run, both supplied through the mounted `data/` directory:

- `data/gateway.config.yaml` — your active config (gitignored; supply your own)
- `data/.env` — secrets referenced via `${VAR}` interpolation (copy from `data/.env.example`)

### Build

```sh
docker build -t agent-gateway:latest .
```

### Run

**bash / macOS / Linux:**

```sh
docker run --rm -p 3000:3000 \
  -e GATEWAY_DATA_DIR=/app/data \
  -v "$PWD/data:/app/data" \
  --env-file data/.env \
  agent-gateway:latest
```

**Windows (PowerShell):**

```powershell
docker run --rm -p 3000:3000 `
  -e GATEWAY_DATA_DIR=/app/data `
  -v "${PWD}\data:/app/data" `
  --env-file data\.env `
  agent-gateway:latest
```

The volume mount persists the SQLite session/audit DB and WeChat sync state across restarts. Port `3000` is only required for inbound webhooks (Teams, OpenAI-API compat) — Slack (Socket Mode), WeChat (long-poll) and Telegram (poll) are outbound-only.

### Docker Compose

```sh
# 1. Copy data/.env.example -> data/.env and fill in secrets
# 2. Ensure data/gateway.config.yaml exists
docker compose up --build
```

Compose wires the `data/` volume, `--env-file`, port mapping, the `/health` healthcheck, and `restart: unless-stopped` automatically.

> **Note on `AGENT_TOKEN`:** for Azure AD–backed HTTP adapters the token is a short-lived JWT and is *not* suitable for a static `.env`. Refresh it externally (sidecar/secret manager) or use a non-AAD adapter token.

---

## Configuration dashboard

The gateway includes an optional embedded web dashboard for inspecting and **hot-editing** config at runtime — no restart needed for most changes. It is **secure by default**: the entire `/admin` surface returns `404` unless an admin token is configured.

### Enable it

Set `GATEWAY_ADMIN_TOKEN` in the environment (e.g. in `data/.env`):

```env
# Enables the /admin dashboard + management API. Long, random, secret.
GATEWAY_ADMIN_TOKEN=your-long-random-admin-token

# Optional: explicit session-cookie signing secret (defaults to a value derived
# from the admin token). Set to rotate sessions independently of the token.
GATEWAY_ADMIN_SESSION_SECRET=

# Optional: set to 'false' to allow the session cookie over plain HTTP for local
# testing (default secure=true requires HTTPS).
GATEWAY_ADMIN_COOKIE_SECURE=
```

Then open `http://localhost:3000/admin` and log in with the token. The login issues a signed, HttpOnly session cookie (1h sliding expiry).

### What it does

| Tab | Capability |
|---|---|
| Overview | Boot time, version, adapter type, live connector status |
| Connectors | List connectors, view health, restart individually |
| Adapter | View current adapter, run a connectivity test, restart |
| Config | Edit the raw `gateway.config.yaml`, validate, and apply with rollback |
| Environment | View, add, edit, and delete variables in `data/.env` (takes effect on container recreate) |
| Sessions | Inspect recent active sessions |
| Audit | Recent audit-log entries, including config changes |

### Hot-reload semantics

When you apply a config change, only what actually changed is reloaded:

- **Connectors** — added / removed / changed connectors are diffed and reconciled individually (in-flight turns drain first). Unchanged connectors are untouched.
- **`http` adapter** — hot-swapped live (new turns use the new target; in-flight turns drain).
- **Adapter *type* changes** (e.g. `http` → `embedded`) or embedded-adapter changes — flagged as `requiresRestart`; apply, then restart the process.

Secrets are **redacted on read** (shown as `••••` or preserved as `${ENV}` references) and **never** leaked to the UI in plaintext. On write, unchanged masked secrets are restored automatically, so you can edit non-secret fields without re-entering credentials.

---

## Adapter interface

Anything that implements `run(request) → response` is a valid adapter.

**TypeScript:**

```ts
import type { AgentAdapter, AgentRequest, AgentResponse } from '@agent-gateway/sdk'

export class MyAgent implements AgentAdapter {
  async run(request: AgentRequest): Promise<AgentResponse> {
    // Load history for request.sessionKey, call your model, save history.
    return { text: `Echo: ${request.message}`, media: [], interrupted: false }
  }
}
```

**Python (via the SDK):**

```python
from agent_gateway import AgentAdapter, AgentRequest, AgentResponse
from fastapi import FastAPI

class MyAgent(AgentAdapter):
    async def run(self, request: AgentRequest) -> AgentResponse:
        return AgentResponse(text=f"Echo: {request.message}", media=[], interrupted=False)
```

Point `adapter.url` at your HTTP server in `gateway.config.yaml`. Done.

### AgentRequest fields

| Field | Type | Description |
|---|---|---|
| `sessionKey` | `string` | Stable routing key — use this for history storage |
| `message` | `string` | Clean user text (bot mention stripped) |
| `messageRaw` | `string` | Original unmodified platform text |
| `media` | `MediaItem[]` | Inbound attachments |
| `isNew` | `bool` | First message in this session |
| `wasAutoReset` | `bool` | Session was idle-reset since last turn |
| `platform.name` | `string` | `"wechat"` / `"telegram"` / `"openai-api"` |
| `platform.chatKind` | `string` | `"dm"` / `"group"` / `"channel"` |
| `platform.userId` | `string` | Sender's platform user ID |
| `platform.userName` | `string` | Sender's display name |
| `abortSignal` | `AbortSignal` | Check in your tool loop — user sent `/stop` |

### HttpAdapter protocols

`HttpAdapter` supports two wire formats via `protocol` in the config:

| Value | Use when |
|---|---|
| `agent-request` (default) | Pointing at an SDK-based agent server (`POST /run` → `AgentRequest` / `AgentResponse`) |
| `openai-responses` | Pointing directly at Azure Foundry / Azure OpenAI Responses API endpoint |

---

## Built-in commands

Intercepted by the gateway before reaching any agent:

| Command | What it does |
|---|---|
| `/stop` | Abort the active run |
| `/new` or `/reset` | Start a fresh session |
| `/approve` | Approve a pending agent action |
| `/deny` | Deny a pending agent action |
| `/status` | Show session state |
| `/help` | List all commands |
| `/retry` | Re-send the last user message |

---

## v0 scope

What shipped in v0:

| Layer | Component | Status |
|---|---|---|
| Connectors | WeChat (iLink) | Shipped |
| Connectors | Telegram | Shipped |
| Connectors | OpenAI API compat (`POST /v1/chat/completions`) | Shipped |
| Core | Full 6-stage turn pipeline | Shipped |
| Core | Session registry (SQLite WAL) | Shipped |
| Core | Serial-per-session concurrency | Shipped |
| Core | Typing indicators | Shipped |
| Core | `send_with_retry` + `chunk_message` | Shipped |
| Core | Approval flow (`/approve`, `/deny`) | Shipped |
| Core | Idle-timeout reset | Shipped |
| Core | Audit log | Shipped |
| Core | Graceful shutdown | Shipped |
| Core | Priority commands | Shipped |
| Adapter | `HttpAdapter` (agent-request + openai-responses protocols) | Shipped |
| Adapter | `EmbeddedAdapter` | Shipped |
| Agent | Reference LangGraph agent (`packages/agent-reference`) | Shipped |

Post-v0 (planned):

| Feature | Notes |
|---|---|
| Slack connector | Requires Socket Mode app token |
| MS Teams connector | Requires Azure Bot registration |
| Discord connector | Planned v1 |
| Streaming responses | SSE / chunked transfer |
| Multi-adapter routing | Per-connector or per-chat-type routing |
| Cron turn source | Scheduled agent turns |
| ACP server | VS Code / Zed / JetBrains integration |
| Distributed session registry | Redis / Postgres backend for multi-replica |

---

## Design docs

- [`docs/agent-gateway-design.md`](docs/agent-gateway-design.md) — full architecture, data models, pipeline spec, error handling
- [`docs/v0-planning.md`](docs/v0-planning.md) — v0 scope and acceptance criteria

### Connectors

- [`docs/connectors/wechat.md`](docs/connectors/wechat.md) — WeChat iLink: QR login, config reference, DM/group policy, token refresh
- [`docs/connectors/telegram.md`](docs/connectors/telegram.md) — Telegram: BotFather setup, poll vs. webhook, group addressing
- [`docs/connectors/openai-api.md`](docs/connectors/openai-api.md) — OpenAI API compat: session continuity, client examples, limitations

### Adapters

- [`docs/adapters/http.md`](docs/adapters/http.md) — `HttpAdapter`: both wire protocols (`agent-request` and `openai-responses`), bearer token refresh, error handling, implementing a compatible server
- [`docs/adapters/embedded.md`](docs/adapters/embedded.md) — `EmbeddedAdapter`: in-process TypeScript agents, full `AgentRequest`/`AgentResponse` field reference, `abortSignal`, approval flow
- [`docs/adapters/reference-agent.md`](docs/adapters/reference-agent.md) — Reference LangGraph agent: setup, HTTP contract, extending with tools, building your own agent
