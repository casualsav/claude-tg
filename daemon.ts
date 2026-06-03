#!/usr/bin/env bun
import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from 'grammy'
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
import { detectUserPrompt, stripAnsi, type PromptInfo, type PromptOption } from './prompt.ts'

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
const pendingPermissions = new Map<string, { tool_name: string; description: string; input_preview: string }>()

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
  private working = false
  private sawWorking = false
  private optimisticUntil = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private static readonly CAP_MS = 15 * 60_000
  private static readonly TICK_MS = 4_000
  private static readonly OPTIMISTIC_MS = 8_000

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
    if (!this.timer) this.timer = setInterval(() => this.tick(), TypingPresence.TICK_MS)
  }

  // Fresh working state from each pane change.
  update(working: boolean): void {
    this.working = working
    if (working) this.sawWorking = true
    else if (this.sawWorking) this.clearAll()   // worked, now idle → turn done
  }

  private active(): boolean {
    return this.working || Date.now() < this.optimisticUntil
  }

  private tick(): void {
    const now = Date.now()
    for (const [chat, exp] of this.targets) if (exp < now) this.targets.delete(chat)
    if (this.targets.size === 0) { this.stop(); return }
    if (this.active()) {
      for (const chat of this.targets.keys()) this.ping(chat)
    } else if (!this.sawWorking) {
      this.clearAll()   // optimistic window elapsed, no work ever seen → give up
    }
  }

  private clearAll(): void {
    this.targets.clear()
    this.sawWorking = false
    this.working = false
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

function hashText(s: string): string {
  return createHash('md5').update(s).digest('hex')
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
  const footer = lines.slice(-5).join(' ').toLowerCase()
  if (/bypass|dangerously.?skip|yolo/i.test(footer)) return 'bypassPermissions'
  if (/\bplan\s*(mode)?\b/i.test(footer)) return 'plan'
  if (/\bauto\b/i.test(footer)) return 'auto'
  if (/accept.?edit/i.test(footer)) return 'acceptEdits'
  return 'default'
}

// Pull the active model out of a /model picker capture. Prefers an explicit
// "current/active model" marker, then a "(current)" suffix, then the cursor-
// highlighted row (the picker opens with the cursor on the model in use).
function parseCurrentModel(pickerText: string): string | null {
  const clean = (s: string) =>
    s.replace(/^[│>\s]+/, '').replace(/[│\s]+$/, '')
     .replace(/^\d+[.)]\s*/, '').replace(/^[✔✓☑●◉❯►▶]\s*/, '')
     .replace(/\s*\((?:current|active|in use|recommended)\)\s*$/i, '').trim()
  const lines = pickerText.split('\n').map(l => stripAnsi(l))
  for (const l of lines) {
    const m = l.match(/(?:current|active)\s*model\s*[:\-]?\s*(.+)/i)
    if (m) { const v = clean(m[1]); if (v) return v }
    const c = l.match(/(.+?)\s*\((?:current|active|in use)\)/i)
    if (c) { const v = clean(c[1]); if (v) return v }
  }
  for (const l of lines) {
    const m = l.match(/^[\s│]*[❯►▶]\s*(.+)$/)
    if (m) { const v = clean(m[1]); if (v) return v }
  }
  return null
}

// Read the active model by briefly opening the /model picker, reading the marked
// entry, then dismissing it with Esc. withInjection pauses the watcher (so the
// picker is never relayed as buttons) and re-baselines it on exit.
async function readCurrentModel(paneId: string, watcher: PaneWatcher): Promise<string | null> {
  return watcher.withInjection(async () => {
    if (!(await sendKeys(paneId, ['/model', 'Enter']))) return null
    await waitForSettle(paneId, 200, 4000)
    const text = await capturePane(paneId)
    await sendKeys(paneId, ['Escape'])
    await waitForSettle(paneId, 200, 3000)
    return parseCurrentModel(text)
  })
}

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

// Tracks the last prompt sent to Telegram to avoid double-relay.
let lastRelayedPromptHash = ''

// In-flight multi-select prompts, keyed by `${chatId}:${messageId}` of the relayed
// Telegram message. Each tap toggles an index in `selected`; Submit replays the
// selection into the pane as Space/Down keystrokes. Cleared on submit.
type PendingMultiSelect = { paneId: string; options: PromptOption[]; selected: Set<number> }
const pendingMultiSelect = new Map<string, PendingMultiSelect>()

// Auth/login URLs surfaced from the pane (e.g. /login's OAuth link), so the user
// can open them in a browser and reply with the code. `lastRelayedAuthUrl` dedups
// the same link across watcher ticks; `authUrlMessageIds` (`${chatId}:${msgId}`)
// marks the relayed messages so a Telegram reply to one is injected into the pane.
let lastRelayedAuthUrl = ''
const authUrlMessageIds = new Set<string>()

function shimWrite(msg: DaemonToShim): void {
  if (activeShim) activeShim.write(msg)
}

function emitInbound(params: InboundParams): void {
  if (activeShim) {
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

function replayBuffer(write: (msg: DaemonToShim) => void): void {
  // Truncate first so new events buffer fresh; deliver from in-memory copy.
  // If delivery fails mid-replay, those events are lost but the file stays clean.
  let lines: string[] = []
  try {
    lines = readFileSync(PENDING_EVENTS_FILE, 'utf8').split('\n').filter(l => l.trim())
    writeFileSync(PENDING_EVENTS_FILE, '', { mode: 0o600 })
  } catch { return }
  for (const line of lines) {
    try { write(JSON.parse(line) as DaemonToShim) } catch {}
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

function onPaneEvent(text: string): void {
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

  const prompt = detectUserPrompt(text)
  if (!prompt) return
  const h = hashText(prompt.question + '|' + prompt.options.map(o => o.label).join('|'))
  if (h === lastRelayedPromptHash) return
  lastRelayedPromptHash = h
  void relayPromptToTelegram(prompt)
}

// Render a prompt as Telegram HTML: bold question, then each numbered option with
// its description (if any) as a blockquote beneath it.
function renderPromptHtml(prompt: PromptInfo): string {
  const lines = [`❓ <b>${escapeHtml(prompt.question)}</b>`]
  if (prompt.multiSelect) lines.push('<i>Pick one or more, then tap ✅ Submit.</i>')
  lines.push('')
  prompt.options.forEach((opt, i) => {
    lines.push(`<b>${i + 1}.</b> ${escapeHtml(opt.label)}`)
    if (opt.description) lines.push(`<blockquote>${escapeHtml(opt.description)}</blockquote>`)
  })
  return lines.join('\n')
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

async function relayPromptToTelegram(prompt: PromptInfo): Promise<void> {
  const access = loadAccess()
  const targets = access.allowFrom
  if (targets.length === 0) return

  const text = renderPromptHtml(prompt)

  for (const chat_id of targets) {
    try {
      if (prompt.multiSelect && activePaneId) {
        const selected = new Set<number>()
        const sent = await bot.api.sendMessage(chat_id, text, {
          parse_mode: 'HTML',
          reply_markup: multiSelectKeyboard(prompt.options, selected),
        })
        pendingMultiSelect.set(`${chat_id}:${sent.message_id}`, {
          paneId: activePaneId, options: prompt.options, selected,
        })
      } else {
        const keyboard = new InlineKeyboard()
        prompt.options.forEach((_, i) => {
          keyboard.text(String(i + 1), `prompt:${i + 1}`)
          if ((i + 1) % 3 === 0) keyboard.row()
        })
        await bot.api.sendMessage(chat_id, text, { parse_mode: 'HTML', reply_markup: keyboard })
      }
    } catch (e) {
      process.stderr.write(`daemon: prompt relay to ${chat_id} failed: ${e}\n`)
    }
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
      activePaneId = null
      paneWatcher = null
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

async function relaySlashCommand(
  paneId: string,
  watcher: PaneWatcher,
  command: string,
  chat_id: string,
  message_id: number,
): Promise<void> {
  await watcher.withInjection(async () => {
    await sendKeys(paneId, [command, 'Enter'])
    await waitForSettle(paneId, 300, 30_000)
  })
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
}

// ---- Telegram bot handlers ----

bot.command('start', async ctx => {
  if (!dmCommandGate(ctx)) return
  await ctx.reply(
    `🔗 This bot bridges Telegram to a Claude Code session.\n\n` +
    `To pair:\n1. DM me anything — you'll get a 6-char code\n` +
    `2. In Claude Code: /telegram:access pair <code>\n\nAfter that, DMs here reach that session.`
  )
})

bot.command('help', async ctx => {
  if (!dmCommandGate(ctx)) return
  await ctx.reply(
    `Messages you send here route to a paired Claude Code session.\n\n` +
    `/start — pairing instructions\n/status — check your pairing state\n` +
    `/mode — interactive mode switcher\n` +
    `/plan, /auto, /default, /acceptedits, /bypass — quick mode switch\n` +
    `/stop — interrupt the current task (Esc)\n` +
    `/reply <response> — type a response into the session (e.g. a /login code)\n` +
    `/model — show the current model (or /model <name> to switch)\n\n` +
    `Any other /slash commands are relayed directly to Claude Code.`
  )
})

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

bot.command('mode', async ctx => {
  const gated = dmCommandGate(ctx)
  if (!gated) return
  if (!activePaneId) {
    await ctx.reply('No active Claude Code session with tmux.')
    return
  }
  const current = detectCurrentMode(await capturePane(activePaneId))
  const keyboard = new InlineKeyboard().text(modeLabel(current), 'mode:cycle')
  await ctx.reply('Choose mode:', { reply_markup: keyboard })
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
bot.command('reply', async ctx => {
  if (!dmCommandGate(ctx)) return
  if (!activePaneId || !paneWatcher) {
    await ctx.reply('No active Claude Code session with tmux.')
    return
  }
  const text = (ctx.match ?? '').toString()
  if (!text.trim()) {
    await ctx.reply('Usage: /reply <response> — types the text into the session, then Enter.')
    return
  }
  const ok = await injectText(activePaneId, paneWatcher, text)
  await ctx.reply(ok ? '✅ Sent to the session.' : 'Could not reach the session pane.')
})

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
  const model = await readCurrentModel(activePaneId, paneWatcher)
  await ctx.reply(
    model
      ? `🧠 Current model: <b>${escapeHtml(model)}</b>`
      : 'Could not determine the current model. Use /model &lt;name&gt; to switch.',
    { parse_mode: 'HTML' },
  )
})

// Interrupt the current turn by sending Esc to the pane (same as pressing Esc
// in the TUI). withInjection pauses the watcher and re-baselines afterward so
// the resulting pane change isn't mistaken for a new prompt/event.
bot.command('stop', async ctx => {
  if (!dmCommandGate(ctx)) return
  if (!activePaneId || !paneWatcher) {
    await ctx.reply('No active Claude Code session with tmux.')
    return
  }
  const ok = await paneWatcher.withInjection(() => sendKeys(activePaneId!, ['Escape']))
  await ctx.reply(ok ? '🛑 Sent interrupt (Esc) to Claude Code.' : 'Could not reach the session pane.')
})

// Inline-button handler for permission requests + mode cycling + prompt answers.
bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data

  // Mode cycle button
  if (data === 'mode:cycle') {
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
    await ctx.answerCallbackQuery().catch(() => {})
    await paneWatcher.withInjection(async () => {
      await sendKeys(activePaneId!, ['BTab'])
      await waitForSettle(activePaneId!, 300, 5000)
    })
    const newModeText = await capturePane(activePaneId)
    const newMode = detectCurrentMode(newModeText)
    const keyboard = new InlineKeyboard().text(modeLabel(newMode), 'mode:cycle')
    await ctx.editMessageText('Choose mode:', { reply_markup: keyboard }).catch(() => {})
    return
  }

  // Prompt answer buttons
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
    const keys: string[] = []
    state.options.forEach((_, i) => {
      if (state.selected.has(i)) keys.push('Space')
      if (i < state.options.length - 1) keys.push('Down')
    })
    keys.push('Enter')
    await ctx.answerCallbackQuery({ text: `Submitted ${state.selected.size} selected` }).catch(() => {})
    await paneWatcher.withInjection(async () => {
      await sendKeys(activePaneId!, keys)
      await waitForSettle(activePaneId!, 300, 5000)
    })
    pendingMultiSelect.delete(key)
    lastRelayedPromptHash = ''  // allow next prompt to relay
    await ctx.editMessageReplyMarkup().catch(() => {})  // drop the keyboard once answered
    return
  }

  // Permission buttons
  const permMatch = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(data)
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

  if (behavior === 'more') {
    const details = pendingPermissions.get(request_id)
    if (!details) {
      await ctx.answerCallbackQuery({ text: 'Details no longer available.' }).catch(() => {})
      return
    }
    const { tool_name, description, input_preview } = details
    let prettyInput: string
    try { prettyInput = JSON.stringify(JSON.parse(input_preview), null, 2) } catch { prettyInput = input_preview }
    const expanded =
      `🔐 Permission: ${tool_name}\n\ntool_name: ${tool_name}\ndescription: ${description}\ninput_preview:\n${prettyInput}`
    const keyboard = new InlineKeyboard()
      .text('✅ Allow', `perm:allow:${request_id}`)
      .text('❌ Deny', `perm:deny:${request_id}`)
    await ctx.editMessageText(expanded, { reply_markup: keyboard }).catch(() => {})
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }

  // Send permission result back to active shim (which forwards to Claude).
  shimWrite({ t: 'permission', params: { request_id, behavior: behavior as 'allow' | 'deny' } })
  pendingPermissions.delete(request_id)
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
    shimWrite({
      t: 'permission',
      params: {
        request_id: permMatch[2]!.toLowerCase(),
        behavior: permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
      },
    })
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

  const params: InboundParams = {
    content,
    meta: {
      chat_id,
      ...(msgId != null ? { message_id: String(msgId) } : {}),
      user: from.username ?? String(from.id),
      user_id: String(from.id),
      ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
      ...(imagePath ? { image_path: imagePath } : {}),
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

  // Reply to a relayed sign-in link → inject the code into the pane (the login
  // input field), not the agent's inbound queue.
  const replyTo = ctx.message.reply_to_message
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
          // Detach previous shim (last-subscriber-wins)
          if (activeShim) {
            try { activeShim.write({ t: 'detached' }) } catch {}
          }
          if (paneWatcher) { paneWatcher.stop(); paneWatcher = null }

          activeShim = { socket, write }

          if (msg.paneId) {
            activePaneId = msg.paneId
            startPaneWatcher(msg.paneId)
          }

          replayBuffer(write)
          break
        }
        case 'call': {
          const callWrite = (response: DaemonToShim) => write(response)
          void handleCall(msg.name, msg.args, callWrite, msg.id)
          break
        }
        case 'permission_request': {
          const { request_id, tool_name, description, input_preview } = msg.params
          pendingPermissions.set(request_id, { tool_name, description, input_preview })
          const access = loadAccess()
          const permText = `🔐 Permission: ${tool_name}`
          const keyboard = new InlineKeyboard()
            .text('See more', `perm:more:${request_id}`)
            .text('✅ Allow', `perm:allow:${request_id}`)
            .text('❌ Deny', `perm:deny:${request_id}`)
          for (const chat_id of access.allowFrom) {
            void bot.api.sendMessage(chat_id, permText, { reply_markup: keyboard }).catch(e => {
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
    if (activeShim?.socket === socket) {
      activeShim = null
      // Keep paneWatcher alive — daemon persists between sessions
    }
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
              { command: 'start', description: 'Welcome and setup guide' },
              { command: 'help', description: 'What this bot can do' },
              { command: 'status', description: 'Check your pairing status' },
              { command: 'mode', description: 'Interactive mode switcher' },
              { command: 'plan', description: 'Switch to plan mode' },
              { command: 'auto', description: 'Switch to auto mode' },
              { command: 'default', description: 'Switch to default mode' },
              { command: 'acceptedits', description: 'Switch to accept-edits mode' },
              { command: 'bypass', description: 'Switch to bypass-permissions mode' },
              { command: 'stop', description: 'Interrupt the current task (Esc)' },
              { command: 'reply', description: 'Type a response into the session (e.g. a /login code)' },
              { command: 'model', description: 'Show the current model (or /model <name> to switch)' },
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
