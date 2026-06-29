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
import { parseWorkingLine, parseDoneLine } from './statusline.ts'
import { claudingFrame } from './clauding.ts'
import { currentTurnFeed, turnAnchorUuid, type FeedItem } from './transcript.ts'
import { isTopicMode } from './topics.ts'
import { isChatFlooded, asLowPriority } from './throttle.ts'
import { scheduleEdit, scheduleDelete } from './edit-scheduler.ts'
import type { Access } from './types.ts'

type MirrorDeps = {
  bot: Bot
  loadAccess: () => Access
  replyMode: () => 'thoughts' | 'actions' | 'off'
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
  // Whether the focused card is "buried" — newer messages landed below it AND the chat has since gone
  // quiet (the daemon owns the latest-message bookkeeping + the quiet debounce). When true, the card
  // deletes itself and re-opens at the bottom so the live mirror returns to where you're looking.
  reanchorDue?: (chat: string, thread: number | null | undefined, mirrorId: number) => boolean
}

let deps: MirrorDeps
export function initMirror(d: MirrorDeps): void {
  deps = d
  restorePersistedCards()
}

const MIRROR_THROTTLE_MS = 3000
// Group chats are flood-limited far tighter than DMs (~20 events/min vs ~60), and that's where every
// session's card piles up. Sync the card less often there so it doesn't saturate the send governor's
// budget and starve replies — it still edits only on real content change, just at a coarser floor.
const MIRROR_THROTTLE_GROUP_MS = 8000
// The FOCUSED session's card (the one the user is driving) refreshes faster than background topics
// even in a group. Safe now that the edit scheduler coalesces + paces every card and replies preempt
// via the per-chat governor — so the blanket 8s group floor (a crude flood guard from when nothing
// coordinated) can ease to 4s for the focused card. Background/aux topics keep the 8s floor. Held
// stable on "focused" (not active-view decay) so it stays snappy through a long turn you're watching.
const MIRROR_THROTTLE_ACTIVE_MS = 4000
const MIRROR_BLOCKS = 8        // digest mode: max ● blocks shown
const MIRROR_FINALIZE_TICKS = 3   // ~4.5s sustained idle (RELAY_POLL_MS=1500) before capping the card
const ACTIONS_TAIL = 3       // actions mode: how many of the newest calls stay as full detail rows
const MIRROR_THOUGHTS = 10   // thoughts mode: max thoughts shown (oldest falls off as new flow in)
// The status footer (verb · elapsed · tokens) is DISABLED for now — it doesn't track reliably yet
// (verb/token scraping off the spinner line is flaky). The whole machinery (the footer method,
// fmtElapsed, the verb/token scrape in syncBody) is kept intact; flip this to re-enable it
// once it can be made dependable. While false, compose renders the body only.
const MIRROR_FOOTER_ENABLED = true   // master switch for the bottom-pinned live status line (scraped verb + elapsed + tokens)
// The live "✻ <verb>…" spinner footer (the "Clauding" working indicator) is shown in DM ONLY. In a
// group/forum the card has no rich-draft companion and the animated spinner reads as noise against the
// plainer group formatting, so topics render the activity body alone. isTopicMode() is the whole-bridge
// mode, which is also the kind of chat this card targets (group topic vs DM), so it's the right gate.
const footerOn = (): boolean => MIRROR_FOOTER_ENABLED && !isTopicMode()

// ---- Card persistence across daemon restarts ----
// Card message ids used to live ONLY in process memory, so every deploy/crash mid-turn orphaned
// the live card: frozen un-capped (never edited again), with the fresh daemon opening a new one
// on its first working tick. With a deploy inside nearly every dev turn, each user message
// produced one card per restart — the "stream fragments into 5-6 messages" bug. Persisting
// {ids, pane, turn anchor, last body} lets the next daemon RESUME editing the same card when it's
// still the same pane + turn, and cap the orphan cleanly when it isn't.
const MIRROR_STATE_FILE = join(STATE_DIR, 'mirror-card.json')
const MIRROR_AUX_STATE_FILE = join(STATE_DIR, 'mirror-aux-cards.json')
type PersistedCard = { ids: Record<string, number>; threads?: Record<string, number>; paneId: string | null; startedAt: number; anchor: string | null; body: string; sawRealBody?: boolean }

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

// Actions card (the renamed tools mode): collapsed history + live tail, the TUI's own pattern.
// Everything older than the newest ACTIONS_TAIL calls folds into renderToolRun's aggregate
// ("Searched 14 patterns, read 9 files…" keeps counting instead of scrolling away); the newest
// few stay as full detail rows so you can watch what's running right now. At Done the whole
// turn collapses into the aggregate — a clean endpoint summary.
export function renderActionsMirror(tools: Array<Extract<FeedItem, { kind: 'tool' }>>, done: boolean): string {
  const split = done ? tools.length : Math.max(0, tools.length - ACTIONS_TAIL)
  const lines: string[] = [
    ...renderToolRun(tools.slice(0, split)),
    ...tools.slice(split).map(a => {
      const [emoji, label] = toolBadge(a.tool)
      return `${emoji} ${label}${a.detail ? `: <code>${escapeHtml(a.detail)}</code>` : ''}`
    }),
  ]
  if (done) lines.push(`✅ <b>Done</b> · ${tools.length} step${tools.length === 1 ? '' : 's'}`)
  let body = lines.join('\n')
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
// way without per-call noise.
export function renderToolRun(run: Array<Extract<FeedItem, { kind: 'tool' }>>): string[] {
  let searched = 0, read = 0, ran = 0
  const other = new Map<string, number>()
  const edits = new Map<string, number>()   // file → summed net delta (repeat edits fold into one line)
  for (const it of run) {
    if (it.tool === 'Grep' || it.tool === 'Glob') searched++
    else if (it.tool === 'Read') read++
    else if (it.tool === 'Bash') ran++
    else if (it.tool === 'Edit' || it.tool === 'MultiEdit' || it.tool === 'Write' || it.tool === 'NotebookEdit') {
      const file = it.detail.split('/').pop() || it.detail || 'file'
      edits.set(file, (edits.get(file) ?? 0) + (it.lines ?? 0))
    } else {
      const [, label] = toolBadge(it.tool)
      other.set(label, (other.get(label) ?? 0) + 1)
    }
  }
  const editLines = [...edits].map(([file, n]) =>
    `✏️ <code>${escapeHtml(file)}</code>${n ? ` <i>${n > 0 ? `+${n}` : `−${-n}`}</i>` : ''}`)
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

// Thoughts card: Claude's narration rendered as plain 💭-led text, with each run of tool calls
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
  // Window to the latest few blocks, then merge ADJACENT thought paragraphs into one 💭-led run
  // (plain text, no blockquote) with the tool-summary lines sitting between the runs.
  const render = (win: Block[]): string => {
    const out: string[] = []
    let quote: string[] = []
    const flushQuote = () => { if (quote.length) { out.push(`💭 ${quote.join('\n\n')}`); quote = [] } }
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
  // chat_id → the forum thread the card lives in (forum mode), so the edit scheduler can tier the
  // card by the user's active view. Persisted alongside ids so a resumed card keeps its thread.
  cardThread = new Map<string, number>()
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
  // Whether this card has ever shown REAL content (thoughts / tools), vs only the "Thinking…"
  // placeholder that opens the instant a message lands. A card that never upgraded past the
  // placeholder (a no-tool / pure-thinking turn, whose reply relays as its own message) is DELETED
  // on conclude rather than capped — so quick Q&A turns don't leave a "Thinking → Done" stub.
  private sawRealBody = false
  private updating = false       // serializes update() — the inbound kick can race the relay tick (double-open guard)
  private verb = 'Working'       // last-scraped spinner verb (held between syncs so it doesn't flicker)
  private tokens: string | null = null   // last-scraped PER-TURN token count (spinner only — never the session total)
  private footerTick = 0         // advances one spinner frame per real card edit (animates with activity, no extra edits)
  private lastSyncAt = 0         // last heavy sync; throttled to MIRROR_THROTTLE_MS
  private createCooldownUntil = 0   // after a create 429, hold off re-posting the card until this passes (stops the create-storm)
  // We edit the card ONLY when its CONTENT changes (body / verb / tokens) — never just because the
  // clock advanced — so the message barely flashes. This key is the content fingerprint (no
  // elapsed); an unchanged key means no edit.
  private contentKey = ''
  // The last-real-user-prompt uuid of the turn the open card tracks — the "same turn?" identity
  // used to resume the card across a daemon restart.
  private anchor: string | null = null
  // Restored ids await a verdict on the first tick (resume vs cap) — needs the live transcript,
  // so it can't be decided at load time.
  private pendingRestore: { anchor: string | null; body: string; sawRealBody?: boolean } | null = null

  constructor(private opts: {
    resolvePane: () => string | null
    targets: () => Promise<Array<{ chat: string; thread?: number }>>
    persist: () => void
    onCreated?: () => void
    focused?: boolean   // the focused session's card — refreshes at the snappier active cadence in group mode
  }) {}

  // ---- persistence ----
  snapshot(): PersistedCard | null {
    return this.msgIds.size
      ? { ids: Object.fromEntries(this.msgIds), threads: Object.fromEntries(this.cardThread), paneId: this.paneId, startedAt: this.startedAt, anchor: this.anchor, body: this.body, sawRealBody: this.sawRealBody }
      : null
  }

  restore(saved: Partial<PersistedCard>): void {
    if (!saved.ids || !Object.keys(saved.ids).length) return
    for (const [chat, mid] of Object.entries(saved.ids)) this.msgIds.set(chat, mid)
    if (saved.threads) for (const [chat, th] of Object.entries(saved.threads)) this.cardThread.set(chat, th)
    this.paneId = saved.paneId ?? null
    this.startedAt = saved.startedAt || Date.now()
    this.pendingRestore = { anchor: saved.anchor ?? null, body: saved.body ?? '', sawRealBody: saved.sawRealBody }
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
      this.sawRealBody = saved.sawRealBody ?? false   // resumed card: cap (not delete) on conclude only if it had shown real content (persisted, no longer inferred from the body)
      process.stderr.write(`daemon: resumed live mirror card across restart (pane ${paneId})\n`)
      return
    }
    await this.capWithCachedBody(saved.body)
    process.stderr.write('daemon: capped orphaned mirror card from previous run\n')
  }

  private reset(): void {
    this.body = ''; this.verb = 'Working'; this.tokens = null; this.sawRealBody = false
    this.contentKey = ''; this.idleTicks = 0; this.startedAt = 0; this.lastSyncAt = 0
    this.paneId = null; this.anchor = null; this.cardThread.clear()
  }

  // The placeholder body shown from the instant a message lands until the turn produces real content.
  // It's the reliable "your message landed, Claude is on it" signal — a real message, immune to
  // Telegram's per-chat typing competition (only one bot-typing renders per chat, so a busy parallel
  // session steals the indicator). Topic mode only: in DM the footer-only card already covers this.
  private thinkingBody(verb: string): string { return `<i>${escapeHtml(verb)}…</i>` }

  // The live Thinking… placeholder body: the CLI's current spinner verb (tracks "Thinking",
  // "Cogitating", … and falls back to "Thinking" when the spinner isn't on-screen at capture time).
  private async renderThinking(paneId: string | null): Promise<string> {
    const cap = await mirrorCapture(paneId).catch(() => '')
    const wl = cap ? parseWorkingLine(cap) : null
    return this.thinkingBody(wl?.verb || 'Thinking')
  }

  // The status line pinned to the bottom of a live card: the whimsical working verb + the live
  // elapsed + the PER-TURN token count (from Claude's spinner line only — never the session
  // total, which is what made it jump to ~270k).
  private footer(): string {
    const elapsed = this.startedAt ? fmtElapsed(Date.now() - this.startedAt) : null
    const parts = [`${claudingFrame(this.footerTick)} ${escapeHtml(this.verb)}…`, elapsed, this.tokens].filter(Boolean)
    return parts.length > 1 ? parts.join(' · ') : ''
  }

  // The HEAVY sync: rebuild the card body from the transcript (+ a pane capture for digest mode and
  // the footer's verb/tokens), updating body and the cached footer pieces. Costs a transcript read
  // (and a tmux capture when needed), so it runs only on the throttled tick. Returns whether
  // there's anything to show.
  private async syncBody(done: boolean, forceThinking = false): Promise<boolean> {
    const mode = deps.replyMode()
    if (mode === 'off') { this.body = ''; return false }
    const paneId = this.opts.resolvePane()
    // A freshly-messaged turn whose content isn't in the transcript yet: show the live Thinking…
    // placeholder rather than reading currentTurnFeed, which would still return the PREVIOUS,
    // concluded turn (the "idle session shows a stale, still-active card on a new message" bug).
    if (forceThinking && !done && !footerOn()) { this.body = await this.renderThinking(paneId); return true }
    const file = paneId ? await deps.resolveTranscriptForPane(paneId) : null

    // The capture feeds the digest body and the footer's verb/tokens scrape — with the footer
    // disabled, thoughts/actions don't need it at all (saves a tmux spawn per sync).
    const needCap = (mode === 'actions' && mirrorMode() === 'digest') || (!done && footerOn())
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
    else {
      // actions (legacy 'tools'/'final')
      if (mirrorMode() === 'off') { this.body = ''; return false }
      if (mirrorMode() === 'digest') body = cap ? renderDigestMirror(cap, done) : null
      else {
        const tools = file ? currentTurnFeed(file, done).filter((it): it is Extract<FeedItem, { kind: 'tool' }> => it.kind === 'tool') : []
        body = tools.length ? renderActionsMirror(tools, done) : null
      }
    }
    if (body == null) {
      // Bodyless phase of a live turn — this is only reached when the card should be open (working,
      // or the daemon's thinking-pending signal is set). In topic mode there's no footer to signal
      // the turn started, so fill it with the Thinking… placeholder so the card opens immediately on
      // receipt. DM keeps its footer-only card (footerOn), unchanged.
      if (!done && !footerOn()) { this.body = await this.renderThinking(paneId); return true }
      return false
    }
    this.body = body
    this.sawRealBody = true
    return true
  }

  // The card text = cached body + the live footer (omitted when done; the body already ends in ✅ Done).
  private compose(done: boolean): string {
    if (done || !footerOn()) return this.body
    const footer = this.footer()
    if (!this.body) return footer                       // pre-tool thinking phase → footer-only card
    return footer ? `${this.body}\n\n${footer}` : this.body
  }

  // Edit the open card to `text` across every tracked chat — via the global edit scheduler.
  private async pushCard(text: string): Promise<void> {
    if (!text || this.msgIds.size === 0) return
    this.scheduleCardEdit(text)
    this.footerTick++   // advance the spinner one frame per content change (gated on body change upstream)
    this.opts.persist()   // keep the persisted body current so a restart's cap fallback shows the latest state
  }

  // Register the card's latest desired text with the global edit scheduler for every tracked chat.
  // The scheduler coalesces superseded frames, paces them against the global + per-chat budget, skips
  // flooded chats, and prioritizes the card in the view the user is currently looking at — so the
  // mirror no longer edits raw (it used to compete with replies at equal priority for the budget).
  private scheduleCardEdit(text: string): void {
    for (const [chat, mid] of this.msgIds)
      scheduleEdit({ chat, mid, thread: this.cardThread.get(chat), source: 'mirror', parseMode: 'HTML', render: () => text })
  }

  // The card's whole lifecycle lives here, driven by one signal — `working` = turnInProgress(file)
  // from the transcript. While the turn runs we open the card once and edit it in place; the
  // instant the turn settles we cap it (✅ Done) and clear it. Idempotent.
  async update(working: boolean, pending = false): Promise<void> {
    // Serialize per card. The inbound kick (kickThinkingMirror) and the relay-loop tick can both
    // call update() for the same pane before the open's sendMessage resolves — without this they
    // each see msgIds empty and post a card, double-firing the "Thinking…" message (the loser is
    // then orphaned, un-tracked, and lingers). Skip a concurrent call; the next tick reconciles.
    if (this.updating) return
    this.updating = true
    try { await this.run(working, pending) } finally { this.updating = false }
  }
  private async run(working: boolean, pending = false): Promise<void> {
    if (this.pendingRestore) await this.reconcile()   // restart verdict first: resume the old card or cap it
    const mode = deps.replyMode()
    // off → never a card. actions+terminalMirror:off → no card. (Explicit off → cap now, no debounce.)
    if (mode === 'off' || (mode === 'actions' && mirrorMode() === 'off')) { this.idleTicks = 0; if (this.msgIds.size) await this.finalize(); return }

    if (!working && !pending) {
      // Debounce the cap: only finalize after sustained idle, so a one-tick blip doesn't split the
      // turn's card. A real turn-end stays not-working, so it still caps within a few ticks.
      if (++this.idleTicks >= MIRROR_FINALIZE_TICKS && this.msgIds.size) await this.finalize()
      return
    }
    this.idleTicks = 0   // working again → reset the debounce
    // Re-anchor: if the FOCUSED live card has been buried under newer messages and the chat has since
    // gone quiet (debounce owned by the daemon), drop it and re-open at the bottom so it returns to
    // where you're looking. respawn() paced-deletes the old card; the next tick opens a fresh one.
    if (this.opts.focused && this.msgIds.size > 0 && deps.reanchorDue) {
      for (const [chat, mid] of this.msgIds) {
        if (deps.reanchorDue(chat, this.cardThread.get(chat) ?? null, mid)) { await this.respawn(); return }
      }
    }
    if (this.msgIds.size === 0 && !this.startedAt) { this.startedAt = Date.now(); this.verb = 'Working'; this.tokens = null }   // start a fresh burst

    // Heavy sync is throttled (transcript read + maybe a capture). We refresh body/verb/tokens,
    // then edit ONLY if the content fingerprint moved — so the card tracks real activity, not the
    // clock, and barely flashes.
    const now = Date.now()
    const throttleMs = !isTopicMode() ? MIRROR_THROTTLE_MS : this.opts.focused ? MIRROR_THROTTLE_ACTIVE_MS : MIRROR_THROTTLE_GROUP_MS
    if (now - this.lastSyncAt < throttleMs && this.msgIds.size > 0) return
    this.lastSyncAt = now
    // Pre-content phase (initial thinking, or a new message on an idle session whose transcript still
    // holds the prior concluded turn): force the Thinking… placeholder over that stale/empty feed.
    // Once real content has shown (sawRealBody) we never force it again, so a concluding turn's card
    // doesn't flicker back to "Thinking…".
    const forceThinking = !working && !this.sawRealBody
    const hasBody = await this.syncBody(false, forceThinking)
    if (!hasBody && !(footerOn() && this.startedAt)) return   // footer-only card still opens in the pre-tool thinking phase (DM)

    if (this.msgIds.size === 0) {
      if (Date.now() < this.createCooldownUntil) return   // a recent create 429'd — don't hammer a fresh post every tick
      // Open the card silently — it's the ambient mirror; the alerting message is the relayed reply.
      this.contentKey = this.body || this.compose(false)
      this.paneId = this.opts.resolvePane()   // remember which pane this card tracks (see abandon)
      const file = this.paneId ? await deps.resolveTranscriptForPane(this.paneId).catch(() => null) : null
      this.anchor = file ? turnAnchorUuid(file) : null   // the turn this card belongs to (restart resume check)
      const text = this.compose(false)
      for (const t of await this.opts.targets()) {
        if (isChatFlooded(t.chat)) continue   // chat is in a 429 window — skip the cosmetic card, let replies use the budget
        const opts = { parse_mode: 'HTML' as const, disable_notification: true, ...(t.thread ? { message_thread_id: t.thread } : {}) }
        try { const m = await deps.bot.api.sendMessage(t.chat, text, opts); this.msgIds.set(t.chat, m.message_id); if (t.thread != null) this.cardThread.set(t.chat, t.thread) }
        catch (e) {
          const ra = Number((e as { parameters?: { retry_after?: number } })?.parameters?.retry_after)
          this.createCooldownUntil = Date.now() + (Number.isFinite(ra) ? ra * 1000 : 5000)
          process.stderr.write(`daemon: activity mirror create failed (cooldown ${Math.round((this.createCooldownUntil - Date.now()) / 1000)}s): ${e}\n`)
        }
      }
      this.opts.persist()
      this.opts.onCreated?.()
    } else {
      const key = this.body || this.compose(false)   // bodyless thinking phase → fingerprint the footer so it ticks
      if (key !== this.contentKey) { this.contentKey = key; await this.pushCard(this.compose(false)) }   // edit only on real change
    }
  }

  // Freeze the open mirror on its final state and stop tracking it, so the next work burst opens
  // a fresh message. No-op if no mirror is open.
  async finalize(): Promise<void> {
    if (this.msgIds.size === 0) return
    if (!this.sawRealBody) {
      // The card never upgraded past the "Thinking…" placeholder — a no-tool / pure-thinking turn
      // whose reply relayed as its own message. Drop the stub rather than cap it to a redundant
      // "✅ Done" sitting next to the answer.
      for (const [chat, mid] of this.msgIds) scheduleDelete(chat, mid)
      this.msgIds.clear(); this.reset(); this.opts.persist()
      return
    }
    await this.syncBody(true)
    let text = this.body || '🖥️ <b>Session</b> · idle'
    if (footerOn()) {
      const done = await this.doneFooter()   // "✻ Baked for 9m 59s" — Claude Code's real completion line
      text = (this.body || '').replace(/✅ <b>Done<\/b>(?: · \d+ steps?)?/, done).trim() || done   // swap the renderer's ✅ Done marker
    }
    this.scheduleCardEdit(text)   // terminal ✅ Done frame — supersedes any pending edit for this card
    this.msgIds.clear(); this.reset(); this.opts.persist()
  }

  // The completed-turn summary, scraped from Claude Code's "✻ Baked for 9m 59s" line; falls back to
  // the card's own elapsed (with the last working verb) when that line isn't on screen at cap time.
  private async doneFooter(): Promise<string> {
    const pane = this.opts.resolvePane()
    const cap = pane ? await mirrorCapture(pane).catch(() => '') : ''
    const d = cap ? parseDoneLine(cap) : null
    if (d) return `✻ ${escapeHtml(d.verb)} for ${escapeHtml(d.duration)}`
    const elapsed = this.startedAt ? fmtElapsed(Date.now() - this.startedAt) : null
    return elapsed ? `✻ ${escapeHtml(this.verb)} for ${elapsed}` : '✅ <b>Done</b>'
  }

  // Cap with the CACHED body — no re-scrape. For orphans and dead panes, where the transcript /
  // pane may be gone (or belong to a different turn entirely).
  async capWithCachedBody(body?: string): Promise<void> {
    if (this.msgIds.size === 0) return
    const b = body ?? this.body
    const text = b ? `${b}\n\n✅ <b>Done</b>` : '✅ <b>Done</b>'
    this.scheduleCardEdit(text)
    this.msgIds.clear(); this.reset(); this.opts.persist()
  }

  // Drop the open card entirely (delete, don't cap) and stop tracking it, so the next relay tick
  // re-sends a fresh one at the BOTTOM of the chat. Used when stream mode changes mid-turn.
  async respawn(): Promise<void> {
    if (this.msgIds.size === 0) return
    for (const [chat, mid] of this.msgIds) scheduleDelete(chat, mid)   // paced delete; the next tick opens a fresh card
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
  focused: true,                             // the user's driven session → snappier 4s cadence in group mode
})

export async function updateTerminalMirror(working: boolean, pending = false): Promise<void> { await asLowPriority(() => focusedCard.update(working, pending)) }
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
export async function updateAuxMirror(paneId: string, working: boolean, pending = false): Promise<void> {
  await asLowPriority(() => auxCardFor(paneId).update(working, pending))
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
