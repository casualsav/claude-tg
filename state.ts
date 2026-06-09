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
import type { Access, Session, PendingMultiSelect, FreeTextPrompt, ChatPrompt } from './types.ts'

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

// ---- Live mirror ----
export const mirrorMsgIds = new Map<string, number>()   // chat_id → the live mirror message id

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

// ---- Session names / pins ----
export const sessionNames = new Map<string, string>()
export const renameReplyTargets = new Set<string>()           // `${chatId}:${messageId}` of list "Rename" prompts
export const nameReplyTargets = new Map<string, string>()      // `${chatId}:${messageId}` → paneId of "Name" prompts
export const sessionPins = new Map<string, number>()
export const pinTextCache = new Map<string, string>()   // last rendered text per chat — skip no-op edits on the 10s refresh
export const newSessionReplyTargets = new Set<string>()   // `${chatId}:${messageId}` of folder prompts
