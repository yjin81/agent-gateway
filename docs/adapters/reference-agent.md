# Reference Agent (`packages/agent-reference`)

The reference agent is a working LangGraph ReAct agent served over FastAPI. It implements the `AgentAdapter` HTTP contract (`POST /run`) and is the canonical starting point for building your own agent.

It is designed to work out of the box with zero external dependencies beyond an OpenAI API key (or a compatible Azure OpenAI endpoint).

---

## What it does

- LangGraph `StateGraph` ReAct agent with two built-in tools:
  - **`get_current_time`** — returns the current UTC time (validates tool calling works end-to-end)
  - **`calculator`** — evaluates a safe arithmetic expression (validates multi-turn tool use and history persistence)
- Per-session conversation history persisted to SQLite via LangChain's `SQLiteChatMessageHistory`, keyed on `sessionKey`
- Clears history and starts fresh when `isNew` or `wasAutoReset` is true
- `GET /health` for liveness probes

---

## Structure

```
packages/agent-reference/
├── agent_reference/
│   ├── agent.py      # LangGraph ReAct graph, tool wiring, run_agent()
│   ├── history.py    # SQLiteChatMessageHistory wrapper keyed on sessionKey
│   ├── server.py     # FastAPI app: POST /run, GET /health
│   └── tools.py      # get_current_time, calculator
└── pyproject.toml    # dependencies: langgraph, langchain-openai, fastapi, uvicorn
```

---

## Setup

### 1. Install dependencies

```sh
cd packages/agent-reference
pip install -e ".[dev]"
```

This installs `langgraph`, `langchain-openai`, `langchain-community`, `fastapi`, `uvicorn`, and the `agent-gateway-sdk`.

### 2. Set environment variables

```env
OPENAI_API_KEY=sk-...                          # required
OPENAI_MODEL=gpt-4o-mini                       # optional, default: gpt-4o-mini
OPENAI_BASE_URL=https://api.openai.com/v1      # optional — override for Azure OpenAI
AGENT_DB_PATH=./data/agent.db                  # optional, default: ./data/agent.db
AGENT_PORT=8080                                # optional, default: 8080
```

For Azure OpenAI:

```env
OPENAI_API_KEY=your-azure-openai-key
OPENAI_BASE_URL=https://<resource>.openai.azure.com/openai/deployments/<deployment>/
OPENAI_MODEL=gpt-4o
```

### 3. Start the agent server

```sh
cd packages/agent-reference
python -m agent_reference.server
# Listening on http://0.0.0.0:8080
```

### 4. Point the gateway at it

In `data/gateway.config.yaml`:

```yaml
adapter:
  type: http
  url: http://localhost:8080/run
  protocol: agent-request
```

---

## HTTP contract

### `POST /run`

**Request body** (`AgentRequest`, snake_case JSON):

```json
{
  "session_key": "v1:telegram:telegram-personal:12345",
  "message": "What is 2 + 2?",
  "message_raw": "What is 2 + 2?",
  "media": [],
  "is_new": false,
  "was_auto_reset": false,
  "platform": {
    "name": "telegram",
    "chat_kind": "dm",
    "user_id": "12345",
    "user_name": "Alice",
    "account_id": "telegram-personal",
    "mentions": []
  },
  "tool_policy": {
    "allowed_tools": [],
    "disabled_tools": []
  }
}
```

**Response body** (`AgentResponse`, snake_case JSON):

```json
{
  "text": "2 + 2 = 4.",
  "media": [],
  "interrupted": false
}
```

**Error responses**:

| Status | When |
|---|---|
| `400` | Malformed request (Pydantic validation error) |
| `500` | Unhandled agent error |

### `GET /health`

Returns `{"status": "ok"}` — used for liveness probes.

---

## Extending the reference agent

### Add a tool

```python
# tools.py
from langchain_core.tools import tool

@tool
def my_tool(query: str) -> str:
    """Brief description — the model sees this."""
    return f"Result for: {query}"
```

Register it in `agent.py`:

```python
from .tools import get_current_time, calculator, my_tool

return create_react_agent(model, tools=[get_current_time, calculator, my_tool])
```

### Change the system prompt

Edit `SYSTEM_PROMPT` in `agent.py`. The prompt is injected at the start of every conversation.

### Use the approval flow

The reference agent does not implement the approval callback — its tools are safe. To add approval support in your own agent, call `approvalCallback` from the `AgentRequest` before executing a dangerous tool:

```python
async def run(self, request: AgentRequest) -> AgentResponse:
    decision = await request.approval_callback("This will send an email. Proceed?")
    if decision == "denied":
        return AgentResponse(text="Cancelled.", media=[], interrupted=False)
    # proceed
```

---

## Building your own agent

The reference agent is meant to be copied and extended. The key pattern:

1. Receive `AgentRequest` at `POST /run`
2. Load history for `request.session_key`
3. If `request.is_new or request.was_auto_reset` — clear history
4. Run your model with history + new message
5. Save the turn to history
6. Return `AgentResponse(text=..., media=[], interrupted=False)`

The gateway owns session routing and delivery. Your agent owns history, prompts, tools, and model calls.
