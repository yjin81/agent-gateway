// core/audit.ts — Append-only audit log (Section 5.6)

import Database from 'better-sqlite3'
import { logger } from '../lib/logger.js'

export type TurnOutcome = 'dropped' | 'handled' | 'observed' | 'dispatched' | 'error'

export interface AuditEntry {
  timestamp: number
  sessionKey: string
  platform: string
  accountId: string
  outcome: TurnOutcome
  messageId: string
  durationMs: number
  error?: string
}

export class AuditLog {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
    this.initialize()
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp   INTEGER NOT NULL,
        session_key TEXT    NOT NULL,
        platform    TEXT    NOT NULL,
        account_id  TEXT    NOT NULL,
        outcome     TEXT    NOT NULL,
        message_id  TEXT    NOT NULL,
        duration_ms INTEGER NOT NULL,
        error       TEXT
      )
    `)
  }

  /** Append an entry. Soft failure — logs on error but does not throw. */
  append(entry: AuditEntry): void {
    try {
      this.db
        .prepare(`
          INSERT INTO audit_log
            (timestamp, session_key, platform, account_id, outcome, message_id, duration_ms, error)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          entry.timestamp,
          entry.sessionKey,
          entry.platform,
          entry.accountId,
          entry.outcome,
          entry.messageId,
          entry.durationMs,
          entry.error ?? null,
        )
    } catch (err) {
      logger.error({ err, entry }, 'AuditLog: failed to append entry')
    }
  }

  /**
   * Record an admin config-change event. Reuses the audit_log table: the
   * `platform` column carries "admin", `message_id` carries the change summary,
   * and `error` carries an optional failure reason.
   */
  appendConfigChange(summary: string, outcome: TurnOutcome = 'handled', error?: string): void {
    this.append({
      timestamp: Date.now(),
      sessionKey: 'admin',
      platform: 'admin',
      accountId: 'admin',
      outcome,
      messageId: summary,
      durationMs: 0,
      ...(error != null ? { error } : {}),
    })
  }

  /** Return the most recent audit entries (newest first). Soft read. */
  recent(limit = 100): AuditEntry[] {
    try {
      const rows = this.db
        .prepare<[number], {
          timestamp: number
          session_key: string
          platform: string
          account_id: string
          outcome: string
          message_id: string
          duration_ms: number
          error: string | null
        }>('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
        .all(limit)
      return rows.map((r) => ({
        timestamp: r.timestamp,
        sessionKey: r.session_key,
        platform: r.platform,
        accountId: r.account_id,
        outcome: r.outcome as TurnOutcome,
        messageId: r.message_id,
        durationMs: r.duration_ms,
        ...(r.error != null ? { error: r.error } : {}),
      }))
    } catch (err) {
      logger.error({ err }, 'AuditLog: failed to read recent entries')
      return []
    }
  }
}
