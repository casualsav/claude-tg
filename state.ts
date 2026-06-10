// Daemon runtime state: the mutable registries the daemon coordinates through.
//
// These were ~25 free-floating module globals in daemon.ts (the graph flagged them as the
// "Daemon State & Config" cluster, cohesion 0.02 — a bag with no internal structure).
// Collecting the never-reassigned collections here gives them a single home and makes the
// daemon's state surface explicit and importable. They are exported under their original
// names, so daemon call sites are unchanged.
//
// NOTE: reassigned scalar `let` flags (focus pointers, relay/mirror counters) still live in
// daemon.ts; they migrate into their domain modules in a later phase.
import type { DaemonToShim } from './common.ts'
import type { Access, Session, PendingMultiSelect, FreeTextPrompt, ChatPrompt, ActiveShim } from './types.ts'
import type { PaneWatcher } from './pane-io.ts'

// ---- Focused-session pointers ----
// The daemon mirrors the focused session into these four live pointers so the rest of the code
// reads "the current pane/shim/watcher" without walking the session registry. They were reassigned
// module `let`s in daemon.ts; a holder object lets session logic (and any extracted module) read
// AND write them through a shared reference. setFocus() is the single writer.
export const focus = {
  activeShim: null as ActiveShim | null,
  activePaneId: null as string | null,
  paneWatcher: null as PaneWatcher | null,
  currentSessionId: null as string | null,
}

// ---- Access / prefs ----
export const _accessFileCache = new Map<string, { mtimeMs: number; size: number; data: Partial<Access> }>()

// ---- Onboarding ----
export const onboardedPanes = new Set<string>()
export const onboardingState = { tag: '', at: 0 }   // debounce: a screen repaints many times per second

// ---- Session registry ----
export const sessions = new Map<string, Session>()   // insertion-ordered; keyed by sessionId

// ---- Permission routing ----
// request_id → the writer of the session that asked, so allow/deny returns to the requesting
// session rather than whichever is focused.
export const permissionOrigin = new Map<string, (msg: DaemonToShim) => void>()

// ---- Interactive prompt state ----
export const pendingMultiSelect = new Map<string, PendingMultiSelect>()
export const freeTextPrompts = new Map<string, FreeTextPrompt>()
export const freeTextReplyTargets = new Map<string, Omit<FreeTextPrompt, 'question'>>()
export const chatPrompts = new Map<string, ChatPrompt>()
export const authUrlMessageIds = new Set<string>()

// ---- Relay / unread tracking ----
export const lastRelayedByFile = new Map<string, string>()
export const unreadNotified = new Map<string, string>()
export const unreadNotifMsgs = new Map<string, Map<string, number>>()

// ---- Off-MCP panes ----
export const offMcpPanes = new Set<string>()

// ---- Usage warnings ----
export const usageWarnState = new Map<string, { resetKey: string; threshold: number; at: number }>()

// ---- Voice ----
export const voiceNudged = new Set<string>()

// ---- Scheduled messages ----
// The fire-time queue + timers live in scheduler.ts; only the force-reply targets (the
// daemon's command/inbound plumbing) are shared here.
export const scheduleReplyTargets = new Map<string, { fireAt: number; paneId: string | null; sessionLabel: string }>()
// "➕ Add" on the /schedule dashboard: the reply carries BOTH the time and the message ("2h ping"),
// so fireAt is parsed from it — unlike scheduleReplyTargets where the time is already fixed.
export const scheduleComposeTargets = new Map<string, { paneId: string | null; sessionLabel: string }>()

// ---- Session names / pins ----
export const sessionNames = new Map<string, string>()
export const renameReplyTargets = new Set<string>()           // `${chatId}:${messageId}` of list "Rename" prompts
export const nameReplyTargets = new Map<string, string>()      // `${chatId}:${messageId}` → paneId of "Name" prompts
export const sessionPins = new Map<string, number>()
export const pinTextCache = new Map<string, string>()   // last rendered text per chat — skip no-op edits on the 10s refresh
export const newSessionReplyTargets = new Set<string>()   // `${chatId}:${messageId}` of folder prompts

// ---- /md: create a markdown file via force-reply ----
// `${chatId}:${messageId}` of the "send me the contents" prompt → the file to write.
export const mdReplyTargets = new Map<string, { path: string; display: string }>()
// When the target already exists we stash the typed contents under a short id and ask for an
// overwrite confirmation (callback data can't carry the path/body, so it carries just the id).
export const mdOverwritePending = new Map<string, { path: string; display: string; contents: string }>()
