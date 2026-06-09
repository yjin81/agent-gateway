// src/connectors/slack/normalize.test.ts

import { describe, it, expect } from 'vitest'
import { normalize } from './normalize.js'
import type { SlackMessageEvent } from './normalize.js'

const BOT_ID = 'UBOT001'
const ACCOUNT_ID = 'slack-test'

function makeEvent(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
  return {
    type: 'message',
    text: 'hello',
    user: 'UUSER001',
    channel: 'C123',
    channel_type: 'im',
    ts: '1700000000.000001',
    ...overrides,
  }
}

describe('slack/normalize', () => {
  describe('drop conditions', () => {
    it('drops bot_message subtype', () => {
      expect(normalize(makeEvent({ bot_id: 'BBOT001' }), ACCOUNT_ID, BOT_ID)).toBeNull()
    })

    it('drops message_changed subtype', () => {
      expect(normalize(makeEvent({ subtype: 'message_changed' }), ACCOUNT_ID, BOT_ID)).toBeNull()
    })

    it('drops message with no user and no bot_id', () => {
      const event = makeEvent()
      // @ts-expect-error intentionally removing user
      delete event.user
      expect(normalize(event, ACCOUNT_ID, BOT_ID)).toBeNull()
    })

    it('drops message with empty text and no media', () => {
      expect(normalize(makeEvent({ text: '' }), ACCOUNT_ID, BOT_ID)).toBeNull()
    })

    it('does not drop file_share subtype', () => {
      const result = normalize(
        makeEvent({ subtype: 'file_share', files: [{ id: 'F1', mimetype: 'image/png', url_private: 'https://x.com/f.png' }] }),
        ACCOUNT_ID,
        BOT_ID,
      )
      expect(result).not.toBeNull()
    })
  })

  describe('DM messages', () => {
    it('sets isAgentAddressed=true for DM', () => {
      const result = normalize(makeEvent({ channel_type: 'im' }), ACCOUNT_ID, BOT_ID)
      expect(result?.routing.isAgentAddressed).toBe(true)
    })

    it('sets chat.kind=dm for DM', () => {
      const result = normalize(makeEvent({ channel_type: 'im' }), ACCOUNT_ID, BOT_ID)
      expect(result?.chat.kind).toBe('dm')
    })

    it('preserves sender id', () => {
      const result = normalize(makeEvent({ user: 'UUSER123', channel_type: 'im' }), ACCOUNT_ID, BOT_ID)
      expect(result?.sender.id).toBe('UUSER123')
    })

    it('uses ts as message id', () => {
      const result = normalize(makeEvent({ ts: '1700000099.000001' }), ACCOUNT_ID, BOT_ID)
      expect(result?.id).toBe('1700000099.000001')
    })
  })

  describe('channel @mention detection', () => {
    it('sets isAgentAddressed=true when bot is @mentioned in channel', () => {
      const result = normalize(
        makeEvent({ text: `<@${BOT_ID}> help me`, channel_type: 'channel' }),
        ACCOUNT_ID,
        BOT_ID,
      )
      expect(result?.routing.isAgentAddressed).toBe(true)
    })

    it('sets isAgentAddressed=false when bot is NOT @mentioned in channel', () => {
      const result = normalize(
        makeEvent({ text: 'just chatting', channel_type: 'channel' }),
        ACCOUNT_ID,
        BOT_ID,
      )
      expect(result?.routing.isAgentAddressed).toBe(false)
    })

    it('strips bot @mention from cleanText', () => {
      const result = normalize(
        makeEvent({ text: `<@${BOT_ID}> help me`, channel_type: 'channel' }),
        ACCOUNT_ID,
        BOT_ID,
      )
      expect(result?.text).toBe('help me')
      expect(result?.textRaw).toBe(`<@${BOT_ID}> help me`)
    })

    it('keeps @mention of other users in cleanText', () => {
      const result = normalize(
        makeEvent({ text: `<@${BOT_ID}> hey <@UOTHER>`, channel_type: 'channel' }),
        ACCOUNT_ID,
        BOT_ID,
      )
      expect(result?.text).toContain('<@UOTHER>')
    })

    it('populates mentions array with isSelf=true for bot mention', () => {
      const result = normalize(
        makeEvent({ text: `<@${BOT_ID}> ping`, channel_type: 'channel' }),
        ACCOUNT_ID,
        BOT_ID,
      )
      const selfMention = result?.content.mentions.find((m) => m.isSelf)
      expect(selfMention).toBeDefined()
      expect(selfMention?.userId).toBe(BOT_ID)
    })
  })

  describe('media extraction', () => {
    it('extracts image media item', () => {
      const result = normalize(
        makeEvent({
          text: '',
          files: [{ id: 'F1', mimetype: 'image/png', url_private: 'https://x.com/img.png', name: 'img.png' }],
        }),
        ACCOUNT_ID,
        BOT_ID,
      )
      expect(result?.media).toHaveLength(1)
      expect(result?.media[0]?.kind).toBe('image')
      expect(result?.media[0]?.url).toBe('https://x.com/img.png')
    })

    it('extracts voice media item', () => {
      const result = normalize(
        makeEvent({
          text: '',
          files: [{ id: 'F2', mimetype: 'audio/mp4', mode: 'voice_message', url_private: 'https://x.com/v.mp4' }],
        }),
        ACCOUNT_ID,
        BOT_ID,
      )
      expect(result?.media[0]?.kind).toBe('audio')
      expect(result?.media[0]?.isVoice).toBe(true)
    })
  })
})
