// connectors/telegram/normalize.ts — grammY Update → NormalizedMessage

import type { Context } from 'grammy'
import type { NormalizedMessage, MediaItem, Mention } from '../types.js'

/**
 * Normalize a grammY context to NormalizedMessage.
 * Returns null for updates that should be silently dropped
 * (e.g. edited messages, inline queries, callback queries).
 */
export function normalize(ctx: Context, accountId: string, botId: number): NormalizedMessage | null {
  const msg = ctx.message ?? ctx.channelPost
  if (msg == null) return null

  const text = msg.text ?? msg.caption ?? ''
  const senderId = msg.from?.id ?? msg.sender_chat?.id
  if (senderId == null) return null

  const senderName =
    msg.from != null
      ? [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ')
      : (msg.sender_chat?.title ?? String(senderId))

  const isSelf = msg.from?.id === botId || msg.sender_chat?.id === botId

  const chatKind = resolveChatKind(msg.chat.type)

  // Extract mentions and strip bot mention from text.
  const { cleanText, mentions } = parseMentionsAndStrip(text, msg.entities ?? [], botId)

  const isAgentAddressed =
    chatKind === 'dm' || // DMs are always addressed to the bot.
    mentions.some((m) => m.isSelf) ||
    msg.reply_to_message?.from?.id === botId

  const media: MediaItem[] = extractMedia(msg)

  return {
    id: String(msg.message_id),
    sender: {
      id: String(senderId),
      name: senderName,
      isSelf,
    },
    chat: {
      id: String(msg.chat.id),
      kind: chatKind,
    },
    text: cleanText,
    textRaw: text,
    media,
    content: { mentions },
    routing: {
      isAgentAddressed,
      accountId,
    },
    raw: msg,
  } satisfies NormalizedMessage & { sessionKey?: string }
}

function resolveChatKind(type: string): 'dm' | 'group' | 'channel' | 'thread' {
  switch (type) {
    case 'private': return 'dm'
    case 'group':
    case 'supergroup': return 'group'
    case 'channel': return 'channel'
    default: return 'group'
  }
}

function parseMentionsAndStrip(
  text: string,
  entities: Array<{ type: string; offset: number; length: number; user?: { id: number; first_name: string; last_name?: string } }>,
  botId: number,
): { cleanText: string; mentions: Mention[] } {
  const mentions: Mention[] = []
  // Sort entities in reverse order so we can splice without shifting offsets.
  const sorted = [...entities].sort((a, b) => b.offset - a.offset)

  let result = text
  for (const entity of sorted) {
    if (entity.type === 'mention') {
      const mention = text.slice(entity.offset, entity.offset + entity.length)
      // @username mention — we don't have a user ID here easily; treat as opaque.
      mentions.push({ userId: mention, name: mention, isSelf: false })
    } else if (entity.type === 'text_mention' && entity.user != null) {
      const name = [entity.user.first_name, entity.user.last_name].filter(Boolean).join(' ')
      const isSelf = entity.user.id === botId
      mentions.push({ userId: String(entity.user.id), name, isSelf })
      if (isSelf) {
        // Remove bot mention from text.
        result = result.slice(0, entity.offset) + result.slice(entity.offset + entity.length)
      }
    }
  }

  return { cleanText: result.trim(), mentions }
}

function extractMedia(
  msg: {
    photo?: Array<{ file_id: string }>
    audio?: { file_id: string; duration: number; mime_type?: string; file_name?: string }
    voice?: { file_id: string; duration: number; mime_type?: string }
    video?: { file_id: string; duration: number; mime_type?: string; file_name?: string }
    document?: { file_id: string; mime_type?: string; file_name?: string }
    sticker?: { file_id: string }
  },
): MediaItem[] {
  const media: MediaItem[] = []

  if (msg.photo != null && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1]!
    media.push({ kind: 'image', url: `tg://file/${largest.file_id}`, isVoice: false })
  }
  if (msg.audio != null) {
    const item: MediaItem = { kind: 'audio', url: `tg://file/${msg.audio.file_id}`, durationMs: msg.audio.duration * 1000, isVoice: false }
    if (msg.audio.mime_type != null) item.mimeType = msg.audio.mime_type
    if (msg.audio.file_name != null) item.fileName = msg.audio.file_name
    media.push(item)
  }
  if (msg.voice != null) {
    const item: MediaItem = { kind: 'audio', url: `tg://file/${msg.voice.file_id}`, durationMs: msg.voice.duration * 1000, isVoice: true }
    if (msg.voice.mime_type != null) item.mimeType = msg.voice.mime_type
    media.push(item)
  }
  if (msg.video != null) {
    const item: MediaItem = { kind: 'video', url: `tg://file/${msg.video.file_id}`, durationMs: msg.video.duration * 1000, isVoice: false }
    if (msg.video.mime_type != null) item.mimeType = msg.video.mime_type
    if (msg.video.file_name != null) item.fileName = msg.video.file_name
    media.push(item)
  }
  if (msg.document != null) {
    const item: MediaItem = { kind: 'document', url: `tg://file/${msg.document.file_id}`, isVoice: false }
    if (msg.document.mime_type != null) item.mimeType = msg.document.mime_type
    if (msg.document.file_name != null) item.fileName = msg.document.file_name
    media.push(item)
  }
  if (msg.sticker != null) {
    media.push({ kind: 'sticker', url: `tg://file/${msg.sticker.file_id}`, isVoice: false })
  }

  return media
}
