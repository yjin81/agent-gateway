// core/session/registry.ts — SessionRegistry backed by better-sqlite3 (WAL mode)

import Database from 'better-sqlite3'
import { SessionRegistryError } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'

export interface SessionRecord {
  sessionKey: string
  createdAt: number
  lastTouchedAt: number
  isNew: boolean
  wasAutoReset: boolean
}

export class SessionRegistry {
  private db: Database.Database

  constructor(dbPath: string) {
    try {
      this.db = new Database(dbPath)
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('foreign_keys = ON')
      this.initialize()
    } catch (err) {
      throw new SessionRegistryError(`Failed to open session registry at ${dbPath}`, {
        cause: String(err),
      })
    }
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_key     TEXT    PRIMARY KEY,
        created_at      INTEGER NOT NULL,
        last_touched_at INTEGER NOT NULL,
        is_new          INTEGER NOT NULL DEFAULT 1,
        was_auto_reset  INTEGER NOT NULL DEFAULT 0
      )
    `)
  }

  /**
   * Get an existing session or create a new one.
   * Hard failure — throws SessionRegistryError on SQLite error.
   */
  getOrCreate(sessionKey: string, idleTimeoutMs: number): SessionRecord {
    const now = Date.now()

    const existing = this.db
      .prepare<[string], { session_key: string; created_at: number; last_touched_at: number; is_new: number; was_auto_reset: number }>(
        'SELECT * FROM sessions WHERE session_key = ?',
      )
      .get(sessionKey)

    if (existing == null) {
      // New session
      try {
        this.db
          .prepare(
            'INSERT INTO sessions (session_key, created_at, last_touched_at, is_new, was_auto_reset) VALUES (?, ?, ?, 1, 0)',
          )
          .run(sessionKey, now, now)
      } catch (err) {
        throw new SessionRegistryError(`Failed to create session: ${sessionKey}`, {
          cause: String(err),
        })
      }
      return {
        sessionKey,
        createdAt: now,
        lastTouchedAt: now,
        isNew: true,
        wasAutoReset: false,
      }
    }

    // Check idle-timeout OR explicit reset (from /new or /reset command)
    const idleElapsed = now - existing.last_touched_at
    const wasAutoReset = idleElapsed > idleTimeoutMs || existing.was_auto_reset === 1

    const record: SessionRecord = {
      sessionKey: existing.session_key,
      createdAt: existing.created_at,
      lastTouchedAt: existing.last_touched_at,
      isNew: existing.is_new === 1,
      wasAutoReset,
    }

    if (wasAutoReset) {
      // Soft write — log on failure but continue (Section 17.3)
      try {
        this.db
          .prepare(
            'UPDATE sessions SET last_touched_at = ?, is_new = 1, was_auto_reset = 1 WHERE session_key = ?',
          )
          .run(now, sessionKey)
        record.isNew = true
        record.wasAutoReset = true
        record.lastTouchedAt = now
      } catch (err) {
        logger.error({ sessionKey, err }, 'SessionRegistry: failed to write idle-timeout reset')
      }
    }

    return record
  }

  /**
   * Update lastTouchedAt for a session after a successful turn.
   * Soft write — logs on failure but does not throw.
   */
  touch(sessionKey: string): void {
    try {
      this.db
        .prepare('UPDATE sessions SET last_touched_at = ?, is_new = 0, was_auto_reset = 0 WHERE session_key = ?')
        .run(Date.now(), sessionKey)
    } catch (err) {
      logger.error({ sessionKey, err }, 'SessionRegistry: failed to touch session')
    }
  }

  /**
   * Mark session as reset (wasAutoReset = true, isNew = true).
   * Used by /new and /reset commands.
   * Soft write.
   */
  resetSession(sessionKey: string): void {
    try {
      this.db
        .prepare(
          'UPDATE sessions SET last_touched_at = ?, is_new = 1, was_auto_reset = 1 WHERE session_key = ?',
        )
        .run(Date.now(), sessionKey)
    } catch (err) {
      logger.error({ sessionKey, err }, 'SessionRegistry: failed to reset session')
    }
  }

  /**
   * List sessions ordered by most-recently touched (read-only admin view).
   * Soft read — returns an empty array on failure.
   */
  list(limit = 100): SessionRecord[] {
    try {
      const rows = this.db
        .prepare<[number], { session_key: string; created_at: number; last_touched_at: number; is_new: number; was_auto_reset: number }>(
          'SELECT * FROM sessions ORDER BY last_touched_at DESC LIMIT ?',
        )
        .all(limit)
      return rows.map((r) => ({
        sessionKey: r.session_key,
        createdAt: r.created_at,
        lastTouchedAt: r.last_touched_at,
        isNew: r.is_new === 1,
        wasAutoReset: r.was_auto_reset === 1,
      }))
    } catch (err) {
      logger.error({ err }, 'SessionRegistry: failed to list sessions')
      return []
    }
  }

  close(): void {
    this.db.close()
  }
}
