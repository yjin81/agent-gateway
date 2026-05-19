// lib/logger.ts — Pino logger with standard gateway fields (Section 17.4)
// Import pino via require() wrapper so this ESM file can use it without type issues.

import pino from 'pino'
import type { Logger } from 'pino'

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'

/** Standard context fields carried on every log entry (Section 17.4). */
export interface LogContext {
  sessionKey?: string
  platform?: string
  accountId?: string
  messageId?: string
  durationMs?: number
  err?: unknown
}

function createLogger(level: LogLevel = 'info'): Logger {
  return pino({
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label }
      },
    },
    // Serialize Error objects under the `err` key.
    serializers: {
      err: pino.stdSerializers.err,
    },
  })
}

/** Module-level singleton — call setLogLevel() before first use if needed. */
let _logger = createLogger((process.env['GATEWAY_LOG_LEVEL'] as LogLevel | undefined) ?? 'info')

export function setLogLevel(level: LogLevel): void {
  _logger = createLogger(level)
}

export const logger: Logger = new Proxy({} as Logger, {
  get(_target, prop) {
    return (_logger as unknown as Record<string | symbol, unknown>)[prop]
  },
})
