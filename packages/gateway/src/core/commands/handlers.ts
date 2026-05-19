// core/commands/handlers.ts — Command handler implementations (Section 5.5)

import type { NormalizedMessage } from '../../connectors/types.js'
import type { RunTurnDeps } from '../pipeline/index.js'
import { COMMAND_REGISTRY } from './registry.js'
import { logger } from '../../lib/logger.js'

/**
 * Dispatch a gateway command by its canonical name.
 * Called from Stage 2 bypass path (priority) or Stage 5 (non-priority).
 */
export async function handleCommand(
  commandName: string,
  msg: NormalizedMessage,
  sessionKey: string,
  deps: RunTurnDeps,
): Promise<void> {
  const { connector, sessionRegistry, runRegistry, approvalMap } = deps

  switch (commandName) {
    case 'stop': {
      runRegistry.abort(sessionKey)
      await safeSend(connector, msg.chat.id, '⏹ Stopped.')
      break
    }

    case 'new':
    case 'reset': {
      runRegistry.abort(sessionKey)
      sessionRegistry.resetSession(sessionKey)
      if (deps.harness.onSessionReset != null) {
        await deps.harness.onSessionReset(sessionKey).catch((err) => {
          logger.warn({ sessionKey, err }, 'handleCommand: onSessionReset threw')
        })
      }
      await safeSend(connector, msg.chat.id, '🔄 Session reset. Starting fresh.')
      break
    }

    case 'approve': {
      const resolve = approvalMap.get(sessionKey)
      if (resolve != null) {
        approvalMap.delete(sessionKey)
        resolve('approved')
        await safeSend(connector, msg.chat.id, '✅ Approved.')
      } else {
        await safeSend(connector, msg.chat.id, 'No pending approval request.')
      }
      break
    }

    case 'deny': {
      const resolve = approvalMap.get(sessionKey)
      if (resolve != null) {
        approvalMap.delete(sessionKey)
        resolve('denied')
        await safeSend(connector, msg.chat.id, '❌ Denied.')
      } else {
        await safeSend(connector, msg.chat.id, 'No pending approval request.')
      }
      break
    }

    case 'status': {
      const slot = runRegistry.getOrCreate(sessionKey)
      const state = slot.state
      const pending = slot.pendingQueue.length
      await safeSend(
        connector,
        msg.chat.id,
        `📊 Session: ${sessionKey}\nState: ${state}\nPending: ${pending}`,
      )
      break
    }

    case 'help': {
      const lines = COMMAND_REGISTRY.map(
        (c) => `/${c.name}${c.aliases.length > 0 ? ` (${c.aliases.map((a) => `/${a}`).join(', ')})` : ''} — ${c.description}`,
      )
      await safeSend(connector, msg.chat.id, lines.join('\n'))
      break
    }

    default: {
      logger.debug({ commandName, sessionKey }, 'handleCommand: unhandled command')
      await safeSend(connector, msg.chat.id, `Unknown command: /${commandName}. Try /help.`)
    }
  }
}

async function safeSend(
  connector: import('../../connectors/types.js').ConnectorInterface,
  chatId: string,
  text: string,
): Promise<void> {
  try {
    await connector.send({ chatId }, text)
  } catch {
    // Best-effort.
  }
}
