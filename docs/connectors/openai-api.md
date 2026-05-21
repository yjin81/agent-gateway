# OpenAI API Compatibility Connector

The OpenAI API compat connector exposes a `POST /v1/chat/completions` endpoint on the gateway's HTTP server. Any client that speaks the OpenAI chat completions protocol — the Python `openai` library, the TypeScript `openai` package, `curl`, or tools like LangChain — can talk to the gateway without a messaging app.

This is the primary developer testing surface for v0. It lets you exercise the full pipeline (session routing, commands, concurrency, adapter call) from any HTTP client.

---

## No external setup required

Unlike platform connectors, the OpenAI API compat connector needs no external credentials or login flow. It is always-on when configured. An optional bearer token can be set to restrict access.

---

## Step 1 — Configure the connector

Add an `openai-api` entry to `data/gateway.config.yaml`:

```yaml
connectors:
  - type: openai-api
    accountId: openai-api-local
    # bearerToken: ${OPENAI_API_COMPAT_TOKEN}  # optional — restrict access
```

The gateway's HTTP server listens on the port configured under `http.port` (default `3000`). The connector registers itself at `/v1` by default, so the full endpoint is:

```
POST http://localhost:3000/v1/chat/completions
```

---

## Configuration reference

| Field | Type | Default | Description |
|---|---|---|---|
| `accountId` | string | required | Logical name. Used in session keys (`v1:openai-api:{accountId}:...`) and logs. Must be unique. |
| `listenPath` | string | `/v1` | Base path under which `POST /chat/completions` is registered. |
| `bearerToken` | string | — | If set, all requests must include `Authorization: Bearer <token>`. |
| `idleTimeoutMs` | number | (gateway default: 3600000) | Override the gateway-level idle timeout for this connector. |

---

## Session continuity

The OpenAI `POST /v1/chat/completions` protocol is stateless — clients send the full message history in every request. The connector extracts the last `user` message as `AgentRequest.message` and ignores the prior history (which belongs to the adapter).

To maintain a persistent session across requests, pass a stable session ID in the custom request header:

```
X-Session-Id: my-session-abc123
```

Without this header, every request gets a fresh session (a new random UUID). This matches the default behaviour of the OpenAI API itself.

---

## Usage examples

### curl

```sh
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "What time is it?"}]
  }'
```

With a persistent session:

```sh
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: dev-session-1" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Remember my name is Alice."}]
  }'
```

### Python openai client

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="unused",  # required by the client but not validated by the gateway unless bearerToken is set
)

response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "What can you do?"}],
    extra_headers={"X-Session-Id": "dev-session-1"},
)
print(response.choices[0].message.content)
```

### TypeScript openai client

```ts
import OpenAI from 'openai'

const client = new OpenAI({
  baseURL: 'http://localhost:3000/v1',
  apiKey: 'unused',
})

const response = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'What can you do?' }],
  // @ts-expect-error custom header
  headers: { 'X-Session-Id': 'dev-session-1' },
})
console.log(response.choices[0].message.content)
```

---

## Response format

The connector returns a standard non-streaming OpenAI response:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Agent reply here"
      },
      "finish_reason": "stop"
    }
  ]
}
```

Streaming (`stream: true`) is not supported in v0.

---

## Limitations

- Streaming responses are not supported (v0). The response is returned in one JSON body after the adapter call completes.
- The `model` field in the request is passed to the adapter via `platform.name` but does not select a model — model selection is the adapter's responsibility.
- Full message history in the request body is not forwarded to the adapter. The adapter manages its own history keyed on `sessionKey`.
