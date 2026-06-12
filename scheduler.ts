// Scheduled-message domain module.
//
// Owns the queue of future messages (persisted to disk), their setTimeout arming, and the
// Telegram-facing list/cancel UI. Extracted from daemon.ts as the first Phase 3 domain carve.
//
// The daemon wires it once via initScheduler(): the scheduler depends on the bot, the access
// loader, and a single injectToPane(paneId, text) callback that hides all the daemon's
// focus/PaneWatcher logic. Everything else here is self-contained.
import { Bot, InlineKeyboard, type Context } from 'grammy'
import { join } from 'node:path'
import { STATE_DIR, readJsonFile, writeJsonFile } from './common.ts'
import { escapeHtml } from './markdown.ts'
import { paneAlive } from './pane-io.ts'
import { fmtWhen, nextRecurrence, recurrenceLabel } from './time.ts'
import type { Access, ScheduledMessage } from './types.ts'

const SCHEDULED_MSGS_FILE = join(STATE_DIR, 'scheduled-messages.json')
export const MAX_TIMEOUT = 2_147_483_647   // setTimeout's ceiling (~24.8 days); longer waits re-arm

type SchedulerDeps = {
  bot: Bot
  loadAccess: () => Access
  // Deliver `text` into a pane, returning whether it landed. The daemon implements this with
  // its own focus state: inject (with watcher pause) if the pane is focused, else plain paste.
  injectToPane: (paneId: string, text: string) => Promise<boolean>
  // Recurring job whose session is gone: spawn a fresh session in `cwd`, wait for the REPL, and
  // deliver there — cron jobs outlive their sessions. Returns the new pane id, or null when the
  // spawn/delivery failed.
  reviveAndInject: (cwd: string, text: string) => Promise<string | null>
}

let deps: SchedulerDeps
let scheduledMsgs: ScheduledMessage[] = []
const scheduledTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function initScheduler(d: SchedulerDeps): void { deps = d }

function saveScheduledMsgs(): void { writeJsonFile(SCHEDULED_MSGS_FILE, scheduledMsgs) }

function armScheduled(msg: ScheduledMessage): void {
  const prev = scheduledTimers.get(msg.id); if (prev) clearTimeout(prev)
  const delay = Math.min(Math.max(0, msg.fireAt - Date.now()), MAX_TIMEOUT)
  scheduledTimers.set(msg.id, setTimeout(() => void fireScheduled(msg.id), delay))
}

export function cancelScheduled(id: string): void {
  const t = scheduledTimers.get(id); if (t) clearTimeout(t)
  scheduledTimers.delete(id)
  scheduledMsgs = scheduledMsgs.filter(m => m.id !== id)
  saveScheduledMsgs()
}

async function fireScheduled(id: string): Promise<void> {
  const msg = scheduledMsgs.find(m => m.id === id)
  if (!msg) return
  if (Date.now() < msg.fireAt - 1000) { armScheduled(msg); return }   // capped long wait → re-arm
  if (msg.recur) {
    // Recurring: roll to the next occurrence instead of removing (cancel is the only way out).
    msg.fireAt = nextRecurrence(msg.recur, Date.now())
    saveScheduledMsgs()
    armScheduled(msg)
  } else {
    scheduledMsgs = scheduledMsgs.filter(m => m.id !== id)
    scheduledTimers.delete(id)
    saveScheduledMsgs()
  }
  await deliverScheduled(msg)
}

async function deliverScheduled(msg: ScheduledMessage): Promise<void> {
  const chats = msg.chatId ? [msg.chatId] : deps.loadAccess().allowFrom
  // Thread the note into the topic the message was scheduled from (forum mode). If that topic
  // is gone by fire time the threaded send fails — retry plain so the note still lands.
  const note = (t: string) => {
    for (const c of chats) {
      void deps.bot.api.sendMessage(c, t, { parse_mode: 'HTML', ...(msg.thread ? { message_thread_id: msg.thread } : {}) })
        .catch(() => msg.thread ? deps.bot.api.sendMessage(c, t, { parse_mode: 'HTML' }).catch(() => {}) : undefined)
    }
  }
  if (!msg.paneId || !(await paneAlive(msg.paneId))) {
    // Recurring jobs outlive sessions: revive one in the job's folder and deliver there. The new
    // pane becomes the job's target so the next fire injects directly.
    if (msg.recur && msg.cwd) {
      note(`⏰ <b>${escapeHtml(msg.sessionLabel)}</b> is gone — starting a session in <code>${escapeHtml(msg.cwd)}</code> for the scheduled job…`)
      const pane = await deps.reviveAndInject(msg.cwd, msg.text)
      if (pane) { msg.paneId = pane; saveScheduledMsgs() }   // next fire injects directly
      note(pane
        ? `📤 Sent the scheduled message to the new session:\n\n${escapeHtml(msg.text)}`
        : `⚠️ Couldn't start a session in <code>${escapeHtml(msg.cwd)}</code> — this run was skipped.`)
      return
    }
    note(`⏰ Couldn't send your scheduled message — <b>${escapeHtml(msg.sessionLabel)}</b> is gone:\n\n${escapeHtml(msg.text)}`)
    return
  }
  const ok = await deps.injectToPane(msg.paneId, msg.text)
  note(ok
    ? `📤 Sent your scheduled message to <b>${escapeHtml(msg.sessionLabel)}</b>:\n\n${escapeHtml(msg.text)}`
    : `⚠️ Couldn't deliver your scheduled message to <b>${escapeHtml(msg.sessionLabel)}</b>.`)
}

// Queue a freshly-built message: persist, arm its timer, and report. Called by the daemon when
// a user replies to a /schedule force-reply.
export function addScheduled(msg: ScheduledMessage): void {
  scheduledMsgs.push(msg)
  saveScheduledMsgs()
  armScheduled(msg)
}

export function scheduledCount(): number { return scheduledMsgs.length }

export function loadScheduledMsgs(): void {
  const arr = readJsonFile<unknown>(SCHEDULED_MSGS_FILE, null)
  if (Array.isArray(arr)) scheduledMsgs = arr.filter((m): m is ScheduledMessage =>
    m && typeof m.id === 'string' && typeof m.fireAt === 'number' && typeof m.text === 'string')
  for (const m of scheduledMsgs) armScheduled(m)   // overdue ones fire ~immediately
}

export function scheduledListText(): string {
  const lines = scheduledMsgs.map((m, i) =>
    `${i + 1}. ${m.recur ? `🔁 ${recurrenceLabel(m.recur)} (next ${fmtWhen(m.fireAt)})` : fmtWhen(m.fireAt)} → <b>${escapeHtml(m.sessionLabel)}</b>: ${escapeHtml(m.text.length > 40 ? m.text.slice(0, 39) + '…' : m.text)}`)
  return `📅 <b>Scheduled messages</b>\n${lines.join('\n')}\n\nTap to cancel:`
}

export function scheduledCancelKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard()
  scheduledMsgs.forEach((m, i) => { kb.text(`🗑 ${i + 1}`, `schedcancel:${m.id}`); if ((i + 1) % 4 === 0) kb.row() })
  return kb
}

export async function scheduleDashboard(ctx: Context): Promise<void> {
  if (scheduledMsgs.length === 0) {
    await ctx.reply('📅 <b>No scheduled messages.</b>\n\nSchedule one with <code>/cron 2h ping the server</code> (also: <code>every 09:00 …</code> or a 5-field cron expr), or tap ➕ to compose one.',
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('➕ Add', 'sched:add') })
    return
  }
  const kb = scheduledCancelKeyboard()
  kb.row().text('➕ Add', 'sched:add')
  await ctx.reply(scheduledListText(), { parse_mode: 'HTML', reply_markup: kb })
}
