// connectors/wechat/context-token.ts — Disk-backed context_token store for iLink Bot API
//
// iLink requires every outbound message to echo the latest context_token
// received from the peer.  Tokens are persisted to disk so the bot can resume
// after a restart without losing existing conversations.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { logger } from '../../lib/logger.js'

export class ContextTokenStore {
  private readonly storeDir: string
  private readonly cache = new Map<string, string>() // `${accountId}:${chatId}` -> token

  constructor(dataDir: string) {
    this.storeDir = path.join(dataDir, 'weixin')
  }

  private filePath(accountId: string): string {
    return path.join(this.storeDir, `${accountId}.context-tokens.json`)
  }

  private cacheKey(accountId: string, chatId: string): string {
    return `${accountId}:${chatId}`
  }

  /** Load persisted tokens for an account into memory. */
  restore(accountId: string): void {
    const fp = this.filePath(accountId)
    if (!fs.existsSync(fp)) return
    try {
      const raw = JSON.parse(fs.readFileSync(fp, 'utf-8')) as Record<string, unknown>
      let count = 0
      for (const [chatId, token] of Object.entries(raw)) {
        if (typeof token === 'string' && token) {
          this.cache.set(this.cacheKey(accountId, chatId), token)
          count++
        }
      }
      if (count > 0) {
        logger.info({ accountId, count }, 'WechatConnector: restored context tokens')
      }
    } catch (err) {
      logger.warn({ accountId, err }, 'WechatConnector: failed to restore context tokens')
    }
  }

  get(accountId: string, chatId: string): string | undefined {
    return this.cache.get(this.cacheKey(accountId, chatId))
  }

  set(accountId: string, chatId: string, token: string): void {
    this.cache.set(this.cacheKey(accountId, chatId), token)
    this.persist(accountId)
  }

  private persist(accountId: string): void {
    const prefix = `${accountId}:`
    const payload: Record<string, string> = {}
    for (const [key, value] of this.cache.entries()) {
      if (key.startsWith(prefix)) {
        payload[key.slice(prefix.length)] = value
      }
    }
    try {
      fs.mkdirSync(this.storeDir, { recursive: true })
      const tmp = this.filePath(accountId) + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf-8')
      fs.renameSync(tmp, this.filePath(accountId))
    } catch (err) {
      logger.warn({ accountId, err }, 'WechatConnector: failed to persist context tokens')
    }
  }
}
