// Queue for later (/queue) — extracted from daemon.ts (split plan #3).
//
// Per-session backlog persisted to later.json: plain items run when the session next sits at a
// normal prompt; @reset items (fireAt) additionally hold until the 5h usage window rolls over.
// The /queue command itself stays in daemon (bot wiring); this module owns the store + sweep.
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'
import { Bot } from 'grammy'
import { STATE_DIR, readJsonFile, writeJsonFile } from './common.ts'
import { escapeHtml } from './markdown.ts'
import { capturePane } from './pane-io.ts'
import { focus } from './state.ts'
import { paneForSession } from './topic-runtime.ts'
import { onNormalPrompt } from './prompt.ts'

type QueueDeps = {
  bot: Bot
  outboundTargetsFor: (paneId: string | null) => Promise<Array<{ chat: string; thread?: number }>>
  // Inject (focused, watcher-paused) or paste (background pane) — the daemon picks.
  deliverToPane: (paneId: string, text: string) => Promise<boolean>
}
let deps: QueueDeps
export function initQueue(d: QueueDeps): void { deps = d }

// ---- Queue for later (ROADMAP #3) ----
// /later <prompt> — a per-session backlog injected when the session goes idle ("when you're
// free", complementing /schedule's "at 3pm"). Persisted so a daemon restart keeps the queue;
// a 15s sweep injects the next item whenever a queued session sits at a normal prompt.
const LATER_FILE = join(STATE_DIR, 'later.json')
export type LaterItem = { text: string; queuedAt: number; fireAt?: number }   // fireAt: hold until the 5h limit window rolls over (ROADMAP #10)
export function readLater(): Record<string, LaterItem[]> {
  const raw = readJsonFile<Record<string, unknown> | null>(LATER_FILE, null)
  if (!raw) return {}
  const out: Record<string, LaterItem[]> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!Array.isArray(v)) continue
    const items = v.filter((i): i is LaterItem => !!i && typeof (i as LaterItem).text === 'string')
    if (items.length) out[k] = items
  }
  return out
}
export function writeLater(map: Record<string, LaterItem[]>): void {
  for (const k of Object.keys(map)) if (!map[k].length) delete map[k]
  if (Object.keys(map).length === 0) { try { unlinkSync(LATER_FILE) } catch {}; return }
  writeJsonFile(LATER_FILE, map)
}

// Inject the next queued item into any session sitting at a normal prompt. One item per session
// per sweep; the injected turn keeps the session busy, so the next item waits for it to settle.
export async function sweepLaterQueues(): Promise<void> {
  const map = readLater()
  if (Object.keys(map).length === 0) return
  for (const [sid, items] of Object.entries(map)) {
    try {
      const pane = sid === 'focused' ? focus.activePaneId : await paneForSession(sid)
      if (!pane || !items.length) continue
      const cap = await capturePane(pane).catch(() => '')
      if (!cap || !onNormalPrompt(cap)) continue   // busy / menu up → not yet
      // First ELIGIBLE item: @reset items hold until their window rollover; plain items
      // behind them still run on idle (the queue isn't strictly FIFO across kinds).
      const idx = items.findIndex(i => !i.fireAt || i.fireAt <= Date.now())
      if (idx < 0) continue
      const item = items.splice(idx, 1)[0]
      writeLater(map)
      const ok = await deps.deliverToPane(pane, item.text)
      if (!ok) { items.unshift(item); writeLater(map); continue }   // pane wedged — retry next sweep
      for (const tg of await deps.outboundTargetsFor(pane)) {
        await deps.bot.api.sendMessage(tg.chat, `▶️ Queued task started: <i>${escapeHtml(item.text.slice(0, 160))}</i>`,
          { parse_mode: 'HTML', disable_notification: true, ...(tg.thread ? { message_thread_id: tg.thread } : {}) }).catch(() => {})
      }
    } catch { /* pane vanished mid-sweep — next pass */ }
  }
}
export const LATER_SWEEP_MS = 15_000
