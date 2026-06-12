// Shared data shapes used across the daemon and its state store.
//
// These were defined inline in daemon.ts, which boots the bot on import and so can't be
// imported from. Pulling the pure type declarations here lets state.ts (and future domain
// modules) reference them without dragging in the daemon's side effects.
import type net from 'node:net'
import type { DaemonToShim } from './common.ts'
import type { PromptOption } from './prompt.ts'

export type PendingEntry = { senderId: string; chatId: string; createdAt: number; expiresAt: number; replies: number }
export type GroupPolicy = { requireMention: boolean; allowFrom: string[] }

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
  renderMarkdown?: boolean
  terminalMirror?: 'tools' | 'digest' | 'off' | boolean
  sessionPin?: boolean
  shipButtons?: boolean   // post Diff/Commit/Push/PR buttons after turns that dirty the git tree (default off)
  budgetDaily?: number    // daily $ cap — warn at 80% and 100% of summed session cost growth (unset = off)
  topicOnEnd?: 'close' | 'delete'   // ended session's topic: close (keep history, default) or delete (tab disappears)
  scheduleTz?: string     // IANA timezone for recurring /schedule wall-clock times (default America/Los_Angeles)
  batchAllow?: boolean    // 2+ permission prompts in one turn offer "Allow all this turn" (default on)
  tts?: { mode: 'off' | 'all'; engine: 'piper' | 'openai' | 'elevenlabs'; voice?: string }   // voice replies (ROADMAP #15); voice = piper voice id
  updateChecks?: boolean  // daily update-available notification for bridge + Claude (default on)
  replyMode?: 'thoughts' | 'tools' | 'hybrid' | 'off' | 'all' | 'final' | 'stream' | 'live'   // all/final/stream/live are legacy aliases
}

// The focused session's writer mirror (socket + write fn).
export type ActiveShim = {
  socket: net.Socket
  write: (msg: DaemonToShim) => void
}

// Every connected shim is a session; the daemon keeps ALL of them and tracks which is focused.
export type Session = {
  socket: net.Socket
  write: (msg: DaemonToShim) => void
  paneId: string | null
  label: string
  subscribedAt: number
}

export type PendingMultiSelect = { paneId: string; options: PromptOption[]; selected: Set<number> }
export type FreeTextPrompt = { paneId: string; downCount: number; tabbed: boolean; question: string }
export type ChatPrompt = { paneId: string; downCount: number; tabbed: boolean; useEscape: boolean }
export type ScheduledMessage = { id: string; fireAt: number; chatId: string; paneId: string | null; sessionLabel: string; text: string; thread?: number; recur?: import('./time.ts').Recurrence; cwd?: string }   // cwd: revive folder when a recurring job's session is gone
