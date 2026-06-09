// src/connectors/wechat/normalize.test.ts

import { describe, it, expect } from 'vitest'
import { normalize } from './normalize.js'
import type { ILinkMessage } from './normalize.js'

const ACCOUNT_ID = 'wechat-test'
const BOT_ILINK_ID = 'bot-ilink-001'
const CDN_BASE = 'https://cdn.example.com'

function makeMsg(overrides: Partial<ILinkMessage> = {}): ILinkMessage {
  return {
    from_user_id: 'user-001',
    to_user_id: BOT_ILINK_ID,
    message_id: 'msg-001',
    message_type: 1,
    item_list: [{ type: 1, text_item: { text: 'hello' } }],
    ...overrides,
  }
}

describe('wechat/normalize', () => {
  describe('drop conditions', () => {
    it('returns null when from_user_id is empty', () => {
      expect(normalize(makeMsg({ from_user_id: '' }), ACCOUNT_ID, BOT_ILINK_ID, CDN_BASE)).toBeNull()
    })

    it('returns null when sender is the bot itself', () => {
      expect(normalize(makeMsg({ from_user_id: BOT_ILINK_ID }), ACCOUNT_ID, BOT_ILINK_ID, CDN_BASE)).toBeNull()
    })

    it('returns null when no text and no media', () => {
      expect(normalize(makeMsg({ item_list: [] }), ACCOUNT_ID, BOT_ILINK_ID, CDN_BASE)).toBeNull()
    })
  })

  describe('DM detection', () => {
    it('identifies DM when to_user_id is the bot', () => {
      const result = normalize(makeMsg(), ACCOUNT_ID, BOT_ILINK_ID, CDN_BASE)
      expect(result?.normalized.chat.kind).toBe('dm')
    })

    it('sets isAgentAddressed=true for DM', () => {
      const result = normalize(makeMsg(), ACCOUNT_ID, BOT_ILINK_ID, CDN_BASE)
      expect(result?.normalized.routing.isAgentAddressed).toBe(true)
    })

    it('uses from_user_id as chatId for DM', () => {
      const result = normalize(makeMsg({ from_user_id: 'user-abc' }), ACCOUNT_ID, BOT_ILINK_ID, CDN_BASE)
      expect(result?.normalized.chat.id).toBe('user-abc')
    })
  })

  describe('group detection', () => {
    it('identifies group when room_id is present', () => {
      const result = normalize(makeMsg({ room_id: 'room-001' }), ACCOUNT_ID, BOT_ILINK_ID, CDN_BASE)
      expect(result?.normalized.chat.kind).toBe('group')
    })

    it('uses room_id as chatId for group', () => {
      const result = normalize(makeMsg({ room_id: 'room-001' }), ACCOUNT_ID, BOT_ILINK_ID, CDN_BASE)
      expect(result?.normalized.chat.id).toBe('room-001')
    })
  })

  describe('text extraction', () => {
    it('extracts plain text from ITEM_TEXT', () => {
      const result = normalize(makeMsg(), ACCOUNT_ID, BOT_ILINK_ID, CDN_BASE)
      expect(result?.normalized.text).toBe('hello')
    })

    it('falls back to voice transcription when no text item', () => {
      const result = normalize(
        makeMsg({ item_list: [{ type: 3, voice_item: { text: 'transcribed voice' } }] }),
        ACCOUNT_ID,
        BOT_ILINK_ID,
        CDN_BASE,
      )
      expect(result?.normalized.text).toBe('transcribed voice')
    })
  })

  describe('media extraction', () => {
    it('extracts image media item with CDN URL', () => {
      const result = normalize(
        makeMsg({
          item_list: [{ type: 1, text_item: { text: 'see pic' } }, { type: 2, image_item: { media: { full_url: 'https://cdn/img.jpg' } } }],
        }),
        ACCOUNT_ID,
        BOT_ILINK_ID,
        CDN_BASE,
      )
      const img = result?.normalized.media.find((m) => m.kind === 'image')
      expect(img).toBeDefined()
      expect(img?.url).toBe('https://cdn/img.jpg')
    })

    it('extracts file media item with filename', () => {
      const result = normalize(
        makeMsg({
          item_list: [
            { type: 1, text_item: { text: 'doc' } },
            { type: 4, file_item: { media: { full_url: 'https://cdn/doc.pdf' }, file_name: 'doc.pdf' } },
          ],
        }),
        ACCOUNT_ID,
        BOT_ILINK_ID,
        CDN_BASE,
      )
      const doc = result?.normalized.media.find((m) => m.kind === 'document')
      expect(doc?.fileName).toBe('doc.pdf')
    })
  })

  describe('context token', () => {
    it('extracts context_token', () => {
      const result = normalize(makeMsg({ context_token: 'ctx-abc' }), ACCOUNT_ID, BOT_ILINK_ID, CDN_BASE)
      expect(result?.contextToken).toBe('ctx-abc')
    })

    it('returns undefined context token when absent', () => {
      const result = normalize(makeMsg(), ACCOUNT_ID, BOT_ILINK_ID, CDN_BASE)
      expect(result?.contextToken).toBeUndefined()
    })
  })
})
