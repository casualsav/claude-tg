#!/usr/bin/env bun
import { Bot, GrammyError, InlineKeyboard, Keyboard, InputFile, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { randomBytes, createHash } from 'node:crypto'
import {
  readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, rmSync,
  statSync, renameSync, realpathSync, chmodSync, unlinkSync, existsSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, extname, basename, sep } from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import net from 'node:net'
import {
  frame, makeLineReader, computeCodeFingerprint,
  STATE_DIR, ACCESS_FILE, APPROVED_DIR, ENV_FILE, INBOX_DIR,
  SOCKET_PATH, DAEMON_PID_FILE, PENDING_EVENTS_FILE,
  type ShimToDaemon, type DaemonToShim, type InboundParams,
} from './common.ts'

// Code fingerprint captured at startup; sent to shims so they can detect and
// replace a daemon left running stale code after a plugin upgrade.
const CODE_FINGERPRINT = computeCodeFingerprint(import.meta.dir)
import { mdToTelegramHtml, chunkHtml, escapeHtml } from './markdown.ts'
import { detectUserPrompt, detectPermissionPrompt, isSubmitScreen, stripAnsi, type PromptInfo, type PromptOption, type PermissionPrompt } from './prompt.ts'
import { resolveTranscript, latestFinalReply, finalRepliesAfter, currentTurnActivity, listRecentSessions, findSessionCwd, type Activity } from './transcript.ts'

// Off-MCP outbound (experimental): instead of the agent calling the MCP reply tool,
// the daemon reads its reply from the session transcript and relays it — lets a session
// run with NO telegram MCP loaded (reclaims the per-request tool/instruction context).
const TRANSCRIPT_OUTBOUND = (process.env.TELEGRAM_TRANSCRIPT_OUTBOUND ?? '') === '1'
// Pin focus to a specific pane (no shim subscribe needed) — lets the daemon drive a
// plugin-less session for off-MCP testing/standalone use. When set, shim subscribes
// register but don't steal this focus.
const FORCE_PANE = process.env.TELEGRAM_FORCE_PANE || null

const exec = promisify(execFile)
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// Timestamp daemon diagnostics so the log file (the shim redirects the daemon's
// stderr there) is readable after the fact. Every daemon write is a whole line,
// so prefixing each write yields exactly one timestamp per line.
const _origStderrWrite = process.stderr.write.bind(process.stderr)
process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]): boolean => {
  const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
  return (_origStderrWrite as (c: string | Uint8Array, ...a: unknown[]) => boolean)(
    `[${new Date().toISOString()}] ${s}`, ...args,
  )
}) as typeof process.stderr.write

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
const STATIC = process.env.TELEGRAM_ACCESS_MODE === 'static'

if (!TOKEN) {
  process.stderr.write(
    `telegram daemon: TELEGRAM_BOT_TOKEN required\n` +
    `  set in ${ENV_FILE}\n`,
  )
  process.exit(1)
}

// ---- Access control (verbatim from server.ts) ----

type PendingEntry = { senderId: string; chatId: string; createdAt: number; expiresAt: number; replies: number }
type GroupPolicy = { requireMention: boolean; allowFrom: string[] }
type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
  renderMarkdown?: boolean
  autoContinue?: boolean
  terminalMirror?: 'tools' | 'digest' | 'off' | boolean
  sessionPin?: boolean
}

function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

const MAX_CHUNK_LIMIT = 4096
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

function readAccessFile(): Access {
  try {
    const parsed = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
      renderMarkdown: parsed.renderMarkdown,
      autoContinue: parsed.autoContinue,
      terminalMirror: parsed.terminalMirror,
      sessionPin: parsed.sessionPin,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try { renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`) } catch {}
    process.stderr.write(`telegram daemon: access.json corrupt, moved aside\n`)
    return defaultAccess()
  }
}

const BOOT_ACCESS: Access | null = STATIC
  ? (() => {
      const a = readAccessFile()
      if (a.dmPolicy === 'pairing') {
        process.stderr.write('telegram daemon: static mode — dmPolicy "pairing" downgraded to "allowlist"\n')
        a.dmPolicy = 'allowlist'
      }
      a.pending = {}
      return a
    })()
  : null

function loadAccess(): Access { return BOOT_ACCESS ?? readAccessFile() }

function assertAllowedChat(chat_id: string): void {
  const access = loadAccess()
  if (access.allowFrom.includes(chat_id)) return
  if (chat_id in access.groups) return
  throw new Error(`chat ${chat_id} is not allowlisted — add via /telegram:access`)
}

function saveAccess(a: Access): void {
  if (STATIC) return
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

function pruneExpired(a: Access): boolean {
  const now = Date.now(); let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) { delete a.pending[code]; changed = true }
  }
  return changed
}

type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

function gate(ctx: Context): GateResult {
  const access = loadAccess()
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access)
  if (access.dmPolicy === 'disabled') return { action: 'drop' }
  const from = ctx.from
  if (!from) return { action: 'drop' }
  const senderId = String(from.id)
  const chatType = ctx.chat?.type

  if (chatType === 'private') {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }
    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = { senderId, chatId: String(ctx.chat!.id), createdAt: now, expiresAt: now + 60 * 60 * 1000, replies: 1 }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    const groupId = String(ctx.chat!.id)
    const policy = access.groups[groupId]
    if (!policy) return { action: 'drop' }
    const groupAllowFrom = policy.allowFrom ?? []
    const requireMention = policy.requireMention ?? true
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) return { action: 'drop' }
    if (requireMention && !isMentioned(ctx, access.mentionPatterns)) return { action: 'drop' }
    return { action: 'deliver', access }
  }
  return { action: 'drop' }
}

function dmCommandGate(ctx: Context): { access: Access; senderId: string } | null {
  if (ctx.chat?.type !== 'private') return null
  if (!ctx.from) return null
  const senderId = String(ctx.from.id)
  const access = loadAccess()
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access)
  if (access.dmPolicy === 'disabled') return null
  if (access.dmPolicy === 'allowlist' && !access.allowFrom.includes(senderId)) return null
  return { access, senderId }
}

function isMentioned(ctx: Context, extraPatterns?: string[]): boolean {
  const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? []
  const text = ctx.message?.text ?? ctx.message?.caption ?? ''
  for (const e of entities) {
    if (e.type === 'mention') {
      const mentioned = text.slice(e.offset, e.offset + e.length)
      if (mentioned.toLowerCase() === `@${botUsername}`.toLowerCase()) return true
    }
    if (e.type === 'text_mention' && e.user?.is_bot && e.user.username === botUsername) return true
  }
  if (ctx.message?.reply_to_message?.from?.username === botUsername) return true
  for (const pat of extraPatterns ?? []) {
    try { if (new RegExp(pat, 'i').test(text)) return true } catch {}
  }
  return false
}

function assertSendable(f: string): void {
  let real, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch { return }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

function checkApprovals(): void {
  let files: string[]
  try { files = readdirSync(APPROVED_DIR) } catch { return }
  if (files.length === 0) return
  for (const senderId of files) {
    const file = join(APPROVED_DIR, senderId)
    void bot.api.sendMessage(senderId, 'Paired! Say hi to Claude.').then(
      () => rmSync(file, { force: true }),
      err => { process.stderr.write(`daemon: failed to send approval confirm: ${err}\n`); rmSync(file, { force: true }) },
    )
  }
}

if (!STATIC) setInterval(checkApprovals, 5000).unref()

// ---- Bot ----

const bot = new Bot(TOKEN)
let botUsername = ''

// ---- Typing presence ----
// Telegram's "typing…" chat action auto-expires after ~5s. To signal that
// Claude is busy for the *whole* duration of a turn, re-send it on an interval
// while the watched pane reports a working state. Armed when a message is
// relayed; cleared when the turn returns to idle (or after a hard time cap).
//
// The loop is self-correcting: it starts optimistically (an inbound message
// almost always kicks off work), then defers to observed pane state. So even if
// detectWorking misses a spinner variant, the indicator fades on its own rather
// than sticking — at worst a few seconds of typing, never a stuck one.
class TypingPresence {
  private targets = new Map<string, number>()   // chat_id -> expiry ms
  private lastWorkingAt = 0
  private sawWorking = false
  private optimisticUntil = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private static readonly CAP_MS = 15 * 60_000
  private static readonly TICK_MS = 4_000
  private static readonly OPTIMISTIC_MS = 8_000
  private static readonly GRACE_MS = 30_000   // keep typing through idle gaps between steps (agent pauses can be long)

  private ping(chat_id: string): void {
    void bot.api.sendChatAction(chat_id, 'typing').catch(() => {})
  }

  // An inbound message was relayed to Claude — begin showing presence.
  arm(chat_id: string): void {
    this.ping(chat_id)
    // With no pane to observe we can't tell when work ends — just ping once.
    if (!paneWatcher) return
    this.targets.set(chat_id, Date.now() + TypingPresence.CAP_MS)
    this.optimisticUntil = Date.now() + TypingPresence.OPTIMISTIC_MS
    this.sawWorking = false
    this.lastWorkingAt = 0
    if (!this.timer) this.timer = setInterval(() => this.tick(), TypingPresence.TICK_MS)
  }

  // Fresh working state from each pane change. Record only the latest time work was
  // seen; a single idle frame no longer ends the turn — the tick decides that from
  // sustained idle — so the indicator survives brief gaps between steps (e.g. a
  // withInjection pause while reading the model, or the lull between tool calls).
  update(working: boolean): void {
    if (working) { this.sawWorking = true; this.lastWorkingAt = Date.now() }
  }

  private tick(): void {
    const now = Date.now()
    for (const [chat, exp] of this.targets) if (exp < now) this.targets.delete(chat)
    if (this.targets.size === 0) { this.stop(); return }

    // Keep typing during the optimistic startup window, or while work was seen within
    // the grace period — this bridges pauses between tool calls / pane updates.
    const recentlyWorked = this.sawWorking && now - this.lastWorkingAt < TypingPresence.GRACE_MS
    if (now < this.optimisticUntil || recentlyWorked) {
      for (const chat of this.targets.keys()) this.ping(chat)
      return
    }
    // Idle past the grace → the turn is over: stop the typing indicator.
    this.clearAll()
  }

  private clearAll(): void {
    this.targets.clear()
    this.sawWorking = false
    this.lastWorkingAt = 0
    this.stop()
  }

  private stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }
}

const typingPresence = new TypingPresence()

// ---- Pane / tmux layer ----

type CcMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'

async function capturePane(paneId: string): Promise<string> {
  const { stdout } = await exec('tmux', ['capture-pane', '-p', '-t', paneId, '-J'], { timeout: 3000 })
  return stdout
}

// Pane validation + injection guard (opus-direct Block B).
async function paneAlive(paneId: string): Promise<boolean> {
  try {
    const { stdout } = await exec('tmux', ['display-message', '-p', '-t', paneId, '#{pane_id}'], { timeout: 2000 })
    return stdout.trim() === paneId
  } catch { return false }
}

async function sendKeys(paneId: string, keys: string[]): Promise<boolean> {
  if (!(await paneAlive(paneId))) return false
  await exec('tmux', ['send-keys', '-t', paneId, ...keys], { timeout: 2000 })
  return true
}

// Send a literal string into the pane (tmux -l), so codes/URLs with characters
// that would otherwise be read as key names ("Enter", "C-c", "-foo") are typed
// verbatim. The trailing `--` guards strings that begin with a dash.
async function sendKeysLiteral(paneId: string, text: string): Promise<boolean> {
  if (!(await paneAlive(paneId))) return false
  await exec('tmux', ['send-keys', '-l', '-t', paneId, '--', text], { timeout: 2000 })
  return true
}

// Type `text` into the pane's input and submit it with Enter, pausing the watcher
// so the resulting change isn't mistaken for a new prompt/event.
async function injectText(paneId: string, watcher: PaneWatcher, text: string): Promise<boolean> {
  return watcher.withInjection(async () => {
    const ok = await sendKeysLiteral(paneId, text)
    if (!ok) return false
    await sendKeys(paneId, ['Enter'])
    await waitForSettle(paneId, 300, 5000)
    return true
  })
}

// Bracket-paste `text` into the pane, then submit with Enter. Unlike injectText
// (literal keystrokes, where an embedded newline reads as Enter and submits early),
// bracketed paste (`paste-buffer -p`) lands multiline content — e.g. a relayed
// Telegram message — as one block so only the trailing Enter submits. Pauses the
// watcher so the inject + the agent's reply aren't misread as a new prompt/event.
const INJECT_BUFFER = 'tg-inbound'
async function injectPaste(paneId: string, watcher: PaneWatcher, text: string): Promise<boolean> {
  return watcher.withInjection(async () => {
    if (!(await paneAlive(paneId))) return false
    await exec('tmux', ['set-buffer', '-b', INJECT_BUFFER, '--', text], { timeout: 2000 })
    await exec('tmux', ['paste-buffer', '-d', '-p', '-b', INJECT_BUFFER, '-t', paneId], { timeout: 2000 })
    await waitForSettle(paneId, 200, 4000)
    await sendKeys(paneId, ['Enter'])
    await waitForSettle(paneId, 300, 5000)
    return true
  })
}

// Move the option cursor down `n` rows, one press at a time. Sending the Downs as
// a single batch makes this TUI coalesce/drop them (the cursor doesn't move), so we
// space them out and let it settle before the caller's follow-up key.
async function navigateDown(paneId: string, n: number): Promise<void> {
  if (n <= 0) return
  for (let i = 0; i < n; i++) {
    await sendKeys(paneId, ['Down'])
    await sleep(140)
  }
  await waitForSettle(paneId, 150, 2000)
}

// Send keys one at a time with a gap. A batched `send-keys k1 k2 k3` can outrun the TUI
// renderer and drop a key (a dropped Down mis-aligns a multi-select toggle onto the wrong
// row); pacing them the way navigateDown does keeps every keystroke landing.
async function sendKeysPaced(paneId: string, keys: string[], gapMs = 150): Promise<void> {
  for (const k of keys) { await sendKeys(paneId, [k]); await sleep(gapMs) }
}

function hashText(s: string): string {
  return createHash('md5').update(s).digest('hex')
}

// Defense-in-depth for relayed-prompt answers that should fully close their modal (single
// -select, multi-select submit, non-tabbed free text). If a drive sequence ever fails to
// match the TUI, the modal stays open and captures ALL keyboard input — a "frozen" pane the
// user can only escape by detaching. So after answering, if a prompt is still up, Esc it and
// say so. NOT used on tabbed/multi-question paths, where a remaining prompt is the next tab.
async function verifyPromptClosed(): Promise<void> {
  if (!activePaneId || !paneWatcher) return
  const cap = await capturePane(activePaneId).catch(() => '')
  if (!cap || (!detectUserPrompt(cap) && !detectPermissionPrompt(cap))) return
  await paneWatcher.withInjection(async () => {
    await sendKeys(activePaneId!, ['Escape'])
    await waitForSettle(activePaneId!, 200, 1500)
  })
  lastRelayedPromptHash = ''
  lastRelayedPermissionHash = ''
  notifyChats('⚠️ That answer didn’t register cleanly in the session — I dismissed the prompt so the terminal wouldn’t hang. Please try again.')
}

// PaneWatcher — ONE loop per active session (opus-direct Block C).
class PaneWatcher {
  private lastHash = ''
  private injecting = false
  private timer?: ReturnType<typeof setInterval>

  constructor(
    private paneId: string,
    private onEvent: (text: string) => void,
    private onDead: () => void,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), 800)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async withInjection<T>(fn: () => Promise<T>): Promise<T> {
    this.injecting = true
    try { return await fn() }
    finally {
      try { this.lastHash = hashText(await capturePane(this.paneId)) } catch {}
      this.injecting = false
    }
  }

  private async tick(): Promise<void> {
    if (this.injecting) return
    let text: string
    try { text = await capturePane(this.paneId) }
    catch { this.stop(); this.onDead(); return }
    const h = hashText(text)
    if (h === this.lastHash) return
    this.lastHash = h
    this.onEvent(text)
  }
}

// ---- Mode detection ----

function detectCurrentMode(paneText: string): CcMode {
  const lines = paneText.split('\n').map(l => stripAnsi(l))
  // Drop the "✗ Auto-update failed…" footer line first — its "Auto" otherwise matches the
  // auto-mode test, making every mode read as 'auto' (broke the /mode picker's live update).
  const footer = lines.slice(-5).filter(l => !/auto-update/i.test(l)).join(' ').toLowerCase()
  if (/bypass|dangerously.?skip|yolo/i.test(footer)) return 'bypassPermissions'
  if (/\bplan\s*(mode)?\b/i.test(footer)) return 'plan'
  if (/\bauto\b/i.test(footer)) return 'auto'
  if (/accept.?edit/i.test(footer)) return 'acceptEdits'
  return 'default'
}

// True when the pane is at Claude Code's normal prompt (input box visible), where reading or
// changing the mode is valid. A settings/config screen or another modal lacks this footer, so
// detectCurrentMode would there fall through to a false 'default' — mode ops guard on this and
// report "another screen" instead of silently switching/mis-reporting.
function onNormalPrompt(paneText: string): boolean {
  const tail = paneText.split('\n').map(l => stripAnsi(l)).slice(-8).join('\n').toLowerCase()
  return /shift\+tab to cycle|\? for shortcuts|esc to interrupt/.test(tail)
}

// Pull the active model name out of a /model picker capture (see parseCurrentModel
// for the row format). Guard against grabbing transcript prose instead of a model
// name when the picker didn't render cleanly: real model names are short, word-like,
// and free of sentence or arrow/glyph noise.
function looksLikeModel(s: string): boolean {
  if (!s || s.length > 40) return false
  if (/[→←⏺●⎿│]/.test(s)) return false       // arrows / transcript glyphs
  if (/[.!?]\s/.test(s)) return false          // sentence punctuation = prose
  return s.split(/\s+/).length <= 6
}

function parseCurrentModel(pickerText: string): string | null {
  const lines = pickerText.split('\n').map(l => stripAnsi(l))
  // Each option renders as "[❯] N. <Label> [✔]   <Version> · <description>", with
  // the active model marked by ✔ (the cursor ❯ also opens on it). Take that row and
  // return the version — the first "·"-segment of the description column (the text
  // after the run of 2+ spaces that separates label from description).
  const isOption = (l: string) => /^\s*(?:[❯►▶]\s*)?\d+[.)]\s/.test(l)
  const row =
    lines.find(l => isOption(l) && /[❯►▶]/.test(l) && /[✔✓]/.test(l)) ??
    lines.find(l => isOption(l) && /[✔✓]/.test(l)) ??
    lines.find(l => /^\s*[❯►▶]\s*\d+[.)]\s/.test(l))
  if (!row) return null
  const rest = row.replace(/^\s*[❯►▶]?\s*\d+[.)]\s*/, '').trim()
  const cols = rest.split(/\s{2,}/).map(s => s.trim()).filter(Boolean)
  const desc = cols.length >= 2 ? cols[cols.length - 1] : (cols[0] ?? '')
  const name = desc.split('·')[0].replace(/[✔✓]/g, '').trim()
  return looksLikeModel(name) ? name : null
}

// Read the active model by briefly opening the /model picker, reading the marked
// entry, then dismissing it with Esc. withInjection pauses the watcher (so the
// picker is never relayed as buttons) and re-baselines it on exit.
// Last successfully-read model, used as a fallback when a read comes back empty
// (e.g. the picker didn't render cleanly because the session was mid-turn).
let lastKnownModel: string | null = null

async function readCurrentModel(paneId: string, watcher: PaneWatcher): Promise<string | null> {
  return watcher.withInjection(async () => {
    // Opening /model only works when Claude is idle — mid-turn it just queues the
    // text. Skip the read while busy and fall back to the last known value.
    if (detectWorking(await capturePane(paneId))) return lastKnownModel
    if (!(await sendKeys(paneId, ['/model', 'Enter']))) return lastKnownModel
    await waitForSettle(paneId, 200, 4000)
    const text = await capturePane(paneId)
    await sendKeys(paneId, ['Escape'])
    await waitForSettle(paneId, 200, 3000)
    const parsed = parseCurrentModel(text)
    if (parsed) lastKnownModel = parsed
    return parsed ?? lastKnownModel
  })
}

// Pull the most recent block of command output from a pane capture: the last
// contiguous run of non-empty content lines sitting above the input box / footer.
// True while Claude Code is mid-turn. The TUI shows a spinner + "esc to
// interrupt" footer while working and clears it when the turn ends, so the
// footer is the ground truth. Markers are intentionally broad — detection only
// drives the typing indicator, which self-corrects from pane state.
function detectWorking(paneText: string): boolean {
  const footer = paneText.split('\n').map(l => stripAnsi(l)).slice(-8).join('\n')
  if (/esc to interrupt/i.test(footer)) return true
  // Spinner glyph followed by an elapsed timer, e.g. "✻ Working… (12s · …)".
  if (/[✢✳✶✻✽✺✷✸✹·●◐◓◑◒][^\n]*\(\d+s\b/.test(footer)) return true
  return false
}

// True when the pane is showing a usage-limit / throttle banner near the bottom —
// i.e. Claude is blocked, not finished. Used to suppress the "✅ Claude finished"
// idle notification while frozen at the limit.
function detectLimited(paneText: string): boolean {
  const tail = paneText.split('\n').map(l => stripAnsi(l)).slice(-10).join('\n')
  // Only the actual-frozen state (100% / "hit your … limit") — NOT sub-100% warnings,
  // which persist for days at the weekly limit while Claude keeps working fine.
  return /used 100% of your [\w-]+ limit|hit your [\w-]+ limit/i.test(tail)
}

function modeLabel(mode: CcMode): string {
  switch (mode) {
    case 'default': return '🏠 Default'
    case 'acceptEdits': return '✏️ Accept Edits'
    case 'plan': return '📋 Plan'
    case 'auto': return '🪄 Auto'
    case 'bypassPermissions': return '🚨 Bypass'
  }
}

async function waitForSettle(paneId: string, pollMs: number, maxMs: number): Promise<void> {
  let lastHash = ''
  let sameCount = 0
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    try {
      const text = await capturePane(paneId)
      const h = hashText(text)
      if (h === lastHash) {
        if (++sameCount >= 2) return
      } else {
        sameCount = 0
        lastHash = h
      }
    } catch { return }
    await sleep(pollMs)
  }
}

// Cycle the permission mode to `target` by pressing Shift+Tab and re-reading the
// footer after each press, stopping the moment the target mode is observed. This
// makes no assumption about the cycle's order or where it starts — it walks the
// real cycle — so it stays correct when bypass/auto modes are present or absent.
// Returns the mode reached, or null if the target isn't in this session's cycle
// (we loop all the way back to the starting mode without finding it, leaving the
// mode unchanged).
async function switchToMode(paneId: string, target: CcMode, watcher: PaneWatcher): Promise<CcMode | null> {
  return watcher.withInjection(async () => {
    const start = detectCurrentMode(await capturePane(paneId))
    if (start === target) return start

    let current = start
    for (let i = 0; i < 6; i++) {   // CC exposes at most a handful of modes — cap at one full loop
      await sendKeys(paneId, ['BTab'])
      await waitForSettle(paneId, 300, 5000)
      current = detectCurrentMode(await capturePane(paneId))
      if (current === target) return current
      if (current === start) break   // cycled all the way back — target isn't reachable here
    }
    return null
  })
}

// Prompt detection (pane-scrape → PromptInfo) lives in ./prompt.ts.

// ---- Session management ----

type ActiveShim = {
  socket: net.Socket
  write: (msg: DaemonToShim) => void
}

let activeShim: ActiveShim | null = null
let activePaneId: string | null = null
let paneWatcher: PaneWatcher | null = null

// ---- Multi-session registry ----
// Every connected shim is a session; we keep ALL of them (not last-subscriber-wins)
// and track which one is "focused". Inbound messages, pane-watching, the control
// surface, and permission replies follow the focused session — mirrored into
// activeShim/activePaneId/paneWatcher above so the rest of the daemon is unchanged.
// A new session never steals focus: the first/only session is focused, additional
// ones are announced and switched to explicitly with /use.
type Session = {
  socket: net.Socket
  write: (msg: DaemonToShim) => void
  paneId: string | null
  label: string
  subscribedAt: number
}
const sessions = new Map<string, Session>()   // insertion-ordered; keyed by sessionId
let currentSessionId: string | null = null
let noTmuxSeq = 0

// Permission requests awaiting a Telegram answer, keyed by request_id → the writer
// of the session that asked, so allow/deny goes back to the session that requested
// it rather than whichever happens to be focused.
const permissionOrigin = new Map<string, (msg: DaemonToShim) => void>()

function orderedSessions(): { id: string; s: Session }[] {
  return [...sessions.entries()].map(([id, s]) => ({ id, s }))
}

// Point the focused-session mirrors at `sessionId` and (re)start its pane watcher.
// Resets pane-derived relay dedups so the newly-focused pane surfaces fresh.
function setFocus(sessionId: string | null): void {
  if (paneWatcher) { paneWatcher.stop(); paneWatcher = null }
  currentSessionId = sessionId
  const s = sessionId ? sessions.get(sessionId) ?? null : null
  activeShim = s ? { socket: s.socket, write: s.write } : null
  activePaneId = s?.paneId ?? null
  lastRelayedPromptHash = ''
  lastRelayedPermissionHash = ''
  lastRelayedAuthUrl = ''
  if (activePaneId) { startPaneWatcher(activePaneId); startRelayLoop() }
  void updateSessionPin()
}

// Remove a session; refocus the next one (if any) if it was the focused one.
function dropSession(sessionId: string): void {
  if (!sessions.delete(sessionId)) return
  if (currentSessionId === sessionId) setFocus(orderedSessions()[0]?.id ?? null)
}

// End a session (socket closed or its pane died) and tell the user if focus moved.
function endSession(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (!s) return
  const wasFocused = currentSessionId === sessionId
  dropSession(sessionId)
  if (wasFocused) {
    const next = currentSessionId ? sessions.get(currentSessionId) : null
    notifyChats(next
      ? `🔚 Session “${s.label}” ended — focus moved to “${next.label}”.`
      : `🔚 Session “${s.label}” ended — no active sessions left.`)
  }
}

// Route a permission decision back to the session that requested it.
function respondPermission(request_id: string, behavior: 'allow' | 'deny'): void {
  const w = permissionOrigin.get(request_id) ?? activeShim?.write
  permissionOrigin.delete(request_id)
  w?.({ t: 'permission', params: { request_id, behavior } })
}

function notifyChats(text: string, extra?: { reply_markup?: InlineKeyboard; parse_mode?: 'HTML' }): void {
  for (const chat_id of loadAccess().allowFrom) void bot.api.sendMessage(chat_id, text, extra).catch(() => {})
}

// Tracks the last prompt sent to Telegram to avoid double-relay.
let lastRelayedPromptHash = ''
let lastRelayedPermissionHash = ''

// In-flight multi-select prompts, keyed by `${chatId}:${messageId}` of the relayed
// Telegram message. Each tap toggles an index in `selected`; Submit replays the
// selection into the pane as Space/Down keystrokes. Cleared on submit.
type PendingMultiSelect = { paneId: string; options: PromptOption[]; selected: Set<number> }
const pendingMultiSelect = new Map<string, PendingMultiSelect>()

// Prompts that carry a "Type something" free-text option, keyed by the relayed
// Telegram message `${chatId}:${messageId}`. Tapping its ✏️ button looks the prompt
// up here to spawn a force-reply; `downCount` is how many Down presses reach the
// free-text option (it sits just past the real options) and `tabbed` selects the
// post-entry behaviour (advance-and-continue vs. resolve).
type FreeTextPrompt = { paneId: string; downCount: number; tabbed: boolean; question: string }
const freeTextPrompts = new Map<string, FreeTextPrompt>()

// Force-reply messages awaiting the user's free-text answer, keyed by the
// force-reply message id; a reply to one is typed into the pane's free-text field.
const freeTextReplyTargets = new Map<string, Omit<FreeTextPrompt, 'question'>>()

// Prompts that offer a "Chat about this" escape hatch, keyed by the relayed
// Telegram message `${chatId}:${messageId}`. Tapping its 💬 button selects that
// option (declining the question so the user can reply conversationally);
// `downCount` is the Down presses to reach it — one past "Type something".
// `useEscape` = the menu has no literal "Chat about this" option (e.g. AskUserQuestion), so the
// 💬 button dismisses with Esc instead of navigating to and selecting that option.
type ChatPrompt = { paneId: string; downCount: number; tabbed: boolean; useEscape: boolean }
const chatPrompts = new Map<string, ChatPrompt>()

// Auth/login URLs surfaced from the pane (e.g. /login's OAuth link), so the user
// can open them in a browser and reply with the code. `lastRelayedAuthUrl` dedups
// the same link across watcher ticks; `authUrlMessageIds` (`${chatId}:${msgId}`)
// marks the relayed messages so a Telegram reply to one is injected into the pane.
let lastRelayedAuthUrl = ''
const authUrlMessageIds = new Set<string>()

// Build the <channel> block the agent recognizes (per the shim's MCP instructions)
// from an inbound message: source + every meta field as an attribute, content as the
// body — identical shape to a native channel notification, so a session that reads it
// as typed input still knows to reply via the reply tool with the right chat_id.
function formatChannelBlock(params: InboundParams): string {
  const attrs = Object.entries(params.meta)
    .map(([k, v]) => `${k}="${v.replace(/"/g, '&quot;')}"`)
    .join(' ')
  return `<channel source="telegram"${attrs ? ' ' + attrs : ''}>${params.content}</channel>`
}

// Inbound injections are serialized through one chain: two Telegram messages arriving
// close together would otherwise drive the same pane concurrently and interleave
// keystrokes. A failed inject (pane died mid-send) re-buffers for the next session.
let inboundInjectChain: Promise<unknown> = Promise.resolve()
function enqueueInboundInject(paneId: string, watcher: PaneWatcher, params: InboundParams): void {
  const block = formatChannelBlock(params)
  const run = () => injectPaste(paneId, watcher, block)
    .then(ok => {
      if (ok) {
        process.stderr.write(`daemon: inbound injected to pane ${paneId} chat=${params.meta.chat_id}\n`)
        // Off-MCP outbound is handled by the continuous relay loop (startRelayLoop), which
        // relays this turn's reply — and any proactive message — once, keyed by uuid.
      }
      else { process.stderr.write(`daemon: inbound inject no-op (pane ${paneId} gone) — buffering\n`); bufferEvent(params) }
    })
    .catch(err => process.stderr.write(`daemon: inbound inject failed: ${err}\n`))
  inboundInjectChain = inboundInjectChain.then(run, run)
}

// ---- Off-MCP outbound: relay the agent's reply from the transcript ----

// Auto-provision off-MCP tooling so a plugin-less session works with no manual setup:
//  - the `tg` actions CLI on PATH (send/react/edit), and
//  - a stable ensure-daemon launcher for the SessionStart hook to relaunch the daemon.
// Re-run each startup so it tracks plugin upgrades. The ensure-daemon launcher globs the
// cache at runtime, so it survives version bumps even while the daemon is down (post-
// reboot). No-ops if the off-MCP sources aren't present (a non-off-MCP build).
function provisionOffMcpTooling(): void {
  try {
    const tgctl = join(import.meta.dir, 'tgctl.ts')
    if (!existsSync(tgctl)) return
    const binDir = [join(homedir(), '.bun', 'bin'), join(homedir(), '.local', 'bin')].find(d => existsSync(d))
    if (binDir) {
      writeFileSync(join(binDir, 'tg'), `#!/bin/sh\nexec bun ${tgctl} "$@"\n`, { mode: 0o755 })
    }
    // Stable ensure-daemon launcher: resolves the newest cache copy at run time (so it
    // works after a version bump, and when the daemon is down). The SessionStart hook
    // runs `bun <STATE_DIR>/ensure-daemon.js`.
    writeFileSync(join(STATE_DIR, 'ensure-daemon.js'),
      `#!/usr/bin/env bun
import { readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
const base = join(homedir(), '.claude', 'plugins', 'cache', 'better-claude-plugins', 'telegram')
let t = null
try { for (const v of readdirSync(base).sort().reverse()) { const p = join(base, v, 'ensure-daemon.ts'); if (existsSync(p)) { t = p; break } } } catch {}
if (t) await import(t)
`, { mode: 0o755 })
    process.stderr.write(`daemon: provisioned off-mcp tooling (tg CLI${binDir ? ` → ${binDir}` : ' — no bin dir'}, ensure-daemon)\n`)
  } catch (e) { process.stderr.write(`daemon: off-mcp provision failed: ${e}\n`) }
}

async function paneCwd(paneId: string): Promise<string | null> {
  try {
    const { stdout } = await exec('tmux', ['display-message', '-p', '-t', paneId, '#{pane_current_path}'], { timeout: 2000 })
    return stdout.trim() || null
  } catch { return null }
}

// Send agent markdown to chats using the same render/chunk path as the reply tool.
async function sendAgentText(chats: string[], text: string): Promise<void> {
  const access = loadAccess()
  const render = access.renderMarkdown !== false
  const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
  const chunks = render ? chunkHtml(mdToTelegramHtml(text), limit) : chunk(text, limit, access.chunkMode ?? 'length')
  for (const chat_id of chats) {
    for (const c of chunks) {
      await bot.api.sendMessage(chat_id, c, render ? { parse_mode: 'HTML' } : {}).catch(e => process.stderr.write(`daemon: transcript relay send failed: ${e}\n`))
    }
  }
}

// After injecting a message, wait for the agent's turn to settle, then read its reply
// (the final text block of its response to that exact message) from the transcript and
// relay it. Self-driven (not tied to the typing/idle signal, which can miss a fast
// turn): poll the pane until it's been idle for a couple of cycles AND the transcript
// holds a reply for our anchor. One poll per injected message, so two quick messages
// each get their own answer relayed.
// Continuous off-MCP outbound. Instead of arming a relay only when an inbound Telegram
// message is injected, a single self-driven loop watches the focused pane and relays each
// completed turn's final assistant text ONCE — keyed by the transcript entry uuid. That
// covers inbound replies AND proactive messages (status pings, a "done" after a long task,
// a reply to terminal-typed input), which the inbound-only relay silently dropped. Idle is
// required (2 consecutive non-working reads) so mid-turn narration isn't relayed, and the
// cursor is primed to the current tail on (re)start so existing backlog never re-sends.
const RELAY_POLL_MS = 1500
let lastRelayedUuid = ''
let relayCursorPrimed = false
// Last uuid relayed per transcript file, so switching back to a session can replay what it
// said while unfocused. In-memory: a fresh daemon has no cursors, so it never replays a
// backlog on the first focus of a session (or after a restart).
const lastRelayedByFile = new Map<string, string>()
// Cross-session unread pings: the latest uuid we've pinged about per file, and the live
// ping message ids (file → chat → messageId) so a follow-up edits in place and a read clears.
const unreadNotified = new Map<string, string>()
const unreadNotifMsgs = new Map<string, Map<string, number>>()
let relayIdleStreak = 0
let relayLoopGen = 0   // bump to retire the running loop when focus moves

// ---- Live activity mirror ----
// One self-editing Telegram message per work burst showing what Claude is doing, so the user
// can watch without the terminal. Two modes (access.terminalMirror, default 'tools'):
//   'tools'  — a compact list of the turn's recent tool calls (🔧 name + detail).
//   'digest' — Claude's recent "● …" blocks (narration + tool headers), the simplified
//              formatting the original /terminal used, as a plain message (the blocks are prose).
//   'off'/false — disabled.
// Refreshed while working, frozen when it settles; throttled + only edited on change for
// Telegram's edit limits. No mirror opens for a sub-tick (tool-less) turn.
const MIRROR_THROTTLE_MS = 3000
const MIRROR_BLOCKS = 8        // digest mode: max ● blocks shown
const MIRROR_TOOLS = 3         // tools mode: max tool rows shown (just the latest few)
const mirrorMsgIds = new Map<string, number>()   // chat_id → the live mirror message id
let mirrorLastText = ''
let mirrorLastEditAt = 0

// Live tool-use feed. On by default ('tools') — opt out via access.json
// `terminalMirror: "off"` (or pick `"digest"`).
function mirrorMode(): 'tools' | 'digest' | 'off' {
  const v = loadAccess().terminalMirror
  if (v === 'off' || v === false) return 'off'
  if (v === 'digest') return 'digest'
  return 'tools'   // unset, true, or 'tools'
}

// Claude's recent "● <text>" blocks from the pane — each leading bullet plus its indented
// wrapped continuation — skipping ⎿ tool-output lines and box chrome. A clean digest of what
// Claude said/did, far more readable than the raw terminal. Oldest first, last `max` kept.
function recentAssistantBlocks(raw: string, max: number): string[] {
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
  if (!activePaneId) return ''
  try { return (await exec('tmux', ['capture-pane', '-p', '-t', activePaneId, '-S', '-120', '-J'], { timeout: 3000 })).stdout }
  catch { return '' }
}

function renderDigestMirror(raw: string, done: boolean): string {
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
}
function toolBadge(tool: string): [string, string] {
  if (TOOL_BADGE[tool]) return TOOL_BADGE[tool]
  if (tool.startsWith('mcp__')) return ['🔌', tool.split('__').pop() || tool]   // mcp__server__action → action
  return ['🔧', tool]
}

function renderToolsMirror(acts: Activity[], done: boolean): string {
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

// The mirror text for the active mode, or null when there's nothing to show yet.
async function buildMirrorText(done: boolean): Promise<string | null> {
  if (mirrorMode() === 'digest') {
    const raw = await mirrorCapture()
    return raw ? renderDigestMirror(raw, done) : null
  }
  const cwd = activePaneId ? await paneCwd(activePaneId) : null
  const file = cwd ? resolveTranscript(cwd) : null
  const acts = file ? currentTurnActivity(file) : []
  return acts.length ? renderToolsMirror(acts, done) : null
}

// While working, post/refresh the mirror; freeze it when the turn settles.
// `settled` = the turn is really over (sustained idle), NOT a single idle tick — a turn
// flickers idle between tool calls, and finalizing on those would end the message and start a
// fresh one on the next call (the "multiple working messages" bug). Caller passes the same
// 2-tick streak the reply relay uses.
async function updateTerminalMirror(settled: boolean): Promise<void> {
  if (mirrorMode() === 'off') { if (mirrorMsgIds.size) await finalizeTerminalMirror(); return }
  if (settled) { await finalizeTerminalMirror(); return }

  const text = await buildMirrorText(false)
  if (!text) return
  const now = Date.now()
  if (mirrorMsgIds.size === 0) {
    mirrorLastText = text; mirrorLastEditAt = now
    for (const chat of loadAccess().allowFrom) {
      try { const m = await bot.api.sendMessage(chat, text, { parse_mode: 'HTML' }); mirrorMsgIds.set(chat, m.message_id) }
      catch (e) { process.stderr.write(`daemon: activity mirror create failed: ${e}\n`) }
    }
  } else if (text !== mirrorLastText && now - mirrorLastEditAt >= MIRROR_THROTTLE_MS) {
    mirrorLastText = text; mirrorLastEditAt = now
    for (const [chat, mid] of mirrorMsgIds) {
      await bot.api.editMessageText(chat, mid, text, { parse_mode: 'HTML' }).catch(() => {})
    }
  }
}

// Freeze the open mirror on its final state and stop tracking it, so the next work burst opens
// a fresh message. No-op if no mirror is open.
async function finalizeTerminalMirror(): Promise<void> {
  if (mirrorMsgIds.size === 0) return
  const text = (await buildMirrorText(true)) ?? '🖥️ <b>Session</b> · idle'
  for (const [chat, mid] of mirrorMsgIds) {
    await bot.api.editMessageText(chat, mid, text, { parse_mode: 'HTML' }).catch(() => {})
  }
  mirrorMsgIds.clear(); mirrorLastText = ''; mirrorLastEditAt = 0
}

async function relayLoopTick(gen: number): Promise<void> {
  if (gen !== relayLoopGen || !activePaneId || !TRANSCRIPT_OUTBOUND) return
  const paneId = activePaneId
  let cap = ''
  try { cap = await capturePane(paneId) } catch { /* transient capture miss — retry next tick */ }
  const idle = cap !== '' && !detectWorking(cap) && !detectLimited(cap)
  relayIdleStreak = idle ? relayIdleStreak + 1 : 0

  // Live activity mirror — finalize only when the turn is settled (2-tick streak), so brief
  // idle gaps between tool calls don't spawn a fresh status message each time.
  await updateTerminalMirror(relayIdleStreak >= 2).catch(() => {})

  if (relayIdleStreak >= 2) {
    const cwd = await paneCwd(paneId)
    const file = cwd ? resolveTranscript(cwd) : null
    const reply = file ? latestFinalReply(file) : null
    if (relayCursorPrimed && reply && reply.uuid && reply.uuid !== lastRelayedUuid) {
      lastRelayedUuid = reply.uuid   // advance before the await so a fast next tick can't double-send
      if (file) lastRelayedByFile.set(file, reply.uuid)
      const chats = loadAccess().allowFrom
      process.stderr.write(`daemon: transcript-outbound relaying ${reply.text.length} chars (uuid ${reply.uuid.slice(0, 8)}) to ${chats.join(',')}\n`)
      await sendAgentText(chats, reply.text).catch(e => process.stderr.write(`daemon: relay send failed: ${e}\n`))
    }
  }
  if (gen === relayLoopGen) setTimeout(() => void relayLoopTick(gen), RELAY_POLL_MS)
}

// Prime the cursor to the transcript tail that exists right now, so only NEW replies relay.
// Done immediately on (re)start — not on the first idle — so a reply produced after a mid
// -turn restart still gets a fresh uuid and relays (the earlier idle-priming swallowed it).
async function primeRelayCursor(): Promise<void> {
  try {
    const cwd = activePaneId ? await paneCwd(activePaneId) : null
    const file = cwd ? resolveTranscript(cwd) : null
    const latest = file ? latestFinalReply(file) : null
    // If we relayed from this session before and it has spoken since (switched away and
    // back), replay the messages we missed before resuming live relay.
    const prev = file ? lastRelayedByFile.get(file) : undefined
    // prev === '' is a real baseline ("seen nothing yet"), so test against undefined, not falsy.
    if (file && prev !== undefined && latest && prev !== latest.uuid) {
      const unread = finalRepliesAfter(file, prev)
      const chats = loadAccess().allowFrom
      if (unread.length) {
        const header = `💬 <i>${unread.length} message${unread.length > 1 ? 's' : ''} from this session while you were away:</i>`
        for (const chat of chats) await bot.api.sendMessage(chat, header, { parse_mode: 'HTML' }).catch(() => {})
        for (const r of unread) await sendAgentText(chats, r.text).catch(() => {})
      }
    }
    lastRelayedUuid = latest?.uuid ?? ''
    if (file) lastRelayedByFile.set(file, lastRelayedUuid)
  } catch { lastRelayedUuid = '' }
  relayCursorPrimed = true
}

// (Re)start the relay loop for the focused pane, retiring any prior loop and re-priming the
// cursor so the new pane's existing tail isn't relayed. No-op unless off-MCP outbound is on.
function startRelayLoop(): void {
  if (!TRANSCRIPT_OUTBOUND) return
  const gen = ++relayLoopGen
  relayCursorPrimed = false
  relayIdleStreak = 0
  mirrorMsgIds.clear(); mirrorLastText = ''; mirrorLastEditAt = 0   // abandon any mirror from the old pane
  void primeRelayCursor().finally(() => {
    if (gen === relayLoopGen) setTimeout(() => void relayLoopTick(gen), RELAY_POLL_MS)
  })
}

// ---- Off-MCP pane auto-discovery ----
// When no pane is pinned (FORCE_PANE) and no shim session is driving, find a plugin-less
// `claude` pane on its own and adopt it — no .env edit / restart to bind a work session.
// Plugin (MCP) sessions register over the shim socket, so they live in `sessions` and are
// excluded here; and we only adopt panes whose claude argv carries --strict-mcp-config, so
// even an unregistered MCP pane is never grabbed. Explicit FORCE_PANE always wins.
let adoptedPaneId: string | null = null

// Every plugin-less pane we currently know about (the focused one plus any unfocused
// siblings). A new pane is announced once, with a switch button, and does NOT steal focus.
const offMcpPanes = new Set<string>()

// All pids in the process tree rooted at `rootPid` (the pane's shell), so we can find the
// claude process — it runs as a child of the pane shell, not the pane's own pid.
async function processTree(rootPid: string): Promise<string[]> {
  const all = [rootPid], queue = [rootPid]
  while (queue.length) {
    const pid = queue.shift()!
    try {
      const { stdout } = await exec('pgrep', ['-P', pid], { timeout: 2000 })
      for (const c of stdout.split('\n').map(s => s.trim()).filter(Boolean)) { all.push(c); queue.push(c) }
    } catch {}
  }
  return all
}

// A process's full argv. Linux exposes it via /proc; macOS/BSD has no /proc, so fall back to
// `ps -ww` (unlimited width, no truncation). Keeps off-MCP auto-discovery portable.
async function processArgv(pid: string): Promise<string> {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() } catch {}
  try { return (await exec('ps', ['-ww', '-p', pid, '-o', 'args='], { timeout: 2000 })).stdout.trim() } catch {}
  return ''
}

// True if the pane shell `panePid` has a claude child launched plugin-less
// (--strict-mcp-config — the off-MCP session signature).
async function isPluginlessClaude(panePid: string): Promise<boolean> {
  for (const pid of await processTree(panePid)) {
    const argv = await processArgv(pid)
    if (!argv || !/\bclaude\b/.test(argv)) continue
    return argv.includes('--strict-mcp-config')
  }
  return false
}

// Scan tmux for every adoptable plugin-less claude pane (registered MCP sessions excluded).
async function findOffMcpPanes(): Promise<string[]> {
  let out = ''
  try {
    const { stdout } = await exec('tmux',
      ['list-panes', '-a', '-F', '#{pane_id}\t#{pane_pid}\t#{pane_current_command}'], { timeout: 3000 })
    out = stdout
  } catch { return [] }

  const candidates: string[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const [paneId, panePid, cmd] = line.split('\t')
    if (!/^(claude|node|bun)$/.test(cmd)) continue   // cheap prefilter before walking the tree
    if (sessions.has(paneId)) continue               // a registered (plugin/MCP) session — never adopt
    if (await isPluginlessClaude(panePid)) candidates.push(paneId)
  }
  return candidates
}

// Mirror the FORCE_PANE binding for an auto-discovered pane: drive it directly, no Session
// (there's no shim socket). Tracked in adoptedPaneId so a later shim subscribe announces
// rather than silently stealing it.
const ADOPTED_PANE_FILE = join(STATE_DIR, 'adopted-pane')

function adoptPane(paneId: string): void {
  offMcpPanes.add(paneId)
  focusOffMcpPane(paneId)
  process.stderr.write(`daemon: adopted off-MCP pane ${paneId} (auto-discovery)\n`)
  // Only announce a genuinely NEW pane. A daemon restart (frequent during dev, or on reboot)
  // re-adopts the same pane and shouldn't re-ping "Connected". Persisted so it survives the
  // restart; the next work burst's status message is enough of a signal anyway.
  let prev = ''
  try { prev = readFileSync(ADOPTED_PANE_FILE, 'utf8').trim() } catch {}
  try { writeFileSync(ADOPTED_PANE_FILE, paneId, { mode: 0o600 }) } catch {}
  if (prev !== paneId) notifyChats(`🔗 Connected to the Claude session.`)
}

// Point the bridge at an off-MCP pane (no shim socket): drive it directly and read its
// transcript. Used by initial adoption and when switching to a discovered sibling pane.
function focusOffMcpPane(paneId: string): void {
  if (paneWatcher) { paneWatcher.stop(); paneWatcher = null }
  adoptedPaneId = paneId
  currentSessionId = paneId
  activePaneId = paneId
  activeShim = null
  lastRelayedPromptHash = ''
  lastRelayedPermissionHash = ''
  lastRelayedAuthUrl = ''
  startPaneWatcher(paneId)
  startRelayLoop()
  void updateSessionPin()
}

// Announce a newly discovered sibling pane with a one-tap switch button — never steals focus.
async function announceNewSession(paneId: string): Promise<void> {
  const n = await sessionNumber(paneId)
  const cwd = await paneCwd(paneId)
  // Snapshot a read baseline at announcement: the user has "seen up to now" (nothing yet),
  // so anything this session says before they first switch to it relays as unread on switch.
  const tfile = cwd ? resolveTranscript(cwd) : null
  if (tfile && !lastRelayedByFile.has(tfile)) lastRelayedByFile.set(tfile, latestFinalReply(tfile)?.uuid ?? '')
  const who = `Session ${n ?? '?'}`
  const where = cwd ? ` (<code>${escapeHtml(cwd)}</code>)` : ''
  const kb = new InlineKeyboard().text(`♻️ Switch to ${who}`, `adoptpane:${paneId}`)
  notifyChats(`🆕 New Claude session: <b>${who}</b>${where}`, { reply_markup: kb, parse_mode: 'HTML' })
}

// Keep the pane registry in sync. Adopts a pane only when nothing is driving; any additional
// pane is registered and announced (with a switch button) without taking focus. Runs at
// startup and on a slow interval, so panes started before/after the daemon get picked up.
async function discoverPanes(): Promise<void> {
  if (FORCE_PANE || !TRANSCRIPT_OUTBOUND) return
  const panes = await findOffMcpPanes()
  const live = new Set(panes)
  for (const p of [...offMcpPanes]) if (!live.has(p)) offMcpPanes.delete(p)

  const haveFocus = !!activePaneId && await paneAlive(activePaneId)
  if (!haveFocus && panes.length) {
    // Prefer the pane we were on before (persisted by adoptPane) if it's still a live
    // candidate, so focus survives a daemon restart instead of snapping back to panes[0].
    let prev = ''
    try { prev = readFileSync(ADOPTED_PANE_FILE, 'utf8').trim() } catch {}
    adoptPane(panes.includes(prev) ? prev : panes[0])   // sets focus + adds to offMcpPanes
  }

  for (const p of panes) {
    if (p === activePaneId) { offMcpPanes.add(p); continue }
    if (!offMcpPanes.has(p)) { offMcpPanes.add(p); void announceNewSession(p) }
  }
  void updateSessionPin()
}

// Deliver an inbound Telegram message to the focused session. Claude Code only lets
// the channel's *primary* --channels session consume inbound notifications, so a
// focused-but-secondary session would never see a socket-delivered message. Typing the
// <channel> block into its pane bypasses that consumer limit and works for any focused
// session. No-tmux sessions (no pane to drive) fall back to the socket; with nothing
// focused, buffer for replay when a session next takes focus.
function emitInbound(params: InboundParams): void {
  if (activePaneId && paneWatcher) {
    enqueueInboundInject(activePaneId, paneWatcher, params)
  } else if (activeShim) {
    activeShim.write({ t: 'inbound', params })
  } else {
    bufferEvent(params)
  }
}

// ---- Event buffering ----

function bufferEvent(params: InboundParams): void {
  const MAX = 50
  try {
    let existing: string[] = []
    try { existing = readFileSync(PENDING_EVENTS_FILE, 'utf8').split('\n').filter(l => l.trim()) } catch {}
    existing.push(JSON.stringify({ t: 'inbound', params }))
    if (existing.length > MAX) existing = existing.slice(-MAX)
    writeFileSync(PENDING_EVENTS_FILE, existing.join('\n') + '\n', { mode: 0o600 })
  } catch (err) {
    process.stderr.write(`daemon: buffer write failed: ${err}\n`)
  }
}

function replayBuffer(): void {
  // Truncate first so new events buffer fresh; deliver from the in-memory copy through
  // emitInbound, so a replay uses the same focused-session path (pane inject / socket)
  // as a live message. Called only after setFocus, so focus is set and won't re-buffer.
  let lines: string[] = []
  try {
    lines = readFileSync(PENDING_EVENTS_FILE, 'utf8').split('\n').filter(l => l.trim())
    writeFileSync(PENDING_EVENTS_FILE, '', { mode: 0o600 })
  } catch { return }
  for (const line of lines) {
    try {
      const msg = JSON.parse(line) as DaemonToShim
      if (msg.t === 'inbound') emitInbound(msg.params)
    } catch {}
  }
}

// ---- Pane event dispatch ----

// Footer for messages whose input method is a free-text reply, telling the user
// both ways to respond. Kept in one place so the wording stays consistent.
const REPLY_FOOTER = `💬 <b>Reply to this message</b>, or use <code>/reply (response)</code>.`

// A sign-in URL surfaced by /login (OAuth authorize link). Scoped to oauth/
// authorize URLs so ordinary links in Claude's replies aren't re-relayed here —
// those already arrive through the MCP reply tool.
const AUTH_URL_RE = /https?:\/\/[^\s│"')]*(?:oauth|authorize)[^\s│"')]*/i

const DEBUG_PANE = (process.env.TELEGRAM_DEBUG_PANE ?? '') === '1'

// Detect Claude Code's usage-limit screen and act on it. The live screen shows a
// status line just above the input — the persistent "You've used N% of your session
// limit · resets H:MMpm (UTC) · /upgrade" throttle banner, and/or a one-time "You've
// hit your … limit · resets …" note (separator is a middle-dot ·). When we see it we
// log it, relay it to Telegram (Claude can't, being rate-limited), and auto-schedule
// the reset reminder from the embedded time so the user needn't run /resetin.
//
// False-positive guards — this very chat can contain the trigger text, so:
//  - free-standing only: the banner line must NOT sit inside an assistant ● block
//    (our own quotes of it live inside ● messages — those are skipped);
//  - bottom-anchored: only the live status zone (last ~14 non-blank lines) counts;
//  - a same-reset-time lockout (~12h): genuine limit windows are ~5h, so the same
//    reset clock-time can't legitimately recur that fast — kills repaint re-fires.
// Matches an actual limit *hit* — the "hit your … limit" note or the "used 100% of
// your … limit" throttle banner. Anchors on the phrase + "resets <digit…>", NOT on the
// trailing "(UTC)": a narrow terminal truncates "(UTC) · /upgrade…" off the right, which
// used to drop detection so a real hit never scheduled the reset / auto-continue. The
// specific phrase + the free-standing-line guard + the ~12h lockout keep false positives
// out. Deliberately does NOT match sub-100% advisory warnings.
const USAGE_LIMIT_RE = /(?:hit your|used 100% of your) [\w-]+ limit\b.{0,12}resets\b.{0,40}\d/i
// Reset clock-time; "(UTC)" optional and the trailing "m" optional, so a clipped
// "resets 5:10a" still parses (the am/pm letter survives — that's what we need).
const RESET_TIME_RE = /\bresets\s+(\d{1,2}):(\d{2})\s*([ap])m?\b/i
// Sub-100% advisory banner, e.g. "used 76% of your weekly limit · resets Jun 7, 4pm
// (UTC) · try /mod…". Captures: percent, limit type (session/weekly/…), reset descr.
const USAGE_WARN_RE = /used (\d+)% of your ([\w-]+) limit\b.{0,12}resets\s+([^·\n]+?)\s*(?:·|$)/i
const USAGE_CAPTURE_FILE = join(STATE_DIR, 'usage-limit-capture.log')
const RESET_RELOCK_MS = (11 * 60 + 59) * 60_000
let lastActedResetKey = ''
let lastActedResetAt = 0
// Last limit-ish line written to the near-miss diagnostic, so a static banner across
// many pane ticks isn't logged repeatedly.
let lastLimitDebugLine = ''
// Per limit type ('session'/'weekly'/…): the highest warning threshold (75/95)
// already sent for the current reset period (`resetKey`), plus when it was sent
// (`at`) so a width-clipped repaint of the same banner can't re-fire it within a
// few hours, so 76/77/… and re-renders don't re-notify.
const usageWarnState = new Map<string, { resetKey: string; threshold: number; at: number }>()
// Backstop re-fire lockout: a genuine reset is ≥5h away (session) or days (weekly),
// so once a threshold is sent for a type, ignore the same-or-lower threshold for this
// long even if the reset descriptor looks different (a truncated/wrapped banner frame).
const WARN_RELOCK_MS = 90 * 60_000

// Normalize a reset descriptor (e.g. "Jun 7, 4pm (UTC)") to a width-stable dedup key.
// Terminal truncation/wrapping clips the trailing "(UTC) · …", so key on the date/time
// core before the timezone paren — otherwise a clipped repaint reads as a new reset
// period and re-fires the heads-up.
function normResetKey(descr: string): string {
  return descr.toLowerCase().replace(/\s*\(.*$/, '').replace(/[….\s]+$/, '').replace(/\s+/g, ' ').trim()
}

// Persist the hit + warning dedup across daemon restarts. In-memory state was the
// cause of repeated 75% alerts during development (each restart re-armed them).
const USAGE_NOTIF_STATE_FILE = join(STATE_DIR, 'usage-notif-state.json')
try {
  const s = JSON.parse(readFileSync(USAGE_NOTIF_STATE_FILE, 'utf8'))
  if (typeof s.lastActedResetKey === 'string') lastActedResetKey = s.lastActedResetKey
  if (typeof s.lastActedResetAt === 'number') lastActedResetAt = s.lastActedResetAt
  for (const [k, v] of Object.entries(s.warn ?? {})) {
    const e = v as { resetKey?: unknown; threshold?: unknown; at?: unknown }
    if (e && typeof e.resetKey === 'string' && typeof e.threshold === 'number') {
      // Normalize on load too (not just on save) — idempotent, and it heals a raw key
      // written by an older daemon or a manual edit, so a leftover "Jun 7, 4pm (UTC)"
      // can't read as a new period against the normalized live banner and re-fire.
      usageWarnState.set(k, { resetKey: normResetKey(e.resetKey), threshold: e.threshold, at: typeof e.at === 'number' ? e.at : 0 })
    }
  }
} catch {}
function saveUsageNotifState(): void {
  try {
    writeFileSync(USAGE_NOTIF_STATE_FILE, JSON.stringify({ lastActedResetKey, lastActedResetAt, warn: Object.fromEntries(usageWarnState) }), { mode: 0o600 })
  } catch {}
}

// The next future UTC instant matching "resets HH:MMam (UTC)" (ms), or null.
function parseResetTime(line: string): number | null {
  const m = line.match(RESET_TIME_RE)
  if (!m) return null
  let hour = parseInt(m[1], 10) % 12
  if (m[3].toLowerCase() === 'p') hour += 12
  const fire = new Date()
  fire.setUTCHours(hour, parseInt(m[2], 10), 0, 0)
  if (fire.getTime() <= Date.now()) fire.setUTCDate(fire.getUTCDate() + 1)
  return fire.getTime()
}

function handleUsageLimit(text: string): void {
  // Mark lines inside an assistant block ("● …" + its indented continuation), so we
  // ignore the banner text when WE quote it in a message — only a real, free-standing
  // status line counts. (A transcript quote of the banner lives inside a ● block.)
  const lines = stripAnsi(text).split('\n').map(l => l.replace(/\s+$/, ''))
  const inBlock: boolean[] = []
  let block = false
  for (const l of lines) {
    if (/^\s*●\s+/.test(l)) { block = true; inBlock.push(true); continue }
    if (block && /^\s{2,}\S/.test(l)) { inBlock.push(true); continue }   // wrapped continuation
    if (block && l.trim()) block = false                                  // a flush line ends the block
    inBlock.push(false)
  }
  // Scan only the bottom region (the live status area), and only free-standing lines.
  const bottom: number[] = []
  for (let i = lines.length - 1; i >= 0 && bottom.length < 14; i--) if (lines[i].trim()) bottom.push(i)
  // ── Limit HIT: relay + auto-schedule + auto-continue ─────────────────────────
  const hitIdx = bottom.find(i => !inBlock[i] && USAGE_LIMIT_RE.test(lines[i]))
  // Diagnostic: a limit-ish banner is in the live zone but strict detection skipped it →
  // snapshot the frame + why (in-block? regex miss?), deduped, so a missed auto-continue
  // can be traced to the real render next time.
  const looseIdx = bottom.find(i => /\blimit\b.{0,24}resets\b/i.test(lines[i]))
  if (looseIdx !== undefined && hitIdx === undefined && lines[looseIdx].trim() !== lastLimitDebugLine) {
    lastLimitDebugLine = lines[looseIdx].trim()
    try {
      const why = JSON.stringify({ line: lines[looseIdx].trim(), inBlock: inBlock[looseIdx], limitRe: USAGE_LIMIT_RE.test(lines[looseIdx]), timeRe: RESET_TIME_RE.test(lines[looseIdx]) })
      const f = join(STATE_DIR, 'limit-debug.log')
      let prev = ''; try { if (statSync(f).size < 256 * 1024) prev = readFileSync(f, 'utf8') } catch {}
      writeFileSync(f, `${prev}\n===== ${new Date().toISOString()} skip ${why} =====\n${stripAnsi(text)}\n`, { mode: 0o600 })
    } catch {}
  }
  if (hitIdx !== undefined) {
    const limitLine = lines[hitIdx].trim()
    const tm = limitLine.match(RESET_TIME_RE)
    const key = tm ? `${tm[1]}:${tm[2]}${tm[3].toLowerCase()}` : limitLine
    const now = Date.now()
    if (key === lastActedResetKey && now - lastActedResetAt < RESET_RELOCK_MS) return
    lastActedResetKey = key
    lastActedResetAt = now
    saveUsageNotifState()

    try {
      let prev = ''
      try { if (statSync(USAGE_CAPTURE_FILE).size < 256 * 1024) prev = readFileSync(USAGE_CAPTURE_FILE, 'utf8') } catch {}
      writeFileSync(USAGE_CAPTURE_FILE, `${prev}\n===== ${new Date().toISOString()} =====\n${stripAnsi(text)}\n`, { mode: 0o600 })
    } catch {}

    const chats = loadAccess().allowFrom
    if (chats.length === 0) return
    const fireAt = parseResetTime(limitLine)
    const note = fireAt
      ? `\n\n⏰ I'll ping you when it resets${loadAccess().autoContinue !== false ? ' and auto-continue' : ''}.`
      : ''
    for (const chat_id of chats) {
      void bot.api.sendMessage(chat_id, `⛔ <b>Claude hit the usage limit.</b>\n${escapeHtml(limitLine)}${note}`, { parse_mode: 'HTML' }).catch(() => {})
    }
    if (fireAt) scheduleReset(fireAt + RESET_GRACE_MS, chats)
    return
  }

  // ── Usage WARNING: one heads-up per threshold (50/75/90) per reset period ────
  const warnIdx = bottom.find(i => !inBlock[i] && USAGE_WARN_RE.test(lines[i]))
  if (warnIdx === undefined) return
  const wm = lines[warnIdx].match(USAGE_WARN_RE)!
  const pct = parseInt(wm[1], 10)
  if (pct < 50 || pct >= 100) return   // <50 not notable; 100 is a hit (handled above)
  const type = wm[2].toLowerCase()
  const resetKey = normResetKey(wm[3])
  const threshold = pct >= 90 ? 90 : pct >= 75 ? 75 : 50
  const prev = usageWarnState.get(type)
  const firedThisPeriod = prev && prev.resetKey === resetKey ? prev.threshold : 0
  // Suppress when this period already saw ≥ this threshold, OR (backstop) we sent the
  // same-or-higher threshold for this type within the lockout — the latter absorbs a
  // truncated/wrapped banner frame whose clipped reset text reads as a new period.
  const lockedOut = !!prev && threshold <= prev.threshold && Date.now() - prev.at < WARN_RELOCK_MS
  if (threshold <= firedThisPeriod || lockedOut) {
    if (DEBUG_PANE) process.stderr.write(`daemon: usage warn suppressed type=${type} pct=${pct} key="${resetKey}" prev=${JSON.stringify(prev)}\n`)
    if (prev) usageWarnState.set(type, { resetKey, threshold: Math.max(prev.threshold, threshold), at: prev.at })
    saveUsageNotifState()
    return
  }
  usageWarnState.set(type, { resetKey, threshold, at: Date.now() })
  saveUsageNotifState()
  process.stderr.write(`daemon: usage warn fired type=${type} threshold=${threshold} key="${resetKey}"\n`)
  const chats = loadAccess().allowFrom
  if (chats.length === 0) return
  const emoji = threshold >= 90 ? '🚨' : threshold >= 75 ? '⚠️' : 'ℹ️'
  for (const chat_id of chats) {
    void bot.api.sendMessage(chat_id, `${emoji} You've used ${threshold}% of your ${escapeHtml(type)} limit`).catch(() => {})
  }
}

function onPaneEvent(text: string): void {
  handleUsageLimit(text)
  // Diagnostic: when TELEGRAM_DEBUG_PANE=1, append each pane frame + the prompt
  // detection result to /tmp/tg-pane-debug.log, so a missed prompt can be traced
  // against the exact rendering. Off by default; no effect on normal operation.
  if (DEBUG_PANE) {
    try {
      appendFileSync(
        '/tmp/tg-pane-debug.log',
        `\n===== ${new Date().toISOString()} detected=${JSON.stringify(detectUserPrompt(text))} =====\n${text}\n`,
      )
    } catch {}
  }

  // Keep the Telegram "typing…" indicator alive while Claude is working.
  typingPresence.update(detectWorking(text))

  // Surface a /login sign-in link if one appears (independent of prompt detection,
  // since the URL is printed as plain output, not a multiple-choice menu).
  const authUrl = stripAnsi(text).match(AUTH_URL_RE)?.[0]
  if (authUrl) {
    const h = hashText(authUrl)
    if (h !== lastRelayedAuthUrl) {
      lastRelayedAuthUrl = h
      void relayAuthUrlToTelegram(authUrl)
    }
  }

  // Permission prompts ("Do you want to …?") have their own footer and detector, so they
  // never collide with the select-menu path. Relay them so the user can approve/deny from
  // Telegram — the whole point of off-MCP is never needing the terminal.
  const perm = detectPermissionPrompt(text)
  if (perm) {
    const ph = hashText(perm.question + '|' + perm.preview + '|' + perm.options.map(o => o.label).join('|'))
    if (ph !== lastRelayedPermissionHash) {
      lastRelayedPermissionHash = ph
      void relayPermissionToTelegram(perm)
    }
    return
  }

  const prompt = detectUserPrompt(text)
  if (!prompt) return
  const h = promptHash(prompt)
  if (h === lastRelayedPromptHash) return
  lastRelayedPromptHash = h
  void relayPromptToTelegram(prompt)
}

// Identity of a prompt for double-relay suppression: its question plus the option
// labels. Each tab of a multi-question prompt is a distinct question, so advancing
// tabs yields a new hash and relays the next question.
function promptHash(prompt: PromptInfo): string {
  return hashText(prompt.question + '|' + prompt.options.map(o => o.label).join('|'))
}

// Telegram sizes a bubble to the wider of its text or its inline keyboard. Permission and
// question prompts have short lines + narrow buttons, so they render skinnier than a normal
// message. A trailing line of braille-blank (U+2800) padding — invisible but width-bearing —
// snaps the bubble out to a normal width without showing any stray characters.
const WIDTH_PAD = '\n' + '⠀'.repeat(40)

// Render a prompt as Telegram HTML: bold question, then each numbered option with
// its description (if any) as a blockquote beneath it.
function renderPromptHtml(prompt: PromptInfo): string {
  const lines = [`❓ <b>${escapeHtml(prompt.question)}</b>`]
  if (prompt.tabbed) lines.push('<i>One of several questions — answer this one to move to the next.</i>')
  else if (prompt.multiSelect) lines.push('<i>Pick one or more, then tap ✅ Submit.</i>')
  lines.push('')
  prompt.options.forEach((opt, i) => {
    lines.push(`<b>${i + 1}.</b> ${escapeHtml(opt.label)}`)
    if (opt.description) lines.push(`<blockquote>${escapeHtml(opt.description)}</blockquote>`)
  })
  // The "Type something" button only rides on the single-select keyboard; multi-select
  // shows checkboxes + Submit (no free-text button), so don't advertise it there.
  if (prompt.freeText && !prompt.multiSelect) lines.push('', '✏️ <i>…or tap “Type something” to write your own answer.</i>')
  return lines.join('\n') + WIDTH_PAD
}

// Permission request as a self-contained message: the tool name as the heading,
// then its description and (pretty-printed, length-capped) input, then "Approve?".
// All the context is inline so there's no separate "see more" step.
function formatPermission(tool_name: string, description: string, input_preview: string): string {
  let pretty: string
  try { pretty = JSON.stringify(JSON.parse(input_preview), null, 2) } catch { pretty = input_preview }
  const parts = [`🔐 <b>${escapeHtml(tool_name)}</b>`, '']
  if (description.trim()) parts.push(escapeHtml(description), '')
  if (pretty.trim()) {
    const capped = pretty.length > 1500 ? pretty.slice(0, 1500) + '\n…(truncated)' : pretty
    parts.push(`<pre>${escapeHtml(capped)}</pre>`, '')
  }
  parts.push('<b>Approve?</b>')
  return parts.join('\n')
}

// Toggle keyboard for a multi-select prompt: a checkbox button per option (3 per
// row) plus a Submit button. ☑ marks currently-selected indices.
function multiSelectKeyboard(options: PromptOption[], selected: Set<number>): InlineKeyboard {
  const kb = new InlineKeyboard()
  options.forEach((_, i) => {
    kb.text(`${selected.has(i) ? '☑' : '☐'} ${i + 1}`, `msel:${i + 1}`)
    if ((i + 1) % 3 === 0) kb.row()
  })
  kb.row().text('✅ Submit', 'msel:submit')
  return kb
}

// Numbered-option keyboard for a single-answer prompt (3 per row). `prefix` is the
// callback namespace — `prompt` for an ordinary single-select (digit-driven) or
// `mq` for a multi-question tab (arrow-driven). A ✏️ Type-something button is
// appended when the prompt offers free text.
function singleAnswerKeyboard(prompt: PromptInfo, prefix: 'prompt' | 'mq'): InlineKeyboard {
  const kb = new InlineKeyboard()
  prompt.options.forEach((_, i) => {
    kb.text(String(i + 1), `${prefix}:${i + 1}`)
    if ((i + 1) % 3 === 0) kb.row()
  })
  if (prompt.freeText) kb.row().text('✏️ Type something', 'ftext')
  // Always offer "Chat about this" — if the menu has a literal option for it we select that,
  // otherwise we Esc-dismiss the question (see the chat handler).
  kb.row().text('💬 Chat about this', 'chat')
  return kb
}

async function relayPromptToTelegram(prompt: PromptInfo): Promise<void> {
  const access = loadAccess()
  const targets = access.allowFrom
  if (targets.length === 0 || !activePaneId) return

  const text = renderPromptHtml(prompt)

  for (const chat_id of targets) {
    try {
      let sent
      if (prompt.multiSelect) {
        const selected = new Set<number>()
        sent = await bot.api.sendMessage(chat_id, text, {
          parse_mode: 'HTML',
          reply_markup: multiSelectKeyboard(prompt.options, selected),
        })
        pendingMultiSelect.set(`${chat_id}:${sent.message_id}`, {
          paneId: activePaneId, options: prompt.options, selected,
        })
      } else {
        sent = await bot.api.sendMessage(chat_id, text, {
          parse_mode: 'HTML',
          reply_markup: singleAnswerKeyboard(prompt, prompt.tabbed ? 'mq' : 'prompt'),
        })
      }
      // Remember the prompt so a ✏️ tap knows how to reach its free-text field: the
      // option sits `options.length` Down presses past the first one. "Chat about
      // this" sits one further down again.
      if (prompt.freeText) {
        freeTextPrompts.set(`${chat_id}:${sent.message_id}`, {
          paneId: activePaneId, downCount: prompt.options.length, tabbed: prompt.tabbed, question: prompt.question,
        })
      }
      // Register chat-dismiss for every question. If the menu carries its own "Chat about this"
      // option we select it (downCount past the options + free-text); otherwise we Esc-dismiss.
      chatPrompts.set(`${chat_id}:${sent.message_id}`, prompt.chat
        ? { paneId: activePaneId, downCount: prompt.options.length + 1, tabbed: prompt.tabbed, useEscape: false }
        : { paneId: activePaneId, downCount: 0, tabbed: prompt.tabbed, useEscape: true })
    } catch (e) {
      process.stderr.write(`daemon: prompt relay to ${chat_id} failed: ${e}\n`)
    }
  }
}

// An option's button face: a leading emoji by intent (Yes / Yes-allow-all / No), the label
// trimmed of its "(shift+tab)" hint and capped so it fits a Telegram button.
function permButtonLabel(opt: { n: number; label: string }): string {
  const bare = opt.label.replace(/\s*\([^)]*\)\s*$/, '').trim()
  const low = bare.toLowerCase()
  const icon = low === 'yes' ? '✅' : low.startsWith('yes') ? '🔁' : low.startsWith('no') ? '❌' : '•'
  const short = bare.length > 38 ? bare.slice(0, 37) + '…' : bare
  return `${icon} ${short}`
}

// Relay a permission prompt to Telegram: the question, a short preview of what's being
// approved, and a button per option (callback pperm:<n>) that injects that choice into the
// pane. One button per row — the labels (esp. "allow all this session") are long.
async function relayPermissionToTelegram(perm: PermissionPrompt): Promise<void> {
  const targets = loadAccess().allowFrom
  if (targets.length === 0 || !activePaneId) return

  const parts = [`🔐 <b>${escapeHtml(perm.question)}</b>`]
  if (perm.preview) parts.push(`<blockquote>${escapeHtml(perm.preview)}</blockquote>`)
  const body = parts.join('\n') + WIDTH_PAD

  const kb = new InlineKeyboard()
  for (const opt of perm.options) kb.text(permButtonLabel(opt), `pperm:${opt.n}`).row()

  process.stderr.write(`daemon: relaying permission prompt (${perm.options.length} opts) “${perm.question}” to ${targets.join(',')}\n`)
  for (const chat_id of targets) {
    try {
      await bot.api.sendMessage(chat_id, body, { parse_mode: 'HTML', reply_markup: kb })
    } catch (e) {
      process.stderr.write(`daemon: permission relay to ${chat_id} failed: ${e}\n`)
    }
  }
}

// Parse the multi-question review/submit tab into the chosen answers. Each is a
// "● <question>" line followed by a "→ <answer>" line.
function parseReviewAnswers(paneText: string): { question: string; answer: string }[] {
  const lines = stripAnsi(paneText).split('\n').map(l => l.trim())
  const out: { question: string; answer: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    const q = lines[i].match(/^●\s+(.+)$/)
    if (q) {
      const a = lines[i + 1]?.match(/^→\s+(.+)$/)
      if (a) out.push({ question: q[1].trim(), answer: a[1].trim() })
    }
  }
  return out
}

// After answering a tab of a multi-question prompt, the form auto-advances. The
// watcher is paused (and re-baselined) across the injection, so it won't surface
// the new screen — we read it here and either relay the next question or, once the
// review/submit tab is reached, press Enter to submit and report the answers.
async function handleTabbedAdvance(chat_id: string): Promise<void> {
  if (!activePaneId || !paneWatcher) return
  const text = await capturePane(activePaneId)
  if (isSubmitScreen(text)) {
    const answers = parseReviewAnswers(text)
    await paneWatcher.withInjection(async () => {
      await sendKeys(activePaneId!, ['Enter'])
      await waitForSettle(activePaneId!, 300, 5000)
    })
    lastRelayedPromptHash = ''
    const summary = answers.length
      ? '\n\n' + answers.map(a => `• ${escapeHtml(a.question)} → <b>${escapeHtml(a.answer)}</b>`).join('\n')
      : ''
    await bot.api.sendMessage(chat_id, `✅ <b>Answers submitted.</b>${summary}`, { parse_mode: 'HTML' }).catch(() => {})
    return
  }
  const next = detectUserPrompt(text)
  if (next?.tabbed) {
    lastRelayedPromptHash = promptHash(next)
    await relayPromptToTelegram(next)
  }
}

// Relay a sign-in link to allowed chats and remember the message ids, so a reply
// to one is routed into the pane (see the message:text handler).
async function relayAuthUrlToTelegram(url: string): Promise<void> {
  const access = loadAccess()
  const targets = access.allowFrom
  if (targets.length === 0) return

  const safe = escapeHtml(url)
  const text =
    `🔑 <b>Sign-in link from Claude Code</b>\n\n` +
    `<a href="${safe}">${safe}</a>\n\n` +
    `Open it in your browser to get your code.\n\n` +
    REPLY_FOOTER

  for (const chat_id of targets) {
    try {
      const sent = await bot.api.sendMessage(chat_id, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      })
      authUrlMessageIds.add(`${chat_id}:${sent.message_id}`)
    } catch (e) {
      process.stderr.write(`daemon: auth-url relay to ${chat_id} failed: ${e}\n`)
    }
  }
}

function startPaneWatcher(paneId: string): void {
  if (paneWatcher) paneWatcher.stop()
  paneWatcher = new PaneWatcher(
    paneId,
    text => onPaneEvent(text),
    () => {
      process.stderr.write(`daemon: pane ${paneId} died\n`)
      const entry = [...sessions.entries()].find(([, s]) => s.paneId === paneId)
      if (entry) endSession(entry[0])
      else {
        activePaneId = null; paneWatcher = null
        offMcpPanes.delete(paneId)
        // Adopted off-MCP pane: clear the binding so the rescan re-adopts a fresh one.
        if (adoptedPaneId === paneId) { adoptedPaneId = null; currentSessionId = null }
      }
      // Down to a single session → focus it automatically, then refresh the pin.
      void refocusSoleSession().then(() => updateSessionPin())
    },
  )
  paneWatcher.start()
}

// ---- File download + transcription ----

// Download a Telegram file to the local inbox, returning its path.
async function downloadTelegramFile(file_id: string): Promise<string> {
  const file = await bot.api.getFile(file_id)
  if (!file.file_path) throw new Error('Telegram returned no file_path')
  const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
  const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
  const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
  const path = join(INBOX_DIR, `${Date.now()}-${uniqueId}.${ext}`)
  mkdirSync(INBOX_DIR, { recursive: true })
  writeFileSync(path, buf)
  return path
}

// Voice transcription runs entirely outside Claude — a local faster-whisper
// model or a hosted Whisper API — so it never consumes Claude usage; only the
// resulting text reaches the session. Backend is chosen at install time via
// TELEGRAM_TRANSCRIBE (off | local | groq | openai); see ACCESS.md.
type TranscribeProvider = 'off' | 'local' | 'groq' | 'openai'

// Transcription config is read live from the .env file (process env as
// fallback) on each call, so /telegram:configure changes apply on the next
// voice message without restarting the long-lived daemon. The .env file wins
// for these keys because the configure skill writes there.
function tConfig(key: string): string | undefined {
  try {
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && m[1] === key) return m[2]
    }
  } catch {}
  return process.env[key]
}

function transcribeProvider(): TranscribeProvider {
  return (tConfig('TELEGRAM_TRANSCRIBE') ?? 'off').toLowerCase() as TranscribeProvider
}

// Returns the transcript, or null if disabled/unconfigured/failed (caller falls
// back to a placeholder so a bad transcription never drops the message).
async function transcribe(audioPath: string): Promise<string | null> {
  const provider = transcribeProvider()
  const model = tConfig('TELEGRAM_TRANSCRIBE_MODEL') ?? ''
  try {
    switch (provider) {
      case 'groq':
        return await transcribeHttp(audioPath,
          'https://api.groq.com/openai/v1/audio/transcriptions',
          tConfig('GROQ_API_KEY'), model || 'whisper-large-v3-turbo')
      case 'openai':
        return await transcribeHttp(audioPath,
          'https://api.openai.com/v1/audio/transcriptions',
          tConfig('OPENAI_API_KEY'), model || 'whisper-1')
      case 'local':
        return await transcribeLocal(audioPath, model || 'base')
      default:
        return null
    }
  } catch (err) {
    process.stderr.write(`daemon: transcription (${provider}) failed: ${err}\n`)
    return null
  }
}

// OpenAI-compatible audio transcription endpoint (covers OpenAI and Groq).
async function transcribeHttp(
  audioPath: string, endpoint: string, apiKey: string | undefined, model: string,
): Promise<string | null> {
  if (!apiKey) {
    process.stderr.write(`daemon: transcription enabled but API key missing for ${endpoint}\n`)
    return null
  }
  const form = new FormData()
  form.append('file', new Blob([readFileSync(audioPath)]), basename(audioPath))
  form.append('model', model)
  form.append('response_format', 'text')
  const res = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.text()).trim() || null
}

// Local faster-whisper via the bundled Python helper (no API, fully private).
async function transcribeLocal(audioPath: string, model: string): Promise<string | null> {
  const python = tConfig('TELEGRAM_WHISPER_PYTHON') || 'python3'
  const script = join(import.meta.dir, 'transcribe_local.py')
  const env = { ...process.env }
  const device = tConfig('TELEGRAM_WHISPER_DEVICE'); if (device) env.TELEGRAM_WHISPER_DEVICE = device
  const compute = tConfig('TELEGRAM_WHISPER_COMPUTE'); if (compute) env.TELEGRAM_WHISPER_COMPUTE = compute
  const { stdout } = await exec(python, [script, audioPath, model], {
    timeout: 300_000, maxBuffer: 10 * 1024 * 1024, env,
  })
  return stdout.trim() || null
}

// Chats already nudged about disabled transcription (in-memory; one hint per
// chat per daemon run is enough).
const voiceNudged = new Set<string>()

function nudgeTranscribeOff(ctx: Context): void {
  const chat_id = String(ctx.chat!.id)
  if (voiceNudged.has(chat_id)) return
  voiceNudged.add(chat_id)
  void bot.api.sendMessage(chat_id,
    '🎙️ Voice transcription is off. To talk to Claude by voice, enable it with ' +
    '/telegram:configure transcribe in your Claude Code session.',
  ).catch(() => {})
}

// Build inbound text for an audio message: transcribe when enabled, else use the
// placeholder. Called post-gate from handleInbound (typing already armed), so it
// never runs for unauthorized senders.
async function audioInboundText(
  ctx: Context, file_id: string, fallback: string,
): Promise<{ text: string; transcribed: boolean }> {
  if (transcribeProvider() === 'off') { nudgeTranscribeOff(ctx); return { text: fallback, transcribed: false } }
  let path: string
  try { path = await downloadTelegramFile(file_id) }
  catch (err) { process.stderr.write(`daemon: audio download failed: ${err}\n`); return { text: fallback, transcribed: false } }
  const transcript = await transcribe(path)
  if (!transcript) return { text: fallback, transcribed: false }
  const caption = ctx.message?.caption
  return { text: caption ? `${transcript}\n\n[caption] ${caption}` : transcript, transcribed: true }
}

// ---- Tool call handling ----

async function handleCall(
  name: string,
  args: Record<string, unknown>,
  write: (msg: DaemonToShim) => void,
  id: string,
): Promise<void> {
  try {
    let text: string
    switch (name) {
      case 'reply': {
        const chat_id = args.chat_id as string
        const msgText = args.text as string
        const reply_to = args.reply_to != null ? Number(args.reply_to) : undefined
        const files = (args.files as string[] | undefined) ?? []
        const format = args.format as string | undefined

        assertAllowedChat(chat_id)
        for (const f of files) {
          assertSendable(f)
          const st = statSync(f)
          if (st.size > MAX_ATTACHMENT_BYTES) throw new Error(`file too large: ${f}`)
        }

        const access = loadAccess()
        const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
        const mode = access.chunkMode ?? 'length'
        const replyMode = access.replyToMode ?? 'first'
        // Rendering: `text` forces plain; `markdownv2` is the legacy raw-passthrough;
        // otherwise standard Markdown auto-renders to HTML unless disabled in config.
        const render = format !== 'text' && format !== 'markdownv2' && access.renderMarkdown !== false
        const parseMode = render ? 'HTML' as const : format === 'markdownv2' ? 'MarkdownV2' as const : undefined
        const chunks = render ? chunkHtml(mdToTelegramHtml(msgText), limit) : chunk(msgText, limit, mode)
        const sentIds: number[] = []

        for (let i = 0; i < chunks.length; i++) {
          const shouldReplyTo = reply_to != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
          const sent = await bot.api.sendMessage(chat_id, chunks[i], {
            ...(shouldReplyTo ? { reply_parameters: { message_id: reply_to } } : {}),
            ...(parseMode ? { parse_mode: parseMode } : {}),
          })
          sentIds.push(sent.message_id)
        }

        const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
        for (const f of files) {
          const ext = extname(f).toLowerCase()
          const input = new InputFile(f)
          const opts = reply_to != null && replyMode !== 'off' ? { reply_parameters: { message_id: reply_to } } : undefined
          if (PHOTO_EXTS.has(ext)) {
            const sent = await bot.api.sendPhoto(chat_id, input, opts)
            sentIds.push(sent.message_id)
          } else {
            const sent = await bot.api.sendDocument(chat_id, input, opts)
            sentIds.push(sent.message_id)
          }
        }
        text = sentIds.length === 1 ? `sent (id: ${sentIds[0]})` : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
        break
      }
      case 'react': {
        assertAllowedChat(args.chat_id as string)
        await bot.api.setMessageReaction(args.chat_id as string, Number(args.message_id), [
          { type: 'emoji', emoji: args.emoji as ReactionTypeEmoji['emoji'] },
        ])
        text = 'reacted'
        break
      }
      case 'download_attachment': {
        text = await downloadTelegramFile(args.file_id as string)
        break
      }
      case 'edit_message': {
        assertAllowedChat(args.chat_id as string)
        const editFormat = args.format as string | undefined
        const editRender = editFormat !== 'text' && editFormat !== 'markdownv2' && loadAccess().renderMarkdown !== false
        const editParseMode = editRender ? 'HTML' as const : editFormat === 'markdownv2' ? 'MarkdownV2' as const : undefined
        // An edit targets one message; if rendered HTML overflows, keep the first chunk.
        const editText = editRender
          ? chunkHtml(mdToTelegramHtml(args.text as string), MAX_CHUNK_LIMIT)[0]
          : args.text as string
        const edited = await bot.api.editMessageText(
          args.chat_id as string,
          Number(args.message_id),
          editText,
          ...(editParseMode ? [{ parse_mode: editParseMode }] : []),
        )
        const msgId = typeof edited === 'object' ? edited.message_id : args.message_id
        text = `edited (id: ${msgId})`
        break
      }
      default:
        write({ t: 'result', id, ok: false, text: `unknown tool: ${name}` })
        return
    }
    write({ t: 'result', id, ok: true, text })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    write({ t: 'result', id, ok: false, text: `${name} failed: ${msg}` })
  }
}

// ---- Slash command relay ----

// Type a slash command into the pane and wait for it to settle. Reaction-free
// core, shared by relaySlashCommand and the session-reset commands.
async function injectSlash(paneId: string, watcher: PaneWatcher, command: string): Promise<void> {
  await watcher.withInjection(async () => {
    await sendKeys(paneId, [command, 'Enter'])
    await waitForSettle(paneId, 300, 30_000)
  })
}

async function relaySlashCommand(
  paneId: string,
  watcher: PaneWatcher,
  command: string,
  chat_id: string,
  message_id: number,
): Promise<void> {
  await injectSlash(paneId, watcher, command)
  void bot.api.setMessageReaction(chat_id, message_id, [
    { type: 'emoji', emoji: '👍' },
  ]).catch(() => {})
}

// ---- Mode command helper ----

async function handleModeCommand(
  ctx: Context,
  target: CcMode,
): Promise<void> {
  const gated = dmCommandGate(ctx)
  if (!gated) return

  if (!activePaneId || !paneWatcher) {
    await ctx.reply('No active Claude Code session with tmux. Send a message from CC first.')
    return
  }
  if (!onNormalPrompt(await capturePane(activePaneId))) {
    await ctx.reply('⚠️ The terminal is on another screen (settings/menu) — can’t change the mode right now.')
    return
  }

  const msgId = ctx.message?.message_id
  const chat_id = String(ctx.chat!.id)
  const paneId = activePaneId
  const watcher = paneWatcher

  const reached = await switchToMode(paneId, target, watcher)

  if (reached === null) {
    const notAvailableMsg = target === 'bypassPermissions'
      ? 'Not available — restart Claude Code with --dangerously-skip-permissions.'
      : target === 'auto'
      ? 'Not available — auto mode requires a qualifying plan or prior detection.'
      : `Could not switch to ${modeLabel(target)}.`
    await ctx.reply(notAvailableMsg)
    return
  }

  if (reached !== target) {
    await ctx.reply(`Switched to ${modeLabel(reached)} (target ${modeLabel(target)} not reached).`)
    return
  }

  if (msgId) {
    void bot.api.setMessageReaction(chat_id, msgId, [{ type: 'emoji', emoji: '👍' }]).catch(() => {})
  }
  void updateSessionPin()
}

// ---- Session-reset command helper ----

// /new and /clear both reset the conversation. Relay the command with no 👍 (the
// confirmation below is the acknowledgement), then report the model the fresh
// session is on.
// Reset the conversation and return the confirmation text (with the active
// model). Callers ensure activePaneId/paneWatcher are set.
async function performReset(command: string): Promise<string> {
  await injectSlash(activePaneId!, paneWatcher!, command)
  const model = await readCurrentModel(activePaneId!, paneWatcher!)
  return model
    ? `🆕 New session started · model: <b>${escapeHtml(model)}</b>`
    : '🆕 New session started.'
}

// Ask for confirmation before /new resets the session (the 🆕 New button is easy
// to hit by accident); the reset runs on the Yes tap — see the newconfirm handler.
async function confirmNewSession(ctx: Context): Promise<void> {
  if (!dmCommandGate(ctx)) return
  if (!activePaneId || !paneWatcher) { await ctx.reply('No active Claude Code session with tmux.'); return }
  const keyboard = new InlineKeyboard().text('✅ Yes, start new session', 'newconfirm:yes')
  await ctx.reply('🆕 Start a new session? This clears the current conversation.\n\nTap to confirm:', { reply_markup: keyboard })
}

// ---- Shared actions (used by both slash commands and the control bar) ----
// Each gates and checks for an active pane itself, so it's safe to call from a
// /command handler or from a control-bar button tap.

// Show a Yes/No confirmation before interrupting — the Esc is sent on the Yes tap (see the
// stopconfirm handler). Shared by /stop and the 🛑 Stop button.
async function confirmStop(ctx: Context): Promise<void> {
  if (!dmCommandGate(ctx)) return
  if (!activePaneId || !paneWatcher) { await ctx.reply('No active Claude Code session with tmux.'); return }
  const keyboard = new InlineKeyboard().text('🛑 Yes, interrupt', 'stopconfirm:yes')
  await ctx.reply('🛑 Interrupt the current task?\n\nTap to confirm:', { reply_markup: keyboard })
}

// The actual interrupt — Esc into the pane. Returns the status line for the caller to show.
async function performStop(): Promise<string> {
  if (!activePaneId || !paneWatcher) return 'No active Claude Code session with tmux.'
  const ok = await paneWatcher.withInjection(() => sendKeys(activePaneId!, ['Escape']))
  return ok ? '🛑 Sent interrupt (Esc) to Claude Code.' : 'Could not reach the session pane.'
}

// Mode picker — a button per mode (current marked ●) plus a quick-switch tip. Shared by /mode
// and the 🧭 Mode button; the mode:set:<mode> callback applies a tapped choice.
const MODES: CcMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']
const MODE_TIP = '💡 Tip: use /default, /acceptedits, /plan, /auto, /bypass for fast switching'

function modePickerKeyboard(current: CcMode): InlineKeyboard {
  const kb = new InlineKeyboard()
  MODES.forEach((m, i) => {
    kb.text(`${m === current ? '● ' : ''}${modeLabel(m)}`, `mode:set:${m}`)
    if ((i + 1) % 2 === 0) kb.row()
  })
  return kb
}

async function doModePicker(ctx: Context): Promise<void> {
  if (!dmCommandGate(ctx)) return
  if (!activePaneId || !paneWatcher) { await ctx.reply('No active Claude Code session with tmux.'); return }
  const cap = await capturePane(activePaneId)
  if (!onNormalPrompt(cap)) { await ctx.reply('⚠️ The terminal is on another screen (settings/menu) — can’t change the mode right now.'); return }
  const current = detectCurrentMode(cap)
  await ctx.reply(`🧭 <b>Mode</b> — currently ${modeLabel(current)}\n\n${MODE_TIP}`, { parse_mode: 'HTML', reply_markup: modePickerKeyboard(current) })
}

// Model picker — buttons for the common aliases plus a tip for any specific name. Shared by
// /model (no arg) and the 🧠 Model button; the model:set:<alias> callback applies a choice.
const MODEL_ALIASES = ['default', 'opus', 'sonnet', 'haiku']
const MODEL_TIP = '💡 Tip: <code>/model &lt;name&gt;</code> to set any specific model.'

function modelPickerKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard()
  MODEL_ALIASES.forEach((m, i) => {
    kb.text(m.charAt(0).toUpperCase() + m.slice(1), `model:set:${m}`)
    if ((i + 1) % 2 === 0) kb.row()
  })
  return kb
}

async function doModelPicker(ctx: Context): Promise<void> {
  if (!dmCommandGate(ctx)) return
  if (!activePaneId || !paneWatcher) { await ctx.reply('No active Claude Code session with tmux.'); return }
  const model = await readCurrentModel(activePaneId, paneWatcher)
  await ctx.reply(
    `🧠 <b>Model</b> — currently ${model ? escapeHtml(model) : 'unknown'}\n\n${MODEL_TIP}`,
    { parse_mode: 'HTML', reply_markup: modelPickerKeyboard() },
  )
}

// Run /cost and relay the readout it prints.
// Strip the common left margin from a block (so a <pre> isn't pushed off-screen) while
// keeping the inner monospace alignment; trims leading/trailing blank lines.
function stripCommonIndent(lines: string[]): string {
  const nonblank = lines.filter(l => l.trim())
  if (!nonblank.length) return ''
  const indent = Math.min(...nonblank.map(l => l.match(/^\s*/)![0].length))
  const out = lines.map(l => l.slice(indent))
  while (out.length && !out[0].trim()) out.shift()
  while (out.length && !out[out.length - 1].trim()) out.pop()
  return out.join('\n')
}

// /context renders inline as a "⎿ Context Usage …" block after the command echo — pull the
// whole block (it can run past one screen, hence a scrollback capture upstream), then reflow
// it for mobile. Falls back to the raw block if the shape isn't recognized.
function extractContextReadout(raw: string): string | null {
  const lines = raw.split('\n').map(l => stripAnsi(l).replace(/\s+$/, '').replace('⎿', ' '))
  // Anchor on the "Context Usage" header itself, not the `❯ /context` echo: on short
  // terminals the output block and the command echo land in either order, so reading
  // "everything after the prompt" can miss the block entirely. Fall back to the echo.
  let start = lines.findLastIndex(l => /Context Usage/i.test(l))
  if (start < 0) { const p = lines.findLastIndex(l => /❯\s*\/context\b/.test(l)); start = p < 0 ? -1 : p + 1 }
  if (start < 0) return null
  const body: string[] = []
  for (let i = start; i < lines.length; i++) {
    if (/^─{10,}/.test(lines[i].trim()) || /Press up to edit queued/i.test(lines[i]) || /^❯\s*\//.test(lines[i].trim())) break
    body.push(lines[i])
  }
  return compactContext(body) ?? (stripCommonIndent(body) || null)
}

// The raw /context block is a 2-D square grid with the per-category legend wedged to its right;
// on a phone the wide grid rows shove the labels off-screen and wrap mid-sentence. Reflow into a
// compact readout: a one-line usage summary + a short bar, then one category per full-width line.
// Returns null (→ caller falls back to the raw block) if the usage figures aren't found.
function compactContext(body: string[]): string | null {
  const stripGrid = (l: string) => l.replace(/^(?:[^\sA-Za-z0-9(]+\s+)+/, '').trim()
  const usageIdx = body.findIndex(l => /[\d.]+[kKmM]?\s*\/\s*[\d.]+[kKmM]?\s*tokens?\s*\(\d+%\)/.test(l))

  // Each legend entry is "<Name>: <tokens> … (NN.N%)" — anchoring on the name+colon skips the
  // leading grid squares and the category-color glyph without needing to know their codepoints.
  const cats: string[] = []
  for (const l of body) {
    const m = l.match(/([A-Za-z][A-Za-z ./&-]*?):\s*([\d.]+[kKmM]?)\b[^()]*?\((\d+(?:\.\d+)?%)\)/)
    if (m) cats.push(`• ${m[1].trim()} — ${m[2]} (${m[3]})`)
  }
  if (usageIdx < 0 && cats.length === 0) return null

  const out: string[] = []
  if (usageIdx >= 0) {
    const summary = stripGrid(body[usageIdx])
    out.push(summary)
    const pm = summary.match(/\((\d+)%\)/)
    if (pm) {
      const filled = Math.round((Math.max(0, Math.min(100, Number(pm[1]))) / 100) * 10)
      out.push('▰'.repeat(filled) + '▱'.repeat(10 - filled))
    }
  }
  if (cats.length) { if (out.length) out.push(''); out.push(...cats) }
  return out.join('\n')
}

// /cost opens a modal (tab bar "Settings Status … Stats" … "Esc to cancel") — take the body
// between them.
function extractCostReadout(raw: string): string | null {
  const lines = raw.split('\n').map(l => stripAnsi(l).replace(/\s+$/, ''))
  let start = lines.findIndex(l => /Settings\s+Status\s+Config\s+Usage\s+Stats/.test(l))
  start = start < 0 ? 0 : start + 1
  let end = lines.findIndex((l, i) => i > start && /Esc to cancel/i.test(l))
  if (end < 0) end = lines.length
  return stripCommonIndent(lines.slice(start, end)) || null
}

// /cost (a modal) and /context (inline) are read-only readouts, but typed while Claude is
// working they just queue — so doReadout gates on the working state and confirms before
// interrupting; idle, it runs straight away.
async function doReadout(ctx: Context, kind: 'cost' | 'context'): Promise<void> {
  if (!dmCommandGate(ctx)) return
  if (!activePaneId || !paneWatcher) { await ctx.reply('No active Claude Code session with tmux.'); return }
  if (detectWorking(await capturePane(activePaneId))) {
    const kb = new InlineKeyboard().text('▶️ Go ahead', `readout:${kind}`).text('✖️ Cancel', 'readout:cancel')
    await ctx.reply(`⏳ Claude is working — running /${kind} will interrupt the current turn. Go ahead?`, { reply_markup: kb })
    return
  }
  await runReadout(String(ctx.chat!.id), kind)
}

async function windowHeightOf(paneId: string): Promise<number | null> {
  try {
    const { stdout } = await exec('tmux', ['display-message', '-p', '-t', paneId, '#{window_height}'], { timeout: 2000 })
    const n = parseInt(stdout.trim(), 10)
    return Number.isFinite(n) ? n : null
  } catch { return null }
}
async function resizeWindowOf(paneId: string, rows: number): Promise<boolean> {
  try {
    const { stdout } = await exec('tmux', ['display-message', '-p', '-t', paneId, '#{window_id}'], { timeout: 2000 })
    const win = stdout.trim()
    if (!win) return false
    await exec('tmux', ['resize-window', '-t', win, '-y', String(rows)], { timeout: 2000 })
    return true
  } catch { return false }
}

// Inject the command, capture + relay its real output (chunked), then return to the prompt.
async function runReadout(chatId: string, kind: 'cost' | 'context'): Promise<void> {
  const paneId = activePaneId, watcher = paneWatcher
  if (!paneId || !watcher) return
  const raw = await watcher.withInjection(async () => {
    if (kind === 'cost') {
      // /cost is a modal that can run taller than the pane, so a short terminal clips it
      // mid-content. Grow the window first so the whole modal renders in one frame, capture,
      // then restore — the user drives from Telegram, so the brief resize is unseen.
      const h = await windowHeightOf(paneId)
      const grew = h !== null && h < 80 && await resizeWindowOf(paneId, 80)
      try {
        await sendKeysLiteral(paneId, '/cost')
        await sendKeys(paneId, ['Enter'])
        await waitForSettle(paneId, 500, 6000)
        const buf = await capturePane(paneId)
        await sendKeys(paneId, ['Escape'])            // close the modal → back to the terminal
        await waitForSettle(paneId, 200, 2000)
        return buf
      } finally {
        if (grew && h !== null) await resizeWindowOf(paneId, h)
      }
    }
    await sendKeysLiteral(paneId, '/context')
    await sendKeys(paneId, ['Enter'])
    await waitForSettle(paneId, 400, 6000)
    const buf = await exec('tmux', ['capture-pane', '-p', '-t', paneId, '-S', '-150', '-J'], { timeout: 3000 }).then(r => r.stdout).catch(() => '')
    await sendKeys(paneId, ['Escape'])                // clear the input line → back to the terminal
    await waitForSettle(paneId, 200, 2000)
    return buf
  })
  const out = kind === 'cost' ? extractCostReadout(raw) : extractContextReadout(raw)
  if (!out) { await bot.api.sendMessage(chatId, `Could not read /${kind} output.`).catch(() => {}); return }
  const title = kind === 'cost' ? '📊 <b>Cost</b>' : '📐 <b>Context</b>'
  const limit = Math.max(1, Math.min(loadAccess().textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
  for (const c of chunkHtml(`${title}\n<pre>${escapeHtml(out)}</pre>`, limit)) {
    await bot.api.sendMessage(chatId, c, { parse_mode: 'HTML' }).catch(() => {})
  }
}

// /session shows where the active session is: cwd, git branch (+dirty), mode, model.
// cwd/branch are read deterministically from tmux + git (no pane scraping).
// ---- Control bar (docked quick-action keyboard) ----
// Buttons send their label as a normal message; the message:text handler matches
// these exact labels and routes each to the action above before any other handling.
const BTN_MODE = '🧭 Mode'
const BTN_MODEL = '🧠 Model'
const BTN_SESSIONS = '🗂 Session'
const BTN_COST = '📊 Cost'
const BTN_STOP = '🛑 Stop'
const BTN_NEW = '🆕 New'

function controlKeyboard(): Keyboard {
  return new Keyboard()
    .text(BTN_MODEL).text(BTN_MODE).text(BTN_SESSIONS).text(BTN_STOP).text(BTN_NEW)
    .resized().persistent()
}

// ---- Telegram bot handlers ----

// The single welcome + feature guide, shown by /start (and the hidden /help alias). Pairing
// steps only appear when the sender isn't paired yet.
function startHelpText(paired: boolean): string {
  const guide =
    `<b>Welcome to the Claude Command Center</b>\n` +
    `Control Claude Code sessions without needing to visit the terminal — send messages &amp; files, get replies, switch models and modes, manage multiple sessions, and watch the work live.\n\n` +

    `💬 <b>Chatting</b>\n` +
    `• Any message you send is typed into the focused session.\n` +
    `• Send 📷 photos, 📎 files, or 🎙️ voice notes — they're handed to the session.\n` +
    `• Whatever the agent says last comes straight back to you here.\n\n` +

    `🧭 <b>Modes &amp; model</b>\n` +
    `<code>/mode</code> — interactive mode switcher\n` +
    `<code>/mode plan·auto·default·acceptedits·bypass</code> — jump to a mode\n` +
    `<code>/model</code> — show the model (<code>/model &lt;name&gt;</code> to switch)\n\n` +

    `🗂️ <b>Sessions</b>\n` +
    `<code>/sessions</code> — list &amp; switch (<code>/sessions #</code> to switch · <code>/sessions name # label</code> to rename)\n` +
    `<code>/resume</code> — pick a recent session (with times) to relaunch\n` +
    `• ➕ <b>New session</b> button — start one in any folder\n` +
    `• Switch back and any 💬 unread messages replay automatically\n\n` +

    `📊 <b>Visibility</b>\n` +
    `<code>/cost</code> — usage &amp; cost breakdown\n` +
    `<code>/context</code> — token-context usage\n` +
    `<code>/terminal [N]</code> — recent terminal activity\n` +
    `<code>/compact</code> — compact the conversation to free context\n\n` +

    `🛑 <b>Control</b>\n` +
    `<code>/stop</code> — interrupt the current task (Esc)\n` +
    `<code>/new</code> — start a fresh conversation\n` +
    `<code>/autocontinue</code> — auto-send "continue" when the limit resets\n\n` +

    `📌 <b>Pinned bar</b> — your session · model · mode, with 🗂️ 🧠 🧭 quick buttons (<code>/pin</code> to toggle).\n` +
    `🔁 Any other <code>/command</code> is relayed straight to Claude Code.`

  if (paired) return guide
  return guide +
    `\n\n🔗 <b>Not paired yet?</b>\n` +
    `1. DM me anything — you'll get a 6-char code\n` +
    `2. In Claude Code: <code>/telegram:access pair &lt;code&gt;</code>\n` +
    `Then DMs here reach that session.`
}

async function sendStartHelp(ctx: Context): Promise<void> {
  const gated = dmCommandGate(ctx)
  if (!gated) return
  const paired = gated.access.allowFrom.includes(gated.senderId)
  await ctx.reply(startHelpText(paired), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
}

bot.command('start', sendStartHelp)
bot.command('help', sendStartHelp)   // hidden alias (muscle memory); kept out of the command menu

bot.command('status', async ctx => {
  const gated = dmCommandGate(ctx)
  if (!gated) return
  const { access, senderId } = gated
  if (access.allowFrom.includes(senderId)) {
    const name = ctx.from!.username ? `@${ctx.from!.username}` : senderId
    await ctx.reply(`Paired as ${name}.`)
    return
  }
  for (const [code, p] of Object.entries(access.pending)) {
    if (p.senderId === senderId) {
      await ctx.reply(`🔗 Pending pairing — run in Claude Code:\n\n/telegram:access pair ${code}`)
      return
    }
  }
  await ctx.reply(`🔗 Not paired. Send me a message to get a pairing code.`)
})

// /mode with no arg pops the picker; /mode <name> jumps straight to that mode.
const MODE_ALIASES: Record<string, CcMode> = {
  default: 'default', normal: 'default',
  acceptedits: 'acceptEdits', accept: 'acceptEdits', edits: 'acceptEdits',
  plan: 'plan', auto: 'auto',
  bypass: 'bypassPermissions', bypasspermissions: 'bypassPermissions', yolo: 'bypassPermissions',
}
bot.command('mode', ctx => {
  const arg = (ctx.match ?? '').toString().trim().toLowerCase().replace(/[-_\s]/g, '')
  const target = arg && MODE_ALIASES[arg]
  return target ? handleModeCommand(ctx, target) : doModePicker(ctx)
})

bot.command('plan', ctx => handleModeCommand(ctx, 'plan'))
bot.command('auto', ctx => handleModeCommand(ctx, 'auto'))
bot.command('default', ctx => handleModeCommand(ctx, 'default'))
bot.command('acceptedits', ctx => handleModeCommand(ctx, 'acceptEdits'))
bot.command('bypass', ctx => handleModeCommand(ctx, 'bypassPermissions'))
// Hidden alias: /yolo is the community nickname for bypass mode. Handled here for
// muscle memory but deliberately kept out of the setMyCommands menu below.
bot.command('yolo', ctx => handleModeCommand(ctx, 'bypassPermissions'))

// Type literal text into the session and press Enter — for free-text TUI prompts
// the button relay can't represent (e.g. pasting a /login code, a filename, etc.).
// /model with no args reports the active model rather than relaying (which would
// pop the picker on Telegram as buttons); /model <name> still relays to switch.
bot.command('model', async ctx => {
  if (!dmCommandGate(ctx)) return
  if (!activePaneId || !paneWatcher) {
    await ctx.reply('No active Claude Code session with tmux.')
    return
  }
  const arg = (ctx.match ?? '').toString().trim()
  if (arg) {
    const chat_id = String(ctx.chat!.id)
    void relaySlashCommand(activePaneId, paneWatcher, `/model ${arg}`, chat_id, ctx.message!.message_id)
    return
  }
  await doModelPicker(ctx)
})

// /new asks to confirm, then resets and reports the model. /clear is a hidden
// alias for /new (kept for muscle memory; deliberately left out of the menu).
bot.command('new', confirmNewSession)
bot.command('clear', confirmNewSession)

// /compact relays straight to the session — compact the conversation to free context.
bot.command('compact', async ctx => {
  if (!dmCommandGate(ctx)) return
  if (!activePaneId || !paneWatcher) { await ctx.reply('No active Claude Code session with tmux.'); return }
  void relaySlashCommand(activePaneId, paneWatcher, '/compact', String(ctx.chat!.id), ctx.message!.message_id)
})

// /dock shows the docked control bar; /dock off hides it. /menu stays as a hidden alias.
bot.command(['dock', 'menu'], async ctx => {
  if (!dmCommandGate(ctx)) return
  const arg = (ctx.match ?? '').toString().trim().toLowerCase()
  if (arg === 'off' || arg === 'hide') {
    await ctx.reply('Control bar hidden — /dock to show it again.', { reply_markup: { remove_keyboard: true } })
    return
  }
  await ctx.reply('🎛 Control bar ready.', { reply_markup: controlKeyboard() })
})

// /cost, /context relay session visibility info. (/session is the registry — below.)
bot.command('cost', ctx => doReadout(ctx, 'cost'))
bot.command('context', ctx => doReadout(ctx, 'context'))

// Trim a captured pane tail down to its content: strip ANSI, drop the trailing
// input-box / footer chrome and surrounding blanks, and keep the last `maxLines`.
function cleanPaneTail(raw: string, maxLines: number): string {
  let lines = raw.split('\n').map(l => stripAnsi(l).replace(/\s+$/, ''))
  const isChrome = (l: string) =>
    !l.trim() ||
    /^[─╭╮╰╯│\s]*$/.test(l) ||                                                  // borders / blank
    /^\s*[❯>]\s*$/.test(l) ||                                                    // empty input cursor
    /shift\+tab to cycle|esc to interrupt|to manage|auto-update failed/i.test(l) // footer chrome
  while (lines.length && isChrome(lines[lines.length - 1])) lines.pop()
  while (lines.length && !lines[0].trim()) lines.shift()
  if (lines.length > maxLines) lines = lines.slice(-maxLines)
  return lines.join('\n')
}

// /terminal [N] — dump the last N lines of the terminal (default 40, capped) so you can
// catch up on recent session activity. Read-only: just captures the pane scrollback.
bot.command('terminal', async ctx => {
  if (!dmCommandGate(ctx)) return
  if (!activePaneId) { await ctx.reply('No active Claude Code session with tmux.'); return }
  const arg = parseInt((ctx.match ?? '').toString().trim(), 10)
  const n = Number.isFinite(arg) ? Math.max(5, Math.min(arg, 200)) : 40
  let raw: string
  try {
    raw = (await exec('tmux', ['capture-pane', '-p', '-t', activePaneId, '-S', `-${n + 20}`, '-J'], { timeout: 3000 })).stdout
  } catch {
    await ctx.reply('Could not read the session pane.')
    return
  }
  const body = cleanPaneTail(raw, n)
  if (!body) { await ctx.reply('Nothing recent to show.'); return }
  const limit = Math.max(1, Math.min(loadAccess().textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
  const chunks = chunkHtml(`📜 <b>Recent terminal (${body.split('\n').length} lines)</b>\n<pre>${escapeHtml(body)}</pre>`, limit)
  for (const c of chunks) await bot.api.sendMessage(String(ctx.chat!.id), c, { parse_mode: 'HTML' }).catch(() => {})
})

// ---- Usage-limit reset reminder ----
// A daemon-side timer that pings the user when their usage limit resets. Works even
// while Claude is frozen at the limit, since the daemon is a separate process. The
// schedule is persisted so it survives a daemon restart (re-armed on startup).
const SCHEDULED_RESET_FILE = join(STATE_DIR, 'scheduled-reset.json')
let resetTimer: ReturnType<typeof setTimeout> | null = null

// Claude prints a ROUNDED reset time ("resets 9:30am"), so the real reset can land a little
// later — firing "continue" exactly then re-hits the limit. Fire a touch after the printed
// time, then verify the session actually resumed and retry a few times if it's still frozen.
const RESET_GRACE_MS = 90_000
const CONTINUE_VERIFY_MS = 12_000
const CONTINUE_RETRY_MS = 3 * 60_000
const CONTINUE_MAX_ATTEMPTS = 5

function fireResetNotification(chats: string[], attempt = 0): void {
  // Auto-continue (default on): type "continue" into the session automatically. Falls back
  // to the manual Continue button when disabled (/autocontinue off) or no live session.
  if (loadAccess().autoContinue !== false && activePaneId && paneWatcher) {
    const msg = attempt === 0
      ? '🕛 Usage limit reset — ▶️ auto-continuing… (turn off with /autocontinue off)'
      : `🔁 Still limited — retrying continue (attempt ${attempt + 1}/${CONTINUE_MAX_ATTEMPTS})…`
    for (const chat_id of chats) void bot.api.sendMessage(chat_id, msg).catch(() => {})
    void (async () => {
      const ok = await injectText(activePaneId!, paneWatcher!, 'continue')
      setTimeout(() => void verifyAutoContinue(chats, attempt, ok), CONTINUE_VERIFY_MS)
    })()
    return
  }
  try { unlinkSync(SCHEDULED_RESET_FILE) } catch {}
  const keyboard = new InlineKeyboard().text('▶️ Continue', 'usage:continue')
  for (const chat_id of chats) {
    void bot.api.sendMessage(chat_id, '🕛 Usage limit reset — continue?', { reply_markup: keyboard }).catch(() => {})
  }
}

// After auto-continue types "continue", confirm the session actually resumed. If it's still
// showing the frozen limit banner (the reset hadn't really landed yet), reschedule a retry a
// few minutes out — persisted + capped — instead of giving up after one early attempt.
async function verifyAutoContinue(chats: string[], attempt: number, injected: boolean): Promise<void> {
  const cap = activePaneId ? await capturePane(activePaneId).catch(() => '') : ''
  const resumed = injected && !!cap && !detectLimited(cap)
  if (resumed) {
    try { unlinkSync(SCHEDULED_RESET_FILE) } catch {}
    for (const chat_id of chats) void bot.api.sendMessage(chat_id, '✅ Session resumed.').catch(() => {})
    return
  }
  if (attempt + 1 >= CONTINUE_MAX_ATTEMPTS) {
    try { unlinkSync(SCHEDULED_RESET_FILE) } catch {}
    for (const chat_id of chats) void bot.api.sendMessage(chat_id, '⚠️ Still limited after several tries — stopping auto-retry. Send "continue" once it lifts.').catch(() => {})
    return
  }
  scheduleReset(Date.now() + CONTINUE_RETRY_MS, chats, attempt + 1)
}

function scheduleReset(fireAt: number, chats: string[], attempt = 0): void {
  if (resetTimer) { clearTimeout(resetTimer); resetTimer = null }
  try { writeFileSync(SCHEDULED_RESET_FILE, JSON.stringify({ fireAt, chats, attempt }), { mode: 0o600 }) } catch {}
  const delay = fireAt - Date.now()
  if (delay <= 0) { fireResetNotification(chats, attempt); return }
  resetTimer = setTimeout(() => { resetTimer = null; fireResetNotification(chats, attempt) }, delay)
}

// Re-arm a persisted reminder on daemon startup (or fire it if it just came due).
function loadScheduledReset(): void {
  let data: { fireAt: number; chats: string[]; attempt?: number }
  try { data = JSON.parse(readFileSync(SCHEDULED_RESET_FILE, 'utf8')) } catch { return }
  if (!data?.fireAt || !Array.isArray(data.chats)) { try { unlinkSync(SCHEDULED_RESET_FILE) } catch {}; return }
  if (data.fireAt < Date.now() - 10 * 60_000) { try { unlinkSync(SCHEDULED_RESET_FILE) } catch {}; return }  // missed long ago
  scheduleReset(data.fireAt, data.chats, data.attempt ?? 0)
}


// /pin on|off toggles the pinned status message (default on); bare /pin shows the
// current state. Off unpins + removes any existing pin; on recreates it.
bot.command('pin', async ctx => {
  if (!dmCommandGate(ctx)) return
  const arg = (ctx.match ?? '').toString().trim().toLowerCase()
  if (arg && arg !== 'on' && arg !== 'off') {
    await ctx.reply('Usage: <code>/pin on</code> | <code>off</code>', { parse_mode: 'HTML' })
    return
  }
  if (arg) {
    const access = loadAccess()
    access.sessionPin = arg === 'on'
    saveAccess(access)
    if (arg === 'off') await removeSessionPins()
    else await updateSessionPin()
  }
  const on = loadAccess().sessionPin !== false
  await ctx.reply(
    `📌 Pinned status message is <b>${on ? 'ON' : 'OFF'}</b>.\n` +
    (on
      ? 'It stays pinned up top with the active session · model · mode and quick buttons.'
      : 'No pinned status message is shown.') +
    '\nToggle with <code>/pin on</code> | <code>off</code>.',
    { parse_mode: 'HTML' },
  )
})

// /autocontinue on|off toggles whether the reset reminder auto-types "continue"
// (default on); bare /autocontinue shows the current state.
bot.command('autocontinue', async ctx => {
  if (!dmCommandGate(ctx)) return
  const arg = (ctx.match ?? '').toString().trim().toLowerCase()
  if (arg && arg !== 'on' && arg !== 'off') {
    await ctx.reply('Usage: <code>/autocontinue on</code> | <code>off</code>', { parse_mode: 'HTML' })
    return
  }
  if (arg) {
    const access = loadAccess()
    access.autoContinue = arg === 'on'
    saveAccess(access)
  }
  const on = loadAccess().autoContinue !== false
  await ctx.reply(
    `▶️ Auto-continue on reset is <b>${on ? 'ON' : 'OFF'}</b>.\n` +
    (on
      ? 'When your usage limit resets, I\'ll automatically send "continue" into the session.'
      : 'When your usage limit resets, I\'ll show a ▶️ Continue button for you to tap.') +
    '\nToggle with <code>/autocontinue on</code> | <code>off</code>.',
    { parse_mode: 'HTML' },
  )
})

// User-set session names (paneId → label), overriding the cwd-derived default. In-memory:
// re-derived from cwd on a daemon restart.
const sessionNames = new Map<string, string>()

// A pane's display label: a user-set name, else the last path segment of its cwd, else the
// pane id.
async function paneLabel(paneId: string): Promise<string> {
  const named = sessionNames.get(paneId)
  if (named) return named
  const cwd = await paneCwd(paneId)
  return (cwd && cwd.split('/').filter(Boolean).pop()) || paneId
}

// The unified session list: every shim-registered session PLUS the off-MCP adopted/forced
// pane (which lives in activePaneId, not the sessions map — without this it shows as "no
// sessions"). `shim` marks the ones switchable via setFocus.
type SessionRow = { key: string; paneId: string | null; label: string; current: boolean; shim: boolean }
async function sessionRows(): Promise<SessionRow[]> {
  const rows: SessionRow[] = []
  const panes = new Set<string>()
  for (const { id, s } of orderedSessions()) {
    if (s.paneId) panes.add(s.paneId)
    const label = (s.paneId && sessionNames.get(s.paneId)) || s.label
    rows.push({ key: id, paneId: s.paneId, label, current: id === currentSessionId, shim: true })
  }
  const offMcp = new Set(offMcpPanes)
  if (activePaneId && !sessions.size) offMcp.add(activePaneId)   // FORCE_PANE / lone adopted pane
  for (const p of offMcp) {
    if (panes.has(p)) continue                                   // already listed as a shim session
    rows.push({ key: p, paneId: p, label: await paneLabel(p), current: currentSessionId === p, shim: false })
  }
  return rows
}

// 1-based position of a session key in the list — the number users see in /session.
async function sessionNumber(key: string): Promise<number | null> {
  const i = (await sessionRows()).findIndex(r => r.key === key)
  return i >= 0 ? i + 1 : null
}

// ---- Pinned "current session" indicator ----
// A single pinned message per chat showing the focused session at a glance —
// 💻 name • model (…) • mode (…). Pinned once and then edited in place on every switch and
// mode change; it stays even with a single session. Pin ids are persisted so a daemon restart
// edits the existing pin instead of pinning a new one.
const SESSION_PIN_FILE = join(STATE_DIR, 'session-pin.json')
const sessionPins = new Map<string, number>()
try { for (const [c, m] of Object.entries(JSON.parse(readFileSync(SESSION_PIN_FILE, 'utf8')) as Record<string, number>)) sessionPins.set(c, m) } catch {}
function persistSessionPins(): void {
  try { writeFileSync(SESSION_PIN_FILE, JSON.stringify(Object.fromEntries(sessionPins)), { mode: 0o600 }) } catch {}
}

// Unpin + delete every pinned status message (used by /pin off).
async function removeSessionPins(): Promise<void> {
  for (const [chat, mid] of sessionPins) {
    await bot.api.unpinChatMessage(chat, mid).catch(() => {})
    await bot.api.deleteMessage(chat, mid).catch(() => {})
  }
  sessionPins.clear(); persistSessionPins()
}

// The model the focused session last used, read from its transcript (non-intrusive, per
// session) — falls back to lastKnownModel. The transcript stores raw ids like
// "claude-opus-4-8"; prettyModel turns that into "Opus 4.8".
function lastModelInTranscript(file: string): string | null {
  let data = ''
  try { data = readFileSync(file, 'utf8') } catch { return null }
  const matches = data.match(/"model":"([^"]+)"/g) ?? []
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i].slice(9, -1)
    if (m && m !== '<synthetic>') return m
  }
  return null
}
function prettyModel(id: string | null): string | null {
  const m = id?.match(/(opus|sonnet|haiku)/i)
  return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : id
}

// Status line for the focused session: 💻 name • model (…) • mode (…). Mode is read live from a
// pane capture; model from the session's transcript. Both degrade to "—" rather than blocking.
async function sessionPinText(rows: SessionRow[]): Promise<string> {
  const cur = rows.find(r => r.current)
  if (!cur) return '🗂️ <b>No active session</b>'
  let mode = '—', model = lastKnownModel
  if (activePaneId) {
    // Strip modeLabel's leading per-mode emoji — the pin uses a single generic 🧭.
    try { const cap = await capturePane(activePaneId); if (onNormalPrompt(cap)) mode = modeLabel(detectCurrentMode(cap)).replace(/^\S+\s+/, '') } catch {}
    try {
      const cwd = await paneCwd(activePaneId)
      const file = cwd ? resolveTranscript(cwd) : null
      model = (file && prettyModel(lastModelInTranscript(file))) || model
    } catch {}
  }
  return `🗂️ <b>${escapeHtml(cur.label)}</b> • 🧠 ${escapeHtml(model ?? '—')} • 🧭 ${escapeHtml(mode)}`
}

// Quick-action buttons on the pinned status message — same emojis as the pin's own fields.
function pinKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🗂️ Sessions', 'pin:sessions')
    .text('🧠 Model', 'pin:model')
    .text('🧭 Mode', 'pin:mode')
}

let pinUpdating = false
async function updateSessionPin(): Promise<void> {
  if (loadAccess().sessionPin === false) return // disabled via /pin off
  if (pinUpdating) return                       // serialize — capture + edit can overlap with switches
  pinUpdating = true
  try {
    const text = await sessionPinText(await sessionRows())
    const reply_markup = pinKeyboard()
    for (const chat of loadAccess().allowFrom) {
      const existing = sessionPins.get(chat)
      if (existing) {
        await bot.api.editMessageText(chat, existing, text, { parse_mode: 'HTML', reply_markup }).catch(() => {})
        // If the user unpinned it, re-pin on the next update (e.g. a session switch) so it returns.
        const info = await bot.api.getChat(chat).catch(() => null)
        if (info?.pinned_message?.message_id !== existing) {
          await bot.api.pinChatMessage(chat, existing, { disable_notification: true }).catch(() => {})
        }
        continue
      }
      try {
        const m = await bot.api.sendMessage(chat, text, { parse_mode: 'HTML', reply_markup })
        await bot.api.pinChatMessage(chat, m.message_id, { disable_notification: true }).catch(() => {})
        sessionPins.set(chat, m.message_id); persistSessionPins()
      } catch (e) { process.stderr.write(`daemon: session pin create failed: ${e}\n`) }
    }
  } finally { pinUpdating = false }
}

// Ping when an *unfocused* off-MCP session speaks: "💬 N messages from Session N while you
// were away" + a switch button. One ping per session, edited in place as the count grows,
// and deleted once you switch in (the read baseline catches up). Skips sessions with no read
// baseline yet (not announced) so it never pings a backlog.
async function checkCrossSessionUnread(): Promise<void> {
  if (!TRANSCRIPT_OUTBOUND) return
  for (const pane of offMcpPanes) {
    if (pane === activePaneId) continue
    const cwd = await paneCwd(pane)
    const file = cwd ? resolveTranscript(cwd) : null
    if (!file) continue
    const latest = latestFinalReply(file)
    const baseline = lastRelayedByFile.get(file)
    if (!latest || baseline === undefined || latest.uuid === baseline) {
      // Caught up (or never baselined) — clear the ping so a future message re-pings fresh.
      const msgs = unreadNotifMsgs.get(file)
      if (msgs) { for (const [chat, mid] of msgs) await bot.api.deleteMessage(chat, mid).catch(() => {}); unreadNotifMsgs.delete(file) }
      unreadNotified.delete(file)
      continue
    }
    if (unreadNotified.get(file) === latest.uuid) continue   // already pinged for this state
    unreadNotified.set(file, latest.uuid)
    const n = await sessionNumber(pane)
    const count = finalRepliesAfter(file, baseline).length
    const text = `💬 ${count} message${count > 1 ? 's' : ''} from <b>Session ${n ?? '?'}</b> while you were away`
    const kb = new InlineKeyboard().text(`♻️ Switch to Session ${n ?? '?'}`, `adoptpane:${pane}`)
    let msgs = unreadNotifMsgs.get(file)
    for (const chat of loadAccess().allowFrom) {
      const mid = msgs?.get(chat)
      if (mid) { await bot.api.editMessageText(chat, mid, text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {}) }
      else {
        const m = await bot.api.sendMessage(chat, text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => null)
        if (m) { if (!msgs) { msgs = new Map(); unreadNotifMsgs.set(file, msgs) } msgs.set(chat, m.message_id) }
      }
    }
  }
}

// When the focused session dies and exactly one remains, move focus to it automatically.
async function refocusSoleSession(): Promise<void> {
  const rows = await sessionRows()
  if (rows.length !== 1 || rows[0].current) return
  const only = rows[0]
  if (only.shim) setFocus(only.key)
  else if (only.paneId && await paneAlive(only.paneId)) focusOffMcpPane(only.paneId)
}

// "✅ Switched to Session N (/path)" — the cwd reads clearer than the bare folder name.
async function switchedMsg(n: number | null, paneId: string | null): Promise<string> {
  const path = paneId ? await paneCwd(paneId) : null
  return `✅ Switched to <b>Session ${n ?? '?'}</b>${path ? ` (<code>${escapeHtml(path)}</code>)` : ''}`
}

// Switch focus to session #n (1-based over sessionRows). Returns the HTML confirmation, or
// an HTML error if the number is out of range / the target can't be focused.
async function switchSessionTo(n: number): Promise<string> {
  const rows = await sessionRows()
  if (n < 1 || n > rows.length) return `No session #${n}. See /session.`
  const row = rows[n - 1]
  if (row.current) return `Already on <b>Session ${n}</b>.`
  if (row.shim) { setFocus(row.key); return switchedMsg(n, row.paneId) }
  if (!row.paneId || !(await paneAlive(row.paneId))) return 'That session’s pane is gone.'
  focusOffMcpPane(row.paneId)
  return switchedMsg(n, row.paneId)
}

// One tappable button per session for the /session listing — ★ marks the active one,
// ▶️ the others. Tapping fires switchsession:<#>. Four per row to stay compact.
function sessionSwitchKeyboard(rows: SessionRow[]): InlineKeyboard {
  const kb = new InlineKeyboard()
  rows.forEach((r, i) => {
    kb.text(`${r.current ? '★' : '▶️'} ${i + 1}`, `switchsession:${i + 1}`)
    if ((i + 1) % 4 === 0) kb.row()
  })
  kb.row().text('➕ New session', 'newsession')
  return kb
}

// New-session creation: spawn a plugin-less claude in a fresh tmux window; discovery then
// announces it with a ▶️ Switch button. The folder comes from a force-reply (see below).
const newSessionReplyTargets = new Set<string>()   // `${chatId}:${messageId}` of folder prompts

async function resolveNewSessionDir(input: string): Promise<string> {
  const t = input.trim()
  const here = async () => (activePaneId && await paneCwd(activePaneId)) || homedir()
  if (!t) return here()
  if (t === '~') return homedir()
  if (/^here$/i.test(t) || t === '.') return here()
  if (t.startsWith('~/')) return join(homedir(), t.slice(2))
  return t
}

async function spawnSession(dir: string, extra = ''): Promise<boolean> {
  try {
    let target: string[] = []
    if (activePaneId) {
      try {
        const { stdout } = await exec('tmux', ['display-message', '-p', '-t', activePaneId, '#{session_name}'], { timeout: 2000 })
        // Trailing colon = "this session, next free window index". Without it, `-t name`
        // is read as a target *window* and defaults to index 0 → "index 0 in use".
        if (stdout.trim()) target = ['-t', `${stdout.trim()}:`]
      } catch {}
    }
    const cmd = `claude --strict-mcp-config${extra ? ` ${extra}` : ''}`   // extra e.g. "--resume <id>"
    await exec('tmux', ['new-window', '-d', ...target, '-c', dir, cmd], { timeout: 5000 })
    return true
  } catch (e) { process.stderr.write(`daemon: spawn session in ${dir} failed: ${e}\n`); return false }
}

// /session — list the connected sessions (★ = focused). /session # switches focus;
// /session name # <label> renames one.
// Render the session listing with the tappable per-session switch keyboard. Shared by the
// /session command (no-arg) and the control-bar Sessions button.
async function doSessionList(ctx: Context): Promise<void> {
  const rows = await sessionRows()
  if (rows.length === 0) { await ctx.reply('No active Claude Code session.'); return }
  const lines = rows.map((r, i) => `${i + 1}. ${r.current ? '★ ' : ''}<b>${escapeHtml(r.label)}</b>`)
  await ctx.reply(
    `🗂 <b>Sessions</b> (★ = active):\n${lines.join('\n')}\n\n` +
    `Tap a number below, or <code>/sessions #</code> to switch · <code>/sessions name # label</code> to rename.`,
    { parse_mode: 'HTML', reply_markup: sessionSwitchKeyboard(rows) })
}

// Friendly last-activity stamp: relative for the last day, absolute date+time beyond that.
function fmtWhen(ms: number): string {
  const mins = Math.floor((Date.now() - ms) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h ago`
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// /resume — list the most recent Claude Code sessions (across all projects) with their last
// activity, each tappable to relaunch via `claude --resume` in a fresh pane.
bot.command('resume', async ctx => {
  if (!dmCommandGate(ctx)) return
  const recents = listRecentSessions(10)
  if (recents.length === 0) { await ctx.reply('No recent sessions found.'); return }
  const kb = new InlineKeyboard()
  const lines = recents.map((s, i) => {
    const folder = s.cwd.split('/').filter(Boolean).pop() || s.cwd || '—'
    const title = s.title ? ` — <i>${escapeHtml(s.title)}</i>` : ''
    kb.text(`${i + 1}`, `resume:${s.sessionId}`)
    if ((i + 1) % 5 === 0) kb.row()
    return `${i + 1}. <b>${escapeHtml(folder)}</b> · ${fmtWhen(s.mtime)}${title}`
  })
  await ctx.reply(
    `🕘 <b>Recent sessions</b>\n${lines.join('\n')}\n\nTap a number to resume it in a new pane.`,
    { parse_mode: 'HTML', reply_markup: kb })
})

bot.command(['sessions', 'session'], async ctx => {   // /sessions is canonical; /session is the alias
  if (!dmCommandGate(ctx)) return
  const arg = (ctx.match ?? '').toString().trim()
  const rows = await sessionRows()

  const nameMatch = arg.match(/^name\s+(\d+)\s+(.+)$/i)
  if (nameMatch) {
    const n = Number(nameMatch[1])
    if (n < 1 || n > rows.length) { await ctx.reply(`No session ${n}. See /session.`); return }
    const row = rows[n - 1]
    if (!row.paneId) { await ctx.reply('That session has no pane to name.'); return }
    const label = nameMatch[2].trim().slice(0, 40)
    sessionNames.set(row.paneId, label)
    await ctx.reply(`✅ Session ${n} renamed to <b>${escapeHtml(label)}</b>.`, { parse_mode: 'HTML' })
    return
  }

  const n = parseInt(arg, 10)
  if (arg && Number.isInteger(n)) {
    if (n < 1 || n > rows.length) { await ctx.reply(`Usage: <code>/session #</code> (1–${rows.length || 1}).`, { parse_mode: 'HTML' }); return }
    await ctx.reply(await switchSessionTo(n), { parse_mode: 'HTML' })
    return
  }

  await doSessionList(ctx)
})

// Interrupt the current turn by sending Esc to the pane (same as pressing Esc
// in the TUI). withInjection pauses the watcher and re-baselines afterward so
// the resulting pane change isn't mistaken for a new prompt/event.
bot.command('stop', confirmStop)

// Inline-button handler for permission requests + mode cycling + prompt answers.
bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data

  // Pinned-message quick actions → the same pickers as /sessions, /model, /mode.
  if (data === 'pin:sessions' || data === 'pin:model' || data === 'pin:mode') {
    if (!loadAccess().allowFrom.includes(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    await ctx.answerCallbackQuery().catch(() => {})
    if (data === 'pin:sessions') await doSessionList(ctx)
    else if (data === 'pin:model') await doModelPicker(ctx)
    else await doModePicker(ctx)
    return
  }

  // "Continue" button on the usage-limit reset ping → type "continue" into the session.
  if (data === 'usage:continue') {
    if (!loadAccess().allowFrom.includes(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    if (!activePaneId || !paneWatcher) {
      await ctx.answerCallbackQuery({ text: 'No active tmux session.' }).catch(() => {})
      return
    }
    await ctx.answerCallbackQuery({ text: 'Continuing…' }).catch(() => {})
    const ok = await injectText(activePaneId, paneWatcher, 'continue')
    await ctx.editMessageText(ok ? '🕛 Usage limit reset — ▶️ continuing…' : '🕛 Usage limit reset (couldn\'t reach the session).').catch(() => {})
    return
  }

  // Mode picker — apply a tapped mode
  const modeSet = /^mode:set:(default|acceptEdits|plan|auto|bypassPermissions)$/.exec(data)
  if (modeSet) {
    if (!loadAccess().allowFrom.includes(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    if (!activePaneId || !paneWatcher) {
      await ctx.answerCallbackQuery({ text: 'No active tmux session.' }).catch(() => {})
      return
    }
    if (!onNormalPrompt(await capturePane(activePaneId))) {
      await ctx.answerCallbackQuery({ text: 'Terminal is on another screen — can’t change mode.' }).catch(() => {})
      return
    }
    const target = modeSet[1] as CcMode
    await ctx.answerCallbackQuery().catch(() => {})
    const reached = await switchToMode(activePaneId, target, paneWatcher)
    if (reached === null) {
      await ctx.editMessageText(`Could not switch to ${modeLabel(target)} — try again.`).catch(() => {})
      return
    }
    await ctx.editMessageText(`🧭 <b>Mode</b> — now ${modeLabel(reached)}\n\n${MODE_TIP}`, {
      parse_mode: 'HTML', reply_markup: modePickerKeyboard(reached),
    }).catch(() => {})
    void updateSessionPin()
    return
  }

  // /cost or /context confirmed while Claude was working — interrupt (Esc), then run it.
  const readoutMatch = /^readout:(cost|context|cancel)$/.exec(data)
  if (readoutMatch) {
    if (!loadAccess().allowFrom.includes(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    if (readoutMatch[1] === 'cancel') {
      await ctx.answerCallbackQuery().catch(() => {})
      await ctx.editMessageText('Cancelled.').catch(() => {})
      return
    }
    if (!activePaneId || !paneWatcher) {
      await ctx.answerCallbackQuery({ text: 'No active tmux session.' }).catch(() => {})
      return
    }
    const kind = readoutMatch[1] as 'cost' | 'context'
    await ctx.answerCallbackQuery({ text: 'Interrupting…' }).catch(() => {})
    await paneWatcher.withInjection(async () => {
      await sendKeys(activePaneId!, ['Escape'])
      await waitForSettle(activePaneId!, 400, 5000)
    })
    await ctx.editMessageText(`▶️ Interrupted — running /${kind}…`).catch(() => {})
    await runReadout(String(ctx.chat?.id), kind)
    return
  }

  // Model picker — apply a tapped model alias
  const modelSet = /^model:set:(default|opus|sonnet|haiku)$/.exec(data)
  if (modelSet) {
    if (!loadAccess().allowFrom.includes(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    if (!activePaneId || !paneWatcher) {
      await ctx.answerCallbackQuery({ text: 'No active tmux session.' }).catch(() => {})
      return
    }
    const alias = modelSet[1]
    await ctx.answerCallbackQuery({ text: `Switching to ${alias}…` }).catch(() => {})
    await injectSlash(activePaneId, paneWatcher, `/model ${alias}`)
    const model = await readCurrentModel(activePaneId, paneWatcher)
    await ctx.editMessageText(`🧠 <b>Model</b> — now ${model ? escapeHtml(model) : escapeHtml(alias)}\n\n${MODEL_TIP}`, {
      parse_mode: 'HTML', reply_markup: modelPickerKeyboard(),
    }).catch(() => {})
    return
  }

  // New-session confirmation (Yes/No under the "Start a new session?" prompt)
  if (data === 'newconfirm:yes') {
    if (!loadAccess().allowFrom.includes(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    if (!activePaneId || !paneWatcher) {
      await ctx.answerCallbackQuery({ text: 'No active tmux session.' }).catch(() => {})
      return
    }
    await ctx.answerCallbackQuery({ text: 'Starting…' }).catch(() => {})
    await ctx.editMessageText('🆕 Starting a new session…').catch(() => {})
    const result = await performReset('/new')
    await ctx.editMessageText(result, { parse_mode: 'HTML' }).catch(() => {})
    return
  }

  // Stop confirmation (Yes/No under the "Interrupt the current task?" prompt)
  if (data === 'stopconfirm:yes') {
    if (!loadAccess().allowFrom.includes(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    await ctx.answerCallbackQuery({ text: 'Interrupting…' }).catch(() => {})
    await ctx.editMessageText(await performStop()).catch(() => {})
    return
  }

  // Session switch button (from the /session listing) → focus that session, confirm, and
  // refresh the listing's ★ so the keyboard stays in sync.
  const switchMatch = /^switchsession:(\d+)$/.exec(data)
  if (switchMatch) {
    if (!loadAccess().allowFrom.includes(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    const msg = await switchSessionTo(Number(switchMatch[1]))
    await ctx.answerCallbackQuery().catch(() => {})
    await ctx.editMessageReplyMarkup({ reply_markup: sessionSwitchKeyboard(await sessionRows()) }).catch(() => {})
    await ctx.reply(msg, { parse_mode: 'HTML' }).catch(() => {})
    return
  }

  // "➕ New session" button → turn the sessions list in place into a folder chooser:
  // This folder / Home / Specify. The first two spawn immediately; Specify drops a force-reply.
  if (data === 'newsession') {
    if (!loadAccess().allowFrom.includes(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    await ctx.answerCallbackQuery().catch(() => {})
    const cwd = activePaneId ? await paneCwd(activePaneId) : null
    const currentLine = cwd
      ? `Current: <code>${escapeHtml(cwd)}</code>`
      : 'Current: <i>current session’s folder</i>'
    const kb = new InlineKeyboard()
      .text('📁 This folder', 'newsession:here')
      .text('🏠 Home', 'newsession:home')
      .text('✏️ Specify', 'newsession:specify')
    await ctx.editMessageText(`📂 <b>New session — choose folder</b>\n\n${currentLine}`, {
      parse_mode: 'HTML', reply_markup: kb,
    }).catch(() => {})
    return
  }

  // Folder chooser buttons. here/home spawn straight away (editing the chooser into a
  // confirmation); specify drops a force-reply for a typed path.
  const nsMatch = /^newsession:(here|home|specify)$/.exec(data)
  if (nsMatch) {
    if (!loadAccess().allowFrom.includes(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    await ctx.answerCallbackQuery().catch(() => {})
    if (nsMatch[1] === 'specify') {
      const cwd = activePaneId ? await paneCwd(activePaneId) : null
      const currentLine = cwd
        ? `Current: <code>${escapeHtml(cwd)}</code>`
        : 'Current: <i>current session’s folder</i>'
      const sent = await ctx.reply(`📂 <b>New session — choose folder</b>\n\n${currentLine}\n\nReply with a folder path · empty = current folder`, {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: 'Folder path (empty = current folder)' },
      }).catch(() => null)
      if (sent) newSessionReplyTargets.add(`${ctx.chat?.id}:${sent.message_id}`)
      await ctx.editMessageReplyMarkup().catch(() => {})   // chooser is spent — strip its buttons
      return
    }
    const dir = nsMatch[1] === 'home' ? homedir() : await resolveNewSessionDir('')
    const ok = await spawnSession(dir)
    await ctx.editMessageText(ok
      ? `🚀 Starting a new session in <code>${escapeHtml(dir)}</code> — it'll pop up here with a ▶️ Switch button shortly.`
      : `❌ Couldn't start a session in <code>${escapeHtml(dir)}</code> — does that folder exist?`,
      { parse_mode: 'HTML' }).catch(() => {})
    return
  }

  // Resume button from /resume → relaunch that session with `claude --resume` in a new pane.
  const resumeMatch = /^resume:([0-9a-fA-F-]+)$/.exec(data)
  if (resumeMatch) {
    if (!loadAccess().allowFrom.includes(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    await ctx.answerCallbackQuery().catch(() => {})
    const id = resumeMatch[1]
    const dir = findSessionCwd(id) ?? homedir()
    const ok = await spawnSession(dir, `--resume ${id}`)
    await ctx.reply(ok
      ? `🔄 Resuming in <code>${escapeHtml(dir)}</code> — it'll pop up here with a ♻️ Switch button shortly.`
      : `❌ Couldn't resume that session in <code>${escapeHtml(dir)}</code>.`,
      { parse_mode: 'HTML' }).catch(() => {})
    return
  }

  // "Switch to it" button under a new-session announcement → focus that pane by id.
  const adoptMatch = /^adoptpane:(%\d+)$/.exec(data)
  if (adoptMatch) {
    if (!loadAccess().allowFrom.includes(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    const paneId = adoptMatch[1]
    if (paneId === activePaneId) { await ctx.answerCallbackQuery({ text: 'Already focused.' }).catch(() => {}); return }
    if (!(await paneAlive(paneId))) {
      await ctx.answerCallbackQuery({ text: 'That pane is gone.' }).catch(() => {})
      await ctx.editMessageReplyMarkup({}).catch(() => {})
      return
    }
    offMcpPanes.add(paneId)
    focusOffMcpPane(paneId)
    await ctx.answerCallbackQuery({ text: 'Switched.' }).catch(() => {})
    await ctx.editMessageReplyMarkup({}).catch(() => {})
    await ctx.reply(await switchedMsg(await sessionNumber(paneId), paneId), { parse_mode: 'HTML' }).catch(() => {})
    return
  }

  // Prompt answer buttons
  // Permission-prompt answer: inject the chosen digit (Yes / allow-all / No) + Enter.
  const ppermMatch = /^pperm:(\d+)$/.exec(data)
  if (ppermMatch) {
    if (!loadAccess().allowFrom.includes(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    if (!activePaneId || !paneWatcher) {
      await ctx.answerCallbackQuery({ text: 'No active tmux session.' }).catch(() => {})
      return
    }
    const num = ppermMatch[1]
    await ctx.answerCallbackQuery({ text: `Answered ${num}` }).catch(() => {})
    await paneWatcher.withInjection(async () => {
      await sendKeys(activePaneId!, [num, 'Enter'])
      await waitForSettle(activePaneId!, 300, 5000)
    })
    lastRelayedPermissionHash = ''  // allow the next permission prompt to relay
    await ctx.editMessageReplyMarkup().catch(() => {})  // drop the buttons — the answer landed
    await verifyPromptClosed()
    return
  }

  const promptMatch = /^prompt:(\d+)$/.exec(data)
  if (promptMatch) {
    const access = loadAccess()
    const senderId = String(ctx.from.id)
    if (!access.allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    if (!activePaneId || !paneWatcher) {
      await ctx.answerCallbackQuery({ text: 'No active tmux session.' }).catch(() => {})
      return
    }
    const num = promptMatch[1]
    await ctx.answerCallbackQuery({ text: `Selected ${num}` }).catch(() => {})
    await paneWatcher.withInjection(async () => {
      await sendKeys(activePaneId!, [num, 'Enter'])
      await waitForSettle(activePaneId!, 300, 5000)
    })
    lastRelayedPromptHash = ''  // allow next prompt to relay
    await ctx.editMessageReplyMarkup().catch(() => {})  // drop the keyboard — signals the answer landed
    await verifyPromptClosed()
    return
  }

  // Multi-question (tabbed) answer buttons. Unlike a single-select, digit keys
  // don't apply here — we move the cursor down to the option and press Enter, which
  // selects it and advances to the next tab. handleTabbedAdvance then relays the
  // next question or submits.
  const mqMatch = /^mq:(\d+)$/.exec(data)
  if (mqMatch) {
    const senderId = String(ctx.from.id)
    if (!loadAccess().allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    if (!activePaneId || !paneWatcher) {
      await ctx.answerCallbackQuery({ text: 'No active tmux session.' }).catch(() => {})
      return
    }
    const num = Number(mqMatch[1])
    await ctx.answerCallbackQuery({ text: `Selected ${num}` }).catch(() => {})
    await paneWatcher.withInjection(async () => {
      await navigateDown(activePaneId!, num - 1)
      await sendKeys(activePaneId!, ['Enter'])
      await waitForSettle(activePaneId!, 300, 5000)
    })
    await ctx.editMessageReplyMarkup().catch(() => {})
    await handleTabbedAdvance(String(ctx.chat?.id))
    return
  }

  // ✏️ Type-something button → open a force-reply so the user can write a free-text
  // answer (driven into the pane by the message:text handler).
  if (data === 'ftext') {
    const senderId = String(ctx.from.id)
    if (!loadAccess().allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    const fp = freeTextPrompts.get(`${ctx.chat?.id}:${ctx.callbackQuery.message?.message_id}`)
    if (!fp) {
      await ctx.answerCallbackQuery({ text: 'This prompt is no longer active.' }).catch(() => {})
      return
    }
    await ctx.answerCallbackQuery().catch(() => {})
    const sent = await ctx.reply(`✏️ Reply with your answer for:\n<b>${escapeHtml(fp.question)}</b>`, {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Your answer' },
    }).catch(() => null)
    if (sent) {
      freeTextReplyTargets.set(`${ctx.chat?.id}:${sent.message_id}`, {
        paneId: fp.paneId, downCount: fp.downCount, tabbed: fp.tabbed,
      })
    }
    return
  }

  // 💬 Chat-about-this button → select the "Chat about this" option, which
  // dismisses the question ("declined") and drops Claude to a normal input. The
  // user's next message then routes into the session like any other.
  if (data === 'chat') {
    const senderId = String(ctx.from.id)
    if (!loadAccess().allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    const cp = chatPrompts.get(`${ctx.chat?.id}:${ctx.callbackQuery.message?.message_id}`)
    if (!cp || !activePaneId || !paneWatcher) {
      await ctx.answerCallbackQuery({ text: 'This prompt is no longer active.' }).catch(() => {})
      return
    }
    await ctx.answerCallbackQuery({ text: 'Dismissing — go ahead and type.' }).catch(() => {})
    await paneWatcher.withInjection(async () => {
      if (cp.useEscape) {
        await sendKeys(activePaneId!, ['Escape'])
      } else {
        await navigateDown(activePaneId!, cp.downCount)
        await sendKeys(activePaneId!, ['Enter'])
      }
      await waitForSettle(activePaneId!, 300, 5000)
    })
    lastRelayedPromptHash = ''
    await ctx.editMessageReplyMarkup().catch(() => {})
    await ctx.reply('💬 Chat about this — send your message below 👇').catch(() => {})
    return
  }

  // Multi-select prompt buttons (toggle an option, or submit the selection)
  const mselMatch = /^msel:(\d+|submit)$/.exec(data)
  if (mselMatch) {
    const access = loadAccess()
    if (!access.allowFrom.includes(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    const key = `${ctx.chat?.id}:${ctx.callbackQuery.message?.message_id}`
    const state = pendingMultiSelect.get(key)
    if (!state) {
      await ctx.answerCallbackQuery({ text: 'This prompt is no longer active.' }).catch(() => {})
      return
    }

    if (mselMatch[1] !== 'submit') {
      const idx = Number(mselMatch[1]) - 1
      if (state.selected.has(idx)) state.selected.delete(idx)
      else state.selected.add(idx)
      await ctx.answerCallbackQuery().catch(() => {})
      await ctx.editMessageReplyMarkup({
        reply_markup: multiSelectKeyboard(state.options, state.selected),
      }).catch(() => {})
      return
    }

    // Submit: drive the TUI from the top option down, toggling Space on each
    // selected row and Enter at the end. Nothing has moved the cursor since the
    // prompt appeared, so the cursor still rests on the first option.
    if (!activePaneId || !paneWatcher) {
      await ctx.answerCallbackQuery({ text: 'No active tmux session.' }).catch(() => {})
      return
    }
    // Toggle each selected row from the top (Space toggles; Down steps between rows).
    const toggles: string[] = []
    state.options.forEach((_, i) => {
      if (state.selected.has(i)) toggles.push('Space')
      if (i < state.options.length - 1) toggles.push('Down')
    })
    await ctx.answerCallbackQuery({ text: `Submitted ${state.selected.size} selected` }).catch(() => {})
    await paneWatcher.withInjection(async () => {
      if (toggles.length) { await sendKeysPaced(activePaneId!, toggles); await waitForSettle(activePaneId!, 200, 3000) }
      // This build renders even a single multi-select question with its own Submit tab —
      // toggling never submits. Move right to the Submit tab and confirm "Submit answers".
      await sendKeys(activePaneId!, ['Right'])
      await waitForSettle(activePaneId!, 200, 3000)
      await sendKeys(activePaneId!, ['Enter'])
      await waitForSettle(activePaneId!, 300, 5000)
    })
    pendingMultiSelect.delete(key)
    lastRelayedPromptHash = ''  // allow next prompt to relay
    await ctx.editMessageReplyMarkup().catch(() => {})  // drop the keyboard once answered
    await verifyPromptClosed()
    return
  }

  // Permission buttons
  const permMatch = /^perm:(allow|deny|guide):([a-km-z]{5})$/.exec(data)
  if (!permMatch) {
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }
  const access = loadAccess()
  const senderId = String(ctx.from.id)
  if (!access.allowFrom.includes(senderId)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }
  const [, behavior, request_id] = permMatch

  // Deny, then invite the user to redirect Claude — their next message reaches it
  // as normal (the MCP permission protocol carries only allow/deny, no message).
  if (behavior === 'guide') {
    respondPermission(request_id, 'deny')
    await ctx.answerCallbackQuery({ text: 'Denied — send your guidance' }).catch(() => {})
    const m = ctx.callbackQuery.message
    const base = m && 'text' in m && m.text ? m.text : '🔐 Permission'
    await ctx.editMessageText(`${base}\n\n❌ Denied — reply with what Claude should do instead.`).catch(() => {})
    return
  }

  // Send permission result back to the session that asked (forwards to Claude).
  respondPermission(request_id, behavior as 'allow' | 'deny')
  const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
  await ctx.answerCallbackQuery({ text: label }).catch(() => {})
  const msg = ctx.callbackQuery.message
  if (msg && 'text' in msg && msg.text) {
    await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {})
  }
})

type AttachmentMeta = { kind: string; file_id: string; size?: number; mime?: string; name?: string; transcribed?: boolean }

async function handleInbound(
  ctx: Context,
  text: string,
  downloadImage: (() => Promise<string | undefined>) | undefined,
  attachment?: AttachmentMeta,
  transcribeAudio?: () => Promise<{ text: string; transcribed: boolean }>,
): Promise<void> {
  const result = gate(ctx)
  if (result.action === 'drop') return
  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    await ctx.reply(`🔗 ${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`)
    return
  }

  const access = result.access
  const from = ctx.from!
  const chat_id = String(ctx.chat!.id)
  const msgId = ctx.message?.message_id

  // Permission text-reply intercept ("yes xxxxx" / "no xxxxx")
  const permMatch = PERMISSION_REPLY_RE.exec(text)
  if (permMatch) {
    respondPermission(
      permMatch[2]!.toLowerCase(),
      permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
    )
    if (msgId != null) {
      const emoji = permMatch[1]!.toLowerCase().startsWith('y') ? '✅' : '❌'
      void bot.api.setMessageReaction(chat_id, msgId, [{ type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] }]).catch(() => {})
    }
    return
  }

  typingPresence.arm(chat_id)

  if (access.ackReaction && msgId != null) {
    void bot.api.setMessageReaction(chat_id, msgId, [
      { type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] },
    ]).catch(() => {})
  }

  // Transcription runs here, post-gate, so we never download or pay for an
  // API transcription on senders who aren't allowed through.
  let content = text
  let attach = attachment
  if (transcribeAudio) {
    const r = await transcribeAudio()
    content = r.text
    if (attach && r.transcribed) attach = { ...attach, transcribed: true }
  }

  const imagePath = downloadImage ? await downloadImage() : undefined

  // Off-MCP: there's no download_attachment tool, so fetch any non-image attachment to a
  // local path up front and inject that path (like image_path) — the agent just Reads it.
  let attachmentPath: string | undefined
  if (TRANSCRIPT_OUTBOUND && attach?.file_id && !imagePath) {
    try { attachmentPath = await downloadTelegramFile(attach.file_id) }
    catch (e) { process.stderr.write(`daemon: off-mcp attachment download failed: ${e}\n`) }
  }

  const params: InboundParams = {
    content,
    meta: {
      chat_id,
      ...(msgId != null ? { message_id: String(msgId) } : {}),
      user: from.username ?? String(from.id),
      user_id: String(from.id),
      ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
      ...(imagePath ? { image_path: imagePath } : {}),
      ...(attachmentPath ? { attachment_path: attachmentPath } : {}),
      ...(attach ? {
        attachment_kind: attach.kind,
        attachment_file_id: attach.file_id,
        ...(attach.size != null ? { attachment_size: String(attach.size) } : {}),
        ...(attach.mime ? { attachment_mime: attach.mime } : {}),
        ...(attach.name ? { attachment_name: attach.name } : {}),
        ...(attach.transcribed ? { attachment_transcribed: 'true' } : {}),
      } : {}),
    },
  }

  emitInbound(params)
}

bot.on('message:text', async ctx => {
  const text = ctx.message.text

  // Control-bar taps arrive as a normal message carrying the button label.
  // Route exact matches to their action before any other handling.
  switch (text) {
    case BTN_MODE:     await doModePicker(ctx); return
    case BTN_MODEL:    await doModelPicker(ctx); return
    case BTN_SESSIONS: await doSessionList(ctx); return
    case BTN_COST:     await doReadout(ctx, 'cost'); return
    case BTN_STOP:     await confirmStop(ctx); return
    case BTN_NEW:      await confirmNewSession(ctx); return
  }

  // Reply to a ✏️ Type-something force-reply → type the answer into the prompt's
  // free-text field: move the cursor down to the "Type something" option, type the
  // text, and Enter. On a multi-question prompt this advances to the next tab, so
  // hand off to handleTabbedAdvance; otherwise the single question resolves.
  const replyTo = ctx.message.reply_to_message
  if (replyTo) {
    // Reply to a "📂 New session" force-reply → resolve the folder and spawn the session.
    const nsKey = `${ctx.chat?.id}:${replyTo.message_id}`
    if (newSessionReplyTargets.has(nsKey)) {
      newSessionReplyTargets.delete(nsKey)
      if (!dmCommandGate(ctx)) return
      const dir = await resolveNewSessionDir(text)
      const ok = await spawnSession(dir)
      await ctx.reply(ok
        ? `🚀 Starting a new session in <code>${escapeHtml(dir)}</code> — it'll pop up here with a ▶️ Switch button shortly.`
        : `❌ Couldn't start a session in <code>${escapeHtml(dir)}</code> — does that folder exist?`,
        { parse_mode: 'HTML' })
      return
    }
    const ft = freeTextReplyTargets.get(`${ctx.chat?.id}:${replyTo.message_id}`)
    if (ft) {
      freeTextReplyTargets.delete(`${ctx.chat?.id}:${replyTo.message_id}`)
      if (!dmCommandGate(ctx)) return
      if (!activePaneId || !paneWatcher) {
        await ctx.reply('No active Claude Code session with tmux.')
        return
      }
      // The cursor must settle on the "Type something" option before the text is
      // typed — otherwise the field isn't focused and the answer resolves empty
      // (to "__other__"). Settle again after typing so Enter commits the full text.
      await paneWatcher.withInjection(async () => {
        await navigateDown(activePaneId!, ft.downCount)
        await sendKeysLiteral(activePaneId!, text)
        await waitForSettle(activePaneId!, 150, 2000)
        await sendKeys(activePaneId!, ['Enter'])
        await waitForSettle(activePaneId!, 300, 5000)
      })
      lastRelayedPromptHash = ''
      if (ft.tabbed) await handleTabbedAdvance(String(ctx.chat?.id))
      else { await ctx.reply('✅ Sent your answer.'); await verifyPromptClosed() }
      return
    }
  }

  // Reply to a relayed sign-in link → inject the code into the pane (the login
  // input field), not the agent's inbound queue.
  if (replyTo && authUrlMessageIds.has(`${ctx.chat?.id}:${replyTo.message_id}`)) {
    if (!dmCommandGate(ctx)) return
    if (!activePaneId || !paneWatcher) {
      await ctx.reply('No active Claude Code session with tmux.')
      return
    }
    const ok = await injectText(activePaneId, paneWatcher, text)
    await ctx.reply(ok ? '✅ Pasted into the session.' : 'Could not reach the session pane.')
    return
  }

  // Relay unhandled slash commands to CC via tmux (after gate check)
  if (text.startsWith('/') && ctx.chat?.type === 'private') {
    const result = gate(ctx)
    if (result.action !== 'deliver') {
      if (result.action === 'pair') {
        const lead = result.isResend ? 'Still pending' : 'Pairing required'
        await ctx.reply(`🔗 ${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`)
      }
      return
    }
    if (!activePaneId || !paneWatcher) {
      await ctx.reply('No active Claude Code session with tmux.')
      return
    }
    const msgId = ctx.message.message_id
    const chat_id = String(ctx.chat.id)
    // /exit (and /quit) closes the session — confirm with a text reply naming it, not a 👍.
    if (/^\/(exit|quit)\b/i.test(text)) {
      const label = await paneLabel(activePaneId)
      await injectSlash(activePaneId, paneWatcher, text)
      await ctx.reply(`✅ Session <b>${escapeHtml(label)}</b> exited`, { parse_mode: 'HTML' })
      return
    }
    void relaySlashCommand(activePaneId, paneWatcher, text, chat_id, msgId)
    return
  }

  await handleInbound(ctx, text, undefined)
})

bot.on('message:photo', async ctx => {
  const caption = ctx.message.caption ?? '(photo)'
  await handleInbound(ctx, caption, async () => {
    const photos = ctx.message.photo
    const best = photos[photos.length - 1]
    try {
      const file = await ctx.api.getFile(best.file_id)
      if (!file.file_path) return undefined
      const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
      const res = await fetch(url)
      const buf = Buffer.from(await res.arrayBuffer())
      const ext = file.file_path.split('.').pop() ?? 'jpg'
      const path = join(INBOX_DIR, `${Date.now()}-${best.file_unique_id}.${ext}`)
      mkdirSync(INBOX_DIR, { recursive: true })
      writeFileSync(path, buf)
      return path
    } catch (err) {
      process.stderr.write(`daemon: photo download failed: ${err}\n`)
      return undefined
    }
  })
})

bot.on('message:document', async ctx => {
  const doc = ctx.message.document
  const name = safeName(doc.file_name)
  await handleInbound(ctx, ctx.message.caption ?? `(document: ${name ?? 'file'})`, undefined, {
    kind: 'document', file_id: doc.file_id, size: doc.file_size, mime: doc.mime_type, name,
  })
})

bot.on('message:voice', async ctx => {
  const voice = ctx.message.voice
  const fallback = ctx.message.caption ?? '(voice message)'
  await handleInbound(ctx, fallback, undefined,
    { kind: 'voice', file_id: voice.file_id, size: voice.file_size, mime: voice.mime_type },
    () => audioInboundText(ctx, voice.file_id, fallback))
})

bot.on('message:audio', async ctx => {
  const audio = ctx.message.audio
  const name = safeName(audio.file_name)
  const fallback = ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? 'audio'})`
  await handleInbound(ctx, fallback, undefined,
    { kind: 'audio', file_id: audio.file_id, size: audio.file_size, mime: audio.mime_type, name },
    () => audioInboundText(ctx, audio.file_id, fallback))
})

bot.on('message:video', async ctx => {
  const video = ctx.message.video
  await handleInbound(ctx, ctx.message.caption ?? '(video)', undefined, {
    kind: 'video', file_id: video.file_id, size: video.file_size, mime: video.mime_type, name: safeName(video.file_name),
  })
})

bot.on('message:video_note', async ctx => {
  const vn = ctx.message.video_note
  await handleInbound(ctx, '(video note)', undefined, { kind: 'video_note', file_id: vn.file_id, size: vn.file_size })
})

bot.on('message:sticker', async ctx => {
  const sticker = ctx.message.sticker
  await handleInbound(ctx, `(sticker${sticker.emoji ? ` ${sticker.emoji}` : ''})`, undefined, {
    kind: 'sticker', file_id: sticker.file_id, size: sticker.file_size,
  })
})

bot.catch(err => {
  process.stderr.write(`daemon: handler error (polling continues): ${err.error}\n`)
})

// ---- Unix socket server ----

function handleShimConnection(socket: net.Socket): void {
  const write = (msg: DaemonToShim): void => { socket.write(frame(msg)) }
  write({ t: 'hello', version: CODE_FINGERPRINT })

  const reader = makeLineReader<ShimToDaemon>(
    async msg => {
      switch (msg.t) {
        case 'subscribe': {
          const sessionId = msg.paneId ?? `no-tmux-${++noTmuxSeq}`
          let label = msg.paneId ?? 'no-tmux'
          let cwdPath = ''
          if (msg.paneId) {
            try {
              const { stdout } = await exec('tmux', ['display-message', '-p', '-t', msg.paneId, '#{pane_current_path}'], { timeout: 2000 })
              cwdPath = stdout.trim()
              if (cwdPath) label = cwdPath.split('/').filter(Boolean).pop() ?? label
            } catch {}
          }
          sessions.set(sessionId, { socket, write, paneId: msg.paneId, label, subscribedAt: Date.now() })
          const announce = (idx: number) => notifyChats(
            `🆕 New Claude session: <b>Session ${idx}</b>${cwdPath ? ` (<code>${escapeHtml(cwdPath)}</code>)` : ''}`,
            { reply_markup: new InlineKeyboard().text(`♻️ Switch to Session ${idx}`, `switchsession:${idx}`), parse_mode: 'HTML' })

          // Focus it only when nothing valid holds focus (the first/only session, or
          // a reconnect of the focused pane). Otherwise announce — never steal focus.
          // A pinned pane (FORCE_PANE) holds focus regardless.
          const adoptionHolds = adoptedPaneId !== null && activePaneId === adoptedPaneId
          if (FORCE_PANE) {
            process.stderr.write(`daemon: session ${sessionId} registered (focus pinned to ${FORCE_PANE})\n`)
          } else if (adoptionHolds) {
            announce(orderedSessions().findIndex(o => o.id === sessionId) + 1)
          } else if (currentSessionId === null || currentSessionId === sessionId || !sessions.has(currentSessionId)) {
            setFocus(sessionId)
            replayBuffer()
          } else {
            announce(orderedSessions().findIndex(o => o.id === sessionId) + 1)
          }
          break
        }
        case 'call': {
          const callWrite = (response: DaemonToShim) => write(response)
          void handleCall(msg.name, msg.args, callWrite, msg.id)
          break
        }
        case 'permission_request': {
          const { request_id, tool_name, description, input_preview } = msg.params
          permissionOrigin.set(request_id, write)
          const access = loadAccess()
          const permText = formatPermission(tool_name, description, input_preview) + WIDTH_PAD
          const keyboard = new InlineKeyboard()
            .text('✅ Allow', `perm:allow:${request_id}`)
            .text('❌ Deny', `perm:deny:${request_id}`)
            .row()
            .text('💬 Deny & guide', `perm:guide:${request_id}`)
          for (const chat_id of access.allowFrom) {
            void bot.api.sendMessage(chat_id, permText, { parse_mode: 'HTML', reply_markup: keyboard }).catch(e => {
              process.stderr.write(`daemon: permission_request to ${chat_id} failed: ${e}\n`)
            })
          }
          break
        }
      }
    },
    (line, err) => process.stderr.write(`daemon: parse error: ${err} (${line.slice(0, 80)})\n`),
  )

  socket.on('data', reader)

  socket.on('close', () => {
    const entry = [...sessions.entries()].find(([, s]) => s.socket === socket)
    if (entry) endSession(entry[0])
  })

  socket.on('error', () => {})
}

// ---- Single-instance guard ----

async function socketAlive(): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createConnection(SOCKET_PATH)
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
    setTimeout(() => { s.destroy(); resolve(false) }, 1000)
  })
}

async function acquireInstance(): Promise<boolean> {
  try {
    const existingPid = parseInt(readFileSync(DAEMON_PID_FILE, 'utf8'), 10)
    if (existingPid > 1 && existingPid !== process.pid) {
      let processAlive = false
      try { process.kill(existingPid, 0); processAlive = true } catch {}
      if (processAlive && await socketAlive()) {
        process.stderr.write(`telegram daemon: another instance running (pid=${existingPid}), exiting\n`)
        return false
      }
    }
  } catch {}

  // Take over: clean up stale socket. PID file written after listen() succeeds.
  try { unlinkSync(SOCKET_PATH) } catch {}
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  return true
}

// ---- Shutdown ----

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('telegram daemon: shutting down\n')
  if (paneWatcher) paneWatcher.stop()
  try {
    if (parseInt(readFileSync(DAEMON_PID_FILE, 'utf8'), 10) === process.pid) unlinkSync(DAEMON_PID_FILE)
  } catch {}
  try { unlinkSync(SOCKET_PATH) } catch {}
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(bot.stop()).finally(() => process.exit(0))
}

// Daemon shuts down on SIGTERM/SIGINT only — never on stdin EOF.
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

process.on('unhandledRejection', err => process.stderr.write(`daemon: unhandled rejection: ${err}\n`))
process.on('uncaughtException', err => process.stderr.write(`daemon: uncaught exception: ${err}\n`))

// ---- Main ----

if (!(await acquireInstance())) process.exit(0)

// Set umask before listen so the socket file is created 0o600 from the start,
// closing the window between bind and chmodSync.
process.umask(0o077)

const server = net.createServer(handleShimConnection)

await new Promise<void>((resolve, reject) => {
  server.listen(SOCKET_PATH, () => {
    // PID written after listen succeeds — prevents TOCTOU race with concurrent spawns.
    writeFileSync(DAEMON_PID_FILE, String(process.pid), { mode: 0o600 })
    process.stderr.write(`telegram daemon: listening on ${SOCKET_PATH}\n`)
    resolve()
  })
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`daemon: socket already in use — another daemon won the race, exiting\n`)
      process.exit(0)
    }
    process.stderr.write(`daemon: socket server error: ${err}\n`)
    reject(err)
  })
})

// Off-MCP standalone: pin focus to the configured pane so transcript-outbound can drive
// a plugin-less session immediately, without waiting for a shim subscribe.
if (FORCE_PANE) {
  currentSessionId = FORCE_PANE
  activePaneId = FORCE_PANE
  startPaneWatcher(FORCE_PANE)
  startRelayLoop()
  process.stderr.write(`daemon: focus pinned to ${FORCE_PANE} (TELEGRAM_FORCE_PANE)\n`)
} else if (TRANSCRIPT_OUTBOUND) {
  // Off-MCP with no pinned pane: find and adopt a plugin-less work session on our own,
  // then keep watching so a session started later (or restarted) gets picked up — siblings
  // are announced with a switch button rather than stealing focus.
  void discoverPanes()
  setInterval(() => void discoverPanes(), 30_000)
  setInterval(() => void checkCrossSessionUnread(), 4_000)   // ping unread in unfocused sessions
}

// Make the `tg` CLI + ensure-daemon launcher available to plugin-less sessions, no setup.
provisionOffMcpTooling()

// Re-arm any persisted usage-limit reset reminder across the restart.
loadScheduledReset()

// ---- Bot startup loop (retry with backoff, daemon persists forever) ----

void (async () => {
  let networkErrors = 0
  for (;;) {
    try {
      await bot.start({
        onStart: info => {
          networkErrors = 0
          botUsername = info.username
          process.stderr.write(`telegram daemon: polling as @${info.username}\n`)
          void bot.api.setMyCommands(
            [
              { command: 'start', description: 'Welcome + everything this bot can do' },
              { command: 'dock', description: 'Show the docked control bar (/dock off to hide)' },
              { command: 'stop', description: 'Interrupt the current task (Esc)' },
              { command: 'model', description: 'Show the current model (or /model <name> to switch)' },
              { command: 'mode', description: 'Interactive mode switcher' },
              { command: 'sessions', description: 'List sessions (/sessions # switch, /sessions name # label)' },
              { command: 'resume', description: 'Resume a recent session (lists them with times)' },
              { command: 'new', description: 'Start a fresh conversation' },
              { command: 'terminal', description: 'Show recent terminal activity (/terminal [N] lines)' },
              { command: 'cost', description: 'Show the session cost readout' },
              { command: 'context', description: 'Show the token-context usage' },
              { command: 'compact', description: 'Compact the conversation to free up context' },
              { command: 'autocontinue', description: 'Auto-send "continue" when the limit resets (on/off)' },
              { command: 'pin', description: 'Toggle the pinned status message (on/off)' },
              { command: 'status', description: 'Check your pairing status' },
            ],
            { scope: { type: 'all_private_chats' } },
          ).catch(() => {})
        },
      })
      return  // only reached on clean bot.stop()
    } catch (err) {
      if (shuttingDown) return
      if (err instanceof Error && err.message === 'Aborted delay') return
      if (err instanceof GrammyError && err.error_code === 409) {
        // Another process holds the token — keep retrying, don't exit.
        process.stderr.write(`daemon: 409 Conflict (another poller holds the token), retrying in 5s\n`)
        await new Promise(r => setTimeout(r, 5000))
      } else {
        networkErrors++
        const delay = Math.min(1000 * networkErrors, 15000)
        process.stderr.write(`daemon: polling error: ${err}, retrying in ${delay / 1000}s\n`)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }
})()
