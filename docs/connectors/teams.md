# MS Teams Connector

The Teams connector integrates the gateway with Microsoft Teams via the **Azure Bot Service webhook** model. Azure Bot Service calls `POST <webhookPath>` for each inbound Activity; the gateway validates the request, normalises it, and routes it through the pipeline.

## Prerequisites

- An Azure Bot resource (or Bot Channels Registration) with:
  - **Microsoft App ID** (`appId`)
  - **Microsoft App Password** (`appPassword`)
- The bot's **Messaging endpoint** in the Azure portal set to `https://<your-host><webhookPath>` (default: `/connectors/teams`).
- The bot added to your Teams tenant (via the Teams app manifest or Azure portal).

## Configuration

```yaml
connectors:
  - type: teams
    accountId: teams-prod
    appId: ${TEAMS_APP_ID}
    appPassword: ${TEAMS_APP_PASSWORD}
    webhookPath: /connectors/teams   # default; must match the Messaging endpoint

http:
  port: 3000
```

The gateway mounts the webhook handler at `webhookPath`. The full inbound URL is:

```
https://<gateway-host><webhookPath>
```

## Authentication

JWT validation is handled automatically by the `BotFrameworkAdapter` from the `botbuilder` SDK. Every inbound request from Azure Bot Service carries an Authorization header; the adapter verifies it against Microsoft's JWKS endpoint before invoking the turn handler. Requests with an invalid token are rejected with HTTP 401 before the gateway sees them.

## Inbound message normalisation

| Teams field | NormalizedMessage field |
|---|---|
| `activity.text` (stripped of `<at>BotName</at>`) | `text` |
| `activity.text` (raw) | `textRaw` |
| `activity.from.id` | `sender.id` |
| `activity.from.name` | `sender.name` |
| `activity.conversation.id` | `chat.id` |
| `personal` conversation → `dm`, all others → `channel` | `chat.kind` |
| DM or @mention present | `routing.isAgentAddressed` |

Non-message activities (typing, reactions, etc.) are silently dropped.

## Outbound reply — two paths

### Path A: in-turn reply (preferred)

If the pipeline produces a response while the original Bot Framework turn is still executing (typical for `EmbeddedAdapter`), `send()` calls `TurnContext.sendActivity()` directly. This is the fastest path and does not require a separate outbound HTTP call to Azure Bot Service.

### Path B: proactive reply

For `HttpAdapter` (and any adapter whose response arrives after the turn ends), `send()` uses the stored `ConversationReference` and calls `BotFrameworkAdapter.continueConversation()`. This opens a new outbound connection to Azure Bot Service, which delivers the message to Teams.

Both paths are transparent to the pipeline — `send()` selects the correct path automatically.

## Streaming

`supportsStreaming` is `false`. Teams does not expose an API to edit an in-flight message (unlike Slack), so the pipeline buffers all chunks and calls `send()` once with the complete response. This is the same behaviour as the WeChat connector.

## sendTyping

`sendTyping()` dispatches an `ActivityTypes.Typing` activity via whichever path (A or B) is available. Teams displays a "…" indicator in the conversation thread while the bot is processing.

## Session keys

Session keys follow the pattern `v1:teams:<accountId>:<conversationId>`. The `conversationId` is `activity.conversation.id` from the inbound payload — unique per Teams conversation thread.

## Limits

- **Rate limiting**: Azure Bot Service applies per-conversation throttling. The gateway does not implement additional back-off for Teams; the Bot Framework SDK will surface throttle errors as exceptions from `sendActivity`.
- **Message length**: Teams renders messages up to ~28 KB. Longer responses are not automatically split by the connector — size the agent's output accordingly.
- **Proactive path requires serviceUrl**: The `ConversationReference` stored per conversation includes the `serviceUrl` from the inbound activity. This is the region-specific Bot Connector endpoint Azure uses to route outbound replies. It is captured automatically on the first inbound message.
