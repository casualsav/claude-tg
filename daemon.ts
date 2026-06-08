#!/usr/bin/env bun
import { Bot, GrammyError, InlineKeyboard, Keyboard, InputFile, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { randomBytes, createHash } from 'node:crypto'
import {
  readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, rmSync,
  statSync, renameSync, realpathSync, chmodSync, unlinkSync, existsSync, openSync, closeSync, copyFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, extname, basename, sep } from 'node:path'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import net from 'node:net'
import {
  frame, makeLineReader, computeCodeFingerprint,
  STATE_DIR, ACCESS_FILE, APPROVED_DIR, ENV_FILE, INBOX_DIR,
  SOCKET_PATH, DAEMON_PID_FILE, PENDING_EVENTS_FILE,
  DAEMON_LOG_FILE, WATCHDOG_PID_FILE, HEARTBEAT_FILE,
  type ShimToDaemon, type DaemonToShim, type InboundParams,
} from './common.ts'

// Code fingerprint captured at startup; sent to shims so they can detect and
// replace a daemon left running stale code after a plugin upgrade.
const CODE_FINGERPRINT = computeCodeFingerprint(import.meta.dir)
import { mdToTelegramHtml, chunkHtml, escapeHtml } from './markdown.ts'
import { detectUserPrompt, detectPermissionPrompt, isSubmitScreen, stripAnsi, type PromptInfo, type PromptOption, type PermissionPrompt } from './prompt.ts'
import { resolveTranscript, latestFinalReply, finalRepliesAfter, textEntriesAfter, turnInProgress, currentTurnActivity, currentTurnFeed, listRecentSessions, findSessionCwd, type Activity, type FeedItem } from './transcript.ts'

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
  replyMode?: 'all' | 'final' | 'hybrid' | 'stream' | 'live'   // stream/live are legacy aliases
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
      replyMode: parsed.replyMode,
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

// Off-MCP token saver: DM inbound blocks no longer carry `c` (the chat id is constant for the
// sole allowlisted user — printing it every message just wastes context). So deliberate actions
// may pass `.` (or nothing) as the chat and we resolve it to that single allowlisted chat here.
// Groups still pass an explicit id. assertAllowedChat validates the result either way.
function resolveChatId(raw: unknown): string {
  const s = (raw == null ? '' : String(raw)).trim()
  if (s && s !== '.') return s
  const allow = loadAccess().allowFrom
  if (allow.length === 1) return allow[0]
  throw new Error(s ? `chat "${s}" not resolvable` : 'no chat id given and not exactly one allowlisted chat')
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
// Telegram's "typing…" chat action auto-expires after ~5s, so to keep it lit for a whole
// turn we re-send it every few seconds while Claude is working. The signal is a single
// "keep-alive window": observe(true) — fed every pane poll (~800ms) by the live
// `esc to interrupt` footer — pushes the window out; a steady ping timer re-sends typing
// while the window is open and falls silent (so Telegram clears it) once work stops.
//
// This is self-correcting by construction: the ping timer always runs, gated only on the
// window, so it can never get stuck on (work ends → window lapses → ~GRACE+5s tail) or
// stuck off (work seen → window reopens → typing resumes). No optimistic/dead-timer edge cases.
class TypingPresence {
  private chats = new Set<string>()             // chats that have messaged — where typing shows
  private workingUntil = 0                      // keep pinging until this time
  private timer: ReturnType<typeof setInterval> | null = null
  private static readonly PING_MS = 4_000       // < Telegram's ~5s expiry, so typing stays solid
  private static readonly GRACE_MS = 5_000      // bridge brief gaps (tool boundaries / inject pauses)

  private pingAll(): void {
    for (const chat of this.chats) void bot.api.sendChatAction(chat, 'typing').catch(() => {})
  }
  private ensureTimer(): void {
    if (!this.timer) this.timer = setInterval(() => { if (Date.now() < this.workingUntil) this.pingAll() }, TypingPresence.PING_MS)
  }

  // An inbound message was relayed — show presence immediately (work almost always follows),
  // and remember this chat so the indicator lands where the conversation is.
  arm(chat_id: string): void {
    this.chats.add(chat_id)
    this.workingUntil = Date.now() + TypingPresence.GRACE_MS
    this.pingAll()
    this.ensureTimer()
  }

  // Live working state from each pane poll. Working extends the keep-alive window; not-working
  // does nothing — the window simply lapses, which is what stops the indicator when done.
  observe(working: boolean): void {
    if (working) { this.workingUntil = Date.now() + TypingPresence.GRACE_MS; this.ensureTimer() }
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
    private onPoll?: (text: string) => void,   // every tick (even when unchanged) — drives typing
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
    this.onPoll?.(text)                 // every poll — a live working signal even when static
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

// ---- First-run onboarding driver ----
// Walk Claude Code's setup (theme · folder trust · login) from Telegram instead of punting to
// the terminal. Only ever runs on a freshly adopted pane that has NEVER reached the REPL
// (onboardedPanes), so a genuine AskUserQuestion is never mistaken for a setup screen.
const onboardedPanes = new Set<string>()
const onboardingState = { tag: '', at: 0 }   // debounce: a screen repaints many times per second
let loginChoiceSent = false

// Which onboarding screen the pane is showing, or null. Theme is only matched with a live select
// footer so "theme" in ordinary output can't trigger it; trust/enter are distinctive enough alone.
function classifyOnboarding(cap: string): 'login' | 'theme' | 'trust' | 'enter' | null {
  const low = cap.toLowerCase()
  const isSelect = /enter to select|↑\/↓|to navigate/.test(low)
  if (isSelect && /select login method|log in with|claude account|anthropic console|with your api key/.test(low)) return 'login'
  if (/do you trust|trust the files|trust this folder/.test(low)) return 'trust'
  if (isSelect && /(text style|dark mode|light mode|color theme|choose .*theme)/.test(low)) return 'theme'
  if (/press enter to continue|enter to continue/.test(low)) return 'enter'
  return null
}

// Offer the login method as buttons — the one step we don't auto-pick (subscription opens an
// OAuth link we can relay; an API key must be typed in the terminal, never over Telegram).
function relayLoginChoice(): void {
  if (loginChoiceSent) return
  loginChoiceSent = true
  const kb = new InlineKeyboard().text('🔐 Subscription (claude.ai)', 'login:sub').row().text('🔑 API key (console)', 'login:api')
  notifyChats('🔐 Claude needs to log in. How do you sign in?', { reply_markup: kb })
}

async function driveOnboarding(paneId: string, stage: 'login' | 'theme' | 'trust' | 'enter'): Promise<void> {
  if (onboardingState.tag === stage && Date.now() - onboardingState.at < 4000) return   // same screen, just repainting
  onboardingState.tag = stage
  onboardingState.at = Date.now()
  if (stage === 'login') { relayLoginChoice(); return }
  // theme / trust / enter → accept the highlighted default. Drive through the watcher so the
  // relay loop doesn't misread the keystroke as activity.
  process.stderr.write(`daemon: onboarding auto-advance (${stage})\n`)
  if (paneWatcher) await paneWatcher.withInjection(async () => { await sendKeys(paneId, ['Enter']); await waitForSettle(paneId, 200, 3000) })
  else await sendKeys(paneId, ['Enter'])
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
  // Spinner glyph followed by an elapsed timer: "(12s", "(3m 56s", "(1h 2m" — any h/m/s unit.
  // (The old /\(\d+s/ missed minute-format timers, so long turns read as idle and relayed
  // mid-turn fragments.)
  if (/[✢✳✶✻✽✺✷✸✹·●◐◓◑◒][^\n]*\(\d+\s*[hms]/.test(footer)) return true
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

// Remove a session. If it was the focused one, drop focus entirely — we no longer auto-switch
// to another session; the user picks from the session-exit menu (announceFocusedExit).
function dropSession(sessionId: string): void {
  if (!sessions.delete(sessionId)) return
  if (currentSessionId === sessionId) setFocus(null)
}

// End a registered session (its socket closed or pane died); if it was focused, offer the
// switch menu rather than silently moving focus.
function endSession(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (!s) return
  const wasFocused = currentSessionId === sessionId
  dropSession(sessionId)
  if (wasFocused) void announceFocusedExit(s.label)
}

// The focused session just ended. Offer a switch menu over whatever's left (no auto-switch),
// or note that nothing remains. Off-MCP and registered sessions both surface via sessionRows.
async function announceFocusedExit(endedLabel: string): Promise<void> {
  const rows = await sessionRows()
  if (rows.length === 0) {
    notifyChats(`🔚 Session “${endedLabel}” ended — no active sessions left.`)
    return
  }
  notifyChats('🔚 Current session ended — switch sessions?', { reply_markup: sessionSwitchKeyboard(rows) })
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

// Build the inbound block the agent reads. Bare minimum, short aliases — it lives in the
// session's context, so every dropped field is saved tokens: tag name encodes the source,
// `c`=chat_id (for the tg CLI), `m`=message_id (for react/reply). The sender `u` is kept only
// for groups (chat_id ≠ user_id) where attribution matters; `img`/`att` are local file paths
// to Read. user_id / ts are dropped entirely. (off-mcp/CLAUDE.md documents this shape.)
function formatChannelBlock(params: InboundParams): string {
  const m = params.meta
  const esc = (v: string) => v.replace(/"/g, '&quot;')
  const a: string[] = []
  // DM (chat_id == user_id): omit c — it's the same id every message, so it's pure token waste.
  // Deliberate actions (tg send/react/edit) default to the sole allowlisted chat (accept `.`).
  // Groups keep c so the agent targets the right chat.
  const isDm = !!m.user_id && m.chat_id === m.user_id
  if (m.chat_id && !isDm) a.push(`c="${esc(m.chat_id)}"`)
  if (m.message_id) a.push(`m="${esc(m.message_id)}"`)
  if (m.user && m.user_id && m.chat_id !== m.user_id) a.push(`u="${esc(m.user)}"`)   // group → keep sender
  if (m.image_path) a.push(`img="${esc(m.image_path)}"`)
  if (m.attachment_path) a.push(`att="${esc(m.attachment_path)}"`)
  return `<tg ${a.join(' ')}>${params.content}</tg>`
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
try { const vs = readdirSync(base).filter(v => /^\\d+\\.\\d+\\.\\d+$/.test(v)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })); for (const v of vs.reverse()) { const p = join(base, v, 'ensure-daemon.ts'); if (existsSync(p)) { t = p; break } } } catch {}
if (t) await import(t)
`, { mode: 0o755 })
    process.stderr.write(`daemon: provisioned off-mcp tooling (tg CLI${binDir ? ` → ${binDir}` : ' — no bin dir'}, ensure-daemon)\n`)
  } catch (e) { process.stderr.write(`daemon: off-mcp provision failed: ${e}\n`) }
}

// Kick off a self-update. update.ts rebuilds the cache dir we run from and restarts us, so it
// must outlive this process: copy it to a stable spot outside the cache and spawn it DETACHED.
// `mode` is 'apply' (pull + rebuild + restart, with rollback) or 'check' (report only). All
// progress + the result are DM'd by update.ts to `chatId`.
function startUpdate(chatId: string, mode: 'apply' | 'check'): { ok: boolean; error?: string } {
  try {
    const src = join(import.meta.dir, 'update.ts')
    if (!existsSync(src)) return { ok: false, error: 'update.ts not found in plugin cache' }
    const runner = join(STATE_DIR, 'update-run.ts')
    copyFileSync(src, runner)
    const log = openSync(DAEMON_LOG_FILE, 'a')
    const child = spawn('bun', [runner, chatId, mode], { detached: true, stdio: ['ignore', log, log], env: process.env })
    child.unref()
    process.stderr.write(`daemon: started self-update (${mode}) pid ${child.pid}\n`)
    return { ok: true }
  } catch (e) { return { ok: false, error: String(e) } }
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

// How Claude's text reaches Telegram. Default 'hybrid'.
//   'all'    — every thought block as its own message, no tool mirror, plus the conclusion.
//   'final'  — only the turn's conclusion block(s) + the live tool-use mirror.
//   'hybrid' — one silent self-editing card (live thoughts + tool use), plus the conclusion
//              block(s) as real messages. (Legacy values stream→all, live→hybrid.)
function replyMode(): 'all' | 'final' | 'hybrid' {
  const v = loadAccess().replyMode as string | undefined
  if (v === 'all' || v === 'stream') return 'all'
  if (v === 'final') return 'final'
  return 'hybrid'
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
// name + input, so richer rendering here is entirely free (no model calls). Emoji set aligned
// with the Hermes tool_progress registry where it maps to Claude Code's actual tools.
const TOOL_BADGE: Record<string, [string, string]> = {
  // Existing badges — unchanged.
  Bash: ['💻', 'terminal'], TodoWrite: ['📋', 'todo'],
  Read: ['📖', 'read'], Edit: ['✏️', 'edit'], MultiEdit: ['✏️', 'edit'], Write: ['📝', 'write'],
  Grep: ['🔍', 'search'], Glob: ['🔍', 'find'], LS: ['📂', 'list'],
  WebFetch: ['🌐', 'fetch'], WebSearch: ['🌐', 'search'], Task: ['🤖', 'agent'],
  NotebookEdit: ['📓', 'notebook'],
  // New (no clash with the above): background processes, clarify, plan, skill.
  BashOutput: ['⚙️', 'process'], KillShell: ['⚙️', 'process'], KillBash: ['⚙️', 'process'],
  AskUserQuestion: ['❓', 'clarify'], ExitPlanMode: ['📐', 'plan'], Skill: ['📚', 'skill'],
}
function toolBadge(tool: string): [string, string] {
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

// Hybrid card: the current turn's narration + tool calls interleaved (transcript-driven, so no
// pane scraping), the latest few items. Text shows as a 💭 thought line; tools keep their badge.
const MIRROR_FEED = 9        // hybrid: max interleaved items shown
function renderHybridMirror(feed: FeedItem[], done: boolean): string {
  const lines: string[] = []
  for (const it of feed.slice(-MIRROR_FEED)) {
    if (it.kind === 'text') {
      const t = it.text.replace(/\s+/g, ' ').trim()
      // Test (reversible): thoughts rendered plain, not italic — wrap in <i>…</i> to revert.
      lines.push(`💭 ${escapeHtml(t.length > 160 ? t.slice(0, 159) + '…' : t)}`)
    } else {
      const [emoji, label] = toolBadge(it.tool)
      const d = it.detail ? `: <code>${escapeHtml(it.detail)}</code>` : ''
      lines.push(`${emoji} ${label}${d}`)
    }
  }
  if (done) lines.push(`✅ <b>Done</b>`)
  return lines.join('\n').slice(0, 3500)
}

// The mirror text for the active mode, or null when there's nothing to show yet. All of it is
// built from the transcript — no pane scraping — so it can't drop or garble blocks.
//   all    → no card (every block goes out as its own message).
//   hybrid → narration + tool calls interleaved (the thought stream the user asked for).
//   final  → the tool-use feed (or, opt-in, the legacy pane digest; none if terminalMirror=off).
async function buildMirrorText(done: boolean): Promise<string | null> {
  const mode = replyMode()
  if (mode === 'all') return null
  const cwd = activePaneId ? await paneCwd(activePaneId) : null
  const file = cwd ? resolveTranscript(cwd) : null
  if (mode === 'hybrid') {
    const feed = file ? currentTurnFeed(file) : []
    return feed.length ? renderHybridMirror(feed, done) : null
  }
  // final
  if (mirrorMode() === 'off') return null
  if (mirrorMode() === 'digest') {
    const raw = await mirrorCapture()
    return raw ? renderDigestMirror(raw, done) : null
  }
  const acts = file ? currentTurnActivity(file) : []
  return acts.length ? renderToolsMirror(acts, done) : null
}

// The card's whole lifecycle lives here, driven by one signal — `working` = turnInProgress(file)
// from the transcript. While the turn runs we open the card once and edit it in place; the
// instant the turn settles (working false) we cap it (✅ Done) and clear it. Nothing else opens
// or closes the card, so there's no create/finalize ping-pong (the cause of the re-send storm:
// the pane-idle backstop fought turnInProgress on this bridged pane, which never shows the
// "esc to interrupt" footer). Idempotent: repeated not-working ticks are a no-op once cleared.
async function updateTerminalMirror(working: boolean): Promise<void> {
  const mode = replyMode()
  // all → never a card. final+terminalMirror:off → no card.
  if (mode === 'all' || (mode === 'final' && mirrorMode() === 'off')) { if (mirrorMsgIds.size) await finalizeTerminalMirror(); return }

  if (!working) { if (mirrorMsgIds.size) await finalizeTerminalMirror(); return }   // turn settled → cap the card once

  const text = await buildMirrorText(false)
  if (!text) return
  const now = Date.now()
  if (mirrorMsgIds.size === 0) {
    // The card always streams silently in both final and hybrid — it's the ambient mirror; the
    // alerting message is the conclusion relayed at turn end.
    mirrorLastText = text; mirrorLastEditAt = now
    for (const chat of loadAccess().allowFrom) {
      try { const m = await bot.api.sendMessage(chat, text, { parse_mode: 'HTML', disable_notification: true }); mirrorMsgIds.set(chat, m.message_id) }
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

  const cwd = await paneCwd(paneId)
  const file = cwd ? resolveTranscript(cwd) : null

  // The card opens/edits/closes entirely inside updateTerminalMirror, off the transcript's turn
  // state (turnInProgress) — NOT pane idle. This bridged pane never shows the "esc to interrupt"
  // footer, so detectWorking reads idle the whole turn; gating the card on that produced a
  // create/finalize storm. turnInProgress is the ground truth, so the card caps exactly when the
  // turn concludes. (relayIdleStreak/detectWorking now only feed ambient signals elsewhere.)
  const working = file ? turnInProgress(file) : !idle
  await updateTerminalMirror(working).catch(() => {})

  // Relay off the transcript, classified by stop_reason: 'all' sends every text block as it
  // lands (play-by-play); 'final'/'hybrid' send only conclusion blocks (stop_reason !== tool_use)
  // and skip mid-turn narration. No pane-idle gate — a block relays the moment it's written, so
  // a turn's conclusion can't leak early and narration can't slip into final/hybrid. The card is
  // already capped by updateTerminalMirror above (which ran before this send), so the ✅ Done
  // lands just before the conclusion message.
  if (relayCursorPrimed && file) {
    const mode = replyMode()
    // Suppress Claude's own usage-limit banner echo (the ⛔ handler sends a richer one), but
    // only a short banner-shaped block — a real reply that merely mentions a limit isn't eaten.
    const isBanner = (t: string) => t.length < 200 && /\b(hit your|used \d+% of your) [\w-]+ limit\b/i.test(t)
    for (const b of textEntriesAfter(file, lastRelayedUuid)) {
      if (!b.uuid || b.uuid === lastRelayedUuid) continue
      lastRelayedUuid = b.uuid                 // advance before the await so a fast tick can't double-send
      lastRelayedByFile.set(file, b.uuid)
      if ((mode === 'all' || b.conclusion) && !isBanner(b.text)) {
        const chats = loadAccess().allowFrom
        process.stderr.write(`daemon: relaying ${b.text.length} chars (uuid ${b.uuid.slice(0, 8)}, ${b.conclusion ? 'conclusion' : 'narration'}) to ${chats.join(',')}\n`)
        await sendAgentText(chats, b.text).catch(e => process.stderr.write(`daemon: relay send failed: ${e}\n`))
      }
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
// excluded here; and we only adopt panes whose claude argv carries the bridge opt-in flag
// (--dangerously-skip-permissions or --strict-mcp-config), so a plain unrelated claude is never
// grabbed. Explicit FORCE_PANE always wins.
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

// True if the pane shell `panePid` has a `claude` child the user opted in for bridging. The
// opt-in is the launch flag: `--dangerously-skip-permissions` (the `claude-tg` autonomy alias)
// or, kept for back-compat, `--strict-mcp-config` (the older off-MCP launcher). Either marks the
// pane as "bridge me", so a plain `claude` doing unrelated work is never grabbed. (The plugin's
// MCP server ships disabled, so off-MCP no longer hinges on --strict-mcp-config — it's just one
// of the accepted signatures now.)
async function isPluginlessClaude(panePid: string): Promise<boolean> {
  for (const pid of await processTree(panePid)) {
    const argv = await processArgv(pid)
    if (!argv || !/\bclaude\b/.test(argv)) continue
    return argv.includes('--dangerously-skip-permissions') || argv.includes('--strict-mcp-config')
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
  if (prev !== paneId) void announceAdopted(paneId)
}

// "Connected" — but if the freshly adopted pane is sitting on Claude's first-run onboarding
// (theme picker / login), it can't accept a chat yet, so say that instead of a misleading
// "Connected". onNormalPrompt covers both the idle prompt and a running task; neither is
// onboarding.
async function announceAdopted(paneId: string): Promise<void> {
  const cap = await capturePane(paneId).catch(() => '')
  if (cap && !onNormalPrompt(cap)) {
    notifyChats('🔗 Found a Claude session on first-run setup — I\'ll walk you through it here ' +
      '(theme, folder trust, then login). Or finish it in the terminal if you prefer.')
  } else {
    notifyChats('🔗 Connected to the Claude session.')
  }
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
  const kb = new InlineKeyboard().text(`♻️ Switch to ${who}`, `adoptpane:${paneId}`).text('✏️ Name', `namesession:${paneId}`)
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
    void hintNoSession(params)
  }
}

// With nothing to deliver to, inbound just buffers silently — the most common "it's not
// working". Nudge the user once (throttled) to launch a session; the daemon auto-discovers it
// and replays the buffer. Skipped if any pane exists (it may just be momentarily unfocused).
let lastNoSessionHintTs = 0
async function hintNoSession(params: InboundParams): Promise<void> {
  if (activeShim || offMcpPanes.size > 0) return
  const chat = params.meta?.chat_id
  if (!chat) return
  if (Date.now() - lastNoSessionHintTs < 60_000) return
  lastNoSessionHintTs = Date.now()
  await bot.api.sendMessage(chat,
    '🕳️ <b>No active session</b> — your message is buffered. Start one in tmux to receive it:\n' +
    '<code>claude-tg</code>  (alias for <code>claude --dangerously-skip-permissions</code>)\n' +
    'The daemon auto-discovers the pane and replays anything buffered.',
    { parse_mode: 'HTML' }).catch(() => {})
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

// A sign-in URL surfaced by /login (OAuth authorize link). Claude Code prints it inside
// its bordered box where it soft-wraps across several lines — `-J` only rejoins tmux's own
// wraps, and the box's `│` borders + padding split the URL regardless, so a plain regex
// grabs only the first line (truncating mid-value). Rebuild it: strip ANSI + box-drawing
// chars, find the line that starts the authorize URL, then greedily append following lines
// that are pure URL characters (no spaces) until the URL ends. Scoped to oauth/authorize so
// ordinary links in Claude's replies aren't re-relayed here.
const URL_CHARS = /^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/
function extractAuthUrl(paneText: string): string | null {
  const lines = stripAnsi(paneText)
    .split('\n')
    .map(l => l.replace(/[─-╿]/g, '').replace(/\s+$/, '').trim())
  const start = lines.findIndex(l => /https?:\/\/\S*(?:oauth|authorize)/i.test(l))
  if (start === -1) return null
  const head = lines[start].match(/https?:\/\/\S+/)
  if (!head) return null
  let url = head[0]
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (!l || !URL_CHARS.test(l)) break
    url += l
  }
  return url
}

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
// Highest context-fill threshold (50/75) already warned for the current fill; re-armed to 0 when
// context drops back under 50% (a /clear or /compact), so each fresh fill warns again.
let ctxWarnThreshold = 0
// Last limit-ish line written to the near-miss diagnostic, so a static banner across
// many pane ticks isn't logged repeatedly.
let lastLimitDebugLine = ''
// Per limit type ('session'/'weekly'/…): the highest warning threshold (75/95)
// already sent for the current reset period (`resetKey`), plus when it was sent
// (`at`) so a width-clipped repaint of the same banner can't re-fire it within a
// few hours, so 76/77/… and re-renders don't re-notify.
const usageWarnState = new Map<string, { resetKey: string; threshold: number; at: number }>()

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
  if (typeof s.ctxWarnThreshold === 'number') ctxWarnThreshold = s.ctxWarnThreshold
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
    writeFileSync(USAGE_NOTIF_STATE_FILE, JSON.stringify({ lastActedResetKey, lastActedResetAt, ctxWarnThreshold, warn: Object.fromEntries(usageWarnState) }), { mode: 0o600 })
  } catch {}
}

// ── Statusline-sourced usage snapshot ────────────────────────────────────────
// statusline-command.sh writes exact 5h/7d used% + reset epochs here on each draw —
// the numbers Claude Code hands the statusline, far more reliable than scraping the
// pane banner. Goes stale when no session is rendering, so an old ts reads as "no
// live data" and the pane-scrape fallback (handleUsageLimit) takes back over.
const USAGE_SNAPSHOT_FILE = join(STATE_DIR, 'usage.json')
const USAGE_POLL_MS = 20_000
type RateWindow = { pct: number; resetsAt: number }   // resetsAt in ms (0 = unknown)
type UsageSnapshot = { fiveHour?: RateWindow; sevenDay?: RateWindow }
function readUsageSnapshot(maxAgeMs = 120_000): UsageSnapshot | null {
  let raw: { ts?: unknown; five_hour?: unknown; seven_day?: unknown }
  try { raw = JSON.parse(readFileSync(USAGE_SNAPSHOT_FILE, 'utf8')) } catch { return null }
  const ts = typeof raw.ts === 'number' ? raw.ts * 1000 : 0
  if (!ts || Date.now() - ts > maxAgeMs) return null
  const win = (w: unknown): RateWindow | undefined => {
    const o = w as { pct?: unknown; resets_at?: unknown } | null
    return o && typeof o.pct === 'number'
      ? { pct: o.pct, resetsAt: typeof o.resets_at === 'number' ? o.resets_at * 1000 : 0 }
      : undefined
  }
  const snap: UsageSnapshot = { fiveHour: win(raw.five_hour), sevenDay: win(raw.seven_day) }
  return snap.fiveHour || snap.sevenDay ? snap : null
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

// Send one usage heads-up per threshold (50/75/90) per reset period for a limit type,
// deduped via usageWarnState. `resetKey` identifies the reset period (epoch-derived from
// the snapshot, descriptor-derived from a pane banner) so a fresh period re-arms the alerts.
function maybeWarn(type: string, pct: number, resetKey: string): void {
  if (pct < 50 || pct >= 100) return   // <50 not notable; 100 is a hit (actOnLimitHit)
  const threshold = pct >= 90 ? 90 : pct >= 75 ? 75 : 50
  const prev = usageWarnState.get(type)
  // Ladder dedup scoped to THIS reset period: only fire a threshold higher than the highest
  // already sent for this resetKey. A new period (different resetKey) re-arms all thresholds,
  // so 50 fires again next window — no cross-period lockout that could swallow it.
  const firedThisPeriod = prev && prev.resetKey === resetKey ? prev.threshold : 0
  if (threshold <= firedThisPeriod) return
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

// Context-fill heads-up: one 💾 ping at 50% and again at 75% as the conversation grows. Re-arms
// when context drops back under 50% (a /clear or /compact), so the next fill warns again. Driven
// off the statusline ctxPct read during pin updates; persisted so a daemon restart doesn't re-fire.
function maybeWarnContext(pct: number | null): void {
  if (pct == null) return
  if (pct < 50) { if (ctxWarnThreshold !== 0) { ctxWarnThreshold = 0; saveUsageNotifState() } return }
  const threshold = pct >= 75 ? 75 : 50
  if (threshold <= ctxWarnThreshold) return
  ctxWarnThreshold = threshold
  saveUsageNotifState()
  process.stderr.write(`daemon: context warn fired threshold=${threshold} (pct=${pct})\n`)
  for (const chat_id of loadAccess().allowFrom) {
    void bot.api.sendMessage(chat_id, `💾 Context is ${threshold}% full — consider <code>/compact</code> or wrapping up soon.`, { parse_mode: 'HTML' }).catch(() => {})
  }
}

// A limit is exhausted: relay it (Claude can't, being limited) and schedule the reset
// reminder / auto-continue at the exact reset instant. Deduped on the reset minute so the
// period can't re-fire while it's still active — and so the pane-scrape and snapshot paths
// can't double-fire across a snapshot going stale. Drives weekly auto-continue too: a 7d
// reset is just a `fireAt` days out, well within setTimeout's range.
function actOnLimitHit(fireAt: number, type: string, banner?: string): void {
  const key = `hit:${Math.round(fireAt / 60_000)}`
  if (key === lastActedResetKey && Date.now() < fireAt) return
  lastActedResetKey = key
  lastActedResetAt = Date.now()
  saveUsageNotifState()
  const chats = loadAccess().allowFrom
  if (chats.length === 0) return
  const note = `\n\n⏰ I'll ping you when it resets${loadAccess().autoContinue !== false ? ' and auto-continue' : ''}.`
  const head = banner ? escapeHtml(banner) : `Out of your ${escapeHtml(type)} limit.`
  for (const chat_id of chats) {
    void bot.api.sendMessage(chat_id, `⛔ <b>Claude hit the usage limit.</b>\n${head}${note}`, { parse_mode: 'HTML' }).catch(() => {})
  }
  scheduleReset(fireAt + RESET_GRACE_MS, chats)
}

// Poll the statusline snapshot: drive warnings + limit auto-continue off exact numbers.
// While it's fresh it owns usage handling and handleUsageLimit stands down (its early return).
function checkUsageSnapshot(): void {
  const snap = readUsageSnapshot()
  if (!snap) return
  for (const [win, type] of [['fiveHour', 'session'], ['sevenDay', 'weekly']] as const) {
    const w = snap[win]
    if (!w) continue
    if (w.pct >= 100 && w.resetsAt > Date.now()) actOnLimitHit(w.resetsAt, type)
    else maybeWarn(type, w.pct, w.resetsAt ? `e${Math.round(w.resetsAt / 60_000)}` : `p:${type}`)
  }
}

function handleUsageLimit(text: string): void {
  // Statusline snapshot is the authoritative source — when it's fresh, checkUsageSnapshot
  // owns usage handling and this pane-scrape fallback stands down to avoid double-firing.
  if (readUsageSnapshot()) return
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
    try {
      let prev = ''
      try { if (statSync(USAGE_CAPTURE_FILE).size < 256 * 1024) prev = readFileSync(USAGE_CAPTURE_FILE, 'utf8') } catch {}
      writeFileSync(USAGE_CAPTURE_FILE, `${prev}\n===== ${new Date().toISOString()} =====\n${stripAnsi(text)}\n`, { mode: 0o600 })
    } catch {}

    const type = limitLine.match(/(?:hit your|used 100% of your)\s+([\w-]+)\s+limit/i)?.[1]?.toLowerCase() ?? 'usage'
    const fireAt = parseResetTime(limitLine)
    if (fireAt) { actOnLimitHit(fireAt, type, limitLine); return }
    // No parseable reset time — relay once (deduped on the banner line), no schedule.
    const key = `hit:${limitLine}`
    if (key === lastActedResetKey && Date.now() - lastActedResetAt < RESET_RELOCK_MS) return
    lastActedResetKey = key
    lastActedResetAt = Date.now()
    saveUsageNotifState()
    const chats = loadAccess().allowFrom
    if (chats.length === 0) return
    for (const chat_id of chats) {
      void bot.api.sendMessage(chat_id, `⛔ <b>Claude hit the usage limit.</b>\n${escapeHtml(limitLine)}`, { parse_mode: 'HTML' }).catch(() => {})
    }
    return
  }

  // ── Usage WARNING: one heads-up per threshold (50/75/90) per reset period ────
  const warnIdx = bottom.find(i => !inBlock[i] && USAGE_WARN_RE.test(lines[i]))
  if (warnIdx === undefined) return
  const wm = lines[warnIdx].match(USAGE_WARN_RE)!
  maybeWarn(wm[2].toLowerCase(), parseInt(wm[1], 10), normResetKey(wm[3]))
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

  // (Typing presence is driven by the watcher's per-poll signal — see startPaneWatcher.)

  // Surface a /login sign-in link if one appears (independent of prompt detection,
  // since the URL is printed as plain output, not a multiple-choice menu).
  const authUrl = extractAuthUrl(text)
  if (authUrl) {
    const h = hashText(authUrl)
    if (h !== lastRelayedAuthUrl) {
      lastRelayedAuthUrl = h
      void relayAuthUrlToTelegram(authUrl)
    }
  }

  // First-run onboarding: drive theme/trust/login from here. Once the pane reaches the REPL it's
  // marked onboarded and never driven again (kept BELOW the auth-URL relay so a login link still
  // surfaces). Skipped entirely for already-onboarded panes, so real questions pass through.
  if (activePaneId) {
    if (onNormalPrompt(text)) { onboardedPanes.add(activePaneId); loginChoiceSent = false }
    else if (adoptedPaneId === activePaneId && !onboardedPanes.has(activePaneId)) {
      const stage = classifyOnboarding(text)
      if (stage) { void driveOnboarding(activePaneId, stage); return }
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

// Relay any assistant text that's landed but not yet been sent, so it arrives BEFORE a
// prompt/permission menu we're about to push. The relay loop normally flushes text at idle,
// but a menu is detected from the pane and fires first — and the pane reads "working" while
// it's up — so without this the preamble only lands after the menu is answered. Dedups via
// lastRelayedUuid (advanced before each await, like the loop) so neither path double-sends.
async function flushPendingText(): Promise<void> {
  if (!TRANSCRIPT_OUTBOUND || !relayCursorPrimed || !activePaneId) return
  const cwd = await paneCwd(activePaneId)
  const file = cwd ? resolveTranscript(cwd) : null
  if (!file) return
  for (const r of finalRepliesAfter(file, lastRelayedUuid)) {
    if (!r.uuid || r.uuid === lastRelayedUuid) continue
    lastRelayedUuid = r.uuid
    lastRelayedByFile.set(file, r.uuid)
    if (/\b(hit your|used \d+% of your) [\w-]+ limit\b/i.test(r.text)) continue   // daemon sends its own ⛔
    await sendAgentText(loadAccess().allowFrom, r.text).catch(e => process.stderr.write(`daemon: prompt pre-flush send failed: ${e}\n`))
  }
}

async function relayPromptToTelegram(prompt: PromptInfo): Promise<void> {
  const access = loadAccess()
  const targets = access.allowFrom
  if (targets.length === 0 || !activePaneId) return

  await flushPendingText()   // preamble text must land before the menu
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

  await flushPendingText()   // any preamble text must land before the approve/deny menu
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
// After the auth code is submitted, Claude Code exchanges it for a token (a network
// round-trip) and then shows a "Login successful" confirmation that waits on Enter. Poll
// the pane until that screen lands, reading the logged-in email off it, so the caller can
// report it and press Enter to drop back to the chat. Returns the email if found.
async function waitForLoginConfirmation(paneId: string, maxMs = 15_000): Promise<string | null> {
  const deadline = Date.now() + maxMs
  let email: string | null = null
  while (Date.now() < deadline) {
    await sleep(500)
    const cap = stripAnsi(await capturePane(paneId).catch(() => ''))
    const m = cap.match(/logged in as[:\s]+([^\s│]+@[^\s│]+)/i)
            ?? cap.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
    if (m) email = m[1] ?? m[0]
    if (/login success|logged in|press enter to continue/i.test(cap)) return email
  }
  return email
}

async function relayAuthUrlToTelegram(url: string): Promise<void> {
  const access = loadAccess()
  const targets = access.allowFrom
  if (targets.length === 0) return

  const safe = escapeHtml(url)
  const text =
    `🔑 <b>Sign-in link from Claude Code</b>\n\n` +
    `<pre>${safe}</pre>\n` +
    `Open it in your browser to get your code, then:\n\n` +
    `💬 <b>Reply to this message with your authentication code.</b>`

  for (const chat_id of targets) {
    try {
      const sent = await bot.api.sendMessage(chat_id, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: { force_reply: true, input_field_placeholder: 'Authentication code' },
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
      if (entry) { endSession(entry[0]); return }   // registered session: handles focus + menu
      // Off-MCP pane: drop it; if it was the focused one, offer the switch menu (no auto-switch).
      const wasActive = activePaneId === paneId || currentSessionId === paneId
      activePaneId = null; paneWatcher = null
      offMcpPanes.delete(paneId)
      if (adoptedPaneId === paneId) adoptedPaneId = null   // clear binding so the rescan re-adopts
      if (wasActive) currentSessionId = null
      const label = sessionNames.get(paneId) || 'Session'
      if (wasActive) void announceFocusedExit(label).then(() => updateSessionPin())
      else void updateSessionPin()
    },
    text => typingPresence.observe(detectWorking(text)),   // live typing signal, every poll
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

// Telegram only accepts message reactions from a fixed emoji set — anything else fails with
// 400 REACTION_INVALID and the reaction silently never lands. Claude tends to pick contextual
// emoji (✅ 🆕 📊 …) outside that set, so map the common intents onto an allowed emoji; the
// react handler also catches REACTION_INVALID and falls back to 👍 so a reaction never no-ops.
const REACTION_ALIAS: Record<string, string> = {
  '✅': '👍', '☑️': '👍', '☑': '👍', '✔️': '👍', '✔': '👍', '👍🏻': '👍',
  '🆕': '🎉', '🎊': '🎉', '📊': '👀', '🔎': '👀', '🔍': '👀',
  '🙂': '😁', '😀': '😁', '😄': '😁', '😊': '😁', '😅': '😁',
  '💪': '🔥', '🚀': '🔥', '⭐': '🔥', '🌟': '🔥', '✨': '🤩',
  '🤖': '👨‍💻', '💻': '👨‍💻', '👋': '🙏', '🙇': '🙏', '😬': '😨', '😕': '🤔',
}
const coerceReaction = (e: string): string => REACTION_ALIAS[e] ?? e

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
        const chat_id = resolveChatId(args.chat_id)
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
      case 'update': {
        const mode = (args.mode as string) === 'check' ? 'check' : 'apply'
        const chat = loadAccess().allowFrom[0]
        if (!chat) { text = 'no owner chat configured (access.json allowFrom is empty)'; break }
        const r = startUpdate(chat, mode)
        text = r.ok ? (mode === 'check' ? 'checking for updates' : 'update started') : `failed: ${r.error}`
        break
      }
      case 'react': {
        const chat = resolveChatId(args.chat_id)
        assertAllowedChat(chat)
        const msgId = Number(args.message_id)
        const wanted = coerceReaction(args.emoji as string)
        const react = (emoji: string) =>
          bot.api.setMessageReaction(chat, msgId, [{ type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] }])
        try {
          await react(wanted)
          text = 'reacted'
        } catch (e) {
          if (!/REACTION_INVALID/.test(String(e))) throw e
          await react('👍')   // Telegram rejected the emoji — land a 👍 rather than silently no-op.
          text = `reacted (👍 — Telegram doesn't allow ${args.emoji} as a reaction)`
        }
        break
      }
      case 'download_attachment': {
        text = await downloadTelegramFile(args.file_id as string)
        break
      }
      case 'edit_message': {
        const editChat = resolveChatId(args.chat_id)
        assertAllowedChat(editChat)
        const editFormat = args.format as string | undefined
        const editRender = editFormat !== 'text' && editFormat !== 'markdownv2' && loadAccess().renderMarkdown !== false
        const editParseMode = editRender ? 'HTML' as const : editFormat === 'markdownv2' ? 'MarkdownV2' as const : undefined
        // An edit targets one message; if rendered HTML overflows, keep the first chunk.
        const editText = editRender
          ? chunkHtml(mdToTelegramHtml(args.text as string), MAX_CHUNK_LIMIT)[0]
          : args.text as string
        const edited = await bot.api.editMessageText(
          editChat,
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
    ? `✅ New session started · model: <b>${escapeHtml(model)}</b>`
    : '✅ New session started.'
}

// Ask for confirmation before /new resets the session (the 🆕 New button is easy
// to hit by accident); the reset runs on the Yes tap — see the newconfirm handler.
async function confirmNewSession(ctx: Context): Promise<void> {
  if (!dmCommandGate(ctx)) return
  if (!activePaneId || !paneWatcher) { await ctx.reply('No active Claude Code session with tmux.'); return }
  const keyboard = new InlineKeyboard()
    .text('🆕 Launch new session', 'newsession')
    .text('♻️ Reset current', 'newconfirm:yes')
  await ctx.reply(
    '🆕 <b>New session</b>\n\n' +
    '• <b>Launch new session</b> — start a fresh Claude in a new window (this one keeps running)\n' +
    '• <b>Reset current</b> — clear this conversation in place',
    { parse_mode: 'HTML', reply_markup: keyboard })
}

// ---- Shared actions (used by both slash commands and the control bar) ----
// Each gates and checks for an active pane itself, so it's safe to call from a
// /command handler or from a control-bar button tap.

// Show a Yes/No confirmation before interrupting — the Esc is sent on the Yes tap (see the
// The pane to interrupt — prefer the live binding, but fall back to known panes so a brief
// binding gap (e.g. a daemon restart mid shim-reconnect) doesn't block /stop. /stop only needs
// to send Esc to the pane; it doesn't need the full watcher.
async function resolveActivePane(): Promise<string | null> {
  const tries: (string | null | undefined)[] = [activePaneId]
  if (currentSessionId) tries.push(sessions.get(currentSessionId)?.paneId)
  try { tries.push(readFileSync(ADOPTED_PANE_FILE, 'utf8').trim()) } catch {}
  for (const p of tries) if (p && await paneAlive(p)) return p
  // last resort: a single live claude pane (any kind)
  try {
    const { stdout } = await exec('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_current_command}'], { timeout: 2000 })
    const claudes = stdout.split('\n').filter(l => /\bclaude\b/.test(l)).map(l => l.split(' ')[0])
    if (claudes.length === 1) return claudes[0]
  } catch {}
  return null
}

// stopconfirm handler). Shared by /stop and the 🛑 Stop button.
async function confirmStop(ctx: Context): Promise<void> {
  if (!dmCommandGate(ctx)) return
  if (!(await resolveActivePane())) { await ctx.reply('No active Claude Code session with tmux.'); return }
  const keyboard = new InlineKeyboard().text('🛑 Yes, interrupt', 'stopconfirm:yes')
  await ctx.reply('🛑 Interrupt the current task?\n\nTap to confirm:', { reply_markup: keyboard })
}

// The actual interrupt — Esc into the pane. Returns the status line for the caller to show.
async function performStop(): Promise<string> {
  const pane = await resolveActivePane()
  if (!pane) return 'No active Claude Code session with tmux.'
  // Use the watcher's injection guard only when it owns this pane; otherwise send Esc directly.
  const ok = paneWatcher && pane === activePaneId
    ? await paneWatcher.withInjection(() => sendKeys(pane, ['Escape']))
    : await sendKeys(pane, ['Escape'])
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
    // Injecting into a busy session just queues the command (it never runs → nothing to read)
    // and resizing the pane mid-render leaves artifacts. Wait for a resting prompt instead.
    await ctx.reply(`⏳ Claude is working — <code>/${kind}</code> needs a resting prompt. Run it again once the turn finishes.`, { parse_mode: 'HTML' })
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
const BTN_SESSIONS = '🖥️ Session'
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

    `🖥️ <b>Sessions</b>\n` +
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

    `📌 <b>Pinned bar</b> — your session · model · mode, with 🖥️ 🧠 🧭 quick buttons (<code>/pin</code> to toggle). <code>/dock</code> shows a tap-keyboard of quick actions.\n` +
    `⚙️ <code>/settings</code> — stream, pin, auto-continue, voice in one panel (<code>/mcp</code> toggles MCP mode).\n` +
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

// Phone keyboards autocapitalize the first letter, so a typed "/context" arrives as
// "/Context" — which grammy's case-sensitive matcher misses, dropping it to the raw
// slash-relay and into the pane verbatim (where Claude Code rejects the unknown "/Context").
// Lowercase the command verb in place (the leading bot_command entity span, same length so
// offsets stay valid) so every "/Cmd" routes like "/cmd".
bot.use(async (ctx, next) => {
  const msg = ctx.message
  const ent = msg?.entities?.find(e => e.type === 'bot_command' && e.offset === 0)
  if (msg?.text && ent) {
    const verb = msg.text.slice(0, ent.length)
    const lower = verb.toLowerCase()
    if (lower !== verb) (msg as { text: string }).text = lower + msg.text.slice(ent.length)
  }
  await next()
})

bot.command('start', sendStartHelp)
bot.command('help', sendStartHelp)   // hidden alias (muscle memory); kept out of the command menu

bot.command('status', async ctx => {
  const gated = dmCommandGate(ctx)
  if (!gated) return
  const { access, senderId } = gated
  if (access.allowFrom.includes(senderId)) {
    // Folded into the pin: re-post the status card as the most recent message (delete the old
    // pinned one, create + pin a fresh one at the bottom) so it lands where the user is reading,
    // no scrolling up to the original pin.
    const chat = String(ctx.chat!.id)
    const old = sessionPins.get(chat)
    if (old) {
      await bot.api.unpinChatMessage(chat, old).catch(() => {})
      await bot.api.deleteMessage(chat, old).catch(() => {})
      sessionPins.delete(chat); pinTextCache.delete(chat); persistSessionPins()
    }
    await createSessionPin(chat, await sessionPinText(await sessionRows()), pinKeyboard())
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

// ---- /update: pick what to update — the bridge or Claude itself ----
// Bare /update opens a dashboard naming both current versions, a button each. The bridge path
// reuses the detached self-updater (update.ts, with rollback). The Claude path runs the native
// per-user `claude update` in the background, then — only if it actually moved the version —
// offers a button to restart the focused session so the running conversation picks it up.

// This bridge's installed version (the cache dir we run from), read non-agentically.
function bridgeVersion(): string {
  try { return JSON.parse(readFileSync(join(import.meta.dir, '.claude-plugin', 'plugin.json'), 'utf8')).version ?? '?' } catch { return '?' }
}

// Installed Claude version — `claude --version` prints "2.1.168 (Claude Code)".
async function claudeVersion(): Promise<string | null> {
  try { const { stdout } = await exec('claude', ['--version'], { timeout: 8000 }); return stdout.trim().split(/\s+/)[0] || null } catch { return null }
}

async function paneCommand(paneId: string): Promise<string> {
  try { const { stdout } = await exec('tmux', ['display-message', '-p', '-t', paneId, '#{pane_current_command}'], { timeout: 2000 }); return stdout.trim() } catch { return '' }
}

// The focused off-MCP session's id — the newest transcript under the active pane's cwd, so we can
// relaunch it with `claude --resume <id>` (same id → same transcript → the conversation continues).
async function activeSessionId(): Promise<string | null> {
  if (!activePaneId) return null
  const cwd = await paneCwd(activePaneId)
  const file = cwd ? resolveTranscript(cwd) : null
  return file ? basename(file, '.jsonl') : null
}

// Restart the focused session in place so a freshly installed Claude takes effect: /exit the
// running claude, then relaunch `claude --resume <id>` in the SAME pane. Keeping the pane id keeps
// the watcher (and this bridge) pointed at it; keeping the session id keeps the conversation.
async function restartFocusedSession(chat: string): Promise<void> {
  const dm = (t: string) => bot.api.sendMessage(chat, t, { parse_mode: 'HTML' }).catch(() => {})
  const pane = activePaneId
  if (!pane || !paneWatcher) { await dm('⚠️ No active session to restart.'); return }
  const id = await activeSessionId()
  if (!id) { await dm('⚠️ Couldn’t find this session’s id to resume — start a new session manually to pick up the update.'); return }
  await dm('♻️ Restarting this session on the new Claude…')
  await paneWatcher.withInjection(async () => {
    await sendKeys(pane, ['/exit', 'Enter'])
    for (let i = 0; i < 40 && (await paneCommand(pane)) === 'claude'; i++) await waitForSettle(pane, 200, 1500)
    await sendKeys(pane, [`claude --dangerously-skip-permissions --resume ${id}`, 'Enter'])
    await waitForSettle(pane, 400, 30_000)
  })
  await dm('✅ Session restarted on the new Claude — your conversation was resumed.')
}

// Run `claude update` in the background; if it moved the version, offer a one-tap session restart.
async function updateClaude(chat: string): Promise<void> {
  const dm = (t: string, kb?: InlineKeyboard) =>
    bot.api.sendMessage(chat, t, { parse_mode: 'HTML', ...(kb ? { reply_markup: kb } : {}) }).catch(() => {})
  await dm('🧠 Updating Claude in the background…')
  const before = await claudeVersion()
  try { await exec('claude', ['update'], { timeout: 300_000 }) }
  catch (e) { await dm(`❌ Claude update failed.\n<code>${escapeHtml(String((e as { stderr?: string })?.stderr || e).slice(0, 300))}</code>`); return }
  const after = await claudeVersion()
  if (after && after !== before) {
    await dm(`✅ Claude updated <b>v${escapeHtml(before ?? '?')}</b> → <b>v${escapeHtml(after)}</b>.\n\nRestart this session now to apply it to the running conversation?`,
      new InlineKeyboard().text('♻️ Restart session now', 'claudeupd:restart'))
  } else {
    await dm(`✅ Claude is already up to date (<b>v${escapeHtml(after ?? before ?? '?')}</b>).`)
  }
}

async function showUpdateDashboard(ctx: Context): Promise<void> {
  const claudeVer = await claudeVersion()
  await ctx.reply(
    '🔄 <b>Update</b>\n\n' +
    `🌉 Telegram bridge: <b>v${escapeHtml(bridgeVersion())}</b>\n` +
    `🧠 Claude Code: <b>v${escapeHtml(claudeVer ?? '?')}</b>\n\n` +
    'What do you want to update?',
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard()
        .text('🌉 Update bridge', 'upd:bridge')
        .text('🧠 Update Claude', 'upd:claude') })
}

// Bare /update opens the dashboard; `/update check` still peeks at the bridge's own availability.
bot.command('update', async ctx => {
  if (!dmCommandGate(ctx)) return
  if ((ctx.match ?? '').toString().trim().toLowerCase() === 'check') {
    const r = startUpdate(String(ctx.chat!.id), 'check')
    if (!r.ok) await ctx.reply(`Couldn't check for updates: ${r.error}`)
    return
  }
  await showUpdateDashboard(ctx)
})

// /dock shows the docked control bar; /dock off hides it. /menu stays as a hidden alias.
bot.command(['dock', 'menu'], async ctx => {
  if (!dmCommandGate(ctx)) return
  const arg = (ctx.match ?? '').toString().trim().toLowerCase()
  if (arg === 'off' || arg === 'hide') {
    await ctx.reply('Control bar hidden — /dock to show it again', { reply_markup: { remove_keyboard: true } })
    return
  }
  await ctx.reply('🎛 Control bar ready', { reply_markup: controlKeyboard() })
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
const RESET_GRACE_MS = 60_000
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
  if (arg && arg !== 'on' && arg !== 'off' && arg !== 'refresh') {
    await ctx.reply('Usage: <code>/pin on</code> | <code>off</code> | <code>refresh</code>', { parse_mode: 'HTML' })
    return
  }
  // /pin refresh re-pins a fresh message — recovers a pin dismissed in the client (which the
  // API still reports as pinned, so a normal update can't bring it back).
  if (arg === 'refresh') {
    if (loadAccess().sessionPin === false) {
      await ctx.reply('📌 Pinned status message is <b>OFF</b> — turn it on with <code>/pin on</code>.', { parse_mode: 'HTML' })
    } else {
      await refreshSessionPin()
      await ctx.reply('📌 Re-pinned a fresh status message.', { parse_mode: 'HTML' })
    }
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
    '\nToggle with <code>/pin on</code> | <code>off</code>; <code>/pin refresh</code> re-pins a fresh one.',
    { parse_mode: 'HTML' },
  )
})

// ---- /settings — one tappable panel for the live channel preferences ----
// MCP on/off is the presence of the plugin's .mcp.json (renamed aside when off). Toggling it
// only affects sessions started afterward — Claude Code loads MCP servers at launch.
function mcpEnabled(): boolean { return existsSync(join(import.meta.dir, '.mcp.json')) }
function toggleMcp(): void {
  const on = join(import.meta.dir, '.mcp.json'), off = join(import.meta.dir, 'mcp.json.disabled')
  try {
    if (existsSync(on)) renameSync(on, off)
    else if (existsSync(off)) renameSync(off, on)
  } catch (e) { process.stderr.write(`daemon: mcp toggle failed: ${e}\n`) }
}
function transcribeStatus(): string {
  try { return readFileSync(ENV_FILE, 'utf8').match(/TELEGRAM_TRANSCRIBE=(\S+)/)?.[1]?.replace(/['"]/g, '') || 'off' }
  catch { return 'off' }
}
// Set/remove keys in .env, preserving everything else and the 600 perms.
function writeEnvVars(updates: Record<string, string | null>): void {
  let lines: string[] = []
  try { lines = readFileSync(ENV_FILE, 'utf8').split('\n') } catch {}
  const keys = new Set(Object.keys(updates))
  const kept = lines.filter(l => l.trim() && !keys.has(l.split('=')[0]?.trim()))
  for (const [k, v] of Object.entries(updates)) if (v !== null) kept.push(`${k}=${v}`)
  try { writeFileSync(ENV_FILE, kept.join('\n') + '\n', { mode: 0o600 }) } catch (e) { process.stderr.write(`daemon: env write failed: ${e}\n`) }
}
function envHas(key: string): boolean {
  try { return new RegExp(`^${key}=\\S`, 'm').test(readFileSync(ENV_FILE, 'utf8')) } catch { return false }
}
// Is the local Whisper engine importable (system python, or the configured venv)?
function whisperReady(): boolean {
  const tries = ['python3']
  try { const py = readFileSync(ENV_FILE, 'utf8').match(/TELEGRAM_WHISPER_PYTHON=(\S+)/)?.[1]; if (py) tries.unshift(py) } catch {}
  for (const py of tries) {
    try { execFileSync(py, ['-c', 'import faster_whisper'], { timeout: 5000, stdio: 'ignore' }); return true } catch {}
  }
  return false
}
// Install the local Whisper engine on demand (system pip, falling back to a venv on a
// PEP 668 externally-managed Python). Runs in the background; notifies the chats on finish.
let whisperInstalling = false
async function provisionWhisper(chats: string[]): Promise<void> {
  if (whisperInstalling) return
  whisperInstalling = true
  const note = (msg: string) => { for (const c of chats) void bot.api.sendMessage(c, msg, { parse_mode: 'HTML' }).catch(() => {}) }
  try {
    try {
      await exec('python3', ['-m', 'pip', 'install', '--quiet', 'faster-whisper'], { timeout: 600_000 })
    } catch {
      // externally-managed Python → dedicated venv, recorded in .env
      const venvPy = join(STATE_DIR, 'whisper-venv', 'bin', 'python')
      await exec('python3', ['-m', 'venv', join(STATE_DIR, 'whisper-venv')], { timeout: 120_000 })
      await exec(venvPy, ['-m', 'pip', 'install', '--quiet', 'faster-whisper'], { timeout: 600_000 })
      writeEnvVars({ TELEGRAM_WHISPER_PYTHON: venvPy })
    }
    note(whisperReady() ? '✅ Whisper engine installed — local transcription is ready.' : '⚠️ Engine installed but not importable — try <code>/telegram:configure transcribe local</code>.')
  } catch (e) {
    process.stderr.write(`daemon: whisper provision failed: ${e}\n`)
    note('⚠️ Couldn’t auto-install the Whisper engine. Set it up once in terminal: <code>/telegram:configure transcribe local</code>')
  } finally { whisperInstalling = false }
}

// Readiness note for a transcription backend. Local installs from here; API keys must be
// added in the terminal — keys are deliberately never collected over Telegram (chat history).
function voiceReady(b: string): string {
  if (b === 'local') return whisperInstalling ? '⏳ installing engine…' : whisperReady() ? '✅ engine ready' : '⚙️ engine not installed — tap 💻 Local to install it here'
  if (b === 'groq') return envHas('GROQ_API_KEY') ? '✅ key set' : '🔑 needs a key — for security, add it in the terminal: <code>/telegram:configure transcribe groq</code>'
  if (b === 'openai') return envHas('OPENAI_API_KEY') ? '✅ key set' : '🔑 needs a key — for security, add it in the terminal: <code>/telegram:configure transcribe openai</code>'
  return 'voice notes arrive as placeholders'
}
function voiceText(): string {
  const b = transcribeStatus()
  return `🎙️ <b>Voice transcription</b>\n\nBackend: <b>${b}</b> — ${voiceReady(b)}\n\n` +
    `💻 <b>Local</b> — private &amp; free, installs &amp; runs right here\n☁️ <b>Groq / OpenAI</b> — hosted; the API key is set in the terminal for security\n🔇 <b>Off</b> — disabled\n\n` +
    `🔒 <i>Local is fully configurable from here. For Groq/OpenAI, tapping sets the backend, then add the key in terminal so it never lands in chat history.</i>\n\nPick a backend:`
}
function voiceKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔇 Off', 'voice:off').text('💻 Local', 'voice:local').row()
    .text('☁️ Groq', 'voice:groq').text('☁️ OpenAI', 'voice:openai').row()
    .text('‹ Back', 'voice:back')
}
function settingsText(): string {
  const a = loadAccess()
  return `⚙️ <b>Settings</b>\n\n` +
    `💬 Stream — <b>${replyMode()}</b>\n` +
    `📌 Pinned message — <b>${a.sessionPin !== false ? 'on' : 'off'}</b>\n` +
    `▶️ Auto-continue — <b>${a.autoContinue !== false ? 'on' : 'off'}</b>\n` +
    `🎙️ Voice transcription — <b>${transcribeStatus()}</b>\n\n` +
    `Tap to change:`
}
function settingsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('💬 Stream', 'set:replymode').text('📌 Pin', 'set:pin').row()
    .text('▶️ Auto-continue', 'set:autocontinue').text('🎙️ Voice transcription', 'set:voice')
}
bot.command('settings', async ctx => {
  if (!dmCommandGate(ctx)) return
  await ctx.reply(settingsText(), { parse_mode: 'HTML', reply_markup: settingsKeyboard() })
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

// /mcp on|off toggles MCP mode for sessions started afterward (relaunch to apply); bare shows it.
bot.command('mcp', async ctx => {
  if (!dmCommandGate(ctx)) return
  const arg = (ctx.match ?? '').toString().trim().toLowerCase()
  if (arg && arg !== 'on' && arg !== 'off') {
    await ctx.reply('Usage: <code>/mcp on</code> | <code>off</code>', { parse_mode: 'HTML' }); return
  }
  if (arg && (arg === 'on') !== mcpEnabled()) toggleMcp()
  await ctx.reply(`🔌 MCP mode is <b>${mcpEnabled() ? 'ON' : 'OFF'}</b> <i>(new sessions; relaunch to apply)</i>.\nToggle with <code>/mcp on</code> | <code>off</code>.`, { parse_mode: 'HTML' })
})

// /stream all|final|hybrid sets how Claude's text reaches you (default hybrid); bare shows it.
bot.command('stream', async ctx => {
  if (!dmCommandGate(ctx)) return
  const arg = (ctx.match ?? '').toString().trim().toLowerCase()
  if (arg === 'all' || arg === 'final' || arg === 'hybrid') {
    const access = loadAccess(); access.replyMode = arg; saveAccess(access)
  } else if (arg) {
    await ctx.reply('Usage: <code>/stream all | final | hybrid</code>', { parse_mode: 'HTML' }); return
  }
  const m = replyMode()
  const desc = m === 'all' ? 'every thought as its own message, no tool mirror, plus the conclusion.'
    : m === 'final' ? 'only the conclusion block(s), with the live tool-use mirror.'
    : 'a silent self-updating card (live thoughts + tools), plus the conclusion block(s).'
  await ctx.reply(`💬 Stream mode is <b>${m}</b> — ${desc}\nChange with <code>/stream all | final | hybrid</code>.`, { parse_mode: 'HTML' })
})

// ---- /schedule: deferred messages into a chosen session ----
// /schedule <dur> drops a force-reply; the reply's text is queued and, at fireAt, pasted into
// the session that was focused when scheduled (pinned by paneId, so different messages can
// target different sessions). Persisted so the queue survives a restart; overdue ones fire on
// load. /schedule cancel removes one — or lists them with a button each when there are several.
const SCHEDULED_MSGS_FILE = join(STATE_DIR, 'scheduled-messages.json')
const MAX_TIMEOUT = 2_147_483_647   // setTimeout's ceiling (~24.8 days); longer waits re-arm
type ScheduledMessage = { id: string; fireAt: number; chatId: string; paneId: string | null; sessionLabel: string; text: string }
let scheduledMsgs: ScheduledMessage[] = []
const scheduledTimers = new Map<string, ReturnType<typeof setTimeout>>()
const scheduleReplyTargets = new Map<string, { fireAt: number; paneId: string | null; sessionLabel: string }>()

// "12h" "1h30m" "90s" "2d" "1w" → ms (sum of every unit chunk), or null if nothing parsed.
function parseDuration(s: string): number | null {
  const unit: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }
  let total = 0, matched = false
  for (const m of s.toLowerCase().matchAll(/(\d+)\s*([smhdw])/g)) { matched = true; total += parseInt(m[1], 10) * unit[m[2]] }
  return matched && total > 0 ? total : null
}

// "12h" / "1h 30m" / "3d 4h" — compact, largest units first; for confirmations.
function formatDuration(ms: number): string {
  const d = Math.floor(ms / 864e5), h = Math.floor(ms % 864e5 / 36e5), m = Math.floor(ms % 36e5 / 6e4)
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '<1m'
}

// Absolute fire time in UTC, e.g. "Jun 8, 01:30 UTC" — unambiguous regardless of timezone.
function fmtWhen(at: number): string {
  return new Date(at).toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) + ' UTC'
}

function saveScheduledMsgs(): void { try { writeFileSync(SCHEDULED_MSGS_FILE, JSON.stringify(scheduledMsgs), { mode: 0o600 }) } catch {} }

function armScheduled(msg: ScheduledMessage): void {
  const prev = scheduledTimers.get(msg.id); if (prev) clearTimeout(prev)
  const delay = Math.min(Math.max(0, msg.fireAt - Date.now()), MAX_TIMEOUT)
  scheduledTimers.set(msg.id, setTimeout(() => void fireScheduled(msg.id), delay))
}

function cancelScheduled(id: string): void {
  const t = scheduledTimers.get(id); if (t) clearTimeout(t)
  scheduledTimers.delete(id)
  scheduledMsgs = scheduledMsgs.filter(m => m.id !== id)
  saveScheduledMsgs()
}

async function fireScheduled(id: string): Promise<void> {
  const msg = scheduledMsgs.find(m => m.id === id)
  if (!msg) return
  if (Date.now() < msg.fireAt - 1000) { armScheduled(msg); return }   // capped long wait → re-arm
  scheduledMsgs = scheduledMsgs.filter(m => m.id !== id)
  scheduledTimers.delete(id)
  saveScheduledMsgs()
  await deliverScheduled(msg)
}

async function deliverScheduled(msg: ScheduledMessage): Promise<void> {
  const chats = msg.chatId ? [msg.chatId] : loadAccess().allowFrom
  const note = (t: string) => { for (const c of chats) void bot.api.sendMessage(c, t, { parse_mode: 'HTML' }).catch(() => {}) }
  if (!msg.paneId || !(await paneAlive(msg.paneId))) {
    note(`⏰ Couldn't send your scheduled message — <b>${escapeHtml(msg.sessionLabel)}</b> is gone:\n\n${escapeHtml(msg.text)}`)
    return
  }
  const ok = msg.paneId === activePaneId && paneWatcher
    ? await injectPaste(msg.paneId, paneWatcher, msg.text)
    : await pasteToPane(msg.paneId, msg.text)
  note(ok
    ? `📤 Sent your scheduled message to <b>${escapeHtml(msg.sessionLabel)}</b>:\n\n${escapeHtml(msg.text)}`
    : `⚠️ Couldn't deliver your scheduled message to <b>${escapeHtml(msg.sessionLabel)}</b>.`)
}

// Paste into a pane the watcher isn't driving (a non-focused scheduled target). Mirrors
// injectPaste minus the watcher pause — safe because no relay loop is reading this pane.
async function pasteToPane(paneId: string, text: string): Promise<boolean> {
  try {
    if (!(await paneAlive(paneId))) return false
    await exec('tmux', ['set-buffer', '-b', INJECT_BUFFER, '--', text], { timeout: 2000 })
    await exec('tmux', ['paste-buffer', '-d', '-p', '-b', INJECT_BUFFER, '-t', paneId], { timeout: 2000 })
    await waitForSettle(paneId, 200, 4000)
    await sendKeys(paneId, ['Enter'])
    return true
  } catch { return false }
}

function loadScheduledMsgs(): void {
  try {
    const arr = JSON.parse(readFileSync(SCHEDULED_MSGS_FILE, 'utf8'))
    if (Array.isArray(arr)) scheduledMsgs = arr.filter((m): m is ScheduledMessage =>
      m && typeof m.id === 'string' && typeof m.fireAt === 'number' && typeof m.text === 'string')
  } catch {}
  for (const m of scheduledMsgs) armScheduled(m)   // overdue ones fire ~immediately
}

function scheduledListText(): string {
  const lines = scheduledMsgs.map((m, i) =>
    `${i + 1}. ${fmtWhen(m.fireAt)} → <b>${escapeHtml(m.sessionLabel)}</b>: ${escapeHtml(m.text.length > 40 ? m.text.slice(0, 39) + '…' : m.text)}`)
  return `📅 <b>Scheduled messages</b>\n${lines.join('\n')}\n\nTap to cancel:`
}

function scheduledCancelKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard()
  scheduledMsgs.forEach((m, i) => { kb.text(`🗑 ${i + 1}`, `schedcancel:${m.id}`); if ((i + 1) % 4 === 0) kb.row() })
  return kb
}

async function scheduleDashboard(ctx: Context): Promise<void> {
  if (scheduledMsgs.length === 0) {
    await ctx.reply('📅 <b>No scheduled messages.</b>\n\nSchedule one with <code>/schedule 12h</code> — then reply with the message to send.', { parse_mode: 'HTML' })
    return
  }
  await ctx.reply(scheduledListText(), { parse_mode: 'HTML', reply_markup: scheduledCancelKeyboard() })
}

bot.command('schedule', async ctx => {
  if (!dmCommandGate(ctx)) return
  const arg = (ctx.match ?? '').toString().trim()
  if (!arg || /^(cancel|list|dash)/i.test(arg)) { await scheduleDashboard(ctx); return }
  const ms = parseDuration(arg)
  if (!ms) {
    await ctx.reply('Usage: <code>/schedule 12h</code> — then reply with the message to send.\nUnits: <code>s m h d w</code> (e.g. <code>1h30m</code>). Cancel with <code>/schedule cancel</code>.', { parse_mode: 'HTML' })
    return
  }
  if (ms > MAX_TIMEOUT) { await ctx.reply('That\'s too far out — max ~24 days.'); return }
  const paneId = activePaneId
  const label = paneId ? (sessionNames.get(paneId) || await paneLabel(paneId)) : 'this session'
  const fireAt = Date.now() + ms
  const sent = await ctx.reply(
    `📅 Scheduling in <b>${formatDuration(ms)}</b> (${fmtWhen(fireAt)}) → <b>${escapeHtml(label)}</b>.\n\nReply to this message with what to send.`,
    { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'Message to schedule' } },
  )
  if (sent) scheduleReplyTargets.set(`${ctx.chat?.id}:${sent.message_id}`, { fireAt, paneId, sessionLabel: label })
})

// User-set session names (paneId → label), overriding the cwd-derived default. Persisted so
// they survive a daemon restart (tmux pane ids are stable across one); a tmux restart re-derives.
const SESSION_NAMES_FILE = join(STATE_DIR, 'session-names.json')
const sessionNames = new Map<string, string>()
try { for (const [k, v] of Object.entries(JSON.parse(readFileSync(SESSION_NAMES_FILE, 'utf8')) as Record<string, string>)) sessionNames.set(k, v) } catch {}
function persistSessionNames(): void {
  try { writeFileSync(SESSION_NAMES_FILE, JSON.stringify(Object.fromEntries(sessionNames)), { mode: 0o600 }) } catch {}
}
const renameReplyTargets = new Set<string>()           // `${chatId}:${messageId}` of list "Rename" prompts
const nameReplyTargets = new Map<string, string>()     // `${chatId}:${messageId}` → paneId of "Name" prompts

// Name a specific pane. Returns the HTML confirmation / error.
async function renamePane(paneId: string, label: string): Promise<string> {
  const clean = label.trim().slice(0, 40)
  if (!clean) return 'Give it a name.'
  sessionNames.set(paneId, clean); persistSessionNames()
  void updateSessionPin()
  const n = await sessionNumber(paneId)
  return `✅ ${n ? `Session ${n}` : 'Session'} renamed to <b>${escapeHtml(clean)}</b>`
}

// Rename session #n (1-based over sessionRows).
async function renameSession(n: number, label: string): Promise<string> {
  const rows = await sessionRows()
  if (n < 1 || n > rows.length) return `No session ${n}.`
  const row = rows[n - 1]
  if (!row.paneId) return 'That session has no pane to name.'
  return renamePane(row.paneId, label)
}

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
const pinTextCache = new Map<string, string>()   // last rendered text per chat — skip no-op edits on the 10s refresh
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
  sessionPins.clear(); pinTextCache.clear(); persistSessionPins()
}

// Force a fresh pin: unpin+delete the old one, then recreate. Recovers a pin the user dismissed
// in their client — Telegram still reports it pinned, so updateSessionPin can't tell it's hidden,
// and editing the same id won't bring it back; only pinning a new message will.
async function refreshSessionPin(): Promise<void> {
  await removeSessionPins()
  await updateSessionPin()
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
  if (!id) return id
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1).toLowerCase()
  // New ids: claude-<family>-<major>-<minor>[-<date>] → "Opus 4.8".
  let m = id.match(/(opus|sonnet|haiku)-(\d+)-(\d+)/i)
  if (m) return `${cap(m[1])} ${m[2]}.${m[3]}`
  // Legacy ids: claude-<major>-<minor>-<family> → "Sonnet 3.5".
  m = id.match(/(\d+)-(\d+)-(opus|sonnet|haiku)/i)
  if (m) return `${cap(m[3])} ${m[1]}.${m[2]}`
  // Family only (no parseable version).
  m = id.match(/(opus|sonnet|haiku)/i)
  return m ? cap(m[1]) : id
}

// Status line for the focused session: 💻 name • model (…) • mode (…). Mode is read live from a
// pane capture; model from the session's transcript. Both degrade to "—" rather than blocking.
async function gitBranch(dir: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 2000 })
    const b = stdout.trim()
    return b && b !== 'HEAD' ? b : null
  } catch { return null }
}

// ---- statusline → pin enrichment ----
// The configured Claude Code statusLine renders rich session metrics (context, tokens, cost,
// rate-limit windows) at the bottom of the pane. The daemon already captures that pane, so rather
// than recompute anything we lift those fields straight out of the capture and re-render them in
// the pin's own layout. Scoped to the statusline's slot — the lines just above Claude Code's
// footer hint — so we never pick up numbers from Claude's reply text higher in the pane.

type StatuslineData = {
  ctxPct: number | null
  tokens: string | null
  cost: string | null
  sessionTime: string | null
  apiTime: string | null
  h5: { pct: number; reset: string } | null
  d7: { pct: number; reset: string } | null
}

const PIN_RULE = '──────────────────────────'
const STATUS_DUR = '(\\d+h\\d+m|\\d+m\\d+s|\\d+h|\\d+m|\\d+s)'

function pinBar(pct: number, width = 10): string {
  const p = Math.max(0, Math.min(100, pct))
  const filled = Math.round((p / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

// The contiguous non-empty, non-border lines directly above the pane's last footer hint — i.e.
// the custom statusline's slot. null when there's no statusline there (the line above the footer
// is the input-box border) or the pane is in a transient state.
function statuslineBlock(paneText: string): string | null {
  const lines = paneText.split('\n').map(l => stripAnsi(l).replace(/\s+$/, ''))
  let last = lines.length - 1
  while (last >= 0 && !lines[last].trim()) last--
  if (last < 1) return null
  const out: string[] = []
  for (let i = last - 1; i >= 0 && last - i <= 6; i--) {
    const l = lines[i]
    if (!l.trim()) break
    if (/^[\s─━│┃┌┐└┘├┤┬┴┼╭╮╰╯╶╴╵╷]+$/.test(l)) break   // input-box border — statusline ends here
    out.unshift(l)
  }
  return out.length ? out.join('\n') : null
}

function parseStatusline(paneText: string): StatuslineData | null {
  const block = statuslineBlock(paneText)
  if (!block) return null
  const str = (re: RegExp): string | null => { const m = block.match(re); return m?.[1] ?? null }
  const up = str(/↑\s*([\d.]+[kKmM]?)/), down = str(/↓\s*([\d.]+[kKmM]?)/)
  const costRaw = str(/\$\s*([\d.]+)/)
  const limit = (re: RegExp): { pct: number; reset: string } | null => {
    const m = block.match(re); return m ? { pct: parseInt(m[1], 10), reset: m[2] } : null
  }
  const data: StatuslineData = {
    ctxPct: (() => { const m = block.match(/ctx\D*?(\d+)\s*%/i); return m ? parseInt(m[1], 10) : null })(),
    tokens: up || down ? `↑${up ?? '?'} ↓${down ?? '?'}` : null,
    cost: costRaw ? `$${parseFloat(costRaw).toFixed(2)}` : null,
    sessionTime: str(new RegExp(`\\$[\\d.]+[^|]*\\|\\s*\\D*?${STATUS_DUR}`)),  // first duration after cost
    apiTime: str(new RegExp(`api\\s+${STATUS_DUR}`, 'i')),
    h5: limit(new RegExp(`5h\\D*?(\\d+)\\s*%\\D*?${STATUS_DUR}`)),
    d7: limit(new RegExp(`7d\\D*?(\\d+)\\s*%\\D*?${STATUS_DUR}`)),
  }
  const empty = data.ctxPct == null && !data.tokens && !data.cost && !data.sessionTime && !data.h5 && !data.d7
  return empty ? null : data
}

async function sessionPinText(rows: SessionRow[]): Promise<string> {
  const cur = rows.find(r => r.current)
  if (!cur) return '🖥️ <b>No active session</b>'
  let mode = '—', model = lastKnownModel, cwd: string | null = null
  let status: StatuslineData | null = null
  if (activePaneId) {
    try {
      const cap = await capturePane(activePaneId)
      // Strip modeLabel's leading per-mode emoji — the pin uses a single generic 🧭.
      if (onNormalPrompt(cap)) mode = modeLabel(detectCurrentMode(cap)).replace(/^\S+\s+/, '')
      status = parseStatusline(cap)
    } catch {}
    try {
      cwd = await paneCwd(activePaneId)
      const file = cwd ? resolveTranscript(cwd) : null
      model = (file && prettyModel(lastModelInTranscript(file))) || model
    } catch {}
  }
  const branch = cwd ? await gitBranch(cwd) : null

  // First line is the collapsed preview Telegram shows up top — keep it identity-only. Everything
  // below is revealed when the pin is expanded, grouped into rule-separated cards.
  const quick = status?.h5 ? ` • 📊 ${status.h5.pct}%` : ''
  const head = `🖥️ <b>${escapeHtml(cur.label)}</b>${quick} • 🧠 ${escapeHtml(model ?? '—')} • 🧭 ${escapeHtml(mode)}`
  const groups: string[] = []
  if (cwd) groups.push(`📁 <code>${escapeHtml(cwd)}</code>${branch ? ` · 🌿 ${escapeHtml(branch)}` : ''}`)
  if (status) {
    maybeWarnContext(status.ctxPct)
    const usage: string[] = []
    if (status.ctxPct != null) usage.push(`💾 Context <code>${pinBar(status.ctxPct)}</code> ${status.ctxPct}%${status.tokens ? `  ·  ${status.tokens}` : ''}`)
    const ct: string[] = []
    if (status.cost) ct.push(`💰 ${status.cost}`)
    if (status.sessionTime) ct.push(`⏱ ${status.sessionTime}`)
    if (status.apiTime) ct.push(`⚡ api ${status.apiTime}`)
    if (ct.length) usage.push(ct.join('  ·  '))
    if (usage.length) groups.push(usage.join('\n'))
    const lim: string[] = []
    if (status.h5) lim.push(`📊 5h <code>${pinBar(status.h5.pct)}</code> ${status.h5.pct}%  ↻ ${status.h5.reset}`)
    if (status.d7) lim.push(`📅 7d <code>${pinBar(status.d7.pct)}</code> ${status.d7.pct}%  ↻ ${status.d7.reset}`)
    if (lim.length) groups.push(lim.join('\n'))
  }
  if (rows.length > 1) groups.push(`🖥️ Session ${rows.findIndex(r => r.current) + 1} of ${rows.length}`)
  groups.push(`🔗 Paired${botUsername ? ` · @${escapeHtml(botUsername)}` : ''} · connected`)

  return groups.length ? `${head}\n\n${groups.join(`\n${PIN_RULE}\n`)}` : head
}

// Quick-action buttons on the pinned status message — same emojis as the pin's own fields.
function pinKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🖥️ Sessions', 'pin:sessions').text('⚙️ Settings', 'pin:settings').row()
    .text('🧠 Model', 'pin:model').text('🧭 Mode', 'pin:mode').row()
    .text('💾 Context', 'pin:context').text('🗜️ Compact', 'pin:compact').row()
    .text('💰 Cost', 'pin:cost').text('🧹 Clear', 'pin:clear')
}

// True when an edit failed because the target message is gone (deleted) rather than a transient
// like "message is not modified" — a gone pin must be recreated, not re-edited forever.
function pinMessageGone(e: unknown): boolean {
  const d = String((e as { description?: string })?.description ?? e)
  return /message to edit not found|message can'?t be edited|message to pin not found|MESSAGE_ID_INVALID/i.test(d)
}

async function createSessionPin(chat: string, text: string, reply_markup: InlineKeyboard): Promise<void> {
  try {
    const m = await bot.api.sendMessage(chat, text, { parse_mode: 'HTML', reply_markup })
    await bot.api.pinChatMessage(chat, m.message_id, { disable_notification: true }).catch(() => {})
    sessionPins.set(chat, m.message_id); pinTextCache.set(chat, text); persistSessionPins()
  } catch (e) { process.stderr.write(`daemon: session pin create failed: ${e}\n`) }
}

let pinUpdating = false
async function updateSessionPin(): Promise<void> {
  if (loadAccess().sessionPin === false) return // disabled via /pin off
  if (pinUpdating) return                       // serialize — capture + edit can overlap with switches
  pinUpdating = true
  try {
    const text = await sessionPinText(await sessionRows())
    const reply_markup = pinKeyboard()
    const hasSession = !!(activePaneId || activeShim)   // off-MCP pane or MCP shim — either counts
    for (const chat of loadAccess().allowFrom) {
      const existing = sessionPins.get(chat)
      if (existing && pinTextCache.get(chat) === text) continue   // nothing changed — skip the no-op edit
      if (existing) {
        try {
          await bot.api.editMessageText(chat, existing, text, { parse_mode: 'HTML', reply_markup })
          pinTextCache.set(chat, text)
        } catch (e) {
          // Deleted out from under us → drop the stale id and recreate below. Transient errors
          // ("message is not modified") leave it in place — the pin is still good.
          if (pinMessageGone(e)) { sessionPins.delete(chat); pinTextCache.delete(chat); persistSessionPins() }
          else pinTextCache.set(chat, text)   // "not modified" → it already shows this text
        }
        if (sessionPins.has(chat)) {
          // If the user unpinned it, re-pin on the next update (e.g. a session switch) so it returns.
          const info = await bot.api.getChat(chat).catch(() => null)
          if (info?.pinned_message?.message_id !== existing) {
            await bot.api.pinChatMessage(chat, existing, { disable_notification: true }).catch(() => {})
          }
          continue
        }
      }
      if (hasSession) await createSessionPin(chat, text, reply_markup)   // don't pin "No active session" out of nowhere
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
  if (row.current) return `Already on <b>Session ${n}</b>`
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
  if (rows.length > 1) kb.text('✏️ Rename', 'renamesession')
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
    const cmd = `claude --dangerously-skip-permissions${extra ? ` ${extra}` : ''}`   // bypass mode + adopt signature; extra e.g. "--resume <id>"
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
    `🖥️ <b>Sessions</b> (★ = active):\n\n${lines.join('\n')}\n\n` +
    `Tap the number below to switch • or use <code>/session #</code>\n\n` +
    `💡 Tip: Use <code>/rename (name)</code> to rename the current session`,
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

// /rename <name> — silent alias to rename the current (focused) session.
bot.command('rename', async ctx => {
  if (!dmCommandGate(ctx)) return
  const name = (ctx.match ?? '').toString().trim()
  if (!name) { await ctx.reply('Usage: <code>/rename &lt;new name&gt;</code>', { parse_mode: 'HTML' }); return }
  const pane = await resolveActivePane()
  if (!pane) { await ctx.reply('No active session to rename.'); return }
  await ctx.reply(await renamePane(pane, name), { parse_mode: 'HTML' })
})

bot.command(['sessions', 'session'], async ctx => {   // /sessions is canonical; /session is the alias
  if (!dmCommandGate(ctx)) return
  const arg = (ctx.match ?? '').toString().trim()
  const rows = await sessionRows()

  const nameMatch = arg.match(/^name\s+(\d+)\s+(.+)$/i)
  if (nameMatch) {
    await ctx.reply(await renameSession(Number(nameMatch[1]), nameMatch[2]), { parse_mode: 'HTML' })
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

  // Pinned-message quick actions → the same pickers as /sessions, /model, /mode, /settings.
  if (data === 'pin:sessions' || data === 'pin:model' || data === 'pin:mode' || data === 'pin:settings') {
    if (!loadAccess().allowFrom.includes(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    await ctx.answerCallbackQuery().catch(() => {})
    if (data === 'pin:sessions') await doSessionList(ctx)
    else if (data === 'pin:model') await doModelPicker(ctx)
    else if (data === 'pin:mode') await doModePicker(ctx)
    else await ctx.reply(settingsText(), { parse_mode: 'HTML', reply_markup: settingsKeyboard() })
    return
  }

  // Pinned-message readouts → /context and /cost, posted at the bottom.
  if (data === 'pin:context' || data === 'pin:cost') {
    if (!loadAccess().allowFrom.includes(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    await ctx.answerCallbackQuery().catch(() => {})
    await doReadout(ctx, data === 'pin:context' ? 'context' : 'cost')
    return
  }

  // Pinned-message session actions → /compact (relay) and /clear (confirm + reset).
  if (data === 'pin:compact' || data === 'pin:clear') {
    if (!loadAccess().allowFrom.includes(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    await ctx.answerCallbackQuery().catch(() => {})
    if (data === 'pin:clear') { await confirmNewSession(ctx); return }
    if (!activePaneId || !paneWatcher) { await ctx.reply('No active Claude Code session with tmux.'); return }
    void relaySlashCommand(activePaneId, paneWatcher, '/compact', String(ctx.chat!.id), ctx.callbackQuery.message!.message_id)
    return
  }

  // /settings panel toggles → flip the setting and re-render the panel in place.
  const setMatch = /^set:(pin|autocontinue|replymode)$/.exec(data)
  if (setMatch) {
    if (!loadAccess().allowFrom.includes(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    await ctx.answerCallbackQuery().catch(() => {})
    const a = loadAccess()
    if (setMatch[1] === 'replymode') {
      const m = replyMode()
      a.replyMode = m === 'all' ? 'final' : m === 'final' ? 'hybrid' : 'all'
      saveAccess(a)
    } else if (setMatch[1] === 'pin') {
      a.sessionPin = a.sessionPin === false                 // flip
      saveAccess(a)
      if (a.sessionPin) await updateSessionPin(); else await removeSessionPins()
    } else if (setMatch[1] === 'autocontinue') {
      a.autoContinue = a.autoContinue === false
      saveAccess(a)
    }
    await ctx.editMessageText(settingsText(), { parse_mode: 'HTML', reply_markup: settingsKeyboard() }).catch(() => {})
    return
  }

  // Voice-transcription sub-panel → switch backend (live; daemon reads .env per voice note).
  const voiceMatch = /^voice:(off|local|groq|openai|back)$/.exec(data)
  if (voiceMatch) {
    if (!loadAccess().allowFrom.includes(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    await ctx.answerCallbackQuery().catch(() => {})
    const choice = voiceMatch[1]
    if (choice === 'back') {
      await ctx.editMessageText(settingsText(), { parse_mode: 'HTML', reply_markup: settingsKeyboard() }).catch(() => {})
      return
    }
    if (choice === 'off') writeEnvVars({ TELEGRAM_TRANSCRIBE: 'off' })
    else if (choice === 'local') {
      writeEnvVars({ TELEGRAM_TRANSCRIBE: 'local', ...(envHas('TELEGRAM_TRANSCRIBE_MODEL') ? {} : { TELEGRAM_TRANSCRIBE_MODEL: 'base' }) })
      if (!whisperReady() && !whisperInstalling) void provisionWhisper(loadAccess().allowFrom)   // install engine here
    }
    else writeEnvVars({ TELEGRAM_TRANSCRIBE: choice })   // groq / openai — key added in terminal (see voiceReady)
    await ctx.editMessageText(voiceText(), { parse_mode: 'HTML', reply_markup: voiceKeyboard() }).catch(() => {})
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

  // /update dashboard → bridge self-update (detached helper, with rollback).
  if (data === 'upd:bridge') {
    if (!loadAccess().allowFrom.includes(String(ctx.from.id))) { await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {}); return }
    await ctx.answerCallbackQuery({ text: 'Updating bridge…' }).catch(() => {})
    await ctx.editMessageText('🌉 Updating the Telegram bridge… progress will follow.', { parse_mode: 'HTML' }).catch(() => {})
    const r = startUpdate(String(ctx.chat?.id), 'apply')
    if (!r.ok) await ctx.editMessageText(`❌ Couldn't start bridge update: ${escapeHtml(r.error ?? '')}`, { parse_mode: 'HTML' }).catch(() => {})
    return
  }

  // /update dashboard → update Claude itself in the background (offers a restart button on finish).
  if (data === 'upd:claude') {
    if (!loadAccess().allowFrom.includes(String(ctx.from.id))) { await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {}); return }
    await ctx.answerCallbackQuery({ text: 'Updating Claude…' }).catch(() => {})
    await ctx.editMessageReplyMarkup().catch(() => {})   // spend the dashboard buttons
    void updateClaude(String(ctx.chat?.id))
    return
  }

  // "Restart session now" under a finished Claude update.
  if (data === 'claudeupd:restart') {
    if (!loadAccess().allowFrom.includes(String(ctx.from.id))) { await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {}); return }
    await ctx.answerCallbackQuery({ text: 'Restarting…' }).catch(() => {})
    await ctx.editMessageReplyMarkup().catch(() => {})
    void restartFocusedSession(String(ctx.chat?.id))
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

  // Confirm/cancel exiting the only session (see the /exit handler's only-session guard).
  if (data === 'exitconfirm:yes' || data === 'exitconfirm:no') {
    if (!loadAccess().allowFrom.includes(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    if (data === 'exitconfirm:no') {
      await ctx.answerCallbackQuery({ text: 'Kept.' }).catch(() => {})
      await ctx.editMessageText('✖️ Exit cancelled — session kept.').catch(() => {})
      return
    }
    if (!activePaneId || !paneWatcher) {
      await ctx.answerCallbackQuery({ text: 'No active tmux session.' }).catch(() => {})
      return
    }
    const label = await paneLabel(activePaneId)
    await ctx.answerCallbackQuery({ text: 'Exiting…' }).catch(() => {})
    await injectSlash(activePaneId, paneWatcher, '/exit')
    await ctx.editMessageText(`✅ Session <b>${escapeHtml(label)}</b> exited`, { parse_mode: 'HTML' }).catch(() => {})
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

  // "🗑 N" on the /schedule cancel list → drop that scheduled message, refresh the list.
  const schedCancelMatch = /^schedcancel:([0-9a-f]+)$/.exec(data)
  if (schedCancelMatch) {
    if (!loadAccess().allowFrom.includes(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    const existed = scheduledMsgs.some(m => m.id === schedCancelMatch[1])
    cancelScheduled(schedCancelMatch[1])
    await ctx.answerCallbackQuery({ text: existed ? 'Cancelled.' : 'Already gone.' }).catch(() => {})
    if (scheduledMsgs.length) await ctx.editMessageText(scheduledListText(), { parse_mode: 'HTML', reply_markup: scheduledCancelKeyboard() }).catch(() => {})
    else await ctx.editMessageText('📅 No scheduled messages left.').catch(() => {})
    return
  }

  // Login-method choice during first-run onboarding (see driveOnboarding / relayLoginChoice).
  if (data === 'login:sub' || data === 'login:api') {
    if (!loadAccess().allowFrom.includes(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    await ctx.answerCallbackQuery().catch(() => {})
    const paneId = activePaneId
    if (!paneId || !paneWatcher) { await ctx.reply('No active session to drive.'); return }
    if (data === 'login:sub') {
      // Subscription is the default (top) option → Enter selects it; the OAuth link then appears
      // and relays on its own, and you reply to that link message with the code.
      await paneWatcher.withInjection(async () => { await sendKeys(paneId, ['Enter']); await waitForSettle(paneId, 300, 5000) })
      await ctx.reply('🔗 Opening the claude.ai sign-in link — I\'ll send it here. Tap it, approve, then reply to that link message with the code shown.')
    } else {
      // API key: select the second option so the key field is ready — but the key itself must be
      // typed in the terminal; we never accept it over Telegram.
      await paneWatcher.withInjection(async () => { await navigateDown(paneId, 1); await sendKeys(paneId, ['Enter']); await waitForSettle(paneId, 300, 5000) })
      await ctx.reply('🔑 For security I won\'t handle API keys over Telegram. I\'ve selected the API-key option — paste your key directly in the terminal window.')
    }
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

  // "✏️ Rename" (session list) → force-reply asking for "<#> <new name>".
  if (data === 'renamesession') {
    if (!loadAccess().allowFrom.includes(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    await ctx.answerCallbackQuery().catch(() => {})
    const sent = await ctx.reply('✏️ Reply with: <code>&lt;session #&gt; &lt;new name&gt;</code>\ne.g. <code>2 API work</code>', {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: '2 New name' },
    }).catch(() => null)
    if (sent) renameReplyTargets.add(`${ctx.chat?.id}:${sent.message_id}`)
    return
  }

  // "✏️ Name" (new-session announcement) → force-reply for a name; targets that pane directly.
  const nameMatch = /^namesession:(%\d+)$/.exec(data)
  if (nameMatch) {
    if (!loadAccess().allowFrom.includes(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    await ctx.answerCallbackQuery().catch(() => {})
    const sent = await ctx.reply('✏️ Reply with a name for this session.', {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Session name' },
    }).catch(() => null)
    if (sent) nameReplyTargets.set(`${ctx.chat?.id}:${sent.message_id}`, nameMatch[1])
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
    await ctx.editMessageReplyMarkup().catch(() => {})  // drop the buttons immediately on tap, not after the settle
    await paneWatcher.withInjection(async () => {
      await sendKeys(activePaneId!, [num, 'Enter'])
      await waitForSettle(activePaneId!, 300, 5000)
    })
    lastRelayedPermissionHash = ''  // allow the next permission prompt to relay
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
    await ctx.deleteMessage().catch(() => {})  // remove the prompt entirely once answered (toast confirms)
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
    await ctx.deleteMessage().catch(() => {})  // remove the answered question (next tab relays its own message)
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
    await ctx.deleteMessage().catch(() => {})  // remove the question; the reply below stands in for it
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
      if (toggles.length) { await sendKeysPaced(activePaneId!, toggles); await waitForSettle(activePaneId!, 250, 4000) }
      // Even a lone multi-select question has its own Submit tab (reached with Right); landing on
      // it renders "Ready to submit your answers?" with "Submit answers" focused. A swallowed Right
      // (render lag) leaves the cursor on an option row, where Enter TOGGLES that row instead of
      // submitting — wedging the prompt. So press Right until the submit screen actually shows
      // (capped), and only then confirm with Enter — never blind-fire Enter on an option row.
      for (let i = 0; i < 4 && !isSubmitScreen(await capturePane(activePaneId!).catch(() => '')); i++) {
        await sendKeys(activePaneId!, ['Right'])
        await waitForSettle(activePaneId!, 250, 4000)
      }
      await sendKeys(activePaneId!, ['Enter'])
      await waitForSettle(activePaneId!, 300, 6000)
    })
    pendingMultiSelect.delete(key)
    lastRelayedPromptHash = ''  // allow next prompt to relay
    await ctx.deleteMessage().catch(() => {})  // remove the prompt entirely once submitted (toast confirms)
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
  await ctx.deleteMessage().catch(() => {})  // remove the permission prompt entirely once answered (toast confirms)
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
    const replyKey = `${ctx.chat?.id}:${replyTo.message_id}`
    // Reply to a "✏️ Rename" (list) force-reply → parse "<#> <name>".
    if (renameReplyTargets.has(replyKey)) {
      renameReplyTargets.delete(replyKey)
      if (!dmCommandGate(ctx)) return
      const m = text.match(/^(\d+)\s+(.+)$/)
      await ctx.reply(m ? await renameSession(Number(m[1]), m[2]) : 'Format: <code>&lt;#&gt; &lt;name&gt;</code>, e.g. <code>2 API work</code>', { parse_mode: 'HTML' })
      return
    }
    // Reply to a "✏️ Name" (announcement) force-reply → name that specific pane.
    if (nameReplyTargets.has(replyKey)) {
      const paneId = nameReplyTargets.get(replyKey)!
      nameReplyTargets.delete(replyKey)
      if (!dmCommandGate(ctx)) return
      await ctx.reply(await renamePane(paneId, text), { parse_mode: 'HTML' })
      return
    }
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
    // Reply to a "📅 /schedule" force-reply → queue the message for its session at fireAt.
    const sched = scheduleReplyTargets.get(replyKey)
    if (sched) {
      scheduleReplyTargets.delete(replyKey)
      if (!dmCommandGate(ctx)) return
      const msg: ScheduledMessage = { id: randomBytes(4).toString('hex'), fireAt: sched.fireAt, chatId: String(ctx.chat?.id), paneId: sched.paneId, sessionLabel: sched.sessionLabel, text }
      scheduledMsgs.push(msg); saveScheduledMsgs(); armScheduled(msg)
      await ctx.reply(`✅ Scheduled for ${fmtWhen(msg.fireAt)} → <b>${escapeHtml(msg.sessionLabel)}</b>.\nCancel with <code>/schedule cancel</code>.`, { parse_mode: 'HTML' })
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
    const paneId = activePaneId, watcher = paneWatcher
    const email = await watcher.withInjection(async () => {
      if (!(await sendKeysLiteral(paneId, text))) return undefined   // pane gone
      await sendKeys(paneId, ['Enter'])
      const found = await waitForLoginConfirmation(paneId)
      await sendKeys(paneId, ['Enter'])                              // skip the confirmation screen
      await waitForSettle(paneId, 300, 5000)
      return found
    })
    if (email === undefined) { await ctx.reply('Could not reach the session pane.'); return }
    await ctx.reply(email ? `✅ Successfully logged in as ${escapeHtml(email)}` : '✅ Logged in.', { parse_mode: 'HTML' })
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
    // /exit (and /quit) closes the session. If it's the only one, confirm first (Yes/No) so the
    // user can't accidentally leave themselves with no session; otherwise exit straight away.
    if (/^\/(exit|quit)\b/i.test(text)) {
      if ((await sessionRows()).length <= 1) {
        const kb = new InlineKeyboard().text('✅ Yes, exit', 'exitconfirm:yes').text('✖️ No', 'exitconfirm:no')
        await ctx.reply('⚠️ This is the only session — confirm exit?', { reply_markup: kb })
        return
      }
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
            { reply_markup: (() => { const k = new InlineKeyboard().text(`♻️ Switch to Session ${idx}`, `switchsession:${idx}`); if (msg.paneId) k.text('✏️ Name', `namesession:${msg.paneId}`); return k })(), parse_mode: 'HTML' })

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

// ---- Crash-restart heartbeat + watchdog cross-guard ----

// HEARTBEAT_FILE exists while we run and is removed on a graceful shutdown — so if it's
// still here at the next startup, the previous instance died uncleanly (a crash, OOM, or
// kill -9). `crashRestart` records that across startup so onStart can announce it once.
let crashRestart = false
function touchHeartbeat(): void { try { writeFileSync(HEARTBEAT_FILE, String(Date.now()), { mode: 0o600 }) } catch {} }

// Cross-guard the watchdog (it guards us): revive it if its pid is gone, so neither staying
// down needs a new Claude session. ensure-daemon (SessionStart) covers the both-dead case.
function ensureWatchdog(): void {
  const watchdogPath = join(import.meta.dir, 'watchdog.ts')
  if (!existsSync(watchdogPath)) return
  try { const pid = parseInt(readFileSync(WATCHDOG_PID_FILE, 'utf8'), 10); if (pid > 1) { process.kill(pid, 0); return } } catch {}
  try {
    const log = openSync(DAEMON_LOG_FILE, 'a')
    const child = spawn('bun', [watchdogPath], { detached: true, stdio: ['ignore', log, log], env: process.env })
    child.unref()
    closeSync(log)
    process.stderr.write(`daemon: launched watchdog (pid ${child.pid})\n`)
  } catch (e) { process.stderr.write(`daemon: watchdog launch failed: ${e}\n`) }
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
  try { unlinkSync(HEARTBEAT_FILE) } catch {}   // clean exit → next startup won't read a crash
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

// Detect an unclean previous exit before we (re)create the heartbeat, then keep it fresh.
crashRestart = existsSync(HEARTBEAT_FILE)
touchHeartbeat()
setInterval(touchHeartbeat, 10_000).unref()

// Bring up / cross-guard the watchdog that keeps us alive between sessions.
ensureWatchdog()
setInterval(ensureWatchdog, 60_000).unref()

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
  // Refresh the session pin so it reflects the pinned pane immediately. Without this the pin
  // keeps whatever stale text it last had (e.g. "No active session" from before the pane
  // existed), since the auto-discovery path — which normally calls this — is skipped here.
  void updateSessionPin()
} else if (TRANSCRIPT_OUTBOUND) {
  // Off-MCP with no pinned pane: find and adopt a plugin-less work session on our own,
  // then keep watching so a session started later (or restarted) gets picked up — siblings
  // are announced with a switch button rather than stealing focus.
  void discoverPanes()
  setInterval(() => void discoverPanes(), 30_000)
  setInterval(() => void checkCrossSessionUnread(), 4_000)   // ping unread in unfocused sessions
}

// Keep the pinned status message's live metrics fresh in EVERY mode — off-MCP pane or MCP shim
// session — once per 10s. No-op edits are skipped and no pin is created when nothing's active, so
// this is cheap when idle and works the same whether or not the plugin's MCP server is loaded.
setInterval(() => void updateSessionPin(), 10_000)

// Make the `tg` CLI + ensure-daemon launcher available to plugin-less sessions, no setup.
provisionOffMcpTooling()

// Re-arm any persisted usage-limit reset reminder across the restart.
loadScheduledReset()

// Re-arm any persisted /schedule messages (overdue ones fire shortly after load).
loadScheduledMsgs()

// Drive usage alerts + limit auto-continue (session + weekly) from the statusline snapshot.
checkUsageSnapshot()
setInterval(checkUsageSnapshot, USAGE_POLL_MS).unref()

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
          // Announce a crash recovery once, only after we're actually connected.
          if (crashRestart) {
            crashRestart = false
            for (const chat_id of loadAccess().allowFrom) void bot.api.sendMessage(chat_id, '♻️ Daemon restarted after a crash.').catch(() => {})
          }
          void bot.api.setMyCommands(
            [
              { command: 'start', description: 'Welcome + everything this bot can do' },
              { command: 'stop', description: 'Interrupt the current task (Esc)' },
              { command: 'status', description: 'Re-post the status pin at the bottom' },
              { command: 'settings', description: 'Channel settings — mirror, pin, auto-continue, MCP, voice' },
              { command: 'sessions', description: 'List sessions (/sessions # switch, /sessions name # label)' },
              { command: 'schedule', description: 'Schedule a message into a session (/schedule 12h · /schedule cancel)' },
              { command: 'resume', description: 'Resume a recent session (lists them with times)' },
              { command: 'new', description: 'Start a fresh conversation' },
              { command: 'stream', description: 'How replies arrive: all · final · hybrid' },
              { command: 'cost', description: 'Show the session cost readout' },
              { command: 'context', description: 'Show the token-context usage' },
              { command: 'compact', description: 'Compact the conversation to free up context' },
              { command: 'update', description: 'Update the Telegram bridge or Claude itself' },
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
