// connectors/wechat/session-key.ts — iLink session-key derivation

/**
 * Derive a gateway session key for a WeChat iLink chat.
 *
 * Format: v1:wechat:{accountId}:{chatId}
 *
 * For DMs, chatId == the peer's iLink user ID.
 * For groups, chatId == the room_id (ends with @chatroom).
 */
export function deriveSessionKey(accountId: string, chatId: string): string {
  return `v1:wechat:${accountId}:${chatId}`
}
