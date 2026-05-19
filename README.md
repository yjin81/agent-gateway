# Agent Gateway

A personal experiment. The goal: run any AI agent on any messaging platform without rewriting platform glue each time, and make it easy for multiple agents to work together as a team.

---

## Why

Building agents is interesting. Wiring them to different platforms, testing them in a chat UI, comparing how different frameworks feel end-to-end — that's where most of the iteration time goes, and most of it is boilerplate.

This gateway handles the platform layer once. An agent just implements one interface (`AgentHarness`) and gets connected to whatever platform is configured. Swap the agent, keep the platform. Swap the platform, keep the agent. This idea is inspired by OpenClaw and Hermes Agent infra.

The second motivation is multi-agent teams. Because every agent in the gateway gets a stable session key and a shared message bus, one agent can invoke another by sending a message to its session. No special orchestration framework needed — agents coordinate through the same turn pipeline used for human messages.

---

## How it works

```
User (Telegram / OpenAI API / ...) 
  → Connector (normalize message)
  → Core Pipeline (session, concurrency, commands)
  → AgentHarness.run(request)
  → Response delivered back to user
```

Three layers:

1. **Connectors** — one per platform. Each converts the platform's raw events into a `NormalizedMessage` and handles outbound delivery. v0 has Telegram and an OpenAI API compatibility endpoint.

2. **Core** — platform-agnostic. Owns session routing, serial-per-session execution (one turn at a time per chat), typing indicators, built-in commands (`/stop`, `/new`, `/approve`, `/deny`, etc.), and the audit log.

3. **Harness** — the agent. Anything that implements `run(request) → response` works. The gateway ships two built-ins: `HTTPHarness` (forward to any HTTP endpoint) and `EmbeddedHarness` (in-process). The reference agent in this repo is a LangGraph ReAct agent served over FastAPI.

---

## Structure

```
agent-gateway/
├── packages/
│   ├── gateway/          # Runtime (TypeScript / Node.js 22)
│   ├── sdk-ts/           # npm: @agent-gateway/sdk
│   ├── sdk-py/           # PyPI: agent-gateway-sdk
│   └── agent-reference/  # Reference LangGraph agent (Python / FastAPI)
├── docs/
│   ├── agent-gateway-design.md   # Full design spec
│   └── v0-planning.md            # v0 scope and acceptance criteria
└── pnpm-workspace.yaml
```

---

## Quickstart

### Prerequisites

- Node.js 22+
- pnpm 10+
- Python 3.11+ (for the reference agent)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- An OpenAI API key

### 1. Install

```sh
pnpm install
```

### 2. Configure

```sh
mkdir -p data
cp docs/gateway.config.example.yaml data/gateway.config.yaml
```

Edit `data/gateway.config.yaml` — it references secrets via `${ENV_VAR}` interpolation, never stores them directly.

Create `data/.env`:

```env
TELEGRAM_BOT_TOKEN=your-bot-token
OPENAI_API_KEY=your-openai-key
```

### 3. Start the reference agent

```sh
cd packages/agent-reference
pip install -e ".[dev]"
python -m agent_reference.server
# Listening on http://localhost:8080
```

### 4. Start the gateway

```sh
cd packages/gateway
pnpm dev
```

Send your bot a message on Telegram. The reference agent (LangGraph ReAct with `get_current_time` and `calculator` tools) responds.

---

## Implementing your own agent

Implement the `AgentHarness` interface. Python example using the SDK:

```python
from agent_gateway import AgentHarness, AgentRequest, AgentResponse
from fastapi import FastAPI

class MyAgent(AgentHarness):
    async def run(self, request: AgentRequest) -> AgentResponse:
        # Load history, call your model, save history — all yours.
        reply = f"Echo: {request.message}"
        return AgentResponse(text=reply, media=[], interrupted=False)
```

Serve it on any port, point `harness.url` at it in the config, done.

TypeScript SDK:

```ts
import type { AgentHarness, AgentRequest, AgentResponse } from '@agent-gateway/sdk'

export class MyAgent implements AgentHarness {
  async run(request: AgentRequest): Promise<AgentResponse> {
    return { text: `Echo: ${request.message}`, media: [], interrupted: false }
  }
}
```

---

## Multi-agent teams

Each agent in the gateway has a stable `sessionKey`. An agent can invoke another by calling the gateway's OpenAI API compat endpoint with the target agent's session ID in `X-Session-Id`. The same pipeline — session isolation, concurrency control, command handling — applies to agent-to-agent turns exactly as it does to human-to-agent turns.

No special orchestration layer. Agents are just callers.

---

## Built-in commands

These are intercepted by the gateway before reaching any agent:

| Command | What it does |
|---|---|
| `/stop` | Abort the current turn |
| `/new` or `/reset` | Start a fresh session (agent clears its history) |
| `/approve` | Approve a pending agent action |
| `/deny` | Deny a pending agent action |
| `/status` | Show session state |
| `/help` | List all commands |

---

## v0 scope

| In scope | Out of scope (v1+) |
|---|---|
| Telegram connector | Slack, Discord, Teams |
| OpenAI API compat endpoint | Streaming responses |
| HTTPHarness + EmbeddedHarness | Multi-harness routing |
| Serial-per-session execution | Distributed / multi-instance |
| Approval flow | Rich media delivery |
| Python + TypeScript SDKs | Automated SDK code-gen |

---

## Design docs

- [`docs/agent-gateway-design.md`](docs/agent-gateway-design.md) — full architecture, data models, pipeline spec, error handling strategy
- [`docs/v0-planning.md`](docs/v0-planning.md) — v0 scope, acceptance criteria, reference agent spec
