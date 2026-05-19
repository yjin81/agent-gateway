// core/reliability.ts — send_with_retry and chunk_message (Section 5.4)

import type { ConnectorInterface, DeliveryTarget, MediaItem } from '../connectors/types.js'
import { ConnectorSendError } from '../lib/errors.js'
import { logger } from '../lib/logger.js'

const MAX_RETRIES = 2
const BASE_BACKOFF_MS = 500

/**
 * Send text (and optional media) with exponential backoff retry.
 * - Network timeout: do NOT retry (idempotency concern).
 * - Rate limit (HTTP 429): retry with backoff.
 * - Formatting error: strip formatting, retry once as plain text.
 * Throws ConnectorSendError if all retries exhausted.
 */
export async function sendWithRetry(
  connector: ConnectorInterface,
  target: DeliveryTarget,
  text: string,
  media?: MediaItem[],
  maxRetries = MAX_RETRIES,
): Promise<void> {
  let lastErr: unknown
  let currentText = text

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await connector.send(target, currentText, media)
      if (result.ok) return
      throw new Error('connector.send() returned ok: false')
    } catch (err) {
      lastErr = err
      const isTimeout = isTimeoutError(err)
      const isRateLimit = isRateLimitError(err)

      if (isTimeout) {
        // Don't retry — message may have been delivered.
        logger.warn(
          { accountId: connector.accountId, chatId: target.chatId, attempt },
          'sendWithRetry: network timeout — not retrying',
        )
        throw new ConnectorSendError('Network timeout during send', {
          cause: String(err),
          chatId: target.chatId,
        })
      }

      if (attempt === maxRetries) break

      if (isRateLimit) {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5)
        logger.warn(
          { accountId: connector.accountId, chatId: target.chatId, attempt, backoffMs: backoff },
          'sendWithRetry: rate limited — retrying',
        )
        await sleep(backoff)
        continue
      }

      // Formatting error heuristic — strip formatting and try once as plain text.
      if (attempt === 0 && isFormattingError(err)) {
        currentText = stripMarkdown(currentText)
        logger.warn(
          { accountId: connector.accountId, chatId: target.chatId },
          'sendWithRetry: formatting error — retrying as plain text',
        )
        continue
      }

      // Generic retry with backoff.
      const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt)
      await sleep(backoff)
    }
  }

  throw new ConnectorSendError('All send retries exhausted', {
    cause: String(lastErr),
    chatId: target.chatId,
  })
}

/** Chunk a long message into platform-compliant segments. */
export function chunkMessage(
  text: string,
  maxLength: number,
  lengthFn: (s: string) => number = (s) => s.length,
): string[] {
  if (lengthFn(text) <= maxLength) return [text]

  const chunks: string[] = []
  let remaining = text
  let inCodeBlock = false
  let codeFence = ''

  while (remaining.length > 0) {
    // Reserve space for chunk suffix "(N/M)" — max 7 chars.
    const effectiveMax = maxLength - 7

    if (lengthFn(remaining) <= effectiveMax) {
      chunks.push(remaining)
      break
    }

    // Find the best split point within effectiveMax.
    let splitAt = findSplitPoint(remaining, effectiveMax, lengthFn)

    const chunk = remaining.slice(0, splitAt)
    remaining = remaining.slice(splitAt)

    // Handle code fence continuity.
    const fenceMatch = chunk.match(/```(\w*)/g)
    if (fenceMatch != null) {
      const openCount = (chunk.match(/```/g) ?? []).length
      if (openCount % 2 !== 0) {
        // Odd number of fences — this chunk has an unclosed code block.
        inCodeBlock = !inCodeBlock
        const langMatch = chunk.match(/```(\w+)/)
        codeFence = langMatch?.[1] ?? ''
      }
    }

    let finalChunk = chunk
    if (inCodeBlock && remaining.length > 0) {
      finalChunk = chunk + '\n```'
    }

    chunks.push(finalChunk.trim())

    if (inCodeBlock && remaining.length > 0) {
      remaining = '```' + codeFence + '\n' + remaining.trimStart()
    }
  }

  // Append "(1/N)" suffixes.
  const total = chunks.length
  return chunks.map((c, i) => (total > 1 ? `${c}\n(${i + 1}/${total})` : c))
}

function findSplitPoint(
  text: string,
  maxLength: number,
  lengthFn: (s: string) => number,
): number {
  // Binary-search for the longest prefix within maxLength.
  let lo = 1
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (lengthFn(text.slice(0, mid)) <= maxLength) lo = mid
    else hi = mid - 1
  }
  const hardCut = lo

  // Prefer to split on a newline.
  const newline = text.lastIndexOf('\n', hardCut)
  if (newline > hardCut / 2) return newline + 1

  // Fall back to space.
  const space = text.lastIndexOf(' ', hardCut)
  if (space > hardCut / 2) return space + 1

  return hardCut
}

function stripMarkdown(text: string): string {
  // Remove common Markdown/MarkdownV2 tokens.
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/`/g, ''))
    .replace(/`[^`]+`/g, (m) => m.replace(/`/g, ''))
    .replace(/[*_~|[\]()>#+\-={}!\\]/g, '')
}

function isTimeoutError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === 'AbortError' || err.message.toLowerCase().includes('timeout')
  }
  return false
}

function isRateLimitError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.message.includes('429') || err.message.toLowerCase().includes('rate limit')
  }
  return false
}

function isFormattingError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.message.toLowerCase().includes('format') || err.message.includes('400')
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
