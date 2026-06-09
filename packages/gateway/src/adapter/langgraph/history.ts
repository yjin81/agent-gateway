// adapter/langgraph/history.ts
// SQLite-backed conversation history for LangGraphAdapter.
//
// Each row stores one message (human or AI) for a session. The adapter loads
// history before invoking the graph and appends the new human + AI messages
// after each turn. On isNew or wasAutoReset, history is cleared first.

import Database from 'better-sqlite3'
import { HumanMessage, AIMessage, BaseMessage } from '@langchain/core/messages'

interface HistoryRow {
  role: 'human' | 'ai'
  content: string
  timestamp: number
}

export class MessageHistory {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS langgraph_history (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        role      TEXT NOT NULL,
        content   TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_lgh_session
        ON langgraph_history (session_key, id);
    `)
  }

  /** Load all messages for a session in chronological order. */
  load(sessionKey: string): BaseMessage[] {
    const rows = this.db
      .prepare<[string], HistoryRow>(
        'SELECT role, content, timestamp FROM langgraph_history WHERE session_key = ? ORDER BY id ASC',
      )
      .all(sessionKey)

    return rows.map((row) =>
      row.role === 'human'
        ? new HumanMessage(row.content)
        : new AIMessage(row.content),
    )
  }

  /** Append a human message then an AI message for a completed turn. */
  append(sessionKey: string, humanText: string, aiText: string): void {
    const now = Date.now()
    const insert = this.db.prepare(
      'INSERT INTO langgraph_history (session_key, role, content, timestamp) VALUES (?, ?, ?, ?)',
    )
    const transaction = this.db.transaction(() => {
      insert.run(sessionKey, 'human', humanText, now)
      insert.run(sessionKey, 'ai', aiText, now)
    })
    transaction()
  }

  /** Delete all history for a session (called on isNew / wasAutoReset). */
  clear(sessionKey: string): void {
    this.db
      .prepare('DELETE FROM langgraph_history WHERE session_key = ?')
      .run(sessionKey)
  }

  close(): void {
    this.db.close()
  }
}
