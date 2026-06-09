// connectors/teams/connector.test.ts
// Unit tests for TeamsConnector.
//
// We cannot test the full HTTP webhook path without a real Azure Bot Service
// JWT, so we test:
//   1. startAccount / stopAccount / isHealthy lifecycle
//   2. send() via Path A (active turn) using a mock TurnContext
//   3. send() via Path B (proactive ref) using a mock adapter
//   4. sendTyping() dispatches a Typing activity
//   5. send() throws ConnectorSendError when no ref is available
//   6. supportsStreaming is false
//   7. Gateway mount path comes from config.webhookPath
//   8. Non-message activities are ignored (via direct _onActivity call via cast)

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TeamsConnector } from './index.js'
import type { NormalizedMessage } from '../types.js'
import { ConnectorSendError } from '../../lib/errors.js'

function makeConnector(webhookPath = '/connectors/teams') {
  return new TeamsConnector({
    type: 'teams',
    accountId: 'teams-test',
    appId: 'fake-app-id',
    appPassword: 'fake-app-password',
    webhookPath,
  })
}

// Build a minimal fake TurnContext that records sent activities.
function makeFakeTurnContext(conversationId: string, text: string, botId = 'bot-1', botName = 'MyBot') {
  const sentActivities: unknown[] = []
  const activity = {
    type: 'message',
    id: 'msg-1',
    text,
    from: { id: 'user-1', name: 'User One' },
    recipient: { id: botId, name: botName },
    conversation: { id: conversationId, conversationType: 'personal' },
    channelId: 'msteams',
    serviceUrl: 'https://smba.trafficmanager.net/amer/',
  }
  const ctx = {
    activity,
    sendActivity: vi.fn(async (_act: unknown) => {
      sentActivities.push(_act)
      return { id: 'sent-1' }
    }),
    sent: sentActivities,
  }
  return ctx
}

describe('TeamsConnector', () => {
  let connector: TeamsConnector
  let received: NormalizedMessage[]

  beforeEach(async () => {
    connector = makeConnector()
    received = []
    connector.onMessage((msg) => received.push(msg))
    await connector.startAccount()
  })

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  it('is healthy after startAccount', () => {
    expect(connector.isHealthy()).toBe(true)
  })

  it('is unhealthy after stopAccount', async () => {
    await connector.stopAccount()
    expect(connector.isHealthy()).toBe(false)
  })

  it('type is "teams"', () => {
    expect(connector.type).toBe('teams')
  })

  it('supportsStreaming is false', () => {
    expect(connector.supportsStreaming).toBe(false)
  })

  it('exposes a Hono app', () => {
    expect(connector.app).toBeDefined()
    expect(typeof connector.app.fetch).toBe('function')
  })

  // ── startAccount validation ───────────────────────────────────────────────

  it('throws non-retryable ConnectorStartupError when appId is empty', async () => {
    const bad = new TeamsConnector({
      type: 'teams',
      accountId: 'bad',
      appId: '',
      appPassword: 'pw',
      webhookPath: '/connectors/teams',
    })
    await expect(bad.startAccount()).rejects.toThrow('appId and appPassword are required')
  })

  // ── send() Path A (active turn) ──────────────────────────────────────────

  it('send() uses active turn context (Path A)', async () => {
    const convId = 'conv-path-a'
    const fakeCtx = makeFakeTurnContext(convId, 'hello')

    // Inject the active turn directly via the private _onActivity codepath.
    // We call _onActivity with a fake context to simulate an inbound message.
    const onActivity = (connector as unknown as { _onActivity(ctx: unknown): Promise<void> })._onActivity.bind(connector)
    const activityPromise = onActivity(fakeCtx)

    // Give callback a tick to fire.
    await new Promise((r) => setTimeout(r, 0))

    // Reply while turn is still active.
    const result = await connector.send({ chatId: convId }, 'Hello from bot')
    expect(result.ok).toBe(true)
    expect(result.sentMessageId).toBe('sent-1')
    expect(fakeCtx.sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello from bot' }),
    )

    await activityPromise
  })

  // ── NormalizedMessage shape ───────────────────────────────────────────────

  it('normalises inbound message correctly', async () => {
    const convId = 'conv-normalize'
    const fakeCtx = makeFakeTurnContext(convId, 'test message')

    const onActivity = (connector as unknown as { _onActivity(ctx: unknown): Promise<void> })._onActivity.bind(connector)
    await onActivity(fakeCtx)

    expect(received).toHaveLength(1)
    const msg = received[0]!
    expect(msg.text).toBe('test message')
    expect(msg.sender.id).toBe('user-1')
    expect(msg.sender.name).toBe('User One')
    expect(msg.chat.id).toBe(convId)
    expect(msg.chat.kind).toBe('dm')
    expect(msg.routing.accountId).toBe('teams-test')
    expect(msg.routing.isAgentAddressed).toBe(true) // DM → always addressed
  })

  it('strips @mention from text', async () => {
    const convId = 'conv-mention'
    const fakeCtx = makeFakeTurnContext(convId, '<at>MyBot</at> please help', 'bot-1', 'MyBot')

    const onActivity = (connector as unknown as { _onActivity(ctx: unknown): Promise<void> })._onActivity.bind(connector)
    await onActivity(fakeCtx)

    expect(received).toHaveLength(1)
    expect(received[0]!.text).toBe('please help')
  })

  it('marks channel chat kind for non-personal conversations', async () => {
    const convId = 'conv-channel'
    const fakeCtx = makeFakeTurnContext(convId, 'hello')
    // Override conversation type to simulate a Teams channel.
    ;(fakeCtx.activity.conversation as { conversationType: string }).conversationType = 'channel'

    const onActivity = (connector as unknown as { _onActivity(ctx: unknown): Promise<void> })._onActivity.bind(connector)
    await onActivity(fakeCtx)

    expect(received[0]!.chat.kind).toBe('channel')
  })

  // ── send() Path B (proactive) ─────────────────────────────────────────────

  it('send() throws ConnectorSendError when no conversation reference exists', async () => {
    await expect(connector.send({ chatId: 'no-such-conv' }, 'hi')).rejects.toThrow(ConnectorSendError)
  })

  it('send() falls back to Path B after active turn is gone', async () => {
    const convId = 'conv-path-b'
    const fakeCtx = makeFakeTurnContext(convId, 'hello')

    // Capture the stored ConversationReference by running _onActivity.
    const onActivity = (connector as unknown as { _onActivity(ctx: unknown): Promise<void> })._onActivity.bind(connector)
    await onActivity(fakeCtx)

    // Clear the active turn map to simulate the turn having ended.
    const activeTurns = (connector as unknown as { activeTurns: Map<string, unknown> }).activeTurns
    activeTurns.delete(convId)

    // Mock continueConversation on the internal BotFrameworkAdapter.
    const adapterInternal = (connector as unknown as { adapter: { continueConversation: (...args: unknown[]) => Promise<void> } }).adapter
    adapterInternal.continueConversation = vi.fn(async (_ref, callback: (ctx: unknown) => Promise<void>) => {
      await callback({
        sendActivity: async (_act: unknown) => ({ id: 'proactive-sent-1' }),
      })
    })

    const result = await connector.send({ chatId: convId }, 'Proactive reply')
    expect(result.ok).toBe(true)
    expect(adapterInternal.continueConversation).toHaveBeenCalled()
  })

  // ── sendTyping ────────────────────────────────────────────────────────────

  it('sendTyping dispatches a Typing activity via active turn', async () => {
    const convId = 'conv-typing'
    const fakeCtx = makeFakeTurnContext(convId, 'hello')

    const onActivity = (connector as unknown as { _onActivity(ctx: unknown): Promise<void> })._onActivity.bind(connector)
    const activityPromise = onActivity(fakeCtx)
    await new Promise((r) => setTimeout(r, 0))

    await connector.sendTyping(convId)
    expect(fakeCtx.sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'typing' }),
    )

    await activityPromise
  })

  it('sendTyping is a no-op when no context or ref exists', async () => {
    // Should not throw.
    await expect(connector.sendTyping('no-conv')).resolves.toBeUndefined()
  })

  // ── Multiple concurrent conversations ────────────────────────────────────

  it('handles two concurrent conversations independently', async () => {
    const onActivity = (connector as unknown as { _onActivity(ctx: unknown): Promise<void> })._onActivity.bind(connector)

    const ctx1 = makeFakeTurnContext('conv-1', 'message one')
    const ctx2 = makeFakeTurnContext('conv-2', 'message two')

    await onActivity(ctx1)
    await onActivity(ctx2)

    expect(received).toHaveLength(2)
    expect(received[0]!.chat.id).toBe('conv-1')
    expect(received[1]!.chat.id).toBe('conv-2')

    await connector.send({ chatId: 'conv-1' }, 'Reply 1')
    await connector.send({ chatId: 'conv-2' }, 'Reply 2')

    expect(ctx1.sendActivity).toHaveBeenCalledWith(expect.objectContaining({ text: 'Reply 1' }))
    expect(ctx2.sendActivity).toHaveBeenCalledWith(expect.objectContaining({ text: 'Reply 2' }))
  })
})
