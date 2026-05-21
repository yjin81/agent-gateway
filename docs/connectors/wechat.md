# WeChat Connector (iLink)

The WeChat connector uses Tencent's **iLink Bot API** — a private API that lets a personal WeChat account act as a bot by receiving and sending messages through an official bot proxy. This is not the WeChat Official Account API; it works with a regular personal WeChat account.

The connector uses HTTP long-polling (`POST /ilink/bot/getupdates`, 35-second server timeout) to receive messages. No public URL is required.

---

## How the iLink login works

Tencent iLink authentication works like WeChat Web login — you scan a QR code in the WeChat app to authorize the bot session. On success, iLink returns three values you store as environment variables:

| Variable | Description |
|---|---|
| `WECHAT_TOKEN` | `bot_token` — the session bearer token for all API calls |
| `WECHAT_ILINK_BOT_ID` | `ilink_bot_id` — the bot's WeChat user ID (looks like `xxxxxxxxxx@im.bot`) |
| `WECHAT_BASE_URL` | `baseurl` — region-specific iLink API endpoint |

The token does not expire on its own, but it is invalidated if you log the WeChat account into another device or if WeChat forces a re-login. Run the login script again if the gateway starts failing with 401 errors.

---

## Step 1 — Install Python dependencies

The login script requires `httpx` and `qrcode`:

```sh
pip install httpx qrcode[pil]
```

---

## Step 2 — Run the QR login script

From the repository root:

```sh
python wechat_login.py
```

The script will:
1. Request a QR code from the iLink API
2. Open the QR code image in your default image viewer (or print a terminal QR if the viewer is unavailable)
3. Poll until you scan the code and confirm in WeChat
4. Write the three credentials to `data/.env`

**Scan the QR code with the WeChat account you want the bot to run as.** This is a personal account, not an Official Account.

Sample output after successful login:

```
QR code saved to: C:\repos\agent-gateway\data\wechat_qr.png
Waiting for scan...
Confirmed. Writing credentials to data/.env
  WECHAT_TOKEN=eyJ...
  WECHAT_ILINK_BOT_ID=1f0543491855@im.bot
  WECHAT_BASE_URL=https://ilinkai.weixin.qq.com
Done.
```

---

## Step 3 — Configure the connector

Add a `wechat` entry to `data/gateway.config.yaml`:

```yaml
connectors:
  - type: wechat
    accountId: wechat-personal        # logical name — appears in session keys and logs
    token: ${WECHAT_TOKEN}
    ilinkBotId: ${WECHAT_ILINK_BOT_ID}
    baseUrl: ${WECHAT_BASE_URL}
    dmPolicy: open                    # accept DMs from anyone
    groupPolicy: disabled             # ignore group messages (default)
```

---

## Configuration reference

| Field | Type | Default | Description |
|---|---|---|---|
| `accountId` | string | required | Logical name for this account. Used in session keys (`v1:wechat:{accountId}:...`) and logs. Must be unique across all connectors. |
| `token` | string | required | iLink bearer token. Use `${WECHAT_TOKEN}` to load from env. |
| `ilinkBotId` | string | required | The bot's own iLink user ID. Used to filter out self-sent messages and to correctly classify DMs vs. group messages. Use `${WECHAT_ILINK_BOT_ID}`. |
| `baseUrl` | string | `https://ilinkai.weixin.qq.com` | Region-specific iLink endpoint. Use `${WECHAT_BASE_URL}` to load from the login response. |
| `cdnBaseUrl` | string | `https://novac2c.cdn.weixin.qq.com/c2c` | WeChat CDN endpoint for encrypted media. The default works for most regions. |
| `dmPolicy` | `open` \| `allowlist` \| `disabled` | `open` | Controls which DMs the bot responds to. |
| `groupPolicy` | `open` \| `disabled` | `disabled` | Controls whether the bot responds in group chats where it is @mentioned. |
| `allowFrom` | string | — | Comma-separated iLink user IDs. Only used when `dmPolicy` or `groupPolicy` is `allowlist`. |
| `chunkDelayMs` | number | `350` | Delay in ms between sequential message chunks when a response is split (rate limit mitigation). |
| `idleTimeoutMs` | number | (gateway default: 3600000) | Override the gateway-level idle timeout for this connector. |

---

## DM policy

| `dmPolicy` value | Behaviour |
|---|---|
| `open` | The bot replies to DMs from anyone. |
| `allowlist` | The bot only replies to users listed in `allowFrom` (comma-separated iLink user IDs). |
| `disabled` | The bot ignores all DMs. |

---

## Group policy

| `groupPolicy` value | Behaviour |
|---|---|
| `open` | The bot replies in group chats when it is @mentioned. |
| `disabled` | The bot ignores all group messages (default). |

---

## Session keys

Session keys for this connector follow the formula:

| Chat type | Formula |
|---|---|
| DM | `v1:wechat:{accountId}:{fromUserId}` |
| Group | `v1:wechat:{accountId}:{roomId}:{fromUserId}` |

The `fromUserId` is the sender's iLink user ID. Group chats are isolated per user, not per room, so each group participant has their own session.

---

## Token refresh

If the gateway starts logging poll errors with HTTP 401 or the WeChat account is forcibly logged out:

1. Stop the gateway.
2. Run `python wechat_login.py` again to obtain a new token.
3. The new credentials are written to `data/.env`.
4. Restart the gateway.

For Azure Foundry `AGENT_TOKEN` refresh (Azure AD JWT), see the adapter config section in the root README.

---

## Troubleshooting

**Messages are received (`msgCount:1` in logs) but no pipeline logs follow**

The message was dropped at policy or normalization. Check:
- `dmPolicy` is not `disabled` for a DM
- `groupPolicy` is `open` for a group message
- `ilinkBotId` in the config matches the `WECHAT_ILINK_BOT_ID` value exactly (including the `@im.bot` suffix)

**Poll loop stops with connection errors**

The gateway will retry with exponential backoff. If it does not recover, check that `WECHAT_TOKEN` and `WECHAT_BASE_URL` are set correctly in `data/.env`.

**`guessChatKind` classification**

The connector classifies a message as a DM when `to_user_id` matches `ilinkBotId`. If `ilinkBotId` is wrong, every DM is misclassified as a group message and dropped (if `groupPolicy: disabled`). This was a known bug fixed after v0 — ensure `ilinkBotId` is set from the login response, not hardcoded.
