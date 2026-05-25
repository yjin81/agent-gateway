// connectors/slack/normalize.ts — Slack event → NormalizedMessage

import type { NormalizedMessage, MediaItem, Mention } from '../types.js'

/**
 * Slack message event fields we care about.
 * Bolt types these as `any` in many places; we narrow only what we use.
 */
export interface SlackMessageEvent {
  type: string
  subtype?: string          // 'bot_message', 'message_changed', 'message_deleted', etc.
  text?: string
  user?: string             // User ID of sender (absent for bot_message)
  bot_id?: string           // Present for bot messages
  channel: string
  channel_type?: string     // 'im' | 'mpim' | 'channel' | 'group'
  ts: string                // Message timestamp — also the message ID
  thread_ts?: string        // Present if this is a reply in a thread
  files?: SlackFile[]
  blocks?: unknown[]
}

interface SlackFile {
  id: string
  name?: string
  mimetype?: string
  url_private?: string
  duration_ms?: number
  mode?: string             // 'voice_message' for Huddled voice clips
}

/**
 * Normalize a Slack message event into a NormalizedMessage.
 * Returns null for events that should be silently dropped.
 *
 * botUserId: the bot's own Slack user ID (from auth.test), used to
 *   - detect self-messages
 *   - strip bot @mentions from text
 *   - detect isAgentAddressed in channels
 */
export function normalize(
  event: SlackMessageEvent,
  accountId: string,
  botUserId: string,
): NormalizedMessage | null {
  // Drop subtypes we don't handle: edits, deletions, joins, bot echoes, etc.
  if (event.subtype != null && event.subtype !== 'file_share') return null

  // Drop messages from bots (including our own).
  if (event.bot_id != null) return null

  const senderId = event.user
  if (!senderId) return null

  // Self-send guard (bot posting as a user — unlikely but defensive).
  const isSelf = senderId === botUserId

  const rawText = event.text ?? ''
  const isDm = event.channel_type === 'im'
  const isMpim = event.channel_type === 'mpim'  // multi-person DM
  const chatKind: 'dm' | 'group' | 'channel' =
    isDm ? 'dm' : isMpim ? 'group' : 'group'

  // Parse <@UXXXXXXX> mentions from the text, strip bot self-mention.
  const { cleanText, mentions } = parseMentionsAndStrip(rawText, botUserId)

  // isAgentAddressed:
  //   - DMs / MPDMs: always true
  //   - Channels / groups: only if the bot was @mentioned
  const isAgentAddressed = isDm || isMpim || mentions.some((m) => m.isSelf)

  const media: MediaItem[] = extractMedia(event.files ?? [])

  // Drop if no text and no media.
  if (!cleanText && media.length === 0) return null

  return {
    id: event.ts,
    sender: {
      id: senderId,
      name: senderId,   // Display name resolved in index.ts if users.info is available
      isSelf,
    },
    chat: {
      id: event.channel,
      kind: chatKind,
    },
    text: cleanText,
    textRaw: rawText,
    media,
    content: { mentions },
    routing: {
      isAgentAddressed,
      accountId,
    },
    raw: event,
  }
}

/**
 * Parse Slack `<@UXXXXXXX>` and `<@UXXXXXXX|display-name>` mention syntax.
 * Strips the bot's own mention from the clean text.
 */
function parseMentionsAndStrip(
  text: string,
  botUserId: string,
): { cleanText: string; mentions: Mention[] } {
  const mentions: Mention[] = []
  // Match <@UXXXXXXX> or <@UXXXXXXX|name>
  const mentionRe = /<@([A-Z0-9]+)(?:\|([^>]*))?>/g
  let cleanText = text

  // Collect all mentions first, then strip bot mention in a second pass.
  const found: Array<{ userId: string; name: string; isSelf: boolean; raw: string }> = []
  let match: RegExpExecArray | null
  while ((match = mentionRe.exec(text)) !== null) {
    const userId = match[1]!
    const displayName = match[2] ?? userId
    const isSelf = userId === botUserId
    found.push({ userId, name: displayName, isSelf, raw: match[0] })
    mentions.push({ userId, name: displayName, isSelf })
  }

  // Strip bot self-mention from clean text.
  for (const m of found) {
    if (m.isSelf) {
      cleanText = cleanText.replace(m.raw, '').trim()
    }
  }

  return { cleanText, mentions }
}

function extractMedia(files: SlackFile[]): MediaItem[] {
  return files.map((f): MediaItem => {
    const isVoice = f.mode === 'voice_message'
    const kind: MediaItem['kind'] =
      f.mimetype?.startsWith('image/') ? 'image' :
      f.mimetype?.startsWith('video/') ? 'video' :
      f.mimetype?.startsWith('audio/') || isVoice ? 'audio' :
      'document'
    const item: MediaItem = { kind, isVoice }
    if (f.url_private) item.url = f.url_private
    if (f.mimetype) item.mimeType = f.mimetype
    if (f.name) item.fileName = f.name
    if (f.duration_ms != null) item.durationMs = f.duration_ms
    return item
  })
}
