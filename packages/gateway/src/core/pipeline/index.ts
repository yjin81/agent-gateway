// core/pipeline/index.ts — runTurn(): the 6-stage pipeline (Sections 5.1, 17.3)

import type { NormalizedMessage } from '../../connectors/types.js'
import type { ConnectorInterface } from '../../connectors/types.js'
import type { AgentHarness } from '../../harness/types.js'
import type { SessionRegistry } from '../session/registry.js'
import type { SessionRunRegistry } from '../session/run-slot.js'
import type { AuditLog, TurnOutcome } from '../audit.js'
import type { GatewayConfig } from '../../config/schema.js'

import { classify } from './classify.js'
import { keepTyping } from '../typing.js'
import { sendWithRetry } from '../reliability.js'
import {
  HarnessError,
  HarnessTimeoutError,
  ConnectorSendError,
  ApprovalTimeoutError,
} from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'
import { handleCommand } from '../commands/handlers.js'

export interface RunTurnDeps {
  connector: ConnectorInterface
  harness: AgentHarness
  sessionRegistry: SessionRegistry
  runRegistry: SessionRunRegistry
  auditLog: AuditLog
  config: GatewayConfig
  /** Map of sessionKey → Promise<'approved'|'denied'> resolver for approval flows. */
  approvalMap: Map<string, (result: 'approved' | 'denied') => void>
}

const OVERFLOW_MESSAGE =
  '⚠ Your previous message was not processed because a newer message arrived. Please resend if needed.'

export async function runTurn(
  msg: NormalizedMessage,
  deps: RunTurnDeps,
): Promise<TurnOutcome> {
  const startTime = Date.now()
  const { connector, harness, sessionRegistry, runRegistry, auditLog, config } = deps

  // ── Stage 2: CLASSIFY ─────────────────────────────────────────────────────
  const classified = classify(msg)
  if (classified.drop) {
    if (classified.reason === 'not-addressed') {
      // Observed — log but don't audit (not agent-addressed).
      return 'observed'
    }
    return 'dropped'
  }
  const { turnClass } = classified

  // ── Stage 3: IDENTIFY ─────────────────────────────────────────────────────
  const idleTimeoutMs =
    config.connectors.find((c) => c['accountId'] === connector.accountId)?.['idleTimeoutMs'] ??
    config.gateway.idleTimeoutMs

  let sessionRecord
  try {
    sessionRecord = sessionRegistry.getOrCreate(
      // Session key is derived by the connector and stored in routing context.
      // We pass it via a property we attach during normalization.
      (msg as NormalizedMessage & { sessionKey?: string }).sessionKey ??
        `v1:${connector.type}:${connector.accountId}:${msg.chat.id}`,
      idleTimeoutMs,
    )
  } catch (err) {
    logger.error(
      { err, accountId: connector.accountId, messageId: msg.id },
      'Stage 3 IDENTIFY: SessionRegistry.getOrCreate failed — dropping turn',
    )
    return 'dropped'
  }

  const { sessionKey } = sessionRecord

  // ── Priority commands: bypass Stage 4 ────────────────────────────────────
  if (turnClass.isPriorityCommand && turnClass.commandName != null) {
    await handleCommand(turnClass.commandName, msg, sessionKey, deps)
    auditLog.append({
      timestamp: Date.now(),
      sessionKey,
      platform: connector.type,
      accountId: connector.accountId,
      outcome: 'handled',
      messageId: msg.id,
      durationMs: Date.now() - startTime,
    })
    sessionRegistry.touch(sessionKey)
    return 'handled'
  }

  // Non-priority commands and regular messages go through Stage 4.
  if (turnClass.kind === 'command' && turnClass.commandName != null) {
    // Non-priority command — still goes through concurrency gate.
    // Fall through to Stage 4.
  }

  // ── Stage 4: CONCURRENCY GATE ─────────────────────────────────────────────
  const slot = runRegistry.getOrCreate(sessionKey)

  if (slot.state === 'running') {
    // Interrupt current run (abort signal) and enqueue this turn.
    runRegistry.abort(sessionKey)

    let resolveEnqueue!: () => void
    const enqueuePromise = new Promise<void>((res) => { resolveEnqueue = res })

    const superseded = runRegistry.enqueue(
      sessionKey,
      { msg, resolve: resolveEnqueue },
      config.gateway.pendingQueueCap,
    )

    if (superseded != null) {
      // Notify the user whose message was superseded.
      try {
        await connector.send({ chatId: msg.chat.id }, OVERFLOW_MESSAGE)
      } catch {
        // Best-effort notification — ignore failure.
      }
    }

    // Wait until this turn is dequeued and re-enters Stage 4.
    await enqueuePromise
    // Re-enter pipeline with the same message — the slot should now be idle.
    return runTurn(msg, deps)
  }

  // Slot is idle — acquire it synchronously.
  const { abortCtrl } = runRegistry.acquire(sessionKey)
  let outcome: TurnOutcome = 'dispatched'
  const typingHandle = keepTyping(msg.chat.id, connector)

  try {
    // ── Stage 5: DISPATCH ────────────────────────────────────────────────────
    // 5a. keep_typing started above.

    // 5b. Build AgentRequest.
    const request: import('../../harness/types.js').AgentRequest = {
      sessionKey,
      message: msg.text,
      messageRaw: msg.textRaw,
      media: msg.media,
      isNew: sessionRecord.isNew,
      wasAutoReset: sessionRecord.wasAutoReset,
      platform: {
        name: connector.type,
        chatKind: msg.chat.kind,
        userId: msg.sender.id,
        userName: msg.sender.name,
        accountId: connector.accountId,
        mentions: msg.content.mentions,
      },
      toolPolicy: { allowedTools: [], disabledTools: [] },
      abortSignal: abortCtrl.signal,
      progressCallback: (_toolName, _preview) => {
        // Fire-and-forget — do not throw (TODO-9).
      },
      approvalCallback: async (prompt: string) => {
        typingHandle.pause()
        try {
          await connector.send({ chatId: msg.chat.id }, `⚠️ Approval required:\n${prompt}\n\nReply /approve or /deny.`)
        } catch {
          // Best-effort.
        }
        return new Promise<'approved' | 'denied'>((resolve) => {
          deps.approvalMap.set(sessionKey, resolve)
          // Timeout
          setTimeout(() => {
            if (deps.approvalMap.has(sessionKey)) {
              deps.approvalMap.delete(sessionKey)
              resolve('denied')
            }
          }, config.gateway.approvalTimeoutMs)
        }).then((result) => {
          typingHandle.resume()
          if (result === 'denied') {
            void connector.send(
              { chatId: msg.chat.id },
              'Approval request expired — action was not taken.',
            ).catch(() => undefined)
          }
          return result
        })
      },
    }

    // 5c. Call harness with timeout.
    let response: import('../../harness/types.js').AgentResponse
    try {
      response = await withTimeout(
        harness.run(request),
        config.gateway.harnessTimeoutMs,
        () => abortCtrl.abort(),
      )
    } catch (err) {
      if (err instanceof HarnessTimeoutError) {
        await safeSend(connector, msg.chat.id, 'The agent took too long to respond. Please try again.')
        logger.error({ sessionKey, platform: connector.type, accountId: connector.accountId, durationMs: Date.now() - startTime, err }, 'Stage 5: harness timeout')
        outcome = 'error'
      } else {
        await safeSend(connector, msg.chat.id, 'Something went wrong processing your message. Please try again.')
        logger.error({ sessionKey, platform: connector.type, accountId: connector.accountId, err }, 'Stage 5: harness error')
        outcome = 'error'
      }
      return outcome
    }

    // Validate AgentResponse shape.
    if (typeof response.text !== 'string') {
      await safeSend(connector, msg.chat.id, 'The agent returned an invalid response.')
      logger.error({ sessionKey, response }, 'Stage 5: malformed AgentResponse')
      outcome = 'error'
      return outcome
    }

    // Interrupted turn — harness cut short by abortSignal.
    if (response.interrupted) {
      outcome = 'dispatched'
      return outcome
    }

    // 5e. Send response text.
    if (response.text.trim()) {
      try {
        await sendWithRetry(connector, { chatId: msg.chat.id }, response.text)
      } catch (err) {
        if (err instanceof ConnectorSendError) {
          // Best-effort plain text fallback already attempted inside sendWithRetry.
          logger.error({ sessionKey, err }, 'Stage 5: ConnectorSendError after retries')
          outcome = 'error'
          return outcome
        }
        throw err
      }
    }

    // 5f. Send response media.
    for (const item of response.media) {
      await connector.send({ chatId: msg.chat.id }, '', [item]).catch((err) => {
        logger.error({ sessionKey, err, item }, 'Stage 5: failed to send media item')
      })
    }

    sessionRegistry.touch(sessionKey)
    outcome = 'dispatched'
    return outcome
  } finally {
    // 5d. Always stop typing and release the slot.
    typingHandle.stop()
    runRegistry.release(sessionKey)

    // ── Stage 6: FINALIZE ──────────────────────────────────────────────────
    auditLog.append({
      timestamp: Date.now(),
      sessionKey,
      platform: connector.type,
      accountId: connector.accountId,
      outcome,
      messageId: msg.id,
      durationMs: Date.now() - startTime,
    })

    // Drain pending queue — loop, not recursion.
    const next = runRegistry.dequeue(sessionKey)
    if (next != null) {
      next.resolve()
    }
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout()
      reject(new HarnessTimeoutError(`Harness did not respond within ${timeoutMs}ms`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    clearTimeout(timer)
  }
}

async function safeSend(
  connector: ConnectorInterface,
  chatId: string,
  text: string,
): Promise<void> {
  try {
    await connector.send({ chatId }, text)
  } catch {
    // Best-effort error message delivery.
  }
}
