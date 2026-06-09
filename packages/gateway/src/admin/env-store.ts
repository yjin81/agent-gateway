// admin/env-store.ts — View / edit / add / delete variables in the data/.env file.
//
// The gateway does not load this file itself: Docker injects it into the process
// environment at container-create time (compose `env_file`). Edits here persist
// to the file (the source of truth the operator maintains) and take effect the
// next time the container is recreated. Comments and ordering are preserved;
// existing variable lines are edited in place, new ones are appended.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'

export interface EnvVar {
  key: string
  value: string
}

/** Valid POSIX-ish env var name (what Docker / shells accept). */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
/** A `KEY=value` assignment line (not a comment). */
const ASSIGN_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/

export class EnvStore {
  constructor(private readonly envPath: string) {}

  /** True if `key` is a syntactically valid environment variable name. */
  static isValidKey(key: string): boolean {
    return KEY_RE.test(key)
  }

  private readLines(): string[] {
    if (!existsSync(this.envPath)) return []
    const content = readFileSync(this.envPath, 'utf8')
    if (content.length === 0) return []
    return content.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  }

  private writeLines(lines: string[]): void {
    writeFileSync(this.envPath, lines.join('\n') + '\n', 'utf8')
  }

  /** All assignment lines as {key, value}, in file order. Comments are skipped. */
  list(): EnvVar[] {
    const out: EnvVar[] = []
    for (const line of this.readLines()) {
      const m = ASSIGN_RE.exec(line)
      if (m == null) continue
      out.push({ key: m[1]!, value: m[2]!.trim() })
    }
    return out
  }

  /**
   * Create or update `key` to `value`. Existing lines are edited in place
   * (preserving position); new keys are appended. Throws on an invalid key name.
   */
  set(key: string, value: string): void {
    if (!EnvStore.isValidKey(key)) throw new Error(`Invalid env var name: ${key}`)
    const lines = this.readLines()
    const newLine = `${key}=${value}`
    const idx = lines.findIndex((line) => {
      const m = ASSIGN_RE.exec(line)
      return m != null && m[1] === key
    })
    if (idx === -1) lines.push(newLine)
    else lines[idx] = newLine
    this.writeLines(lines)
  }

  /** Remove `key`'s assignment line. Returns false if it was not present. */
  delete(key: string): boolean {
    const lines = this.readLines()
    const next = lines.filter((line) => {
      const m = ASSIGN_RE.exec(line)
      return !(m != null && m[1] === key)
    })
    if (next.length === lines.length) return false
    this.writeLines(next)
    return true
  }
}
