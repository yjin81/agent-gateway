# HttpAdapter

`HttpAdapter` forwards every agent turn to an HTTP endpoint and returns the response. It is the primary integration path for agents running in a separate process — whether that is the reference LangGraph agent, an Azure Foundry endpoint, or any custom HTTP server.

---

## Configuration

```yaml
adapter:
  type: http
  url: https://your-agent-endpoint/run
  bearerTokenEnv: AGENT_TOKEN        # optional — name of env var holding the bearer token
  protocol: agent-request            # agent-request (default) or openai-responses
  model: gpt-4o                      # required when protocol: openai-responses
```

| Field | Type | Default | Description |
|---|---|---|---|
| `type` | `"http"` | required | Must be `"http"`. |
| `url` | string (URL) | required | Full URL the adapter POSTs to on every turn. |
| `bearerTokenEnv` | string | — | Name of an env var whose value is sent as `Authorization: Bearer <value>`. The token is read at request time, so refreshing the env var (e.g. refreshing an Azure AD JWT) takes effect without restarting the gateway. |
| `protocol` | `"agent-request"` \| `"openai-responses"` | `"agent-request"` | Wire format. See below. |
| `model` | string | — | Model name sent in the request body. Required when `protocol: openai-responses`. Ignored for `agent-request`. |

---

## Protocols

### `agent-request` (default)

Use this when the URL points to an agent server built with the `agent-gateway-sdk` — including the reference LangGraph agent at `packages/agent-reference`.

**Request** — `POST <url>`:

```json
{
  "sessionKey": "v1:wechat:wechat-personal:user@im.wechat",
  "message": "What time is it?",
  "messageRaw": "What time is it?",
  "media": [],
  "isNew": false,
  "wasAutoReset": false,
  "platform": {
    "name": "wechat",
    "chatKind": "dm",
    "userId": "user@im.wechat",
    "userName": "user@im.wechat",
    "accountId": "wechat-personal",
    "mentions": []
  },
  "toolPolicy": {
    "allowedTools": [],
    "disabledTools": []
  }
}
```

Note: `abortSignal`, `progressCallback`, and `approvalCallback` are stripped before serialization — they are not serializable over HTTP.

**Response** — `200 OK`:

```json
{
  "text": "The current UTC time is 08:27.",
  "media": [],
  "interrupted": false
}
```

### `openai-responses`

Use this when the URL points directly to an Azure Foundry or Azure OpenAI **Responses API** endpoint. The adapter translates `AgentRequest` into the Responses API wire format and parses the response back into `AgentResponse`. No SDK-based agent server is needed.

**Config example** — Azure Foundry:

```yaml
adapter:
  type: http
  url: https://<resource>.services.ai.azure.com/api/projects/<project>/applications/<app>/protocols/openai/responses?api-version=2025-11-15-preview
  bearerTokenEnv: AGENT_TOKEN
  protocol: openai-responses
  model: gpt-4.1
```

**Request body sent to the endpoint**:

```json
{
  "model": "gpt-4.1",
  "input": [
    {
      "type": "message",
      "role": "system",
      "content": "Platform: wechat (dm)\nUser: Alice (id=user@im.wechat)\nSession: v1:wechat:...\nThis is the first message in this session."
    },
    {
      "type": "message",
      "role": "user",
      "content": "What can you do?"
    }
  ]
}
```

Platform context and session metadata are injected as a system message so the Foundry agent has full context even though it has no awareness of the gateway.

**Response parsing**: the adapter extracts all `output_text` blocks from `output[].content[]` across all assistant messages and joins them.

---

## Bearer token refresh

`bearerTokenEnv` is read from `process.env` at request time, not at startup. To rotate a short-lived token (e.g. an Azure AD JWT):

1. Update the env var in the shell or process environment.
2. The next request automatically picks up the new value — no restart needed.

**Azure Foundry token refresh** (PowerShell):

```powershell
$env:AGENT_TOKEN = az account get-access-token --resource https://ai.azure.com --query accessToken -o tsv
```

**Azure Foundry token refresh** (bash):

```sh
export AGENT_TOKEN=$(az account get-access-token --resource https://ai.azure.com --query accessToken -o tsv)
```

The token must be in scope for `https://ai.azure.com`. Run `az login` first if needed.

---

## Error handling

| HTTP status | Gateway behaviour |
|---|---|
| `4xx` | `AdapterError` thrown; gateway sends an error message to the user and releases the session slot. |
| `5xx` | Same as `4xx`. |
| Network failure / timeout | `AdapterError` thrown. If the gateway's `adapterTimeoutMs` is exceeded, the turn is aborted and the session slot is released. |
| Response body not valid JSON | `AdapterError` thrown. |
| `openai-responses`: no `output_text` in response | `AdapterError` thrown. |

---

## Implementing a compatible server

Any HTTP server that accepts a `POST` with the `AgentRequest` JSON body and returns `AgentResponse` JSON is compatible with `protocol: agent-request`.

**Python (FastAPI + agent-gateway-sdk):**

```python
from fastapi import FastAPI
from agent_gateway.types import AgentRequest, AgentResponse

app = FastAPI()

@app.post("/run", response_model=AgentResponse)
async def run(request: AgentRequest) -> AgentResponse:
    # request.session_key — use for history storage
    # request.message     — clean user text
    # request.is_new      — True on first message in session
    reply = f"Echo: {request.message}"
    return AgentResponse(text=reply, media=[], interrupted=False)
```

**TypeScript (Hono):**

```ts
import { Hono } from 'hono'
import type { AgentRequest, AgentResponse } from '@agent-gateway/sdk'

const app = new Hono()

app.post('/run', async (c) => {
  const req = await c.req.json<AgentRequest>()
  const response: AgentResponse = {
    text: `Echo: ${req.message}`,
    media: [],
    interrupted: false,
  }
  return c.json(response)
})
```

See [`docs/adapters/reference-agent.md`](reference-agent.md) for the full reference agent implementation.
