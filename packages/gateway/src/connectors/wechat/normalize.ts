// connectors/wechat/normalize.ts — iLink JSON message -> NormalizedMessage

import type { NormalizedMessage, MediaItem } from '../types.js'
import { deriveSessionKey } from './session-key.js'

// iLink item types (from weixin.py constants)
const ITEM_TEXT = 1
const ITEM_IMAGE = 2
const ITEM_VOICE = 3
const ITEM_FILE = 4
const ITEM_VIDEO = 5

// iLink message source types
const MSG_TYPE_USER = 1

interface ILinkItem {
  type?: number
  text_item?: { text?: string }
  image_item?: { media?: ILinkMedia; aeskey?: string }
  voice_item?: { media?: ILinkMedia; text?: string }
  file_item?: { media?: ILinkMedia; file_name?: string }
  video_item?: { media?: ILinkMedia }
  ref_msg?: {
    title?: string
    message_item?: ILinkItem
  }
}

interface ILinkMedia {
  encrypt_query_param?: string
  aes_key?: string
  full_url?: string
}

export interface ILinkMessage {
  from_user_id?: string
  to_user_id?: string
  room_id?: string
  chat_room_id?: string
  message_id?: string
  message_type?: number
  message_state?: number
  context_token?: string
  item_list?: ILinkItem[]
  [key: string]: unknown
}

/**
 * Extract the plain-text content from an iLink item_list.
 * Handles quoted references by prepending a prefix.
 */
function extractText(itemList: ILinkItem[]): string {
  for (const item of itemList) {
    if (item.type === ITEM_TEXT) {
      const text = String(item.text_item?.text ?? '')
      const ref = item.ref_msg ?? {}
      const refItem = ref.message_item
      if (refItem) {
        const refType = refItem.type
        if (refType === ITEM_IMAGE || refType === ITEM_VIDEO || refType === ITEM_FILE || refType === ITEM_VOICE) {
          const title = ref.title ?? ''
          const prefix = title ? `[引用媒体: ${title}]\n` : '[引用媒体]\n'
          return `${prefix}${text}`.trim()
        }
        const parts: string[] = []
        if (ref.title) parts.push(ref.title)
        const refText = extractText([refItem])
        if (refText) parts.push(refText)
        if (parts.length > 0) {
          return `[引用: ${parts.join(' | ')}]\n${text}`.trim()
        }
      }
      return text
    }
  }
  // Fall back to voice transcription
  for (const item of itemList) {
    if (item.type === ITEM_VOICE) {
      const voiceText = String(item.voice_item?.text ?? '')
      if (voiceText) return voiceText
    }
  }
  return ''
}

/**
 * Determine chat type and effective chatId from an iLink message.
 * Groups have a non-empty room_id / chat_room_id.
 */
function guessChatKind(message: ILinkMessage, accountId: string, ilinkBotId: string): { kind: 'dm' | 'group'; chatId: string } {
  const roomId = String(message.room_id ?? message.chat_room_id ?? '').trim()
  const toUserId = String(message.to_user_id ?? '').trim()
  // A message is a DM when it is addressed directly to the bot (to_user_id matches the bot's iLink ID).
  // Using accountId here would be wrong — accountId is a logical name like "wechat-personal", not the iLink bot ID.
  const botId = ilinkBotId.trim()
  const isGroup = Boolean(roomId) || (
    Boolean(toUserId) && Boolean(botId) && toUserId !== botId && message.message_type === MSG_TYPE_USER
  )
  if (isGroup) {
    return { kind: 'group', chatId: roomId || toUserId || String(message.from_user_id ?? '') }
  }
  return { kind: 'dm', chatId: String(message.from_user_id ?? '') }
}

/**
 * Build a lightweight MediaItem descriptor from an iLink item.
 * Media content is NOT downloaded here — descriptors carry the CDN URL.
 */
function itemToMediaDescriptor(item: ILinkItem, cdnBaseUrl: string): MediaItem | null {
  switch (item.type) {
    case ITEM_IMAGE: {
      const media = item.image_item?.media
      const url = media?.full_url ?? (
        media?.encrypt_query_param
          ? `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
          : undefined
      )
      return { kind: 'image', isVoice: false, ...(url != null ? { url } : {}) }
    }
    case ITEM_VIDEO: {
      const media = item.video_item?.media
      const url = media?.full_url ?? (
        media?.encrypt_query_param
          ? `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
          : undefined
      )
      return { kind: 'video', isVoice: false, ...(url != null ? { url } : {}) }
    }
    case ITEM_VOICE: {
      if (item.voice_item?.text) return null // already transcribed to text
      const media = item.voice_item?.media
      const url = media?.full_url ?? (
        media?.encrypt_query_param
          ? `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
          : undefined
      )
      return { kind: 'audio', isVoice: true, ...(url != null ? { url } : {}) }
    }
    case ITEM_FILE: {
      const fileItem = item.file_item
      const media = fileItem?.media
      const url = media?.full_url ?? (
        media?.encrypt_query_param
          ? `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
          : undefined
      )
      const fileName = fileItem?.file_name
      return {
        kind: 'document',
        isVoice: false,
        ...(url != null ? { url } : {}),
        ...(fileName != null ? { fileName } : {}),
      }
    }
    default:
      return null
  }
}

export interface NormalizeResult {
  normalized: NormalizedMessage & { sessionKey: string }
  contextToken: string | undefined
}

/**
 * Normalize an iLink inbound message into a NormalizedMessage.
 * Returns null if the message should be ignored (self-message, no content, etc.).
 */
export function normalize(
  message: ILinkMessage,
  accountId: string,
  ilinkBotId: string,
  cdnBaseUrl: string,
): NormalizeResult | null {
  const senderId = String(message.from_user_id ?? '').trim()
  if (!senderId) return null
  // Filter out self-sent messages
  if (senderId === ilinkBotId || senderId === accountId) return null

  const itemList = message.item_list ?? []
  const text = extractText(itemList)
  const media: MediaItem[] = []
  for (const item of itemList) {
    const m = itemToMediaDescriptor(item, cdnBaseUrl)
    if (m) media.push(m)
    // Also check ref_msg
    if (item.ref_msg?.message_item) {
      const refM = itemToMediaDescriptor(item.ref_msg.message_item, cdnBaseUrl)
      if (refM) media.push(refM)
    }
  }

  if (!text && media.length === 0) return null

  const { kind, chatId } = guessChatKind(message, accountId, ilinkBotId)
  const messageId = String(message.message_id ?? '').trim() || `wechat-${Date.now()}`
  const contextToken = String(message.context_token ?? '').trim() || undefined

  const normalized: NormalizedMessage & { sessionKey: string } = {
    id: messageId,
    sender: {
      id: senderId,
      name: senderId,
      isSelf: false,
    },
    chat: {
      id: chatId,
      kind,
    },
    text,
    textRaw: text,
    media,
    content: { mentions: [] },
    routing: {
      isAgentAddressed: kind === 'dm', // group messages require @mention logic (deferred)
      accountId,
    },
    raw: message,
    sessionKey: deriveSessionKey(accountId, chatId),
  }

  return { normalized, contextToken }
}
