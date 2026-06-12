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
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { STATE_DIR, readJsonFile, writeJsonFile } from './common.ts'
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
export const chatPrompts = new Map<string, ChatPrompt>()

// ---- Force-reply targets ----
// One registry for every "reply to this message" continuation, keyed `${chatId}:${messageId}`
// of the prompt we sent. The kind discriminates what the user's reply means; the payload is
// whatever that flow needs to finish. (Was seven parallel per-feature maps.)
export type ReplyTarget =
  | ({ kind: 'freetext' } & Omit<FreeTextPrompt, 'question'>)   // type into a TUI free-text field
  | { kind: 'authurl' }                                          // login code for a relayed sign-in link (not consumed on use — retries allowed)
  | { kind: 'topiccreate'; threadId: number; name: string }      // folder for a user-created forum topic's session
  | { kind: 'schedule'; fireAt: number; paneId: string | null; sessionLabel: string; thread?: number }   // message body; time already fixed
  | { kind: 'schedcompose'; paneId: string | null; sessionLabel: string; thread?: number }               // "time message" in one line
  | { kind: 'md'; path: string; display: string }                // contents for a /md file
  | { kind: 'acctname'; thread?: number }                        // name for a new Claude account (settings → Accounts → ➕)
  | { kind: 'newsession'; anchor?: boolean }                     // folder for /new in General (spawn → own topic; anchor → becomes the General base session)
  | { kind: 'ttskey'; engine: 'openai' | 'elevenlabs' }          // API key for a hosted TTS engine (settings → 🔊 Voice replies)
  | { kind: 'stucktext'; paneId: string }                        // raw text typed into a wedged pane (stuck-screen dump)
  | { kind: 'budget'; panelMsgId?: number }                      // daily $ cap (or 'off') from the /budget panel's set button
export const replyTargets = new Map<string, ReplyTarget>()

// ---- Relay tracking ----
// Persisted across restarts: this map used to be memory-only, so every deploy/crash re-primed
// each transcript's cursor to its current tail — and a reply written during the restart window
// (a deploy lands mid-turn constantly in dev) was silently swallowed, never relayed. Writing
// through on set() and restoring at boot lets the relay loops resume from the true cursor and
// ship anything that landed while the daemon was down. Debounced one tick; cursors for
// transcripts deleted since the last run are dropped on load.
const RELAY_CURSORS_FILE = join(STATE_DIR, 'relay-cursors.json')
class PersistedCursorMap extends Map<string, string> {
  private timer: ReturnType<typeof setTimeout> | null = null
  override set(file: string, uuid: string): this {
    super.set(file, uuid)
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        writeJsonFile(RELAY_CURSORS_FILE, Object.fromEntries(this))
      }, 250)
      this.timer.unref?.()
    }
    return this
  }
}
export const lastRelayedByFile: Map<string, string> = new PersistedCursorMap()
for (const [file, uuid] of Object.entries(readJsonFile<Record<string, string>>(RELAY_CURSORS_FILE, {}))) {
  if (existsSync(file)) lastRelayedByFile.set(file, uuid)
}

// ---- Off-MCP panes ----
export const offMcpPanes = new Set<string>()

// ---- Usage warnings ----
export const usageWarnState = new Map<string, { resetKey: string; threshold: number; at: number }>()

// ---- Voice ----
export const voiceNudged = new Set<string>()

// ---- Session names ----
export const sessionNames = new Map<string, string>()

// ---- /md overwrite confirmation ----
// When the target already exists we stash the typed contents under a short id and ask for an
// overwrite confirmation (callback data can't carry the path/body, so it carries just the id).
export const mdOverwritePending = new Map<string, { path: string; display: string; contents: string }>()
