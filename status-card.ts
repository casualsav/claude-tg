// Pinned status card + session pins — extracted from daemon.ts (split plan #1).
//
// Owns the per-chat/per-topic pinned card: rendering (statusCardText), the pin id store, the
// 10s refresh loops, and the quick-action keyboard. Pure-ish: everything daemon-shaped comes
// in through initStatusCard's deps (the bot, the transcript resolver, and two mutable daemon
// readings), so the module is unit-testable with a fake bot.
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { Bot, InlineKeyboard } from 'grammy'
import { STATE_DIR, readJsonFile, writeJsonFile } from './common.ts'
import { exec } from './proc.ts'
import { escapeHtml } from './markdown.ts'
import { parseStatusline, pinBar, type StatuslineData } from './statusline.ts'
import { capturePane, paneCwd } from './pane-io.ts'
import { focus } from './state.ts'
import { loadAccess } from './access.ts'
import { isTopicMode, getGroupChatId, listTopics, getGeneralSession } from './topics.ts'
import { paneForSession } from './topic-runtime.ts'
import { detectCurrentMode, onNormalPrompt, type CcMode } from './prompt.ts'

type StatusCardDeps = {
  bot: Bot
  // Focused-pane transcript resolution lives in daemon (per-pane tmux-option cache).
  transcriptForPane: (pane: string | null, cwd: string | null) => Promise<string | null>
  lastKnownModel: () => string | null   // last /model picker reading (daemon mutable)
  botUsername: () => string             // set once the bot connects
}
let deps: StatusCardDeps
export function initStatusCard(d: StatusCardDeps): void { deps = d }

// Compact head-badge form of a mode — one 🛡 (permission posture) + short lowercase word, sized
// for the pin preview. The per-mode emojis live on in modeLabel (pickers/buttons).
export function modeBadge(mode: CcMode): string {
  switch (mode) {
    case 'default': return '🛡ask'
    case 'acceptEdits': return '🛡edits'
    case 'plan': return '🛡plan'
    case 'auto': return '🛡auto'
    case 'bypassPermissions': return '🛡yolo'
  }
}
// ---- Pinned status message ----
// One pinned card per DM chat (and per topic in forum mode) with the live session metrics —
// model · mode · context · usage (statusCardText; deliberately no session identity). Edited in
// place on the 10s refresh; pin ids persist so a daemon restart edits the existing pin instead
// of pinning a new one. Keys: DM chat id, or `topic:<threadId>` in forum mode.
const SESSION_PIN_FILE = join(STATE_DIR, 'session-pin.json')
export const sessionPins = new Map<string, number>()
export const pinTextCache = new Map<string, string>()   // last rendered text per key — skip no-op edits
for (const [c, m] of Object.entries(readJsonFile<Record<string, number>>(SESSION_PIN_FILE, {}))) sessionPins.set(c, m)
export function persistSessionPins(): void {
  writeJsonFile(SESSION_PIN_FILE, Object.fromEntries(sessionPins))
}

// Unpin + delete every pinned status message (used by /pin off).
export async function removeSessionPins(): Promise<void> {
  const group = getGroupChatId()
  for (const [key, mid] of sessionPins) {
    const chat = key.startsWith('topic:') ? group : key
    if (!chat) continue
    await deps.bot.api.unpinChatMessage(chat, mid).catch(() => {})
    await deps.bot.api.deleteMessage(chat, mid).catch(() => {})
  }
  sessionPins.clear(); pinTextCache.clear(); persistSessionPins()
}

// Force a fresh pin: unpin+delete the old one, then recreate. Recovers a pin the user dismissed
// in their client — Telegram still reports it pinned, so updateSessionPin can't tell it's hidden,
// and editing the same id won't bring it back; only pinning a new message will.
export async function refreshSessionPin(): Promise<void> {
  await removeSessionPins()
  await updateSessionPin()
}

// The model the focused session last used, read from its transcript (non-intrusive, per
// session) — falls back to deps.lastKnownModel(). The transcript stores raw ids like
// "claude-opus-4-8"; prettyModel turns that into "Opus 4.8".
export function lastModelInTranscript(file: string): string | null {
  let data = ''
  try { data = readFileSync(file, 'utf8') } catch { return null }
  const matches = data.match(/"model":"([^"]+)"/g) ?? []
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i].slice(9, -1)
    if (m && m !== '<synthetic>') return m
  }
  return null
}
// The Claude Code build a session is actually RUNNING, from its transcript (every entry stamps
// it). The installed binary can be newer — the native build auto-updates underneath live sessions.
export function lastVersionInTranscript(file: string): string | null {
  let data = ''
  try { data = readFileSync(file, 'utf8') } catch { return null }
  const m = data.match(/"version":"(\d+\.\d+\.\d+[^"]*)"/g)
  return m?.length ? m[m.length - 1].slice(11, -1) : null
}
// The session's working plan: the most recent TodoWrite state in its transcript (ROADMAP #16).
// Whole-file read matches lastModelInTranscript's pattern (the pin tick already pays it).
type TodoState = { total: number; done: number; active: string | null }
export function lastTodosInTranscript(file: string): TodoState | null {
  let data = ''
  try { data = readFileSync(file, 'utf8') } catch { return null }
  const idx = data.lastIndexOf('"name":"TodoWrite"')
  if (idx < 0) return null
  const start = data.lastIndexOf('\n', idx) + 1
  const endNl = data.indexOf('\n', idx)
  const line = data.slice(start, endNl < 0 ? data.length : endNl)
  try {
    const rec = JSON.parse(line) as { message?: { content?: unknown } }
    const content = rec?.message?.content
    type Todo = { status?: string; content?: string; activeForm?: string }
    const block = Array.isArray(content)
      ? (content as { type?: string; name?: string; input?: { todos?: Todo[] } }[]).find(b => b?.type === 'tool_use' && b?.name === 'TodoWrite')
      : null
    const todos = block?.input?.todos
    if (!Array.isArray(todos) || todos.length === 0) return null
    const done = todos.filter(t => t?.status === 'completed').length
    const act = todos.find(t => t?.status === 'in_progress')
    return { total: todos.length, done, active: act ? String(act.activeForm ?? act.content ?? '').trim() || null : null }
  } catch { return null }
}

// Family name only — "Opus" / "Sonnet" / "Haiku" / "Fable" (no version), for the pin tagline.
export function prettyModel(id: string | null): string | null {
  if (!id) return id
  const m = id.match(/(opus|sonnet|haiku|fable)/i)
  return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : id
}

// Status line for the focused session: 💻 name • model (…) • mode (…). Mode is read live from a
// pane capture; model from the session's transcript. Both degrade to "—" rather than blocking.
export async function gitBranch(dir: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 2000 })
    const b = stdout.trim()
    return b && b !== 'HEAD' ? b : null
  } catch { return null }
}

// ---- statusline → status card enrichment ----
// The configured Claude Code statusLine renders rich session metrics (context, tokens, cost,
// rate-limit windows) at the bottom of the pane. The daemon already captures that pane, so rather
// than recompute anything we lift those fields straight out of the capture and re-render them in
// the card's own layout. Scoped to the statusline's slot — the lines just above Claude Code's
// footer hint — so we never pick up numbers from Claude's reply text higher in the pane.

const CARD_RULE = '──────────────────────────'

// Status card for any pane — usage · context · model · effort · mode up top (the collapsed
// preview Telegram shows), rule-separated detail groups below. Deliberately NO session identity:
// in topic mode the tab is the session, and the DM drives a single one. Rendered into the pinned
// status message (refreshed in place) and re-posted by /status.
export async function statusCardText(paneId: string | null): Promise<string> {
  if (!paneId) return '🖥️ <b>No active session</b>'
  let mode = '—', cwd: string | null = null
  let model = paneId === focus.activePaneId ? deps.lastKnownModel() : null
  let status: StatuslineData | null = null
  try {
    const cap = await capturePane(paneId)
    // Emoji + a SHORT lowercase word (🚨 bypass), matching the "⚡ high" badge grammar — the full
    // modeLabel name made the collapsed pin preview truncate.
    if (onNormalPrompt(cap)) mode = modeBadge(detectCurrentMode(cap))
    status = parseStatusline(cap)
  } catch {}
  let todos: TodoState | null = null
  try {
    cwd = await paneCwd(paneId)
    const file = await deps.transcriptForPane(paneId, cwd)
    model = (file && prettyModel(lastModelInTranscript(file))) || model
    if (file) todos = lastTodosInTranscript(file)
  } catch {}
  const branch = cwd ? await gitBranch(cwd) : null

  // Head badges: model · think · effort · mode, then session (5h) · weekly (7d) · context. Mode
  // sits in the identity cluster (emoji + short word, same grammar as "⚡ high") rather than
  // dangling as a bare emoji at the end. Think is a bare ✻ — the worded "✻ think" up top
  // ellipsized the collapsed pin preview, but one glyph fits (it also stays in the body).
  // Single-space packing throughout — double spacing pushed the context % off the preview.
  // Think + effort read as one cluster ("✻⚡high") — no space between the glyph and the bolt.
  const effortBadge = status?.effort ? `${status?.think ? '' : ' '}⚡${escapeHtml(status.effort)}` : ''
  const modeBadgeStr = mode === '—' ? '' : ` ${escapeHtml(mode)}`
  const thinkBadge = status?.think ? ' ✻' : ''
  const stats = [
    status?.h5 ? `🕒 ${status.h5.pct}%` : '',
    status?.d7 ? `📅 ${status.d7.pct}%` : '',
    status?.ctxPct != null ? `💾 ${status.ctxPct}%` : '',
  ].filter(Boolean).join(' ')
  const head = `🧠 ${escapeHtml(model ?? '—')}${thinkBadge}${effortBadge}${modeBadgeStr}${stats ? ` ${stats}` : ''}`
  const groups: string[] = []
  if (cwd) groups.push(`📁 <code>${escapeHtml(cwd)}</code>${branch ? ` · 🌿 ${escapeHtml(branch)}` : ''}`)
  // The session's working plan (ROADMAP #16): latest TodoWrite state, with the in-progress step.
  if (todos && todos.done < todos.total) {
    groups.push(`📋 ${todos.done}/${todos.total}${todos.active ? ` · ${escapeHtml(todos.active.slice(0, 70))}` : ''}`)
  }
  if (status) {
    // Usage group: the 5h/7d limit bars, then the cost/time data.
    const lim: string[] = []
    if (status.h5) lim.push(`🕒 5h <code>${pinBar(status.h5.pct)}</code> ${status.h5.pct}%  ↻ ${status.h5.reset}`)
    if (status.d7) lim.push(`📅 7d <code>${pinBar(status.d7.pct)}</code> ${status.d7.pct}%  ↻ ${status.d7.reset}`)
    const ct: string[] = []
    if (status.cost) ct.push(`💰 ${status.cost}`)
    if (status.sessionTime) ct.push(`⏱ ${status.sessionTime}`)
    if (status.apiTime) ct.push(`⚡ api ${status.apiTime}`)
    if (status.think) ct.push('✻ think')
    if (ct.length) lim.push(ct.join('  ·  '))
    if (lim.length) groups.push(lim.join('\n'))
    // Context group: the context bar + token data.
    if (status.ctxPct != null) groups.push(`💾 Context <code>${pinBar(status.ctxPct)}</code> ${status.ctxPct}%${status.tokens ? `  ·  ${status.tokens}` : ''}`)
  }
  groups.push(`🔗 Paired${deps.botUsername() ? ` · @${escapeHtml(deps.botUsername())}` : ''} · connected`)
  return `${head}\n\n${groups.join(`\n${CARD_RULE}\n`)}`
}

// Quick-action buttons on the status card — same emojis as the card's own fields.
export function statusKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🧠 Model', 'st:model').text('🎚️ Effort', 'st:effort').row()
    .text('🕹️ Mode', 'st:mode').text('🗜️ Compact', 'st:compact').row()
    .text('💾 Context', 'st:context').text('💰 Cost', 'st:cost').row()
    .text('⚙️ Settings', 'st:settings').text('📌 Pin off', 'st:pinoff')
}

// NB: topic cards must stay keyboard-less — Telegram renders a pinned message's first inline
// button inside the pin banner, crowding out the status preview. Pin off lives in /settings
// (📌 Pin) and /pin off instead; the DM card keeps its buttons (its banner always showed one).


// True when an edit failed because the target message is gone (deleted) rather than a transient
// like "message is not modified" — a gone pin must be recreated, not re-edited forever.
export function pinMessageGone(e: unknown): boolean {
  const d = String((e as { description?: string })?.description ?? e)
  return /message to edit not found|message can'?t be edited|message to pin not found|MESSAGE_ID_INVALID/i.test(d)
}

// Delete every currently-pinned message in a DM chat. getChat only reports the topmost pinned
// message, so delete that and re-fetch until none remain (bounded). deleteMessage also clears the
// pin; if a message is too old to delete, unpin it so the loop still advances. Run right before
// pinning a fresh card → there is only ever one pin, and creating a new one removes all old ones
// (tracked or orphaned from a prior daemon run / a pin misfire). DM only — never sweep the group.
export async function clearAllPins(chat: string): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const info = await deps.bot.api.getChat(chat).catch(() => null)
    const pid = (info as { pinned_message?: { message_id?: number } } | null)?.pinned_message?.message_id
    if (!pid) break
    const deleted = await deps.bot.api.deleteMessage(chat, pid).then(() => true).catch(() => false)
    if (!deleted) { await deps.bot.api.unpinChatMessage(chat, pid).catch(() => {}); break }
  }
}

// Single-pin guarantee for a topic: unpin everything in the thread before pinning a fresh card.
// Group pins STACK and the API can't enumerate them (getChat only reports the group's topmost),
// so a card the pin store forgot — state-file loss, a daemon run from another cache dir — would
// otherwise stay pinned alongside the new one forever. Runs only when a new card is about to be
// pinned; the old card's message stays in history, only its pin is cleared.
export async function clearTopicPins(group: string, threadId: number): Promise<void> {
  await deps.bot.api.unpinAllForumTopicMessages(group, threadId).catch(() => {})
}

export async function createSessionPin(chat: string, text: string, reply_markup: InlineKeyboard): Promise<void> {
  try {
    await clearAllPins(chat)   // single-pin guarantee: remove any prior/orphaned pins before the new one
    const m = await deps.bot.api.sendMessage(chat, text, { parse_mode: 'HTML', reply_markup })
    await deps.bot.api.pinChatMessage(chat, m.message_id, { disable_notification: true }).catch(() => {})
    sessionPins.set(chat, m.message_id); pinTextCache.set(chat, text); persistSessionPins()
  } catch (e) { process.stderr.write(`daemon: session pin create failed: ${e}\n`) }
}

// Forum mode: one pinned status card PER topic, each tracking its own session. Keyed in sessionPins
// as `topic:<threadId>` (distinct from DM mode's numeric chat keys, so the persisted map holds both).
// A topic whose session isn't running keeps its existing pin untouched. No clearAllPins here — each
// topic has its own single in-thread pin, so we never sweep the whole group's pins.
export async function updateTopicPins(): Promise<void> {
  const group = getGroupChatId()
  if (!group) return
  // The General-anchored session gets a real pin in General (keyed `general`), with the quick-action
  // keyboard — its taps resolve via targetPaneOf, which maps General back to the anchored pane.
  const anchorSid = getGeneralSession()
  if (anchorSid) {
    const paneId = await paneForSession(anchorSid)
    if (paneId) {
      const text = await statusCardText(paneId)
      const key = 'general'
      const existing = sessionPins.get(key)
      if (existing && pinTextCache.get(key) !== text) {
        try { await deps.bot.api.editMessageText(group, existing, text, { parse_mode: 'HTML', reply_markup: statusKeyboard() }); pinTextCache.set(key, text) }
        catch (e) {
          if (pinMessageGone(e)) { sessionPins.delete(key); pinTextCache.delete(key); persistSessionPins() }
          else pinTextCache.set(key, text)   // "not modified" → already current
        }
      }
      if (!sessionPins.has(key)) {
        try {
          await deps.bot.api.unpinAllGeneralForumTopicMessages(group).catch(() => {})   // single-pin guarantee for General
          const m = await deps.bot.api.sendMessage(group, text, { parse_mode: 'HTML', reply_markup: statusKeyboard(), disable_notification: true })
          await deps.bot.api.pinChatMessage(group, m.message_id, { disable_notification: true }).catch(() => {})
          sessionPins.set(key, m.message_id); pinTextCache.set(key, text); persistSessionPins()
        } catch (e) { process.stderr.write(`daemon: general pin create failed: ${e}\n`) }
      }
    }
  }
  for (const t of listTopics()) {
    if (t.closed) continue
    const paneId = await paneForSession(t.sessionId)
    if (!paneId) continue
    const text = await statusCardText(paneId)
    const key = `topic:${t.threadId}`
    const existing = sessionPins.get(key)
    if (existing && pinTextCache.get(key) === text) continue   // unchanged → skip the edit
    if (existing) {
      try { await deps.bot.api.editMessageText(group, existing, text, { parse_mode: 'HTML', reply_markup: statusKeyboard() }); pinTextCache.set(key, text); continue }
      catch (e) {
        if (pinMessageGone(e)) { sessionPins.delete(key); pinTextCache.delete(key); persistSessionPins() }
        else { pinTextCache.set(key, text); continue }   // "not modified" → already current
      }
    }
    try {
      await clearTopicPins(group, t.threadId)   // single-pin guarantee — drop any prior/orphaned card pins first
      const m = await deps.bot.api.sendMessage(group, text, { parse_mode: 'HTML', message_thread_id: t.threadId, disable_notification: true, reply_markup: statusKeyboard() })
      await deps.bot.api.pinChatMessage(group, m.message_id, { disable_notification: true }).catch(() => {})
      sessionPins.set(key, m.message_id); pinTextCache.set(key, text); persistSessionPins()
    } catch (e) { process.stderr.write(`daemon: topic pin create failed: ${e}\n`) }
  }
}

let pinUpdating = false
export async function updateSessionPin(): Promise<void> {
  if (loadAccess().sessionPin === false) return // disabled via /pin off
  if (pinUpdating) return                       // serialize — capture + edit can overlap with switches
  pinUpdating = true
  try {
    if (isTopicMode()) { await updateTopicPins(); return }   // forum mode → per-topic pins, not the DM pin
    const text = await statusCardText(focus.activePaneId)
    const reply_markup = statusKeyboard()
    const hasSession = !!(focus.activePaneId || focus.activeShim)   // off-MCP pane or MCP shim — either counts
    for (const chat of loadAccess().allowFrom) {
      const existing = sessionPins.get(chat)
      if (existing && pinTextCache.get(chat) === text) continue   // nothing changed — skip the no-op edit
      if (existing) {
        try {
          await deps.bot.api.editMessageText(chat, existing, text, { parse_mode: 'HTML', reply_markup })
          pinTextCache.set(chat, text)
        } catch (e) {
          // Deleted out from under us → drop the stale id and recreate below. Transient errors
          // ("message is not modified") leave it in place — the pin is still good.
          if (pinMessageGone(e)) { sessionPins.delete(chat); pinTextCache.delete(chat); persistSessionPins() }
          else pinTextCache.set(chat, text)   // "not modified" → it already shows this text
        }
        if (sessionPins.has(chat)) {
          // If the user unpinned it, re-pin on the next update (e.g. a mode change) so it returns.
          const info = await deps.bot.api.getChat(chat).catch(() => null)
          if (info?.pinned_message?.message_id !== existing) {
            await deps.bot.api.pinChatMessage(chat, existing, { disable_notification: true }).catch(() => {})
          }
          continue
        }
      }
      if (hasSession) await createSessionPin(chat, text, reply_markup)   // don't pin "No active session" out of nowhere
    }
  } finally { pinUpdating = false }
}