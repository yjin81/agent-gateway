# Slack Connector

Connects the gateway to a Slack workspace using **Socket Mode** (Bolt SDK).  
No public URL or firewall changes required — Slack pushes events to the gateway over an outbound WebSocket.

---

## 1. Create a Slack App

1. Go to https://api.slack.com/apps and click **Create New App → From scratch**.
2. Name the app (e.g. `Agent Gateway`) and pick your workspace.

---

## 2. Enable Socket Mode

1. In the left sidebar go to **Settings → Socket Mode**.
2. Toggle **Enable Socket Mode** on.
3. When prompted, create an **App-Level Token** with the `connections:write` scope.  
   Copy the token — it starts with `xapp-`. This is your `SLACK_APP_TOKEN`.

---

## 3. Subscribe to Bot Events

1. Go to **Event Subscriptions** in the sidebar.
2. Toggle **Enable Events** on.
3. Under **Subscribe to bot events**, add:
   - `message.im` — direct messages to the bot
   - `message.channels` — messages in public channels the bot joins
   - `message.groups` — messages in private channels
   - `message.mpim` — messages in multi-person DMs
4. Save changes.

---

## 4. Set OAuth Scopes

Go to **OAuth & Permissions → Scopes → Bot Token Scopes** and add:

| Scope | Purpose |
|---|---|
| `chat:write` | Post messages |
| `im:history` | Read DMs |
| `channels:history` | Read public channel messages |
| `groups:history` | Read private channel messages |
| `mpim:history` | Read multi-person DM messages |
| `users:read` | Resolve user display names (optional) |

---

## 5. Install the App

1. Go to **OAuth & Permissions** and click **Install to Workspace**.
2. Copy the **Bot User OAuth Token** (starts with `xoxb-`). This is your `SLACK_BOT_TOKEN`.

---

## 6. Get the Signing Secret

Go to **Basic Information → App Credentials** and copy the **Signing Secret**.  
This is your `SLACK_SIGNING_SECRET`.

---

## 7. Configure the Gateway

Add the three secrets to `data/.env`:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
```

Uncomment (and customise) the Slack connector block in `data/gateway.config.yaml`:

```yaml
- type: slack
  accountId: slack-workspace
  botToken: ${SLACK_BOT_TOKEN}
  appToken: ${SLACK_APP_TOKEN}
  signingSecret: ${SLACK_SIGNING_SECRET}
  dmPolicy: open            # respond to all DMs
  groupPolicy: addressedOnly  # only respond when @mentioned in channels
```

Then start the gateway as usual:

```powershell
.\start-gateway.ps1
```

You should see a log line like:

```
SlackConnector: Socket Mode connected  accountId=slack-workspace
```

---

## Session Key Formula

| Context | Session key |
|---|---|
| Direct message | `v1:slack:{accountId}:{channelId}` |
| Thread reply (any channel) | `v1:slack:{accountId}:{channelId}:{threadTs}` |
| Top-level channel / group message | `v1:slack:{accountId}:{channelId}:{userId}` |

DM channels are one-to-one so the user ID is implicit.  
Thread replies share a single session so the full thread is coherent conversation history.  
Top-level channel messages are isolated per user to avoid mixing histories.

---

## Addressing the Bot

| Channel type | When is the bot addressed? |
|---|---|
| DM (`im`) | Always |
| Multi-person DM (`mpim`) | Always |
| Channel / group | Only when `@BotName` is included in the message |

Use `groupPolicy: addressedOnly` (default for groups) to have the bot stay silent unless mentioned.
