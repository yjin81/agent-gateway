// core/pipeline/classify.ts — Stage 2: NormalizedMessage → TurnClass

import type { NormalizedMessage } from '../../connectors/types.js'
import { COMMAND_REGISTRY } from '../commands/registry.js'

export interface TurnClass {
  kind: 'message' | 'command' | 'reaction' | 'system'
  /** True if this is a /stop, /new, /reset, /approve, or /deny command. */
  isPriorityCommand: boolean
  /** Canonical command name (e.g. "stop") when kind === "command". */
  commandName?: string
}

export type ClassifyResult =
  | { drop: true; reason: 'self' | 'no-sender' | 'not-addressed' }
  | { drop: false; turnClass: TurnClass }

/**
 * Stage 2: Classify an inbound NormalizedMessage.
 *
 * Drop conditions (return drop:true):
 *   - sender.isSelf → bot-loop protection
 *   - sender.id empty / null → unidentifiable sender
 *   - not isAgentAddressed AND not a command → observed (non-drop in group, but not dispatched)
 *
 * Note: "not-addressed" is a soft drop — the turn is logged as `observed`, not truly dropped.
 */
export function classify(msg: NormalizedMessage): ClassifyResult {
  // Drop bot-loop messages.
  if (msg.sender.isSelf) {
    return { drop: true, reason: 'self' }
  }

  // Drop messages with no identifiable sender.
  if (!msg.sender.id) {
    return { drop: true, reason: 'no-sender' }
  }

  const text = msg.text.trim()

  // Detect gateway commands (start with '/').
  if (text.startsWith('/')) {
    const rawCommand = text.split(/\s+/)[0]?.slice(1).toLowerCase() ?? ''
    const entry = COMMAND_REGISTRY.find(
      (c) => c.name === rawCommand || c.aliases.includes(rawCommand),
    )
    const commandName = entry?.name ?? rawCommand
    const isPriorityCommand = entry?.priority === true

    return {
      drop: false,
      turnClass: {
        kind: 'command',
        isPriorityCommand,
        commandName,
      },
    }
  }

  // If not addressed to the bot in a group context, mark as observed.
  if (!msg.routing.isAgentAddressed) {
    return { drop: true, reason: 'not-addressed' }
  }

  return {
    drop: false,
    turnClass: { kind: 'message', isPriorityCommand: false },
  }
}
