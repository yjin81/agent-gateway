// connectors/openai-api/normalize.ts — HTTP request body → NormalizedMessage

import type { NormalizedMessage } from '../types.js'

interface ChatMessage {
  role: string
  content: string
}

interface ChatCompletionRequestBody {
  messages?: ChatMessage[]
  model?: string
}

/**
 * Normalize a POST /v1/chat/completions request body into a NormalizedMessage.
 * The last `user` message is treated as the current turn.
 * Session continuity is based on the X-Session-Id header.
 */
export function normalizeOpenAIRequest(
  body: ChatCompletionRequestBody,
  sessionId: string,
  accountId: string,
): NormalizedMessage | null {
  const messages = body.messages ?? []
  // Find the last user message.
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  if (lastUser == null) return null

  const text = typeof lastUser.content === 'string' ? lastUser.content : ''

  return {
    id: `openai-api:${Date.now()}`,
    sender: {
      id: sessionId,
      name: 'user',
      isSelf: false,
    },
    chat: {
      id: sessionId,
      kind: 'dm',
    },
    text,
    textRaw: text,
    media: [],
    content: { mentions: [] },
    routing: {
      isAgentAddressed: true, // OpenAI API calls are always addressed to the agent.
      accountId,
    },
    raw: body,
  }
}
