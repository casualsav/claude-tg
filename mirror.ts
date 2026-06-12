// Live activity mirror domain module.
//
// One self-editing Telegram message per work burst showing what Claude is doing, so the user
// can watch without the terminal. Extracted from daemon.ts (Phase 3b). Owns the open-card
// tracking + throttle/idle state; each card's lifecycle is driven by one `working` signal.
//
// Two kinds of card share the MirrorCard machinery:
//   focused — the rich relay loop's card (DM mode, or the focused session's topic). Persisted
//             across daemon restarts (resume-or-cap, see the persistence block).
//   aux     — forum-topics mode: every OTHER session gets its own card in its own topic, driven
//             by auxRelayTick. Persisted the same way (a deploy lands mid-turn constantly in
//             dev — without resume-or-cap every topic would collect orphan cards).
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
  // Where the focused card should open: the focused session's topic in forum mode, else the DM
  // chats. The daemon supplies this (outboundTargetsFor) so the mirror doesn't know about topics.
  outboundTargets: () => Promise<Array<{ chat: string; thread?: number }>>
  // Where a specific pane's aux card should open (its own topic).
  auxOutboundTargets: (paneId: string) => Promise<Array<{ chat: string; thread?: number }>>
}

let deps: MirrorDeps
export function initMirror(d: MirrorDeps): void {
  deps = d
  restorePersistedCards()
}

const MIRROR_THROTTLE_MS = 3000
const MIRROR_BLOCKS = 8        // digest mode: max ● blocks shown
const MIRROR_TOOLS = 10        // tools mode: max tool rows shown (newest replaces oldest until ✅ Done)
const MIRROR_FINALIZE_TICKS = 3   // ~4.5s sustained idle (RELAY_POLL_MS=1500) before capping the card
const MIRROR_FEED = 10       // hybrid: max interleaved items shown (matches tools & thoughts)
const MIRROR_THOUGHTS = 10   // thoughts mode: max thoughts shown (oldest falls off as new flow in)
// The status footer (verb · elapsed · tokens) is DISABLED for now — it doesn't track reliably yet
// (verb/token scraping off the spinner line is flaky). The whole machinery (the footer method,
// fmtElapsed, the verb/token scrape in syncBody) is kept intact; flip this to re-enable it
// once it can be made dependable. While false, compose renders the body only.
const MIRROR_FOOTER_ENABLED = false

// ---- Card persistence across daemon restarts ----
// Card message ids used to live ONLY in process memory, so every deploy/crash mid-turn orphaned
// the live card: frozen un-capped (never edited again), with the fresh daemon opening a new one
// on its first working tick. With a deploy inside nearly every dev turn, each user message
// produced one card per restart — the "stream fragments into 5-6 messages" bug. Persisting
// {ids, pane, turn anchor, last body} lets the next daemon RESUME editing the same card when it's
// still the same pane + turn, and cap the orphan cleanly when it isn't.
const MIRROR_STATE_FILE = join(STATE_DIR, 'mirror-card.json')
const MIRROR_AUX_STATE_FILE = join(STATE_DIR, 'mirror-aux-cards.json')
type PersistedCard = { ids: Record<string, number>; paneId: string | null; startedAt: number; anchor: string | null; body: string }

// Compact live elapsed for the status footer: "23s" / "1m 40s" / "1h 02m".
function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60), sec = s % 60
  if (m < 60) return sec ? `${m}m ${sec}s` : `${m}m`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
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
async function mirrorCapture(paneId: string | null): Promise<string> {
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
  let body = lines.join('\n')
  while (body.length > 3500 && lines.length > 1) { lines.shift(); body = lines.join('\n') }
  if (body.length > 3500) body = chunkHtml(body, 3500)[0] ?? body.slice(0, 3500)
  return body
}

// Split a narration block into its visual paragraphs (blank-line separated), keeping fenced
// code blocks glued. On the card, paragraphs within one block render exactly like separate
// thoughts (a blank line apart on the card), so the MIRROR_THOUGHTS window must count
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

// A run of consecutive tool calls (between two thoughts) folded into compact summary lines:
// one aggregate sentence ("Searched 3 patterns, read 2 files, ran 2 shell commands"), then one
// line per file edit with its net line delta. The thoughts card shows the work narrative this
// way without the hybrid card's per-call noise.
export function renderToolRun(run: Array<Extract<FeedItem, { kind: 'tool' }>>): string[] {
  let searched = 0, read = 0, ran = 0
  const other = new Map<string, number>()
  const editLines: string[] = []
  for (const it of run) {
    if (it.tool === 'Grep' || it.tool === 'Glob') searched++
    else if (it.tool === 'Read') read++
    else if (it.tool === 'Bash') ran++
    else if (it.tool === 'Edit' || it.tool === 'MultiEdit' || it.tool === 'Write' || it.tool === 'NotebookEdit') {
      const file = it.detail.split('/').pop() || it.detail || 'file'
      const n = it.lines
      const delta = n ? ` <i>${n > 0 ? `+${n}` : `−${-n}`}</i>` : ''
      editLines.push(`✏️ <code>${escapeHtml(file)}</code>${delta}`)
    } else {
      const [, label] = toolBadge(it.tool)
      other.set(label, (other.get(label) ?? 0) + 1)
    }
  }
  const parts: string[] = []
  if (searched) parts.push(`searched ${searched} pattern${searched === 1 ? '' : 's'}`)
  if (read) parts.push(`read ${read} file${read === 1 ? '' : 's'}`)
  if (ran) parts.push(`ran ${ran} shell command${ran === 1 ? '' : 's'}`)
  for (const [label, n] of other) parts.push(n > 1 ? `${escapeHtml(label)} ×${n}` : escapeHtml(label))
  const sentence = parts.join(', ')
  return [
    ...(sentence ? [`<i>${sentence[0].toUpperCase()}${sentence.slice(1)}</i>`] : []),
    ...editLines,
  ]
}

// Thoughts card: Claude's narration rendered in shaded blockquotes, with each run of tool calls
// between thoughts folded into renderToolRun's compact summary lines.
export function renderThoughtsMirror(feed: FeedItem[], done: boolean): string {
  // Build the display blocks first: thought PARAGRAPHS (the visual unit — see
  // splitThoughtParagraphs) and tool-summary lines, in feed order.
  type Block = { thought: boolean; html: string }
  const blocks: Block[] = []
  let run: Array<Extract<FeedItem, { kind: 'tool' }>> = []
  const flushRun = () => { if (run.length) { for (const html of renderToolRun(run)) blocks.push({ thought: false, html }); run = [] } }
  for (const it of feed) {
    if (it.kind === 'tool') { run.push(it); continue }
    flushRun()
    for (const p of splitThoughtParagraphs(it.text)) {
      const html = mdToTelegramHtml(p).trim()
      if (html) blocks.push({ thought: true, html })
    }
  }
  flushRun()
  // Window to the latest few blocks, then merge ADJACENT thought paragraphs into one shaded
  // blockquote (💭 leads it) with the summary lines sitting between the quotes.
  const render = (win: Block[]): string => {
    const out: string[] = []
    let quote: string[] = []
    const flushQuote = () => { if (quote.length) { out.push(`<blockquote>💭 ${quote.join('\n\n')}</blockquote>`); quote = [] } }
    for (const b of win) { if (b.thought) quote.push(b.html); else { flushQuote(); out.push(b.html) } }
    flushQuote()
    return out.join('\n')
  }
  let win = blocks.slice(-MIRROR_THOUGHTS)
  let body = render(win)
  while (body.length > 3500 && win.length > 1) { win = win.slice(1); body = render(win) }
  if (body.length > 3500) body = chunkHtml(body, 3500)[0] ?? body.slice(0, 3500)
  if (!body) return done ? '✅ <b>Done</b>' : ''
  return done ? `${body}\n\n✅ <b>Done</b>` : body
}

// ---- The card lifecycle (shared by the focused card and per-pane aux cards) ----
class MirrorCard {
  msgIds = new Map<string, number>()   // chat_id → the live mirror message id
  // The pane the open card belongs to. A relay-loop restart on the SAME pane (focus re-adoption
  // mid-turn) must keep the existing card rather than orphan it and open a second one — see abandon.
  paneId: string | null = null
  // Consecutive not-working ticks. The card is finalized (one ✅ Done, then a fresh card on the next
  // turn) only after this crosses the threshold — so a single transient not-working tick can't split
  // one turn's card into two. Reset to 0 on any working tick.
  private idleTicks = 0
  // When the current card (work burst) opened — drives the live elapsed timer in the status footer.
  private startedAt = 0
  // The card has two update cadences. The heavy sync (pane capture + transcript read) refreshes the
  // body + the footer's verb/tokens on the throttled relay tick; the cached values carry across
  // ticks so a re-render doesn't re-scrape.
  private body = ''              // last-synced card body (no footer)
  private verb = 'Working'       // last-scraped spinner verb (held between syncs so it doesn't flicker)
  private tokens: string | null = null   // last-scraped PER-TURN token count (spinner only — never the session total)
  private lastSyncAt = 0         // last heavy sync; throttled to MIRROR_THROTTLE_MS
  // We edit the card ONLY when its CONTENT changes (body / verb / tokens) — never just because the
  // clock advanced — so the message barely flashes. This key is the content fingerprint (no
  // elapsed); an unchanged key means no edit.
  private contentKey = ''
  // The last-real-user-prompt uuid of the turn the open card tracks — the "same turn?" identity
  // used to resume the card across a daemon restart.
  private anchor: string | null = null
  // Restored ids await a verdict on the first tick (resume vs cap) — needs the live transcript,
  // so it can't be decided at load time.
  private pendingRestore: { anchor: string | null; body: string } | null = null

  constructor(private opts: {
    resolvePane: () => string | null
    targets: () => Promise<Array<{ chat: string; thread?: number }>>
    persist: () => void
    onCreated?: () => void
  }) {}

  // ---- persistence ----
  snapshot(): PersistedCard | null {
    return this.msgIds.size
      ? { ids: Object.fromEntries(this.msgIds), paneId: this.paneId, startedAt: this.startedAt, anchor: this.anchor, body: this.body }
      : null
  }

  restore(saved: Partial<PersistedCard>): void {
    if (!saved.ids || !Object.keys(saved.ids).length) return
    for (const [chat, mid] of Object.entries(saved.ids)) this.msgIds.set(chat, mid)
    this.paneId = saved.paneId ?? null
    this.startedAt = saved.startedAt || Date.now()
    this.pendingRestore = { anchor: saved.anchor ?? null, body: saved.body ?? '' }
  }

  // First tick after a restart with a restored card: same pane + same turn → keep editing it (the
  // restart is invisible); anything else → cap the orphan with its last known body so it never
  // lingers un-capped, and let the normal lifecycle open a fresh card for the new turn.
  private async reconcile(): Promise<void> {
    const saved = this.pendingRestore
    this.pendingRestore = null
    if (!saved || this.msgIds.size === 0) return
    const paneId = this.opts.resolvePane()
    const file = paneId ? await deps.resolveTranscriptForPane(paneId).catch(() => null) : null
    const anchor = file ? turnAnchorUuid(file) : null
    if (paneId && paneId === this.paneId && anchor && anchor === saved.anchor) {
      this.anchor = anchor
      this.body = saved.body   // contentKey + the cap fallback hold the last body until the next sync
      this.contentKey = saved.body
      process.stderr.write(`daemon: resumed live mirror card across restart (pane ${paneId})\n`)
      return
    }
    await this.capWithCachedBody(saved.body)
    process.stderr.write('daemon: capped orphaned mirror card from previous run\n')
  }

  private reset(): void {
    this.body = ''; this.verb = 'Working'; this.tokens = null
    this.contentKey = ''; this.idleTicks = 0; this.startedAt = 0; this.lastSyncAt = 0
    this.paneId = null; this.anchor = null
  }

  // The status line pinned to the bottom of a live card: the whimsical working verb + the live
  // elapsed + the PER-TURN token count (from Claude's spinner line only — never the session
  // total, which is what made it jump to ~270k).
  private footer(): string {
    const elapsed = this.startedAt ? fmtElapsed(Date.now() - this.startedAt) : null
    const parts = [`⏳ <i>${escapeHtml(this.verb)}</i>`, elapsed, this.tokens].filter(Boolean)
    return parts.length > 1 ? parts.join(' · ') : ''
  }

  // The HEAVY sync: rebuild the card body from the transcript (+ a pane capture for digest mode and
  // the footer's verb/tokens), updating body and the cached footer pieces. Costs a transcript read
  // (and a tmux capture when needed), so it runs only on the throttled tick. Returns whether
  // there's anything to show.
  private async syncBody(done: boolean): Promise<boolean> {
    const mode = deps.replyMode()
    if (mode === 'off') { this.body = ''; return false }
    const paneId = this.opts.resolvePane()
    const file = paneId ? await deps.resolveTranscriptForPane(paneId) : null

    // The capture feeds the digest body and the footer's verb/tokens scrape — with the footer
    // disabled, thoughts/tools/hybrid don't need it at all (saves a tmux spawn per sync).
    const needCap = (mode === 'tools' && mirrorMode() === 'digest') || (!done && MIRROR_FOOTER_ENABLED)
    const cap = needCap ? await mirrorCapture(paneId) : ''
    // Refresh the footer pieces from Claude's spinner line, but only when a fresh reading exists — a
    // tick that misses the line (it scrolls) keeps the last good verb/tokens instead of flickering.
    if (cap) {
      const wl = parseWorkingLine(cap)
      if (wl?.verb) this.verb = wl.verb
      if (wl?.tokens) this.tokens = wl.tokens
    }

    let body: string | null
    if (mode === 'thoughts') body = renderThoughtsMirror(file ? currentTurnFeed(file, done) : [], done) || null   // `done` → drop the reply (relayed on its own)
    else if (mode === 'hybrid') { const feed = file ? currentTurnFeed(file, done) : []; body = feed.length ? renderHybridMirror(feed, done) : null }
    else {
      // tools (legacy 'final')
      if (mirrorMode() === 'off') { this.body = ''; return false }
      if (mirrorMode() === 'digest') body = cap ? renderDigestMirror(cap, done) : null
      else { const acts = file ? currentTurnActivity(file) : []; body = acts.length ? renderToolsMirror(acts, done) : null }
    }
    if (body == null) return false
    this.body = body
    return true
  }

  // The card text = cached body + the live footer (omitted when done; the body already ends in ✅ Done).
  private compose(done: boolean): string {
    if (done || !this.body || !MIRROR_FOOTER_ENABLED) return this.body
    const footer = this.footer()
    return footer ? `${this.body}\n\n${footer}` : this.body
  }

  // Edit the open card to `text` across every tracked chat.
  private async pushCard(text: string): Promise<void> {
    if (!text || this.msgIds.size === 0) return
    for (const [chat, mid] of this.msgIds) await deps.bot.api.editMessageText(chat, mid, text, { parse_mode: 'HTML' }).catch(() => {})
    this.opts.persist()   // keep the persisted body current so a restart's cap fallback shows the latest state
  }

  // The card's whole lifecycle lives here, driven by one signal — `working` = turnInProgress(file)
  // from the transcript. While the turn runs we open the card once and edit it in place; the
  // instant the turn settles we cap it (✅ Done) and clear it. Idempotent.
  async update(working: boolean): Promise<void> {
    if (this.pendingRestore) await this.reconcile()   // restart verdict first: resume the old card or cap it
    const mode = deps.replyMode()
    // off → never a card. tools+terminalMirror:off → no card. (Explicit off → cap now, no debounce.)
    if (mode === 'off' || (mode === 'tools' && mirrorMode() === 'off')) { this.idleTicks = 0; if (this.msgIds.size) await this.finalize(); return }

    if (!working) {
      // Debounce the cap: only finalize after sustained idle, so a one-tick blip doesn't split the
      // turn's card. A real turn-end stays not-working, so it still caps within a few ticks.
      if (++this.idleTicks >= MIRROR_FINALIZE_TICKS && this.msgIds.size) await this.finalize()
      return
    }
    this.idleTicks = 0   // working again → reset the debounce
    if (this.msgIds.size === 0 && !this.startedAt) { this.startedAt = Date.now(); this.verb = 'Working'; this.tokens = null }   // start a fresh burst

    // Heavy sync is throttled (transcript read + maybe a capture). We refresh body/verb/tokens,
    // then edit ONLY if the content fingerprint moved — so the card tracks real activity, not the
    // clock, and barely flashes.
    const now = Date.now()
    if (now - this.lastSyncAt < MIRROR_THROTTLE_MS && this.msgIds.size > 0) return
    this.lastSyncAt = now
    if (!(await this.syncBody(false))) return   // nothing to show yet (e.g. thoughts mode, no narration)

    if (this.msgIds.size === 0) {
      // Open the card silently — it's the ambient mirror; the alerting message is the relayed reply.
      this.contentKey = this.body
      this.paneId = this.opts.resolvePane()   // remember which pane this card tracks (see abandon)
      const file = this.paneId ? await deps.resolveTranscriptForPane(this.paneId).catch(() => null) : null
      this.anchor = file ? turnAnchorUuid(file) : null   // the turn this card belongs to (restart resume check)
      const text = this.compose(false)
      for (const t of await this.opts.targets()) {
        const opts = { parse_mode: 'HTML' as const, disable_notification: true, ...(t.thread ? { message_thread_id: t.thread } : {}) }
        try { const m = await deps.bot.api.sendMessage(t.chat, text, opts); this.msgIds.set(t.chat, m.message_id) }
        catch (e) { process.stderr.write(`daemon: activity mirror create failed: ${e}\n`) }
      }
      this.opts.persist()
      this.opts.onCreated?.()
    } else {
      const key = this.body
      if (key !== this.contentKey) { this.contentKey = key; await this.pushCard(this.compose(false)) }   // edit only on real change
    }
  }

  // Freeze the open mirror on its final state and stop tracking it, so the next work burst opens
  // a fresh message. No-op if no mirror is open.
  async finalize(): Promise<void> {
    if (this.msgIds.size === 0) return
    await this.syncBody(true)
    const text = this.body || '🖥️ <b>Session</b> · idle'
    for (const [chat, mid] of this.msgIds) {
      await deps.bot.api.editMessageText(chat, mid, text, { parse_mode: 'HTML' }).catch(() => {})
    }
    this.msgIds.clear(); this.reset(); this.opts.persist()
  }

  // Cap with the CACHED body — no re-scrape. For orphans and dead panes, where the transcript /
  // pane may be gone (or belong to a different turn entirely).
  async capWithCachedBody(body?: string): Promise<void> {
    if (this.msgIds.size === 0) return
    const b = body ?? this.body
    const text = b ? `${b}\n\n✅ <b>Done</b>` : '✅ <b>Done</b>'
    for (const [chat, mid] of this.msgIds) await deps.bot.api.editMessageText(chat, mid, text, { parse_mode: 'HTML' }).catch(() => {})
    this.msgIds.clear(); this.reset(); this.opts.persist()
  }

  // Drop the open card entirely (delete, don't cap) and stop tracking it, so the next relay tick
  // re-sends a fresh one at the BOTTOM of the chat. Used when stream mode changes mid-turn.
  async respawn(): Promise<void> {
    if (this.msgIds.size === 0) return
    for (const [chat, mid] of this.msgIds) {
      await deps.bot.api.deleteMessage(chat, mid).catch(() => {})
    }
    this.msgIds.clear(); this.reset(); this.opts.persist()
  }

  // Abandon tracking of any open card WITHOUT touching the Telegram messages — used when focus/
  // relay moves to a new pane, so the stale card is simply left in place and a fresh one opens.
  // If `focusedPaneId` matches the pane the open card already tracks, this is a relay-loop restart
  // on the SAME session (focus re-adoption mid-turn), not a real pane switch — keep the live card so
  // the turn doesn't get a second, duplicate card opened beneath the orphaned first one.
  abandon(focusedPaneId?: string | null): void {
    if (focusedPaneId != null && this.msgIds.size > 0 && focusedPaneId === this.paneId) return
    this.msgIds.clear(); this.reset(); this.opts.persist()
  }
}

// ---- The focused card (DM mode / the focused session's topic) ----
const focusedCard = new MirrorCard({
  resolvePane: () => deps.getActivePaneId(),
  targets: () => deps.outboundTargets(),
  persist: () => writeJsonFile(MIRROR_STATE_FILE, focusedCard.snapshot() ?? {}),
  onCreated: () => deps.retriggerTyping(),   // the mirror send clears Telegram's typing state — re-assert it
})

export async function updateTerminalMirror(working: boolean): Promise<void> { await focusedCard.update(working) }
export async function respawnTerminalMirror(): Promise<void> { await focusedCard.respawn() }
export function abandonMirror(focusedPaneId?: string | null): void { focusedCard.abandon(focusedPaneId) }

// ---- Aux cards (forum-topics mode: one card per non-focused session, in its own topic) ----
const auxCards = new Map<string, MirrorCard>()

function persistAuxCards(): void {
  const out: Record<string, PersistedCard> = {}
  for (const [pane, card] of auxCards) { const s = card.snapshot(); if (s) out[pane] = s }
  writeJsonFile(MIRROR_AUX_STATE_FILE, out)
}

function auxCardFor(paneId: string): MirrorCard {
  let card = auxCards.get(paneId)
  if (!card) {
    card = new MirrorCard({
      resolvePane: () => paneId,
      targets: () => deps.auxOutboundTargets(paneId),
      persist: persistAuxCards,
    })
    auxCards.set(paneId, card)
  }
  return card
}

// Drive a non-focused pane's card from auxRelayTick (same `working` signal as its relay).
export async function updateAuxMirror(paneId: string, working: boolean): Promise<void> {
  await auxCardFor(paneId).update(working)
}

// The panes currently holding an aux card — for the daemon's cleanup sweep.
export function auxMirrorPanes(): string[] { return [...auxCards.keys()] }

// A pane left the aux set (died, or became the focused pane): cap its card with the cached body
// (the pane/transcript may be gone) and stop tracking it.
export async function dropAuxMirror(paneId: string): Promise<void> {
  const card = auxCards.get(paneId)
  if (!card) return
  auxCards.delete(paneId)
  await card.capWithCachedBody()
  persistAuxCards()
}

function restorePersistedCards(): void {
  focusedCard.restore(readJsonFile<Partial<PersistedCard>>(MIRROR_STATE_FILE, {}))
  const aux = readJsonFile<Record<string, Partial<PersistedCard>>>(MIRROR_AUX_STATE_FILE, {})
  for (const [pane, saved] of Object.entries(aux)) {
    const card = auxCardFor(pane)
    card.restore(saved)
  }
}
