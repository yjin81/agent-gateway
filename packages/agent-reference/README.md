# agent-reference

Reference LangGraph agent for Agent Gateway v0. Implements the `AgentAdapter` HTTP contract and is the canonical starting point for adapter authors.

## What it does

- LangGraph ReAct agent with two built-in tools: `get_current_time` and `calculator`
- Persisted conversation history per `sessionKey` (SQLite via LangChain)
- Greets on new sessions (`isNew: true`) and acknowledges idle resets (`wasAutoReset: true`)
- Exposes `POST /run` and `GET /health` via FastAPI

## Run standalone

```bash
cd packages/agent-reference
export OPENAI_API_KEY=sk-...
uv run python -m agent_reference.server
# Server starts on http://0.0.0.0:8080
```

## Run with the gateway

Configure `gateway.config.yaml` to point the `http` adapter at the agent:

```yaml
adapter:
  type: http
  url: http://localhost:8080/run
  protocol: agent-request
```

Then start both processes:

```bash
# Terminal 1 — reference agent
cd packages/agent-reference
export OPENAI_API_KEY=sk-...
uv run python -m agent_reference.server

# Terminal 2 — gateway
cd packages/gateway
node dist/index.js
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | _(required for real LLM)_ | OpenAI API key |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Override for Azure OpenAI or local models |
| `AGENT_MODEL` | `gpt-4o-mini` | Model name passed to `ChatOpenAI` |
| `AGENT_SYSTEM_PROMPT` | `"You are a helpful assistant."` | System prompt injected at conversation start |
| `AGENT_DB_PATH` | `./data/agent.db` | SQLite file for conversation history |
| `AGENT_PORT` | `8080` | Port the FastAPI server listens on |
| `AGENT_BEARER_TOKEN` | _(none)_ | If set, all requests must supply `Authorization: Bearer <token>` |

## Run tests

```bash
cd packages/agent-reference
uv sync --extra dev
uv run python -m pytest
```
