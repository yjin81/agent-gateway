# LangGraphAdapter

`LangGraphAdapter` wraps a compiled LangGraph.js `StateGraph` and runs it **in-process** inside the gateway. No separate HTTP server, no extra deployment to manage — the graph executes inside the same Node.js process as the gateway.

---

## When to use this adapter

| Situation | Recommended adapter |
|---|---|
| TypeScript agent built with LangGraph.js | **`LangGraphAdapter`** (this doc) |
| Agent running as a separate HTTP process | [`HttpAdapter`](./http.md) |
| Simple inline function, no framework | [`EmbeddedAdapter`](./embedded.md) |

---

## Installation

`@langchain/langgraph` and `@langchain/core` are peer dependencies of the gateway package. Install them alongside the gateway:

```bash
npm install @langchain/langgraph @langchain/core
```

---

## Quick start

```typescript
import { StateGraph, END } from '@langchain/langgraph'
import { ChatOpenAI } from '@langchain/openai'
import { LangGraphAdapter, GatewayStateAnnotation } from '@agent-gateway/gateway/adapter'

// 1. Build your graph using GatewayStateAnnotation as the state type.
const llm = new ChatOpenAI({ model: 'gpt-4o' })

const graph = new StateGraph(GatewayStateAnnotation)
  .addNode('agent', async (state) => {
    const response = await llm.invoke(state.messages)
    return { messages: [response] }
  })
  .addEdge('__start__', 'agent')
  .addEdge('agent', END)
  .compile()

// 2. Wrap it in LangGraphAdapter.
const adapter = new LangGraphAdapter(graph, {
  dbPath: './data/agent.db',   // optional — where to store conversation history
})

// 3. Pass to startGateway.
startGateway({ config, adapter })
```

---

## State annotation

Your graph's state must be based on `GatewayStateAnnotation` (or a superset of it). The adapter uses `MessagesAnnotation` plus gateway metadata fields:

```typescript
import { GatewayStateAnnotation } from '@agent-gateway/gateway/adapter'
import { Annotation } from '@langchain/langgraph'

// Minimal — use GatewayStateAnnotation directly.
const graph = new StateGraph(GatewayStateAnnotation)

// With extra fields — spread the spec.
const MyState = Annotation.Root({
  ...GatewayStateAnnotation.spec,
  scratchpad: Annotation<string>(),
})
const graph = new StateGraph(MyState)
```

### Fields provided by the gateway

| Field | Type | Description |
|---|---|---|
| `messages` | `BaseMessage[]` | Full conversation history loaded from SQLite, including the current `HumanMessage`. |
| `sessionKey` | `string` | Unique key identifying this user + platform + account combination. |
| `isNew` | `boolean` | `true` on the very first turn in this session. Use to greet new users. |
| `wasAutoReset` | `boolean` | `true` when the session was automatically reset (inactivity timeout). Use to acknowledge the reset. |
| `platform.name` | `string` | Connector type: `"slack"`, `"wechat"`, `"openai-api"`, etc. |
| `platform.chatKind` | `"dm" \| "group" \| "channel" \| "thread"` | Kind of chat the message arrived in. |
| `platform.userId` | `string` | Platform user ID of the sender. |
| `platform.userName` | `string` | Display name of the sender. |
| `toolPolicy` | `{ allowedTools: string[], disabledTools: string[] }` | Per-session tool policy set by the gateway operator. Your graph is responsible for enforcing this if needed. |

The gateway populates all of these before invoking the graph. You do not need to manage history loading or session state — the adapter handles it.

---

## Constructor options

```typescript
new LangGraphAdapter(graph, options?)
```

| Option | Type | Default | Description |
|---|---|---|---|
| `dbPath` | `string` | `'./data/langgraph.db'` | Path to the SQLite file where conversation history is stored. Created automatically if it does not exist. Use separate paths for separate agents. |
| `buildConfig` | `(request: AgentRequest) => Record<string, unknown>` | — | Called before each turn. Return values are merged into `RunnableConfig`. Use this to inject configurable fields (e.g. `configurable: { systemPrompt }`) into the graph without coupling the graph to the `AgentRequest` type. |

---

## Conversation history

The adapter manages conversation history automatically:

- **Load**: before each turn, all prior `HumanMessage` + `AIMessage` pairs for the session are loaded from SQLite and prepended to `state.messages`.
- **Save**: after each turn, the new human message and the last AI message text are appended to the store.
- **Clear**: when `isNew` or `wasAutoReset` is true, the session's history is wiped before the graph runs.

> **Note**: only the final AI text is stored — intermediate messages (tool calls, tool results) are not persisted. A multi-step tool loop within a single turn is collapsed to the final answer. If your agent relies on remembering which tools it called, store that context explicitly in a custom state field and handle its persistence in your graph.

---

## Streaming

If the graph uses a LangChain `ChatModel` node, the adapter automatically streams token chunks via `graph.streamEvents()`. No extra configuration is needed — the adapter implements `stream()` natively.

```
Graph node calls ChatModel.invoke()
  → LangGraph emits on_chat_model_stream events
  → LangGraphAdapter yields StreamChunk deltas to the pipeline
  → Pipeline forwards to connector (Slack edit, SSE, etc.)
```

If your graph returns `AIMessage` objects directly (without going through a `ChatModel`), no stream deltas are emitted and the pipeline receives only a final empty delta. Use `run()` path behaviour (non-streaming connectors) or restructure the node to use a `ChatModel`.

---

## Abort handling

The gateway passes an `AbortSignal` to the graph via `RunnableConfig.signal`. LangGraph's built-in nodes — `ChatModel` invocations, tool execution — honour the signal automatically and stop work when it fires.

For **custom nodes that do long-running work**, call `checkAbort(config)` at safe checkpoints:

```typescript
import { checkAbort } from '@agent-gateway/gateway/adapter'
import type { RunnableConfig } from '@langchain/core/runnables'

async function mySearchNode(state: GatewayState, config: RunnableConfig) {
  checkAbort(config)                      // check before starting
  const results = await fetchFromApi()
  checkAbort(config)                      // check after async work
  return { messages: [new AIMessage(summarise(results))] }
}
```

`checkAbort` throws `GatewayAbortError` if the signal has fired. The adapter catches it and returns `interrupted: true` to the pipeline, which silently drops the turn — no error message is sent to the user.

If you need to catch it yourself:

```typescript
import { GatewayAbortError } from '@agent-gateway/gateway/adapter'

try {
  // ... long work ...
} catch (err) {
  if (err instanceof GatewayAbortError) {
    // Clean up resources, then re-throw so the adapter can handle it.
    throw err
  }
}
```

---

## Using `buildConfig`

`buildConfig` is the recommended way to inject per-request configuration into the graph without coupling the graph to the `AgentRequest` type:

```typescript
const adapter = new LangGraphAdapter(graph, {
  buildConfig: (request) => ({
    configurable: {
      systemPrompt: request.platform.name === 'slack'
        ? 'You are a Slack assistant. Be concise.'
        : 'You are a helpful assistant.',
    },
  }),
})
```

Inside the graph, read from `config.configurable`:

```typescript
async function agentNode(state: GatewayState, config: RunnableConfig) {
  const systemPrompt = (config.configurable as { systemPrompt?: string }).systemPrompt ?? ''
  const llm = new ChatOpenAI({ model: 'gpt-4o' })
  const response = await llm.invoke([
    new SystemMessage(systemPrompt),
    ...state.messages,
  ])
  return { messages: [response] }
}
```

---

## Lifecycle

Call `adapter.close()` when shutting down the gateway to release the SQLite file lock:

```typescript
process.on('SIGTERM', async () => {
  adapter.close()
  process.exit(0)
})
```

In tests, always call `adapter.close()` in `afterEach` / `afterAll` before deleting the database file, otherwise `better-sqlite3` holds the file lock and the delete fails.

---

## Testing

Write unit tests with `FakeListChatModel` to avoid live API calls:

```typescript
import { FakeListChatModel } from '@langchain/core/utils/testing'
import { StateGraph, END } from '@langchain/langgraph'
import { LangGraphAdapter, GatewayStateAnnotation } from '@agent-gateway/gateway/adapter'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tmpDir: string
let adapter: LangGraphAdapter

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'my-agent-test-'))
  const llm = new FakeListChatModel({ responses: ['Hello!'] })
  const graph = new StateGraph(GatewayStateAnnotation)
    .addNode('agent', async (state) => ({ messages: [await llm.invoke(state.messages)] }))
    .addEdge('__start__', 'agent')
    .addEdge('agent', END)
    .compile()
  adapter = new LangGraphAdapter(graph, { dbPath: join(tmpDir, 'test.db') })
})

afterEach(() => {
  adapter.close()
  rmSync(tmpDir, { recursive: true, force: true })
})
```

---

## Exported symbols

| Symbol | Kind | Description |
|---|---|---|
| `LangGraphAdapter` | class | The adapter itself. |
| `LangGraphAdapterOptions` | interface | Constructor options. |
| `GatewayStateAnnotation` | annotation | LangGraph state annotation — spread into your graph state. |
| `GatewayState` | type | TypeScript type of the gateway state. |
| `checkAbort` | function | Throws `GatewayAbortError` if the abort signal has fired. Use in custom tool nodes. |
| `GatewayAbortError` | class | Error thrown by `checkAbort`. Caught by the adapter and converted to `interrupted: true`. |

All are re-exported from `@agent-gateway/gateway/adapter`:

```typescript
import {
  LangGraphAdapter,
  GatewayStateAnnotation,
  checkAbort,
  GatewayAbortError,
} from '@agent-gateway/gateway/adapter'
```
