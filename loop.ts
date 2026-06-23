// Autonomous loop (/loop) — re-run one goal prompt until a check passes (split plan: domain module).
//
// Design: idle-driven re-prompt. A loop is a persisted per-session record; a 15s sweep (same
// cadence as the /queue backlog) waits for the session to sit at a normal prompt with a NEW
// final reply since the last injection — proof the iteration's turn actually ran and finished —
// then evaluates stop conditions and either ends the loop or re-injects the goal. Every
// iteration is an ordinary turn, so streaming, the mirror card, and permission relays behave
// exactly as they do for a hand-typed prompt.
//
// Setup is a reply-driven wizard in ONE self-editing card: check command → max iterations →
// budget ("unlimited" waives a limit; both waived needs an explicit "Start anyway"), then the
// same message becomes the live status card and finally the run summary. Completion is the
// daemon running the check command (objective); with no check it falls back to Claude printing
// LOOP_DONE — self-report, deliberately the weaker signal.
import { Bot, InlineKeyboard } from 'grammy'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'
import { exec } from './proc.ts'
import { STATE_DIR, readJsonFile, writeJsonFile } from './common.ts'
import { escapeHtml } from './markdown.ts'
import { scheduleEdit } from './edit-scheduler.ts'
import { capturePane, paneCwd, paneAlive } from './pane-io.ts'
import { focus } from './state.ts'
import { paneForSession } from './topic-runtime.ts'
import { onNormalPrompt, stripAnsi } from './prompt.ts'
import { parseStatusline } from './statusline.ts'
import { latestFinalReply, turnInProgress } from './transcript.ts'

type LoopDeps = {
  bot: Bot
  // Inject (focused, watcher-paused) or paste (background pane) — the daemon picks.
  deliverToPane: (paneId: string, text: string) => Promise<boolean>
  // Esc into the pane for "stop now" (focused watcher paused only when needed).
  paneKeys: (paneId: string, keys: string[], settle?: [number, number]) => Promise<boolean>
  // The pane's transcript via the daemon's stamped-@tg_transcript-first resolver.
  resolveTranscriptForPane: (paneId: string) => Promise<string | null>
}
let deps: LoopDeps
export function initLoop(d: LoopDeps): void { deps = d }

export type LoopStatus = 'wizard:check' | 'wizard:max' | 'wizard:budget' | 'wizard:time' | 'confirm' | 'running' | 'paused' | 'stopping'
export type LoopRecord = {
  goal: string
  status: LoopStatus
  check?: string            // shell command, exit 0 = done; absent = LOOP_DONE self-report
  maxIter?: number          // absent = explicitly unlimited
  budget?: number           // $ ceiling; absent = explicitly unlimited
  timeLimitMs?: number      // wall-clock ceiling from start; absent = explicitly unlimited
  iter: number              // 1-based, the iteration currently running (0 before start)
  spent: number             // $ accumulated from statusline cost deltas
  costBase?: number         // last statusline cost seen (delta/reset tracking, sweepBudget-style)
  warnedNoCost?: boolean    // budget set but the statusline never showed a $ figure — warned once
  lastReplyUuid: string     // final reply present when the current iteration was injected
  lastReplyText?: string    // normalized previous conclusion — the no-progress guard
  injectedAt?: number
  pausedKind?: 'noprogress' | 'stall' | 'checkbroken'
  chat: string
  thread?: number
  cardMsg?: number
  startedAt: number
  lastCheckNote?: string    // short "exit 1 — 3 tests failed" line for the card
}

const LOOPS_FILE = join(STATE_DIR, 'loops.json')
export const LOOP_SWEEP_MS = 15_000
const STALL_MS = 10 * 60_000        // injected but no new turn concluded → pause and ping
const CHECK_TIMEOUT_MS = 5 * 60_000

export function readLoops(): Record<string, LoopRecord> {
  const raw = readJsonFile<Record<string, unknown> | null>(LOOPS_FILE, null)
  if (!raw) return {}
  const out: Record<string, LoopRecord> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v && typeof (v as LoopRecord).goal === 'string' && typeof (v as LoopRecord).status === 'string') out[k] = v as LoopRecord
  }
  return out
}
export function writeLoops(map: Record<string, LoopRecord>): void {
  if (Object.keys(map).length === 0) { try { unlinkSync(LOOPS_FILE) } catch {}; return }
  writeJsonFile(LOOPS_FILE, map)
}

// ---- Reply parsing (wizard) ----
// `null` = invalid input (the card re-prompts); `{}` = the limit was explicitly waived.
const UNLIMITED_RE = /^["'“”]?\s*(unlimited|none|no ?limit|inf(inity)?|∞)\s*["'“”]?$/i
export function parseCheckReply(text: string): { check?: string } | null {
  const t = text.trim()
  if (!t) return null
  return UNLIMITED_RE.test(t) ? {} : { check: t }
}
export function parseMaxReply(text: string): { max?: number } | null {
  const t = text.trim()
  if (UNLIMITED_RE.test(t)) return {}
  const m = /^(\d+)$/.exec(t)
  const n = m ? parseInt(m[1], 10) : NaN
  return Number.isFinite(n) && n >= 1 ? { max: n } : null
}
export function parseBudgetReply(text: string): { budget?: number } | null {
  const t = text.trim()
  if (UNLIMITED_RE.test(t)) return {}
  const m = /^\$?(\d+(?:[.,]\d{1,2})?)$/.exec(t)
  const n = m ? parseFloat(m[1].replace(',', '.')) : NaN
  return Number.isFinite(n) && n > 0 ? { budget: n } : null
}
export function parseTimeReply(text: string): { ms?: number } | null {
  const t = text.trim()
  if (UNLIMITED_RE.test(t)) return {}
  const m = /^(\d+(?:\.\d+)?)\s*(h|hrs?|hours?|m|mins?|minutes?)$/i.exec(t)
  if (!m) return null
  const n = parseFloat(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  return { ms: Math.round(n * (/^h/i.test(m[2]) ? 3_600_000 : 60_000)) }
}

// ---- Iteration prompt ----
export function iterationPrompt(rec: Pick<LoopRecord, 'goal' | 'iter' | 'maxIter' | 'check'>): string {
  const head = `[/loop iteration ${rec.iter}${rec.maxIter ? ` of ${rec.maxIter}` : ''}]`
  const done = rec.check
    ? `This loop ends when \`${rec.check}\` exits 0 — run it yourself to verify progress before ending the turn.`
    : `When the goal is FULLY complete, end your reply with the single word LOOP_DONE on its own line. Never output that word otherwise.`
  return `${head} Continue working toward this goal:\n\n${rec.goal}\n\n${done}`
}

// ---- Boundary decision (pure, tested) ----
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
export type BoundaryDecision =
  | { action: 'stop'; kind: 'done' | 'user' | 'limit'; reason: string }
  | { action: 'pause'; reason: string }
  | { action: 'continue' }
// Order: explicit stop › objective success › self-report › hard limits › no-progress guard.
// Success outranks limits so a run that finishes ON its last iteration reads as done, not capped.
export function decideBoundary(rec: LoopRecord, replyText: string, checkOk: boolean | null = null, now: number = Date.now()): BoundaryDecision {
  if (rec.status === 'stopping') return { action: 'stop', kind: 'user', reason: 'stopped by user' }
  if (checkOk === true) return { action: 'stop', kind: 'done', reason: `check passed (<code>${escapeHtml(rec.check ?? '')}</code>)` }
  if (!rec.check && /^\s*LOOP_DONE\s*$/m.test(replyText)) return { action: 'stop', kind: 'done', reason: 'Claude reported the goal complete' }
  if (rec.budget !== undefined && rec.spent >= rec.budget) return { action: 'stop', kind: 'limit', reason: `budget reached ($${rec.spent.toFixed(2)} of $${rec.budget.toFixed(2)})` }
  if (rec.maxIter !== undefined && rec.iter >= rec.maxIter) return { action: 'stop', kind: 'limit', reason: `max iterations reached (${rec.maxIter})` }
  if (rec.timeLimitMs !== undefined && now - rec.startedAt >= rec.timeLimitMs) return { action: 'stop', kind: 'limit', reason: `time limit reached (${fmtDur(rec.timeLimitMs)})` }
  if (rec.lastReplyText && norm(replyText) === rec.lastReplyText) return { action: 'pause', reason: 'no progress — the last two conclusions are identical' }
  return { action: 'continue' }
}

// ---- Card rendering ----
const fmtLimit = (n: number | undefined, money: boolean) => n === undefined ? 'unlimited' : money ? `$${n.toFixed(2)}` : String(n)
function fmtDur(ms: number): string {
  const m = Math.round(ms / 60_000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`
}
function summaryLine(rec: LoopRecord): string {
  return `✅ ${rec.check ? `<code>${escapeHtml(rec.check)}</code>` : 'self-report'} · 🔂 ${fmtLimit(rec.maxIter, false)} · 💸 ${fmtLimit(rec.budget, true)} · ⏳ ${rec.timeLimitMs === undefined ? 'unlimited' : fmtDur(rec.timeLimitMs)}`
}
function cardHtml(rec: LoopRecord): string {
  const goal = `🔁 <b>Loop</b>: “${escapeHtml(rec.goal.slice(0, 200))}”`
  switch (rec.status) {
    case 'wizard:check':
      return `${goal}\n\n✅ <b>Check command?</b>\nReply with a shell command — exit 0 means the goal is done (e.g. <code>bun test</code>).\n<i>Reply "none" to rely on Claude reporting completion itself.</i>`
    case 'wizard:max':
      return `${goal}\n✅ Check: ${rec.check ? `<code>${escapeHtml(rec.check)}</code>` : 'self-report'}\n\n🔂 <b>Max iterations?</b>\nReply with a number.\n<i>Reply "unlimited" to set no iteration limit.</i>`
    case 'wizard:budget':
      return `${goal}\n✅ Check: ${rec.check ? `<code>${escapeHtml(rec.check)}</code>` : 'self-report'} · 🔂 Max: ${fmtLimit(rec.maxIter, false)}\n\n💸 <b>Loop budget?</b>\nReply with a dollar amount, e.g. <code>5</code> or <code>12.50</code>.\n<i>Reply "unlimited" to set no budget limit.</i>`
    case 'wizard:time':
      return `${goal}\n✅ Check: ${rec.check ? `<code>${escapeHtml(rec.check)}</code>` : 'self-report'} · 🔂 Max: ${fmtLimit(rec.maxIter, false)} · 💸 ${fmtLimit(rec.budget, true)}\n\n⏳ <b>Time limit?</b>\nReply with a duration, e.g. <code>2h</code> or <code>90m</code>.\n<i>Reply "unlimited" to set no time limit.</i>`
    case 'confirm': {
      const noHardStop = rec.maxIter === undefined && rec.budget === undefined && rec.timeLimitMs === undefined
      return `${goal}\n${summaryLine(rec)}` + (noHardStop
        ? `\n\n⚠️ <b>No hard stop set</b> — this loop runs until the check passes or you stop it manually.`
        : '')
    }
    case 'running':
    case 'stopping': {
      const soft = rec.status === 'stopping' ? '\n⏸ Stopping after this iteration…' : ''
      const time = `⏱ ${fmtDur(Date.now() - rec.startedAt)}${rec.timeLimitMs !== undefined ? `/${fmtDur(rec.timeLimitMs)}` : ''}`
      return `🔁 <b>Loop running</b> — iter ${rec.iter}${rec.maxIter ? `/${rec.maxIter}` : ''} · $${rec.spent.toFixed(2)}${rec.budget !== undefined ? `/$${rec.budget.toFixed(2)}` : ''} · ${time}\n` +
        `${goal}\n✅ Last check: ${escapeHtml(rec.lastCheckNote ?? (rec.check ? 'not run yet' : 'self-report (LOOP_DONE)'))}${soft}`
    }
    case 'paused': {
      const why = rec.pausedKind === 'stall' ? 'the injected prompt never became a turn'
        : rec.pausedKind === 'checkbroken' ? `the check command couldn't run (${escapeHtml(rec.lastCheckNote ?? '?')}) — fix it, then Resume re-evaluates`
        : 'no progress between iterations'
      return `⏸ <b>Loop paused</b> — ${why} (iter ${rec.iter}, $${rec.spent.toFixed(2)} spent)\n${goal}`
    }
  }
}
function cardKeyboard(rec: LoopRecord, sid: string): InlineKeyboard | undefined {
  switch (rec.status) {
    case 'wizard:check': case 'wizard:max': case 'wizard:budget': case 'wizard:time':
      return new InlineKeyboard().text('✖️ Cancel', `loop:cancel:${sid}`)
    case 'confirm': {
      const anyway = rec.maxIter === undefined && rec.budget === undefined
      return new InlineKeyboard().text(anyway ? '▶️ Start anyway' : '▶️ Start', `loop:go:${sid}`).text('✖️ Cancel', `loop:cancel:${sid}`)
    }
    case 'running':
      return new InlineKeyboard().text('⏸ Stop after iter', `loop:stopsoft:${sid}`).text('⏹ Stop now', `loop:stopnow:${sid}`)
    case 'stopping':
      return new InlineKeyboard().text('⏹ Stop now', `loop:stopnow:${sid}`)
    case 'paused':
      return new InlineKeyboard().text('▶️ Resume', `loop:resume:${sid}`).text('⏹ Stop', `loop:stopnow:${sid}`)
  }
}

// Edit the card in place; skip no-op edits (Telegram 400s on identical content).
const lastCardHtml = new Map<string, string>()
async function renderCard(sid: string, rec: LoopRecord): Promise<void> {
  const html = cardHtml(rec)
  const kb = cardKeyboard(rec, sid)
  const extra = { parse_mode: 'HTML' as const, ...(kb ? { reply_markup: kb } : {}) }
  if (rec.cardMsg) {
    if (lastCardHtml.get(sid) === html + rec.status) return
    scheduleEdit({ chat: rec.chat, mid: rec.cardMsg, thread: rec.thread, source: 'loop', render: () => html, extra })
  } else {
    const sent = await deps.bot.api.sendMessage(rec.chat, html, { ...extra, ...(rec.thread ? { message_thread_id: rec.thread } : {}) }).catch(() => null)
    if (sent) rec.cardMsg = sent.message_id
  }
  lastCardHtml.set(sid, html + rec.status)
}

// ---- Wizard ----
export function activeLoop(sid: string): LoopRecord | null { return readLoops()[sid] ?? null }
// While a wizard/confirm card is open, plain messages in its chat+topic answer the open field.
export function wizardSidFor(chat: string, thread: number | undefined): string | null {
  for (const [sid, rec] of Object.entries(readLoops())) {
    if (rec.chat === chat && rec.thread === thread && rec.status.startsWith('wizard')) return sid
  }
  return null
}

export async function startLoopWizard(sid: string, goal: string, chat: string, thread: number | undefined): Promise<void> {
  const map = readLoops()
  const rec: LoopRecord = { goal, status: 'wizard:check', iter: 0, spent: 0, lastReplyUuid: '', chat, thread, startedAt: Date.now() }
  map[sid] = rec
  await renderCard(sid, rec)
  writeLoops(map)
}

export async function handleLoopWizardReply(sid: string, text: string): Promise<void> {
  const map = readLoops()
  const rec = map[sid]
  if (!rec) return
  if (rec.status === 'wizard:check') {
    const p = parseCheckReply(text)
    if (!p) return
    rec.check = p.check
    rec.status = 'wizard:max'
  } else if (rec.status === 'wizard:max') {
    const p = parseMaxReply(text)
    if (!p) { await nudgeInvalid(rec, 'a whole number (or "unlimited")'); return }
    rec.maxIter = p.max
    rec.status = 'wizard:budget'
  } else if (rec.status === 'wizard:budget') {
    const p = parseBudgetReply(text)
    if (!p) { await nudgeInvalid(rec, 'a dollar amount like 5 or 12.50 (or "unlimited")'); return }
    rec.budget = p.budget
    rec.status = 'wizard:time'
  } else if (rec.status === 'wizard:time') {
    const p = parseTimeReply(text)
    if (!p) { await nudgeInvalid(rec, 'a duration like 2h or 90m (or "unlimited")'); return }
    rec.timeLimitMs = p.ms
    rec.status = 'confirm'
  } else return
  await renderCard(sid, rec)
  writeLoops(map)
}
async function nudgeInvalid(rec: LoopRecord, want: string): Promise<void> {
  await deps.bot.api.sendMessage(rec.chat, `🤔 Didn't catch that — reply with ${want}.`,
    { disable_notification: true, ...(rec.thread ? { message_thread_id: rec.thread } : {}) }).catch(() => {})
}
async function say(rec: LoopRecord, html: string, loud = false): Promise<void> {
  await deps.bot.api.sendMessage(rec.chat, html,
    { parse_mode: 'HTML', disable_notification: !loud, ...(rec.thread ? { message_thread_id: rec.thread } : {}) }).catch(() => {})
}

// ---- Lifecycle (wizard buttons + /loop subcommands) ----
async function paneFor(sid: string): Promise<string | null> {
  return sid === 'focused' ? focus.activePaneId : await paneForSession(sid)
}

export async function loopCancel(sid: string): Promise<string> {
  const map = readLoops()
  const rec = map[sid]
  if (!rec) return 'No loop here.'
  delete map[sid]
  writeLoops(map)
  if (rec.cardMsg) scheduleEdit({ chat: rec.chat, mid: rec.cardMsg, thread: rec.thread, source: 'loop', render: () => '✖️ Loop setup cancelled.' })
  return 'Cancelled.'
}

export async function loopGo(sid: string): Promise<string> {
  const map = readLoops()
  const rec = map[sid]
  if (!rec || rec.status !== 'confirm') return 'No loop waiting to start.'
  const pane = await paneFor(sid)
  if (!pane || !(await paneAlive(pane))) return 'No live session pane to run the loop in.'
  // Pre-flight the verifier: a broken check must fail HERE, not "fail" every iteration until
  // a cap (that's the runaway path) — and if it already passes there's nothing to loop on.
  if (rec.check) {
    const res = await runCheck(rec.check, await paneCwd(pane).catch(() => null))
    rec.lastCheckNote = res.note
    writeLoops(map)
    if (!res.ran) {
      const note = `🚫 The check couldn't run (${escapeHtml(res.note)}) — fix the command, then tap Start again.`
      await say(rec, note)
      return note
    }
    if (res.ok) {
      const note = `✅ The check already passes (<code>${escapeHtml(rec.check)}</code>) — nothing to loop on. Cancel, or change the goal's check.`
      await say(rec, note)
      return note
    }
  }
  // Baseline the transcript cursor + statusline cost so iteration 1 is measured from here.
  const file = await deps.resolveTranscriptForPane(pane)
  rec.lastReplyUuid = (file ? latestFinalReply(file)?.uuid : '') ?? ''
  rec.lastReplyText = undefined
  const cap = await capturePane(pane).catch(() => '')
  const cost = parseFloat((parseStatusline(cap)?.cost ?? '').replace('$', ''))
  rec.costBase = Number.isFinite(cost) ? cost : undefined
  rec.iter = 1
  rec.status = 'running'
  rec.startedAt = Date.now()
  rec.injectedAt = Date.now()
  const ok = await deps.deliverToPane(pane, iterationPrompt(rec))
  if (!ok) { rec.status = 'confirm'; writeLoops(map); return 'Could not reach the session pane — try again.' }
  await renderCard(sid, rec)
  writeLoops(map)
  return 'Loop started.'
}

export async function loopStopSoft(sid: string): Promise<string> {
  const map = readLoops()
  const rec = map[sid]
  if (rec?.status === 'stopping') return 'Already stopping after this iteration — <code>/loop stop now</code> to interrupt.'
  if (!rec || (rec.status !== 'running' && rec.status !== 'paused')) return 'No running loop.'
  if (rec.status === 'paused') { await finishLoop(sid, rec, map, 'user', 'stopped by user'); return 'Loop stopped.' }
  rec.status = 'stopping'
  await renderCard(sid, rec)
  writeLoops(map)
  return 'Stopping after the current iteration.'
}

export async function loopStopNow(sid: string): Promise<string> {
  const map = readLoops()
  const rec = map[sid]
  if (!rec) return 'No loop here.'
  if (rec.status.startsWith('wizard') || rec.status === 'confirm') return loopCancel(sid)
  const pane = await paneFor(sid)
  if (pane && (rec.status === 'running' || rec.status === 'stopping')) {
    await deps.paneKeys(pane, ['Escape'], [200, 2000]).catch(() => {})
  }
  await finishLoop(sid, rec, map, 'user', 'stopped by user (interrupted)')
  return 'Loop stopped.'
}

export async function loopResume(sid: string): Promise<string> {
  const map = readLoops()
  const rec = map[sid]
  if (!rec || rec.status !== 'paused') return 'No paused loop.'
  const pane = await paneFor(sid)
  if (!pane || !(await paneAlive(pane))) return 'No live session pane to resume in.'
  if (rec.pausedKind === 'checkbroken') {
    // The iteration already concluded — don't re-prompt. Clear the pause and let the next sweep
    // re-evaluate the same boundary with the (hopefully fixed) check command.
    rec.pausedKind = undefined
    rec.status = 'running'
    rec.injectedAt = Date.now()
    await renderCard(sid, rec)
    writeLoops(map)
    return 'Resumed — re-running the check at the next sweep.'
  }
  if (rec.pausedKind === 'noprogress') rec.iter++   // stall keeps its iteration; no-progress moves on
  rec.pausedKind = undefined
  rec.status = 'running'
  rec.injectedAt = Date.now()
  const ok = await deps.deliverToPane(pane, iterationPrompt(rec))
  if (!ok) { rec.status = 'paused'; writeLoops(map); return 'Could not reach the session pane.' }
  await renderCard(sid, rec)
  writeLoops(map)
  return 'Loop resumed.'
}

export function loopStatusHtml(sid: string): string {
  const rec = readLoops()[sid]
  if (!rec) return '🔁 No loop for this session — <code>/loop &lt;goal&gt;</code> to set one up.'
  return cardHtml(rec)
}
export function loopStatusKeyboard(sid: string): InlineKeyboard | undefined {
  const rec = readLoops()[sid]
  return rec ? cardKeyboard(rec, sid) : undefined
}

// Terminal state: final card edit (buttons gone) + one loud summary message.
async function finishLoop(sid: string, rec: LoopRecord, map: Record<string, LoopRecord>, kind: 'done' | 'user' | 'limit', reason: string): Promise<void> {
  delete map[sid]
  writeLoops(map)
  lastCardHtml.delete(sid)
  const icon = kind === 'done' ? '✅' : kind === 'user' ? '🛑' : '⛔️'
  const summary = `${icon} <b>Loop ${kind === 'done' ? 'finished' : 'stopped'}</b> — ${reason}\n` +
    `🔁 ${rec.iter} iteration${rec.iter === 1 ? '' : 's'} · 💸 $${rec.spent.toFixed(2)} · 🕐 ${fmtDur(Date.now() - rec.startedAt)}\n` +
    `<i>${escapeHtml(rec.goal.slice(0, 200))}</i>`
  if (rec.cardMsg) scheduleEdit({ chat: rec.chat, mid: rec.cardMsg, thread: rec.thread, source: 'loop', parseMode: 'HTML', render: () => summary })
  await deps.bot.api.sendMessage(rec.chat, summary, { parse_mode: 'HTML', ...(rec.thread ? { message_thread_id: rec.thread } : {}) }).catch(() => {})
}

// ---- Sweep ----
// Spend tracking mirrors the daily-budget sweep: statusline cost is cumulative per conversation,
// so accumulate positive deltas and re-baseline at 0 when the cost drops (a /clear mid-loop).
function updateSpend(rec: LoopRecord, cap: string): boolean {
  const cost = parseFloat((parseStatusline(cap)?.cost ?? '').replace('$', ''))
  if (!Number.isFinite(cost)) return false
  if (rec.costBase === undefined) { rec.costBase = cost; return true }   // first readable sighting baselines, never bills pre-loop spend
  if (cost < rec.costBase) rec.costBase = 0                              // conversation reset mid-loop — the fresh session counts from its start
  const before = rec.spent
  rec.spent += Math.max(0, cost - rec.costBase)
  const changed = rec.spent !== before || rec.costBase !== cost
  rec.costBase = cost
  return changed
}

// ran=false means the verifier itself is broken (couldn't start, not found/executable, timed
// out) — that must never count as "the work isn't done yet", or a typo'd command silently
// burns every iteration to its cap.
type CheckResult = { ran: boolean; ok: boolean; note: string }
function lastOutputLine(s: string): string {
  const lines = stripAnsi(s).split('\n').map(l => l.trim()).filter(Boolean)
  return (lines.at(-1) ?? '').slice(0, 80)
}
async function runCheck(cmd: string, cwd: string | null): Promise<CheckResult> {
  try {
    await exec('bash', ['-lc', cmd], { timeout: CHECK_TIMEOUT_MS, maxBuffer: 4_000_000, ...(cwd ? { cwd } : {}) })
    return { ran: true, ok: true, note: 'exit 0 ✓' }
  } catch (e) {
    const err = e as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string }
    const tail = lastOutputLine(`${err.stdout ?? ''}\n${err.stderr ?? ''}`)
    if (err.killed) return { ran: false, ok: false, note: `timed out after ${CHECK_TIMEOUT_MS / 60_000}m` }
    if (typeof err.code !== 'number') return { ran: false, ok: false, note: 'could not start' }
    if (err.code === 126 || err.code === 127) return { ran: false, ok: false, note: `exit ${err.code} — ${tail || 'command not found'}` }
    return { ran: true, ok: false, note: `exit ${err.code}${tail ? ` — ${tail}` : ''}` }
  }
}

const sweeping = new Set<string>()   // a slow check command must not be re-entered by the next tick
export async function sweepLoops(): Promise<void> {
  const map = readLoops()
  for (const [sid, rec] of Object.entries(map)) {
    if (rec.status !== 'running' && rec.status !== 'stopping') continue
    if (sweeping.has(sid)) continue
    sweeping.add(sid)
    try {
      const pane = await paneFor(sid)
      if (!pane || !(await paneAlive(pane))) { await finishLoop(sid, rec, map, 'limit', 'the session pane is gone'); continue }
      const cap = await capturePane(pane).catch(() => '')
      // Spend ticks even mid-turn (a restart stays honest), but the CARD only edits at iteration
      // boundaries/state changes — it must never compete with the mirror/streaming edits mid-turn.
      if (updateSpend(rec, cap)) writeLoops(map)
      const file = await deps.resolveTranscriptForPane(pane)
      if (!file || turnInProgress(file)) continue
      if (!cap || !onNormalPrompt(cap)) continue   // menu/permission card up → the relay owns the pane
      const reply = latestFinalReply(file)
      if (!reply || reply.uuid === rec.lastReplyUuid) {
        // Idle but the iteration never concluded — injection may have been eaten. Pause loudly
        // rather than re-injecting blind (re-sending into an unknown pane state is how loops run away).
        if (rec.injectedAt && Date.now() - rec.injectedAt > STALL_MS) {
          rec.status = 'paused'; rec.pausedKind = 'stall'
          await renderCard(sid, rec)
          writeLoops(map)
          await say(rec, '⏸ Loop paused — the injected prompt never became a turn.', true)
        }
        continue
      }
      // Iteration boundary: the injected turn ran and concluded.
      if (rec.budget !== undefined && rec.costBase === undefined && !rec.warnedNoCost) {
        // Budget honesty: no $ figure ever appeared on the statusline (API-less setups can hide
        // it) — say so once instead of silently never enforcing the cap the user asked for.
        rec.warnedNoCost = true
        writeLoops(map)
        await say(rec, '⚠️ Can\'t read this session\'s $ cost from the statusline — the loop <b>budget can\'t be enforced</b>. Iteration and time limits still apply.', true)
      }
      let checkOk: boolean | null = null
      if (rec.check && rec.status !== 'stopping') {
        const res = await runCheck(rec.check, await paneCwd(pane).catch(() => null))
        rec.lastCheckNote = res.note
        if (!res.ran) {
          // Broken verifier ≠ failed iteration: pause without advancing the reply cursor, so a
          // Resume after fixing the command re-evaluates THIS boundary instead of re-prompting.
          rec.status = 'paused'; rec.pausedKind = 'checkbroken'
          await renderCard(sid, rec)
          writeLoops(map)
          await say(rec, `⏸ Loop paused — the check couldn't run (${escapeHtml(res.note)}). Fix it, then Resume.`, true)
          continue
        }
        checkOk = res.ok
      }
      const d = decideBoundary(rec, reply.text, checkOk)
      if (d.action === 'stop') { await finishLoop(sid, rec, map, d.kind, d.reason); continue }
      rec.lastReplyUuid = reply.uuid
      rec.lastReplyText = norm(reply.text)
      if (d.action === 'pause') {
        rec.status = 'paused'; rec.pausedKind = 'noprogress'
        await renderCard(sid, rec)
        writeLoops(map)
        await say(rec, `⏸ Loop paused — ${d.reason}.`, true)
        continue
      }
      rec.iter++
      rec.injectedAt = Date.now()
      const ok = await deps.deliverToPane(pane, iterationPrompt(rec))
      if (!ok) { rec.iter--; rec.lastReplyUuid = '' }   // pane wedged — retry the boundary next sweep
      await renderCard(sid, rec)
      writeLoops(map)
    } catch { /* pane/transcript vanished mid-sweep — next pass */ }
    finally { sweeping.delete(sid) }
  }
}
