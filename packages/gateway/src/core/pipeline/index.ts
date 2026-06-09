// core/pipeline/index.ts — runTurn(): the 6-stage pipeline (Sections 5.1, 17.3)

import type { NormalizedMessage, ConnectorInterface, DeliveryTarget } from '../../connectors/types.js'
import type { AgentAdapter, AgentRequest, AgentResponse, StreamChunk } from '../../adapter/types.js'
import type { SessionRegistry } from '../session/registry.js'
import type { SessionRunRegistry } from '../session/run-slot.js'
import type { AuditLog, TurnOutcome } from '../audit.js'
import type { GatewayConfig } from '../../config/schema.js'

import { classify } from './classify.js'
import { keepTyping } from '../typing.js'
import { sendWithRetry } from '../reliability.js'
import {
  AdapterError,
  AdapterTimeoutError,
  AdapterAbortedError,
  ConnectorSendError,
  ApprovalTimeoutError,
} from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'
import { handleCommand } from '../commands/handlers.js'

export interface RunTurnDeps {
  connector: ConnectorInterface
  adapter: AgentAdapter
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
  const { connector, adapter, sessionRegistry, runRegistry, auditLog, config } = deps

  // ── Stage 2: CLASSIFY ─────────────────────────────────────────────────────
  const classified = classify(msg)
  logger.debug(
    { accountId: connector.accountId, messageId: msg.id, senderId: msg.sender.id, classified },
    'Stage 2 CLASSIFY',
  )
  if (classified.drop) {
    if (classified.reason === 'not-addressed') {
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
    // Do NOT call touch() after new/reset — it would overwrite the reset flags.
    const isResetCommand = turnClass.commandName === 'new' || turnClass.commandName === 'reset'
    if (!isResetCommand) {
      sessionRegistry.touch(sessionKey)
    }
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
    const request: AgentRequest = {
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

    // 5c. Call adapter — streaming path if available, otherwise non-streaming.
    logger.debug(
      { sessionKey, platform: connector.type, chatKind: msg.chat.kind, userId: msg.sender.id, message: msg.text, isNew: sessionRecord.isNew, mediaCount: msg.media.length, streaming: adapter.stream != null },
      'Stage 5 DISPATCH → adapter',
    )
    let response: AgentResponse
    let streamed = false
    try {
      if (adapter.stream != null) {
        response = await runStreaming(adapter, request, connector, { chatId: msg.chat.id }, config.gateway.adapterTimeoutMs, abortCtrl)
        streamed = true
      } else {
        response = await withTimeout(
          adapter.run(request),
          config.gateway.adapterTimeoutMs,
          () => abortCtrl.abort(),
        )
      }
    } catch (err) {
      if (err instanceof AdapterTimeoutError) {
        await safeSend(connector, msg.chat.id, 'The agent took too long to respond. Please try again.')
        logger.error({ sessionKey, platform: connector.type, accountId: connector.accountId, durationMs: Date.now() - startTime, err }, 'Stage 5: adapter timeout')
        outcome = 'error'
      } else if (err instanceof AdapterAbortedError) {
        // User-initiated abort (e.g. /stop) — send no message; /stop handler already notified the user.
        logger.info({ sessionKey, platform: connector.type }, 'Stage 5: adapter aborted by user')
        outcome = 'error'
      } else {
        await safeSend(connector, msg.chat.id, 'Something went wrong processing your message. Please try again.')
        logger.error({ sessionKey, platform: connector.type, accountId: connector.accountId, err }, 'Stage 5: adapter error')
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

    logger.debug(
      { sessionKey, text: response.text, mediaCount: response.media.length, interrupted: response.interrupted, durationMs: Date.now() - startTime },
      'Stage 5 DISPATCH ← adapter response',
    )

    // Interrupted turn — adapter cut short by abortSignal.
    if (response.interrupted) {
      outcome = 'dispatched'
      return outcome
    }

    // 5e. Send response text — only on the non-streaming path.
    // The streaming path already delivered text chunk-by-chunk (or buffered it)
    // inside runStreaming(); we must not send it again here.
    if (!streamed && response.text.trim()) {
      logger.debug(
        { sessionKey, chatId: msg.chat.id, textLength: response.text.length },
        'Stage 5 FINALIZE → delivering response to connector',
      )
      try {
        await sendWithRetry(connector, { chatId: msg.chat.id }, response.text)
      } catch (err) {
        if (err instanceof ConnectorSendError) {
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
      reject(new AdapterTimeoutError(`Adapter did not respond within ${timeoutMs}ms`))
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

// ── Streaming helper ──────────────────────────────────────────────────────────

/**
 * Run the adapter's stream() method, routing chunks to the connector.
 *
 * If the connector declares supportsStreaming = true, each chunk is forwarded
 * to connector.sendChunk() as it arrives (progressive delivery).
 *
 * If the connector does not support streaming, all chunks are buffered and
 * the assembled text is sent via sendWithRetry() once done: true is received —
 * identical to the non-streaming path from the user's perspective.
 *
 * The adapterTimeoutMs applies to the first chunk only. Subsequent chunks are
 * not individually timed out — the AbortSignal handles cancellation throughout.
 *
 * Throws AdapterTimeoutError / AdapterAbortedError / AdapterError on failure.
 */
async function runStreaming(
  adapter: AgentAdapter,
  request: AgentRequest,
  connector: ConnectorInterface,
  target: DeliveryTarget,
  adapterTimeoutMs: number,
  abortCtrl: AbortController,
): Promise<AgentResponse> {
  const iterable = adapter.stream!(request)
  const chunks: StreamChunk[] = []
  let firstChunkReceived = false

  // timeoutRace rejects with AdapterTimeoutError after adapterTimeoutMs if we
  // haven't received the first chunk yet. We settle it via resolveTimeout once
  // the first chunk arrives so it never causes an unhandled rejection.
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let resolveTimeout!: () => void
  const timeoutRace = new Promise<never>((_, reject) => {
    // We need a resolve handle to defuse the promise after first chunk.
    // Cast via a parallel resolve-only promise to keep the type clean.
    const defuse = new Promise<void>((res) => { resolveTimeout = res })
    void defuse // intentionally unused value; only the side-effect (resolveTimeout) matters
    timeoutTimer = setTimeout(() => {
      abortCtrl.abort()
      reject(new AdapterTimeoutError(`Adapter did not respond within ${adapterTimeoutMs}ms`))
    }, adapterTimeoutMs)
  })
  // Suppress unhandled-rejection noise on the timeout promise.
  timeoutRace.catch(() => undefined)

  try {
    const iterator = iterable[Symbol.asyncIterator]()
    while (true) {
      // Race each .next() call against the first-chunk timeout.
      const step = await (
        firstChunkReceived
          ? iterator.next()
          : Promise.race([iterator.next(), timeoutRace])
      ) as IteratorResult<StreamChunk>

      if (!firstChunkReceived) {
        firstChunkReceived = true
        clearTimeout(timeoutTimer)
        resolveTimeout()
      }

      if (step.done) break

      const chunk = step.value

      if (abortCtrl.signal.aborted) break

      chunks.push(chunk)
      const accumulated = chunks.map((c) => c.delta).join('')

      if (connector.supportsStreaming && connector.sendChunk != null) {
        await connector.sendChunk(target, chunk, accumulated)
      }

      if (chunk.done) break
    }

    // Empty iterable with no chunks — ensure timeout fires if still pending.
    if (!firstChunkReceived) {
      await timeoutRace
    }
  } finally {
    clearTimeout(timeoutTimer)
    resolveTimeout() // always defuse to avoid lingering unhandled rejection
  }

  const assembled = assembleResponse(chunks)

  // Buffer path: connector doesn't support streaming — deliver assembled text now.
  if (!connector.supportsStreaming && assembled.text.trim() && !assembled.interrupted) {
    await sendWithRetry(connector, target, assembled.text)
  }

  return assembled
}

/** Assemble a full AgentResponse from a sequence of StreamChunks. */
function assembleResponse(chunks: StreamChunk[]): AgentResponse {
  const text = chunks.map((c) => c.delta).join('')
  const last = chunks[chunks.length - 1]
  return {
    text,
    media: last?.media ?? [],
    interrupted: last?.interrupted ?? false,
  }
}
