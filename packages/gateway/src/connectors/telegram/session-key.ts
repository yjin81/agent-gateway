// connectors/telegram/session-key.ts — deriveSessionKey for Telegram chat types

/**
 * Derives a stable session key from Telegram message facts.
 * Format: v1:telegram:{accountId}:{chatId}
 *
 * All Telegram chat types (DM, group, supergroup, channel) use the chat.id
 * as the routing primitive. Groups are per-group (not per-user), which is
 * intentional — the group is one session so the bot responds coherently
 * to the whole conversation.
 *
 * Version prefix `v1:` allows future migration via
 * `gateway migrate-sessions --connector telegram --from v1 --to v2`.
 */
export function deriveSessionKey(accountId: string, chatId: number | string): string {
  return `v1:telegram:${accountId}:${chatId}`
}
