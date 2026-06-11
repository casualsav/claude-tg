// Live activity mirror domain module.
//
// One self-editing Telegram message per work burst showing what Claude is doing, so the user
// can watch without the terminal. Extracted from daemon.ts (Phase 3b). Owns the open-card
// tracking + throttle/idle state; the whole card lifecycle is driven by one `working` signal
// from updateTerminalMirror().
//
// Wired once via initMirror(): depends on the bot, the access loader, the daemon's replyMode()
// helper (shared across the daemon, so it stays there), a live getActivePaneId getter, and a
// retriggerTyping callback (the mirror send clears Telegram's typing state).
import { Bot } from 'grammy'
import { join } from 'node:path'
import { exec } from './proc.ts'
import { stripAnsi } from './prompt.ts'
import { STATE_DIR, readJsonFile, writeJsonFile } from './common.ts'
import { mdToTelegramHtml, chunkHtml, escapeHtml } from './markdown.ts'
import { parseWorkingLine } from './statusline.ts'
import { currentTurnActivity, currentTurnFeed, turnAnchorUuid, type Activity, type FeedItem } from './transcript.ts'
import type { Access } from './types.ts'

type MirrorDeps = {
  bot: Bot
  loadAccess: () => Access
  replyMode: () => 'thoughts' | 'tools' | 'hybrid' | 'off'
  getActivePaneId: () => string | null
  retriggerTyping: () => void
  // The pane's transcript, resolved by the daemon (stamped @tg_transcript path first, cwd
  // fallback) — so the card reads the right session even across accounts (CLAUDE_CONFIG_DIR)
  // and same-cwd siblings, instead of guessing "newest .jsonl for the cwd" here.
  resolveTranscriptForPane: (paneId: string) => Promise<string | null>
  // Where the card should open: the focused session's topic in forum mode, else the DM chats. The
  // daemon supplies this (outboundTargetsFor) so the mirror doesn't need to know about topics.
  outboundTargets: () => Promise<Array<{ chat: string; thread?: number }>>
}

let deps: MirrorDeps
export function initMirror(d: MirrorDeps): void {
  deps = d
  restorePersistedCard()
}

const MIRROR_THROTTLE_MS = 3000
const MIRROR_BLOCKS = 8        // digest mode: max ● blocks shown
const MIRROR_TOOLS = 5         // tools mode: max tool rows shown (newest replaces oldest until ✅ Done)
const MIRROR_FINALIZE_TICKS = 3   // ~4.5s sustained idle (RELAY_POLL_MS=1500) before capping the card
const MIRROR_FEED = 5        // hybrid: max interleaved items shown (matches tools & thoughts)
const MIRROR_THOUGHTS = 5    // thoughts mode: max thoughts shown (oldest falls off as new flow in)
// The status footer (verb · elapsed · tokens) is DISABLED for now — it doesn't track reliably yet
// (verb/token scraping off the spinner line is flaky). The whole machinery (mirrorFooter,
// fmtElapsed, the verb/token scrape in syncMirrorBody) is kept intact; flip this to re-enable it
// once it can be made dependable. While false, composeCard renders the body only.
const MIRROR_FOOTER_ENABLED = false

const mirrorMsgIds = new Map<string, number>()   // chat_id → the live mirror message id
// The pane the open card belongs to. A relay-loop restart on the SAME pane (focus re-adoption mid
// -turn) must keep the existing card rather than orphan it and open a second one — see abandonMirror.
let mirrorPaneId: string | null = null
// Consecutive not-working ticks. The card is finalized (one ✅ Done, then a fresh card on the next
// turn) only after this crosses the threshold — so a single transient not-working tick can't split
// one turn's card into two. Reset to 0 on any working tick.
let mirrorIdleTicks = 0
// When the current card (work burst) opened — drives the live elapsed timer in the status footer.
let mirrorStartedAt = 0
// The card has two update cadences. The heavy sync (pane capture + transcript read) refreshes the
// body + the footer's verb/tokens on the throttled relay tick; a light 1s ticker re-renders the
// footer so the elapsed timer counts up smoothly to the second between syncs. These caches carry
// the last-synced values across ticks so the timer can re-render without re-scraping.
let mirrorBody = ''              // last-synced card body (no footer)
let mirrorVerb = 'Working'       // last-scraped spinner verb (held between syncs so it doesn't flicker)
let mirrorTokens: string | null = null   // last-scraped PER-TURN token count (spinner only — never the session total)
let mirrorLastSyncAt = 0         // last heavy sync; throttled to MIRROR_THROTTLE_MS
// We edit the card ONLY when its CONTENT changes (body / verb / tokens) — never just because the
// clock advanced — so the message barely flashes. The elapsed is rendered at each such edit, so it
// steps to the current value on real activity rather than ticking every second. This key is the
// content fingerprint (no elapsed); an unchanged key means no edit.
let mirrorContentKey = ''
// The last-real-user-prompt uuid of the turn the open card tracks — the "same turn?" identity
// used to resume the card across a daemon restart (see the persistence block below).
let mirrorAnchor: string | null = null

// ---- Card persistence across daemon restarts ----
// mirrorMsgIds used to live ONLY in process memory, so every deploy/crash mid-turn orphaned the
// live card: frozen un-capped (never edited again), with the fresh daemon opening a new one on
// its first working tick. With a deploy inside nearly every dev turn, each user message produced
// one card per restart — the "stream fragments into 5-6 messages" bug. Persisting
// {ids, pane, turn anchor, last body} lets the next daemon RESUME editing the same card when it's
// still the same pane + turn, and cap the orphan cleanly when it isn't.
const MIRROR_STATE_FILE = join(STATE_DIR, 'mirror-card.json')
type PersistedCard = { ids: Record<string, number>; paneId: string | null; startedAt: number; anchor: string | null; body: string }
// Restored ids await a verdict on the first tick (resume vs cap) — needs the live transcript,
// so it can't be decided at load time.
let pendingRestore: { anchor: string | null; body: string } | null = null

function persistMirror(): void {
  writeJsonFile(MIRROR_STATE_FILE, mirrorMsgIds.size
    ? { ids: Object.fromEntries(mirrorMsgIds), paneId: mirrorPaneId, startedAt: mirrorStartedAt, anchor: mirrorAnchor, body: mirrorBody } satisfies PersistedCard
    : {})
}

function restorePersistedCard(): void {
  const saved = readJsonFile<Partial<PersistedCard>>(MIRROR_STATE_FILE, {})
  if (!saved.ids || !Object.keys(saved.ids).length) return
  for (const [chat, mid] of Object.entries(saved.ids)) mirrorMsgIds.set(chat, mid)
  mirrorPaneId = saved.paneId ?? null
  mirrorStartedAt = saved.startedAt || Date.now()
  pendingRestore = { anchor: saved.anchor ?? null, body: saved.body ?? '' }
}

// First tick after a restart with a restored card: same pane + same turn → keep editing it (the
// restart is invisible); anything else → cap the orphan with its last known body so it never
// lingers un-capped, and let the normal lifecycle open a fresh card for the new turn.
async function reconcileRestoredCard(): Promise<void> {
  const saved = pendingRestore
  pendingRestore = null
  if (!saved || mirrorMsgIds.size === 0) return
  const paneId = deps.getActivePaneId()
  const file = paneId ? await deps.resolveTranscriptForPane(paneId).catch(() => null) : null
  const anchor = file ? turnAnchorUuid(file) : null
  if (paneId && paneId === mirrorPaneId && anchor && anchor === saved.anchor) {
    mirrorAnchor = anchor
    mirrorBody = saved.body   // contentKey + the cap fallback hold the last body until the next sync
    mirrorContentKey = saved.body
    process.stderr.write(`daemon: resumed live mirror card across restart (pane ${paneId})\n`)
    return
  }
  const text = saved.body ? `${saved.body}\n\n✅ <b>Done</b>` : '✅ <b>Done</b>'
  for (const [chat, mid] of mirrorMsgIds) await deps.bot.api.editMessageText(chat, mid, text, { parse_mode: 'HTML' }).catch(() => {})
  mirrorMsgIds.clear(); resetMirrorState(); persistMirror()
  process.stderr.write('daemon: capped orphaned mirror card from previous run\n')
}

// Compact live elapsed for the status footer: "23s" / "1m 40s" / "1h 02m".
function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60), sec = s % 60
  if (m < 60) return sec ? `${m}m ${sec}s` : `${m}m`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

// The status line pinned to the bottom of a live card: the whimsical working verb + the live
// elapsed (counted locally, smooth to the second) + the PER-TURN token count (from Claude's spinner
// line only — never the session total, which is what made it jump to ~270k). Verb/tokens are cached
// between terminal syncs so they hold steady; elapsed ticks every second off mirrorStartedAt.
function mirrorFooter(): string {
  const elapsed = mirrorStartedAt ? fmtElapsed(Date.now() - mirrorStartedAt) : null
  const parts = [`⏳ <i>${escapeHtml(mirrorVerb)}</i>`, elapsed, mirrorTokens].filter(Boolean)
  return parts.length > 1 ? parts.join(' · ') : ''
}

// Reset every per-burst cache. Called whenever a card is capped/dropped so the next burst is fresh.
function resetMirrorState(): void {
  mirrorBody = ''; mirrorVerb = 'Working'; mirrorTokens = null
  mirrorContentKey = ''; mirrorIdleTicks = 0; mirrorStartedAt = 0; mirrorLastSyncAt = 0
  mirrorPaneId = null; mirrorAnchor = null
}

// Live tool-use feed. On by default ('tools') — opt out via access.json
// `terminalMirror: "off"` (or pick `"digest"`).
function mirrorMode(): 'tools' | 'digest' | 'off' {
  const v = deps.loadAccess().terminalMirror
  if (v === 'off' || v === false) return 'off'
  if (v === 'digest') return 'digest'
  return 'tools'   // unset, true, or 'tools'
}

// Claude's recent "● <text>" blocks from the pane — each leading bullet plus its indented
// wrapped continuation — skipping ⎿ tool-output lines and box chrome. A clean digest of what
// Claude said/did, far more readable than the raw terminal. Oldest first, last `max` kept.
export function recentAssistantBlocks(raw: string, max: number): string[] {
  const lines = raw.split('\n').map(l => stripAnsi(l).replace(/\s+$/, ''))
  const blocks: string[] = []
  let cur: string[] | null = null
  const flush = () => { if (cur) { blocks.push(cur.join('\n')); cur = null } }
  for (const l of lines) {
    const m = l.match(/^\s*●\s+(.+)$/)
    if (m) { flush(); cur = [`● ${m[1].trim()}`] }
    else if (cur) {
      if (/^\s{2,}\S/.test(l) && !/^\s*⎿/.test(l)) cur.push(`  ${l.trim()}`)
      else flush()
    }
  }
  flush()
  return blocks.slice(-max)
}

// Pane capture with a little scrollback, so the digest has recent blocks even as they scroll.
async function mirrorCapture(): Promise<string> {
  const paneId = deps.getActivePaneId()
  if (!paneId) return ''
  try { return (await exec('tmux', ['capture-pane', '-p', '-t', paneId, '-S', '-120', '-J'], { timeout: 3000 })).stdout }
  catch { return '' }
}

export function renderDigestMirror(raw: string, done: boolean): string {
  const header = done ? '🖥️ <b>Session</b> · idle' : '🖥️ <b>Session</b> · live'
  const blocks = recentAssistantBlocks(raw, MIRROR_BLOCKS)
  if (blocks.length === 0) return header
  return `${header}\n\n${escapeHtml(blocks.join('\n').slice(0, 3500))}`
}

// Per-tool emoji + human label for the live mirror. The transcript already carries the tool
// name + input, so richer rendering here is entirely free (no model calls).
const TOOL_BADGE: Record<string, [string, string]> = {
  Bash: ['💻', 'terminal'], TodoWrite: ['📋', 'todo'],
  Read: ['📖', 'read'], Edit: ['✏️', 'edit'], MultiEdit: ['✏️', 'edit'], Write: ['📝', 'write'],
  Grep: ['🔍', 'search'], Glob: ['🔍', 'find'], LS: ['📂', 'list'],
  WebFetch: ['🌐', 'fetch'], WebSearch: ['🌐', 'search'], Task: ['🤖', 'agent'],
  NotebookEdit: ['📓', 'notebook'],
  BashOutput: ['⚙️', 'process'], KillShell: ['⚙️', 'process'], KillBash: ['⚙️', 'process'],
  AskUserQuestion: ['❓', 'clarify'], ExitPlanMode: ['📐', 'plan'], Skill: ['📚', 'skill'],
}
export function toolBadge(tool: string): [string, string] {
  if (TOOL_BADGE[tool]) return TOOL_BADGE[tool]
  if (tool.startsWith('mcp__')) {
    // mcp__server__action → keyword-match the action for browser/web MCPs, else a plug.
    const action = (tool.split('__').pop() || tool).replace(/^browser_/, '')
    if (/navigat|goto|open/i.test(action)) return ['🌐', action]
    if (/screenshot|vision|snapshot|image/i.test(action)) return ['📸', action]
    if (/click|tap|press/i.test(action)) return ['👆', action]
    if (/type|fill|input|key/i.test(action)) return ['⌨️', action]
    if (/scroll/i.test(action)) return ['📜', action]
    if (/search|query|find/i.test(action)) return ['🔍', action]
    return ['🔌', action]
  }
  return ['🔧', tool]   // unregistered tool
}

export function renderToolsMirror(acts: Activity[], done: boolean): string {
  // No "Working…" header — just the latest few tool calls scrolling by (oldest fall off as
  // new ones arrive). A Done summary caps the feed at the bottom when the turn settles.
  const lines: string[] = []
  for (const a of acts.slice(-MIRROR_TOOLS)) {
    const [emoji, label] = toolBadge(a.tool)
    const d = a.detail ? `: <code>${escapeHtml(a.detail)}</code>` : ''
    lines.push(`${emoji} ${label}${d}`)
  }
  if (done) lines.push(`✅ <b>Done</b> · ${acts.length} step${acts.length === 1 ? '' : 's'}`)
  return lines.join('\n')
}

// Hybrid card: the current turn's narration + tool calls interleaved (transcript-driven, so no
// pane scraping), the latest few items.
export function renderHybridMirror(feed: FeedItem[], done: boolean): string {
  const lines: string[] = []
  for (const it of feed.slice(-MIRROR_FEED)) {
    if (it.kind === 'text') {
      const html = mdToTelegramHtml(it.text.trim()).trim()
      if (html) lines.push(`<blockquote>🗨️ ${html}</blockquote>`)   // thought: shaded blockquote sets it apart from the tool badges
    } else {
      const [emoji, label] = toolBadge(it.tool)
      const d = it.detail ? `: <code>${escapeHtml(it.detail)}</code>` : ''
      lines.push(`${emoji} ${label}${d}`)                 // tool: the emoji badge differentiates it
    }
  }
  if (done) lines.push('✅ <b>Done</b>')
  // Keep the HTML valid under the card cap: drop oldest lines first, then hard-cap safely.
  let body = lines.join('\n\n')
  while (body.length > 3500 && lines.length > 1) { lines.shift(); body = lines.join('\n\n') }
  if (body.length > 3500) body = chunkHtml(body, 3500)[0] ?? body.slice(0, 3500)
  return body
}

// Split a narration block into its visual paragraphs (blank-line separated), keeping fenced
// code blocks glued. On the card, paragraphs within one block render exactly like separate
// thoughts (a blank line apart inside the blockquote), so the 5-thought window must count
// PARAGRAPHS — counting feed items let a multi-paragraph block show 6+ visual thoughts.
export function splitThoughtParagraphs(text: string): string[] {
  const out: string[] = []
  let cur: string[] = []
  let inFence = false
  const flush = () => { const p = cur.join('\n').trim(); if (p) out.push(p); cur = [] }
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    if (!inFence && line.trim() === '') { flush(); continue }
    cur.push(line)
  }
  flush()
  return out
}

// Thoughts-only card: just Claude's narration, rendered (not raw markdown) with a blank line
// between thoughts and no 💭 prefix.
export function renderThoughtsMirror(feed: FeedItem[], done: boolean): string {
  const thoughts = feed
    .filter((it): it is Extract<FeedItem, { kind: 'text' }> => it.kind === 'text')
    .flatMap(it => splitThoughtParagraphs(it.text))
    .slice(-MIRROR_THOUGHTS)   // keep only the latest few; oldest fall off as new thoughts flow in
  const rendered = thoughts.map(t => mdToTelegramHtml(t).trim()).filter(Boolean)
  let body = rendered.join('\n\n')
  while (body.length > 3500 && rendered.length > 1) { rendered.shift(); body = rendered.join('\n\n') }
  if (body.length > 3500) body = chunkHtml(body, 3500)[0] ?? body.slice(0, 3500)
  if (!body) return done ? '✅ <b>Done</b>' : ''
  const head = `<blockquote>💭 ${body}</blockquote>`   // thoughts shaded in a blockquote; ✅ Done stays outside it
  return done ? `${head}\n\n✅ <b>Done</b>` : head
}

// The HEAVY sync: rebuild the card body from the transcript (+ a pane capture for tools/digest and
// for the spinner verb/tokens), updating mirrorBody and the cached footer pieces. Costs a tmux
// capture + transcript read, so it runs only on the throttled relay tick — the 1s ticker re-renders
// off these caches without re-scraping. Returns whether there's anything to show.
async function syncMirrorBody(done: boolean): Promise<boolean> {
  const mode = deps.replyMode()
  if (mode === 'off') { mirrorBody = ''; return false }
  const paneId = deps.getActivePaneId()
  const file = paneId ? await deps.resolveTranscriptForPane(paneId) : null

  const needCap = !done || (mode === 'tools' && mirrorMode() === 'digest')
  const cap = needCap ? await mirrorCapture() : ''
  // Refresh the footer pieces from Claude's spinner line, but only when a fresh reading exists — a
  // tick that misses the line (it scrolls) keeps the last good verb/tokens instead of flickering,
  // and tokens come from the spinner ONLY (the per-turn count), never the cumulative statusline.
  if (cap) {
    const wl = parseWorkingLine(cap)
    if (wl?.verb) mirrorVerb = wl.verb
    if (wl?.tokens) mirrorTokens = wl.tokens
  }

  let body: string | null
  if (mode === 'thoughts') body = renderThoughtsMirror(file ? currentTurnFeed(file, done) : [], done) || null   // `done` → drop the reply (relayed on its own)
  else if (mode === 'hybrid') { const feed = file ? currentTurnFeed(file, done) : []; body = feed.length ? renderHybridMirror(feed, done) : null }
  else {
    // tools (legacy 'final')
    if (mirrorMode() === 'off') { mirrorBody = ''; return false }
    if (mirrorMode() === 'digest') body = cap ? renderDigestMirror(cap, done) : null
    else { const acts = file ? currentTurnActivity(file) : []; body = acts.length ? renderToolsMirror(acts, done) : null }
  }
  if (body == null) return false
  mirrorBody = body
  return true
}

// The card text = cached body + the live footer (omitted when done; the body already ends in ✅ Done).
function composeCard(done: boolean): string {
  if (done || !mirrorBody || !MIRROR_FOOTER_ENABLED) return mirrorBody
  const footer = mirrorFooter()
  return footer ? `${mirrorBody}\n\n${footer}` : mirrorBody
}

// The content fingerprint that decides whether to edit: the body (the thoughts/tools), NOT the
// footer. Claude's spinner verb rotates and its token count climbs every few seconds the whole
// turn, so keying on them would flash the card every few seconds regardless. Keying on the body
// means an edit fires only on a genuinely new thought/tool; the footer (verb · elapsed · tokens)
// refreshes to the current values on those edits, so it steps with real activity.
function contentKey(): string { return mirrorBody }

// Edit the open card to `text` across every tracked chat.
async function pushCard(text: string): Promise<void> {
  if (!text || mirrorMsgIds.size === 0) return
  for (const [chat, mid] of mirrorMsgIds) await deps.bot.api.editMessageText(chat, mid, text, { parse_mode: 'HTML' }).catch(() => {})
  persistMirror()   // keep the persisted body current so a restart's cap fallback shows the latest state
}

// The card's whole lifecycle lives here, driven by one signal — `working` = turnInProgress(file)
// from the transcript. While the turn runs we open the card once and edit it in place; the
// instant the turn settles we cap it (✅ Done) and clear it. Idempotent.
export async function updateTerminalMirror(working: boolean): Promise<void> {
  if (pendingRestore) await reconcileRestoredCard()   // restart verdict first: resume the old card or cap it
  const mode = deps.replyMode()
  // off → never a card. tools+terminalMirror:off → no card. (Explicit off → cap now, no debounce.)
  if (mode === 'off' || (mode === 'tools' && mirrorMode() === 'off')) { mirrorIdleTicks = 0; if (mirrorMsgIds.size) await finalizeTerminalMirror(); return }

  if (!working) {
    // Debounce the cap: only finalize after sustained idle, so a one-tick blip doesn't split the
    // turn's card. A real turn-end stays not-working, so it still caps within a few ticks.
    if (++mirrorIdleTicks >= MIRROR_FINALIZE_TICKS && mirrorMsgIds.size) await finalizeTerminalMirror()
    return
  }
  mirrorIdleTicks = 0   // working again → reset the debounce
  if (mirrorMsgIds.size === 0 && !mirrorStartedAt) { mirrorStartedAt = Date.now(); mirrorVerb = 'Working'; mirrorTokens = null }   // start a fresh burst

  // Heavy sync is throttled (a tmux capture + transcript read). We refresh body/verb/tokens here,
  // then edit ONLY if the content fingerprint moved — so the card tracks real activity, not the
  // clock, and barely flashes. The elapsed in the footer steps to "now" whenever such an edit fires.
  const now = Date.now()
  if (now - mirrorLastSyncAt < MIRROR_THROTTLE_MS && mirrorMsgIds.size > 0) return
  mirrorLastSyncAt = now
  if (!(await syncMirrorBody(false))) return   // nothing to show yet (e.g. thoughts mode, no narration)

  if (mirrorMsgIds.size === 0) {
    // Open the card silently — it's the ambient mirror; the alerting message is the relayed reply.
    mirrorContentKey = contentKey()
    mirrorPaneId = deps.getActivePaneId()   // remember which pane this card tracks (see abandonMirror)
    const file = mirrorPaneId ? await deps.resolveTranscriptForPane(mirrorPaneId).catch(() => null) : null
    mirrorAnchor = file ? turnAnchorUuid(file) : null   // the turn this card belongs to (restart resume check)
    const text = composeCard(false)
    for (const t of await deps.outboundTargets()) {
      const opts = { parse_mode: 'HTML' as const, disable_notification: true, ...(t.thread ? { message_thread_id: t.thread } : {}) }
      try { const m = await deps.bot.api.sendMessage(t.chat, text, opts); mirrorMsgIds.set(t.chat, m.message_id) }
      catch (e) { process.stderr.write(`daemon: activity mirror create failed: ${e}\n`) }
    }
    persistMirror()
    deps.retriggerTyping()   // the mirror send clears Telegram's typing state — re-assert it now
  } else {
    const key = contentKey()
    if (key !== mirrorContentKey) { mirrorContentKey = key; await pushCard(composeCard(false)) }   // edit only on real change
  }
}

// Freeze the open mirror on its final state and stop tracking it, so the next work burst opens
// a fresh message. No-op if no mirror is open.
async function finalizeTerminalMirror(): Promise<void> {
  if (mirrorMsgIds.size === 0) return
  await syncMirrorBody(true)
  const text = mirrorBody || '🖥️ <b>Session</b> · idle'
  for (const [chat, mid] of mirrorMsgIds) {
    await deps.bot.api.editMessageText(chat, mid, text, { parse_mode: 'HTML' }).catch(() => {})
  }
  mirrorMsgIds.clear(); resetMirrorState(); persistMirror()
}

// Drop the open card entirely (delete, don't cap) and stop tracking it, so the next relay tick
// re-sends a fresh one at the BOTTOM of the chat. Used when stream mode changes mid-turn.
export async function respawnTerminalMirror(): Promise<void> {
  if (mirrorMsgIds.size === 0) return
  for (const [chat, mid] of mirrorMsgIds) {
    await deps.bot.api.deleteMessage(chat, mid).catch(() => {})
  }
  mirrorMsgIds.clear(); resetMirrorState(); persistMirror()
}

// Abandon tracking of any open card WITHOUT touching the Telegram messages — used when focus/
// relay moves to a new pane, so the stale card is simply left in place and a fresh one opens.
// If `focusedPaneId` matches the pane the open card already tracks, this is a relay-loop restart on
// the SAME session (focus re-adoption mid-turn), not a real pane switch — keep the live card so the
// turn doesn't get a second, duplicate card opened beneath the orphaned first one.
export function abandonMirror(focusedPaneId?: string | null): void {
  if (focusedPaneId != null && mirrorMsgIds.size > 0 && focusedPaneId === mirrorPaneId) return
  mirrorMsgIds.clear(); resetMirrorState(); persistMirror()
}
