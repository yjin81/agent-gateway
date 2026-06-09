# HttpAdapter

`HttpAdapter` forwards every agent turn to an HTTP endpoint and returns the response. It is the primary integration path for agents running in a separate process — whether that is the reference LangGraph agent, an Azure Foundry endpoint, or any custom HTTP server.

---

## Configuration

```yaml
adapter:
  type: http
  url: https://your-agent-endpoint/run
  bearerTokenEnv: AGENT_TOKEN        # optional — name of env var holding the bearer token
  apiKeyEnv: AGENT_API_KEY           # optional — name of env var holding an API key (Azure key auth)
  apiKeyHeader: api-key              # optional — header for the API key (default: api-key)
  protocol: agent-request            # agent-request (default) or openai-responses
  model: gpt-4o                      # required when protocol: openai-responses
```

| Field | Type | Default | Description |
|---|---|---|---|
| `type` | `"http"` | required | Must be `"http"`. |
| `url` | string (URL) | required | Full URL the adapter POSTs to on every turn. |
| `bearerTokenEnv` | string | — | Name of an env var whose value is sent as `Authorization: Bearer <value>`. The token is read at request time, so refreshing the env var (e.g. refreshing an Azure AD JWT) takes effect without restarting the gateway. |
| `apiKeyEnv` | string | — | Name of an env var whose value is sent as the `apiKeyHeader` header. Use for Azure OpenAI / Foundry **key** auth (a long-lived key) instead of a short-lived AAD bearer token. Read at request time, like `bearerTokenEnv`. If both are set, both headers are sent. Empty/unset values send no header. |
| `apiKeyHeader` | string | `api-key` | Header name used to send `apiKeyEnv`'s value. Defaults to `api-key` (Azure convention); use `x-api-key` for Anthropic-style endpoints. |
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

### `openai-responses` — streaming (SSE)

When the adapter's `stream()` method is called by the pipeline (i.e. the connector supports streaming), `HttpAdapter` sends `stream: true` to the Foundry endpoint and consumes the response as a `text/event-stream`.

**Additional request fields sent when streaming:**

```json
{
  "model": "gpt-4.1",
  "input": [ ... ],
  "stream": true
}
```

**SSE events consumed:**

| Event type | Action |
|---|---|
| `response.output_text.delta` | Yield `{ delta, done: false }` |
| `response.completed` | Yield `{ delta: '', done: true, interrupted: false }` and stop |
| `response.incomplete` | Yield `{ delta: '', done: true, interrupted: true }` and stop |
| `response.failed` | Throw `AdapterError` with the error message from the response |
| `[DONE]` sentinel | Yield final done chunk and stop |
| Any other event type | Silently skipped |

No config change is needed to activate streaming — it is used automatically when the connector declares `supportsStreaming: true` (e.g. the Slack connector). The non-streaming `run()` path is used for connectors that buffer (e.g. WeChat).

> **Foundry note:** Not all Foundry agent types support `stream: true`. If the endpoint returns a non-SSE error response, the pipeline catches it as an `AdapterError` and sends an error message to the user. Check your Foundry application's API documentation to confirm streaming is supported.

---

## Bearer token management

Short-lived tokens like Azure AD JWTs must **not** be stored in `data/.env`. They expire (typically within 1 hour) and stale values in `.env` cause hard-to-diagnose 401s — the config interpolation `${AGENT_TOKEN}` would bake the expired value into the config at startup.

The correct split:

| Where | What goes there |
|---|---|
| `data/.env` | Long-lived secrets: `WECHAT_TOKEN`, bot tokens, API keys, `AGENT_ENDPOINT` |
| `start-gateway.ps1` | Short-lived tokens fetched fresh on every startup |

`start-gateway.ps1` fetches `AGENT_TOKEN` via `az account get-access-token` before starting the gateway and fails fast if the fetch fails — so the gateway never starts with a missing or expired token.

`bearerTokenEnv` is read from `process.env` at request time (not at startup), so the token value seen by the gateway is whatever was set in the process environment when `start-gateway.ps1` launched it.

**`bearerTokenEnv` must be set to the name of the env var, not its value:**

```yaml
# Correct — the gateway looks up process.env['AGENT_TOKEN'] at request time
bearerTokenEnv: AGENT_TOKEN

# Wrong — config interpolation bakes the JWT string into bearerTokenEnv,
# then process.env['eyJ0eX...'] returns undefined → empty bearer → 401
bearerTokenEnv: ${AGENT_TOKEN}
```

To manually refresh mid-session, restart the gateway via `.\start-gateway.ps1` — it always fetches a fresh token. The token expiry time is printed at startup so you know when the next restart is needed.

---

## Error handling

| HTTP status | Gateway behaviour |
|---|---|
| `4xx` | `AdapterError` thrown; gateway sends an error message to the user and releases the session slot. |
| `5xx` | Same as `4xx`. |
| Network failure / timeout | `AdapterError` thrown. If the gateway's `adapterTimeoutMs` is exceeded, the turn is aborted and the session slot is released. |
| Response body not valid JSON | `AdapterError` thrown. |
| `openai-responses`: no `output_text` in response | `AdapterError` thrown. |
| `openai-responses` SSE: `response.failed` event | `AdapterError` thrown with the upstream error message. |
| `openai-responses` SSE: response body missing | `AdapterError` thrown. |

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
