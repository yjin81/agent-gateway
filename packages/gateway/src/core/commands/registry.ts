// core/commands/registry.ts — Central command registry (Section 5.5)

export interface CommandEntry {
  /** Canonical name (no leading slash). */
  name: string
  /** Aliases that resolve to this command. */
  aliases: string[]
  /** If true, this command bypasses the concurrency gate (Stage 4). */
  priority: boolean
  description: string
}

export const COMMAND_REGISTRY: CommandEntry[] = [
  // ── Priority commands ──────────────────────────────────────────────────────
  {
    name: 'stop',
    aliases: ['cancel'],
    priority: true,
    description: 'Abort the currently running agent turn.',
  },
  {
    name: 'new',
    aliases: ['reset', 'clear'],
    priority: true,
    description: 'Start a new session (clears history).',
  },
  {
    name: 'approve',
    aliases: ['yes'],
    priority: true,
    description: 'Approve a pending agent action.',
  },
  {
    name: 'deny',
    aliases: ['no', 'reject'],
    priority: true,
    description: 'Deny a pending agent action.',
  },

  // ── Session commands ───────────────────────────────────────────────────────
  {
    name: 'retry',
    aliases: [],
    priority: false,
    description: 'Re-send the last user message.',
  },
  {
    name: 'resume',
    aliases: [],
    priority: false,
    description: 'Switch to a named session.',
  },
  {
    name: 'title',
    aliases: [],
    priority: false,
    description: 'Set or show the current session title.',
  },
  {
    name: 'background',
    aliases: ['bg'],
    priority: false,
    description: 'Run a prompt in an isolated parallel session.',
  },

  // ── Utility commands ───────────────────────────────────────────────────────
  {
    name: 'status',
    aliases: [],
    priority: false,
    description: 'Show session info and connected platforms.',
  },
  {
    name: 'help',
    aliases: ['?'],
    priority: false,
    description: 'List available commands.',
  },
  {
    name: 'restart',
    aliases: [],
    priority: false,
    description: 'Drain active runs and restart the gateway.',
  },
]

export function findCommand(nameOrAlias: string): CommandEntry | undefined {
  const lower = nameOrAlias.toLowerCase()
  return COMMAND_REGISTRY.find((c) => c.name === lower || c.aliases.includes(lower))
}
