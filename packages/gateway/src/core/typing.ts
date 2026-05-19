// core/typing.ts — Typing indicator management (Section 5.3)

import type { ConnectorInterface } from '../connectors/types.js'
import { logger } from '../lib/logger.js'

const TYPING_INTERVAL_MS = 2_000

export interface TypingHandle {
  pause(): void
  resume(): void
  stop(): void
}

/**
 * Start a keep-typing loop that sends a typing indicator every TYPING_INTERVAL_MS.
 * Returns a handle to pause (for approval flows), resume, and stop.
 */
export function keepTyping(
  chatId: string,
  connector: ConnectorInterface,
): TypingHandle {
  let paused = false
  let stopped = false

  async function tick(): Promise<void> {
    while (!stopped) {
      if (!paused) {
        try {
          await connector.sendTyping(chatId)
        } catch (err) {
          logger.warn({ chatId, accountId: connector.accountId, err }, 'keepTyping: sendTyping failed')
        }
      }
      await sleep(TYPING_INTERVAL_MS)
    }
  }

  // Fire and forget — errors are caught inside tick().
  void tick()

  return {
    pause() { paused = true },
    resume() { paused = false },
    stop() { stopped = true },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
