// connectors/slack/session-key.ts — session key formula for Slack

/**
 * Session key formula for Slack:
 *
 * DM / direct message:
 *   v1:slack:{accountId}:{channelId}
 *   One session per DM channel (each user has a unique DM channel with the bot).
 *
 * Channel / group DM — top-level message:
 *   v1:slack:{accountId}:{channelId}:{userId}
 *   Isolated per user within the channel so multiple people do not share history.
 *
 * Channel / group DM — thread reply:
 *   v1:slack:{accountId}:{channelId}:{threadTs}
 *   Thread timestamp is unique per thread; all participants in a thread share one session,
 *   matching the Slack mental model where a thread is a coherent conversation unit.
 */
export function deriveSessionKey(
  accountId: string,
  channelId: string,
  userId: string,
  threadTs: string | undefined,
  isDm: boolean,
): string {
  if (isDm) {
    // Each DM channel belongs to one user — no need to include userId.
    return `v1:slack:${accountId}:${channelId}`
  }
  if (threadTs != null) {
    // Thread reply — isolate by thread, not by user.
    return `v1:slack:${accountId}:${channelId}:${threadTs}`
  }
  // Top-level channel message — isolate by user.
  return `v1:slack:${accountId}:${channelId}:${userId}`
}
