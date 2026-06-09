# EmbeddedAdapter

`EmbeddedAdapter` runs the agent in the same Node.js process as the gateway. There is no HTTP hop — the gateway calls `agent.run(request)` directly.

Use this when:
- Your agent is written in TypeScript/JavaScript and you want a single process deployment.
- You are writing tests that need to exercise the full gateway pipeline without spinning up a separate server.
- You want to prototype an agent quickly without setting up an HTTP server.

For Python agents, use [`HttpAdapter`](http.md) pointed at a FastAPI process instead — Node.js cannot run Python in-process.

---

## How it works

`EmbeddedAdapter` is a thin wrapper. It holds a reference to any object that implements `AgentAdapter` and delegates `run()`, `stream()`, and `onSessionReset()` to it:

```ts
export class EmbeddedAdapter implements AgentAdapter {
  stream?: (request: AgentRequest) => AsyncIterable<StreamChunk>

  constructor(private readonly inner: AgentAdapter) {
    // Only expose stream() if the inner adapter implements it.
    if (inner.stream != null) {
      this.stream = (request) => inner.stream!(request)
    }
  }

  run(request: AgentRequest): Promise<AgentResponse> {
    return this.inner.run(request)
  }

  async onSessionReset(sessionKey: string): Promise<void> {
    await this.inner.onSessionReset?.(sessionKey)
  }
}
```

`stream()` is only present on the `EmbeddedAdapter` instance when the inner adapter implements it. The pipeline checks `adapter.stream != null` before taking the streaming path — so if the inner adapter has no `stream()` method, behaviour is identical to v0 (single `run()` call, complete response delivered at once).

The gateway calls `adapter.run()` or `adapter.stream()` depending on whether the connector supports streaming — whether that adapter is `HttpAdapter`, `EmbeddedAdapter`, or any custom implementation makes no difference to the pipeline.

---

## Setup

### 1. Implement `AgentAdapter`

```ts
// my-agent.ts
import type { AgentAdapter, AgentRequest, AgentResponse } from '@agent-gateway/sdk'

export class MyAgent implements AgentAdapter {
  private history = new Map<string, string[]>()

  async run(request: AgentRequest): Promise<AgentResponse> {
    if (request.isNew || request.wasAutoReset) {
      this.history.delete(request.sessionKey)
    }

    const past = this.history.get(request.sessionKey) ?? []
    past.push(request.message)
    this.history.set(request.sessionKey, past)

    const text = `You said: "${request.message}". Turn ${past.length} in this session.`
    return { text, media: [], interrupted: false }
  }

  async onSessionReset(sessionKey: string): Promise<void> {
    this.history.delete(sessionKey)
  }
}
```

### 2. Configure the gateway

In `data/gateway.config.yaml`:

```yaml
adapter:
  type: embedded
  module: ./my-agent.js      # path to the compiled JS module, relative to the gateway package
```

The `module` field is resolved by the gateway at startup and must export a class or factory that implements `AgentAdapter`. The exact loading convention depends on how the gateway's `EmbeddedAdapter` factory is wired in `index.ts` for your project.

Alternatively, instantiate `EmbeddedAdapter` directly in code and pass it to `GatewayRunner`:

```ts
import { GatewayRunner } from './packages/gateway/src/index.js'
import { EmbeddedAdapter } from './packages/gateway/src/adapter/embedded.js'
import { MyAgent } from './my-agent.js'

const runner = new GatewayRunner({
  configPath: 'data/gateway.config.yaml',
  adapter: new EmbeddedAdapter(new MyAgent()),
})
await runner.start()
```

---

## `AgentAdapter` interface

```ts
interface AgentAdapter {
  run(request: AgentRequest): Promise<AgentResponse>

  /**
   * Optional streaming path. When present, the pipeline calls stream() in
   * preference to run() and routes chunks to the connector.
   * The iterable must yield one or more chunks with done: false, then exactly
   * one final chunk with done: true. It must honour request.abortSignal.
   */
  stream?(request: AgentRequest): AsyncIterable<StreamChunk>

  // Optional — called when wasAutoReset = true
  onSessionReset?(sessionKey: string): Promise<void>
}
```

### `StreamChunk`

| Field | Type | Description |
|---|---|---|
| `delta` | `string` | Token text to append to the accumulated response. May be empty on the final chunk. |
| `done` | `boolean` | True on the last chunk — no further chunks will follow. |
| `interrupted` | `boolean?` | Populated only on the final chunk. True if `abortSignal` fired mid-stream. |
| `media` | `MediaItem[]?` | Media attachments. Populated only on the final chunk. |

### `AgentRequest`

| Field | Type | Description |
|---|---|---|
| `sessionKey` | `string` | Stable routing key. Use as the key for all history/state storage. |
| `message` | `string` | Clean user text — bot mention stripped, platform syntax removed. |
| `messageRaw` | `string` | Original unmodified platform text. |
| `media` | `MediaItem[]` | Inbound attachments. |
| `isNew` | `boolean` | True on the first message in this session. |
| `wasAutoReset` | `boolean` | True if the session was reset due to idle timeout since the last turn. |
| `platform.name` | `string` | Connector type: `"wechat"`, `"telegram"`, `"openai-api"`. |
| `platform.chatKind` | `"dm" \| "group" \| "channel" \| "thread"` | Chat type. |
| `platform.userId` | `string` | Sender's platform user ID. |
| `platform.userName` | `string` | Sender's display name. |
| `platform.accountId` | `string` | Which connector account received the message. |
| `platform.mentions` | `Mention[]` | Other users mentioned in the message. |
| `toolPolicy.allowedTools` | `string[]` | Allowlist (empty = all allowed). |
| `toolPolicy.disabledTools` | `string[]` | Blocklist. |
| `abortSignal` | `AbortSignal` | Fires when the user sends `/stop` or a newer message supersedes this turn. Check this in any tool loop. |
| `progressCallback` | `(toolName, preview) => void` | Call during tool execution for live progress display. Must not throw. |
| `approvalCallback` | `(prompt) => Promise<'approved' \| 'denied'>` | Call before executing a dangerous tool. The gateway suspends the turn and waits for the user to send `/approve` or `/deny`. |

### `AgentResponse`

| Field | Type | Description |
|---|---|---|
| `text` | `string` | Response text. Plain text or CommonMark. No platform-specific syntax. |
| `media` | `MediaItem[]` | Media items to deliver. Gateway routes by `kind`. |
| `interrupted` | `boolean` | Set to `true` if `abortSignal` fired and the turn was cut short. |

---

## Honouring `abortSignal`

If a user sends a new message while the agent is running, or sends `/stop`, `abortSignal` fires. A well-behaved adapter checks this between expensive steps:

```ts
async run(request: AgentRequest): Promise<AgentResponse> {
  for (const step of steps) {
    if (request.abortSignal.aborted) {
      return { text: '', media: [], interrupted: true }
    }
    await executeStep(step)
  }
  // ...
}
```

---

## Using the approval flow

```ts
async run(request: AgentRequest): Promise<AgentResponse> {
  const decision = await request.approvalCallback(
    'This will delete all files in /tmp. Proceed?'
  )
  if (decision === 'denied') {
    return { text: 'Action cancelled.', media: [], interrupted: false }
  }
  // proceed with dangerous action
}
```

The gateway sends the prompt to the platform chat, pauses the typing indicator, and waits for `/approve` or `/deny`. The `approvalCallback` resolves to `'denied'` if the user does not respond within `approvalTimeoutMs` (default 5 minutes).

---

## Implementing `stream()` for progressive delivery

If the connector supports streaming (e.g. Slack), implement `stream()` on your inner agent to deliver tokens as they are generated:

```ts
import type { AgentAdapter, AgentRequest, AgentResponse, StreamChunk } from '@agent-gateway/sdk'

export class MyStreamingAgent implements AgentAdapter {
  async run(request: AgentRequest): Promise<AgentResponse> {
    // Fallback — assembles the full response when the connector does not stream.
    const chunks: string[] = []
    for await (const chunk of this.stream(request)) {
      chunks.push(chunk.delta)
      if (chunk.done) break
    }
    return { text: chunks.join(''), media: [], interrupted: false }
  }

  async *stream(request: AgentRequest): AsyncIterable<StreamChunk> {
    const tokens = await generateTokens(request.message)  // your LLM call
    for (const token of tokens) {
      if (request.abortSignal.aborted) {
        yield { delta: '', done: true, interrupted: true, media: [] }
        return
      }
      yield { delta: token, done: false }
    }
    yield { delta: '', done: true, interrupted: false, media: [] }
  }
}
```

Rules for `stream()` implementors:

- Yield one or more chunks with `done: false`, then **exactly one** final chunk with `done: true`.
- Set `interrupted: true` on the final chunk if `abortSignal` fired.
- Populate `media` only on the final chunk.
- Never throw after the first chunk — yield a `done: true` chunk instead.

When `stream()` is not implemented, `EmbeddedAdapter` does not expose the method and the pipeline uses `run()` instead — no streaming, identical to v0.
