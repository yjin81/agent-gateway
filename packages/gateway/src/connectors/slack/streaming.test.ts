// connectors/slack/streaming.test.ts
// Unit tests for SlackConnector.sendChunk() — progressive streaming delivery.
// Uses a mock Slack client; no real Socket Mode connection required.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { StreamChunk } from '../../adapter/types.js'
import type { DeliveryTarget } from '../types.js'

// ── Minimal SlackConnector factory with mocked Bolt client ────────────────────
//
// SlackConnector constructor calls `new App(...)`. Rather than spinning up a
// real Bolt app we reach into the private fields after construction and replace
// the client with a mock. This is intentionally minimal — we only need
// app.client.chat.postMessage and app.client.chat.update.

import { SlackConnector } from './index.js'
import type { SlackConnectorConfig } from '../../config/schema.js'

const STUB_CONFIG: SlackConnectorConfig = {
  type: 'slack',
  accountId: 'test-slack',
  botToken: 'xoxb-stub',
  appToken: 'xapp-stub',
  signingSecret: 'stub-secret',
}

interface MockClient {
  chat: {
    postMessage: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
}

function makeConnectorWithMockClient(): { connector: SlackConnector; client: MockClient } {
  const connector = new SlackConnector(STUB_CONFIG)

  const client: MockClient = {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1000.0001' }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
  }

  // Reach into private field — acceptable in unit tests for otherwise-untestable code.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(connector as any).app = { client }

  return { connector, client }
}

const TARGET: DeliveryTarget = { chatId: 'C123' }

function chunk(delta: string, done = false): StreamChunk {
  return done
    ? { delta, done: true, interrupted: false, media: [] }
    : { delta, done: false }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SlackConnector.sendChunk()', () => {
  describe('supportsStreaming flag', () => {
    it('is true', () => {
      const { connector } = makeConnectorWithMockClient()
      expect(connector.supportsStreaming).toBe(true)
    })
  })

  describe('first chunk', () => {
    it('calls chat.postMessage with accumulated text', async () => {
      const { connector, client } = makeConnectorWithMockClient()
      await connector.sendChunk(TARGET, chunk('Hello'), 'Hello')

      expect(client.chat.postMessage).toHaveBeenCalledOnce()
      expect(client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'C123', text: 'Hello' }),
      )
    })

    it('uses "…" placeholder when accumulated text is empty', async () => {
      const { connector, client } = makeConnectorWithMockClient()
      await connector.sendChunk(TARGET, chunk(''), '')

      expect(client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: '…' }),
      )
    })

    it('passes thread_ts when replyToMessageId is set', async () => {
      const { connector, client } = makeConnectorWithMockClient()
      const threadTarget: DeliveryTarget = { chatId: 'C123', replyToMessageId: '999.001' }
      await connector.sendChunk(threadTarget, chunk('hi'), 'hi')

      expect(client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ thread_ts: '999.001' }),
      )
    })
  })

  describe('final chunk (done=true)', () => {
    it('calls chat.update with final accumulated text', async () => {
      const { connector, client } = makeConnectorWithMockClient()

      // First chunk posts message.
      await connector.sendChunk(TARGET, chunk('Hello'), 'Hello')
      // Final chunk should update with full text.
      await connector.sendChunk(TARGET, chunk(' world', true), 'Hello world')

      expect(client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'C123', ts: '1000.0001', text: 'Hello world' }),
      )
    })

    it('does not call chat.update when final accumulated text is empty', async () => {
      const { connector, client } = makeConnectorWithMockClient()

      await connector.sendChunk(TARGET, chunk(''), '')
      await connector.sendChunk(TARGET, chunk('', true), '')

      expect(client.chat.update).not.toHaveBeenCalled()
    })

    it('removes streaming state after final chunk so next turn starts fresh', async () => {
      const { connector, client } = makeConnectorWithMockClient()

      await connector.sendChunk(TARGET, chunk('A'), 'A')
      await connector.sendChunk(TARGET, chunk('', true), 'A')

      // Reset mock counts and start a second turn.
      client.chat.postMessage.mockClear()
      client.chat.update.mockClear()

      await connector.sendChunk(TARGET, chunk('B'), 'B')
      // Should post a new message, not try to update the old ts.
      expect(client.chat.postMessage).toHaveBeenCalledOnce()
    })
  })

  describe('single-chunk stream (first = final)', () => {
    it('posts a message and does not call update when done=true on first chunk', async () => {
      const { connector, client } = makeConnectorWithMockClient()

      await connector.sendChunk(TARGET, chunk('complete', true), 'complete')

      expect(client.chat.postMessage).toHaveBeenCalledOnce()
      expect(client.chat.update).not.toHaveBeenCalled()
    })
  })

  describe('debounce — intermediate chunks', () => {
    it('updates immediately when interval has elapsed', async () => {
      const { connector, client } = makeConnectorWithMockClient()

      // Post initial message.
      await connector.sendChunk(TARGET, chunk('A'), 'A')
      client.chat.update.mockClear()

      // Backdate lastUpdateAt so the debounce interval has "elapsed".
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const state = (connector as any).streamingState.get('C123')
      state.lastUpdateAt = Date.now() - 1000 // 1 second ago

      await connector.sendChunk(TARGET, chunk('B'), 'AB')

      expect(client.chat.update).toHaveBeenCalledOnce()
      expect(client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'AB' }),
      )
    })

    it('does not update immediately when interval has not elapsed', async () => {
      const { connector, client } = makeConnectorWithMockClient()

      await connector.sendChunk(TARGET, chunk('A'), 'A')
      client.chat.update.mockClear()

      // lastUpdateAt is very recent — do not touch it.
      await connector.sendChunk(TARGET, chunk('B'), 'AB')

      // No immediate update — a timer is pending.
      expect(client.chat.update).not.toHaveBeenCalled()
    })

    it('final chunk cancels pending debounce timer and flushes', async () => {
      const { connector, client } = makeConnectorWithMockClient()

      await connector.sendChunk(TARGET, chunk('A'), 'A')
      // Intermediate chunk — schedules debounce (no immediate update).
      await connector.sendChunk(TARGET, chunk('B'), 'AB')
      client.chat.update.mockClear()

      // Final chunk should cancel the timer and update with full text.
      await connector.sendChunk(TARGET, chunk('', true), 'AB')

      expect(client.chat.update).toHaveBeenCalledOnce()
      expect(client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'AB' }),
      )
    })
  })
})
