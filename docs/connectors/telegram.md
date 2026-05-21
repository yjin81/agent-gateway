# Telegram Connector

The Telegram connector uses the [grammY](https://grammy.dev/) library and supports two connection modes:

- **Long polling** (default) — the gateway polls `getUpdates`. No public URL required. Ideal for development and single-instance deployments.
- **Webhook** — Telegram pushes events to an HTTPS endpoint you expose. Requires a public URL with a valid TLS certificate.

---

## Step 1 — Create a bot with BotFather

1. Open Telegram and start a chat with [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts.
3. Copy the bot token — it looks like `123456789:AAF...`.

---

## Step 2 — Add the token to `data/.env`

```env
TELEGRAM_BOT_TOKEN=123456789:AAF...
```

---

## Step 3 — Configure the connector

Add a `telegram` entry to `data/gateway.config.yaml`:

```yaml
connectors:
  - type: telegram
    accountId: telegram-personal      # logical name — unique across all connectors
    token: ${TELEGRAM_BOT_TOKEN}
    # mode: poll                      # default — no public URL needed
```

---

## Configuration reference

| Field | Type | Default | Description |
|---|---|---|---|
| `accountId` | string | required | Logical name for this account. Used in session keys (`v1:telegram:{accountId}:...`) and logs. Must be unique. |
| `token` | string | required | Telegram bot token from BotFather. Use `${TELEGRAM_BOT_TOKEN}` to load from env. |
| `mode` | `poll` \| `webhook` | `poll` | Connection mode. |
| `webhookUrl` | string | — | Required when `mode: webhook`. Must be a public HTTPS URL (e.g. `https://your-host.example.com/connectors/telegram`). |
| `idleTimeoutMs` | number | (gateway default: 3600000) | Override the gateway-level idle timeout for this connector. |

---

## Session keys

| Chat type | Formula |
|---|---|
| DM | `v1:telegram:{accountId}:{conversationId}` |
| Group / channel | `v1:telegram:{accountId}:{conversationId}:{senderId}` |

Group sessions are isolated per user so multiple people in a group each have their own independent session with the agent.

---

## Addressing

- **DM**: every message is agent-addressed — the bot always responds.
- **Group**: the bot only responds when it is @mentioned by username or when a message directly replies to one of the bot's messages.

---

## Webhook mode

For production deployments behind a load balancer or on a public server:

```yaml
connectors:
  - type: telegram
    accountId: telegram-prod
    token: ${TELEGRAM_BOT_TOKEN}
    mode: webhook
    webhookUrl: https://your-host.example.com/connectors/telegram
```

Telegram requires the webhook URL to be HTTPS with a valid certificate (self-signed is supported with manual registration). The gateway exposes the webhook endpoint automatically when `mode: webhook` is configured.

---

## Troubleshooting

**Bot does not respond in a group**

- Make sure the bot was added to the group.
- The message must @mention the bot by its username. Messages without a mention are silently observed (not dispatched) — this is by design to avoid the bot responding to every message in a busy group.

**`409 Conflict` on startup**

Another instance of the gateway is running with the same bot token and long-polling. Telegram only allows one active `getUpdates` consumer per token. Stop the other instance first.

**Token invalid (401)**

Regenerate the token with `/revoke` in BotFather, update `data/.env`, and restart the gateway.
