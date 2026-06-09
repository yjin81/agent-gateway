// src/core/pipeline/classify.test.ts

import { describe, it, expect } from 'vitest'
import { classify } from './classify.js'
import type { NormalizedMessage } from '../../connectors/types.js'

function makeMsg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: 'msg-1',
    sender: { id: 'user-1', name: 'Test User', isSelf: false },
    chat: { id: 'chat-1', kind: 'dm' },
    text: 'hello',
    textRaw: 'hello',
    media: [],
    content: { mentions: [] },
    routing: { isAgentAddressed: true, accountId: 'test' },
    raw: {},
    ...overrides,
  }
}

describe('classify', () => {
  describe('drop: self', () => {
    it('drops messages from the bot itself', () => {
      const result = classify(makeMsg({ sender: { id: 'bot', name: 'bot', isSelf: true } }))
      expect(result).toEqual({ drop: true, reason: 'self' })
    })
  })

  describe('drop: no-sender', () => {
    it('drops messages with empty sender id', () => {
      const result = classify(makeMsg({ sender: { id: '', name: '', isSelf: false } }))
      expect(result).toEqual({ drop: true, reason: 'no-sender' })
    })
  })

  describe('drop: not-addressed', () => {
    it('drops messages not addressed to bot in group context', () => {
      const result = classify(makeMsg({ routing: { isAgentAddressed: false, accountId: 'test' } }))
      expect(result).toEqual({ drop: true, reason: 'not-addressed' })
    })
  })

  describe('priority commands', () => {
    it.each(['/stop', '/new', '/approve', '/deny', '/reset'])(
      'classifies %s as priority command',
      (cmd) => {
        const result = classify(makeMsg({ text: cmd }))
        expect(result).toMatchObject({ drop: false, turnClass: { kind: 'command', isPriorityCommand: true } })
      },
    )

    it('extracts command name without leading slash', () => {
      const result = classify(makeMsg({ text: '/stop' }))
      if (result.drop) throw new Error('should not drop')
      expect(result.turnClass.commandName).toBe('stop')
    })

    it('is case-insensitive for commands', () => {
      const result = classify(makeMsg({ text: '/STOP' }))
      if (result.drop) throw new Error('should not drop')
      expect(result.turnClass.commandName).toBe('stop')
    })
  })

  describe('non-priority commands', () => {
    it.each(['/help', '/status'])(
      'classifies %s as non-priority command',
      (cmd) => {
        const result = classify(makeMsg({ text: cmd }))
        expect(result).toMatchObject({ drop: false, turnClass: { kind: 'command', isPriorityCommand: false } })
      },
    )
  })

  describe('regular message', () => {
    it('classifies plain text as message', () => {
      const result = classify(makeMsg({ text: 'what is 2+2?' }))
      expect(result).toMatchObject({ drop: false, turnClass: { kind: 'message', isPriorityCommand: false } })
    })

    it('classifies addressed message as message even in group', () => {
      const result = classify(makeMsg({
        text: 'hello bot',
        chat: { id: 'c1', kind: 'group' },
        routing: { isAgentAddressed: true, accountId: 'test' },
      }))
      expect(result).toMatchObject({ drop: false, turnClass: { kind: 'message' } })
    })
  })
})
