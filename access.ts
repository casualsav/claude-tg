// Access control — the bridge's security boundary.
//
// Decides who may reach the session: DM allowlist/pairing, group allowlist + mention gating, and
// the static-lockdown mode that freezes the security half. Extracted from daemon.ts (Phase 3f) so
// this — the highest-blast-radius code in the codebase (the bang-shell RCE and skip-permissions
// bypass both sit behind these gates) — is isolated and unit-testable.
//
// The split: the SECURITY half (dmPolicy/allowFrom/groups/pending) lives in access.json and is
// frozen at boot under static mode; PREFERENCES live in prefs.json and stay mutable always. Wired
// via initAccess({ getBotUsername }) — the one daemon-state dependency (isMentioned needs the live
// bot username, set after the daemon connects).
import { readFileSync, writeFileSync, renameSync, statSync, mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { Context } from 'grammy'
import { ACCESS_FILE, PREFS_FILE, STATE_DIR } from './common.ts'
import { _accessFileCache } from './state.ts'
import { getGroupChatId } from './topics.ts'
import type { Access } from './types.ts'

// Static lockdown: the security half is baked + immutable (tamper-proof allowlist).
export const STATIC = process.env.TELEGRAM_ACCESS_MODE === 'static'

type AccessDeps = { getBotUsername: () => string }
let deps: AccessDeps = { getBotUsername: () => '' }
export function initAccess(d: AccessDeps): void { deps = d }

export function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

// Security fields live in access.json (baked + immutable under static mode); everything else is a
// mutable preference kept in prefs.json so /settings keeps working even under a static lockdown.
const PREF_KEYS = [
  'mentionPatterns', 'ackReaction', 'replyToMode', 'textChunkLimit', 'chunkMode',
  'renderMarkdown', 'terminalMirror', 'sessionPin', 'replyMode', 'shipButtons', 'budgetDaily',
  'topicOnEnd', 'scheduleTz', 'batchAllow', 'tts', 'updateChecks',
] as const satisfies readonly (keyof Access)[]

// Parse a JSON access/prefs file into a partial; {} on missing, moved-aside + {} on corrupt.
function readJsonAccess(path: string): Partial<Access> {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Partial<Access>
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    try { renameSync(path, `${path}.corrupt-${Date.now()}`) } catch {}
    process.stderr.write(`telegram daemon: ${path} corrupt, moved aside\n`)
    return {}
  }
}

// loadAccess() runs on nearly every poll/relay/inbound — dozens of times a second — and the split
// made it read+parse TWO files each call. Cache the parsed result keyed by mtime+size so we only
// re-parse when a file actually changes (statSync is ~free next to readFileSync+JSON.parse).
// saveAccess() invalidates explicitly, so same-millisecond writes are never missed.
function readJsonAccessCached(path: string): Partial<Access> {
  let st: { mtimeMs: number; size: number }
  try { st = statSync(path) } catch { _accessFileCache.delete(path); return {} }
  const hit = _accessFileCache.get(path)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data
  const data = readJsonAccess(path)
  _accessFileCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, data })
  return data
}

// Security half — dmPolicy/allowFrom/groups/pending from access.json. Baked at boot in static mode.
function readSecurity(): Access {
  const p = readJsonAccessCached(ACCESS_FILE)
  return {
    dmPolicy: p.dmPolicy ?? 'pairing',
    allowFrom: p.allowFrom ?? [],
    groups: p.groups ?? {},
    pending: p.pending ?? {},
  }
}

// Preference half — from prefs.json; always mutable, even under static mode. Migration: before
// prefs.json exists, fall back to any pref fields still living in the legacy combined access.json.
function readPrefs(): Partial<Access> {
  let raw = readJsonAccessCached(PREFS_FILE)
  if (Object.keys(raw).length === 0) raw = readJsonAccessCached(ACCESS_FILE)
  const out: Partial<Access> = {}
  for (const k of PREF_KEYS) if (raw[k] !== undefined) (out as Record<string, unknown>)[k] = raw[k]
  return out
}

// Only the security half is frozen at boot under static mode (tamper-proof allowlist).
const BOOT_SECURITY: Access | null = STATIC
  ? (() => {
      const a = readSecurity()
      if (a.dmPolicy === 'pairing') {
        process.stderr.write('telegram daemon: static mode — dmPolicy "pairing" downgraded to "allowlist"\n')
        a.dmPolicy = 'allowlist'
      }
      a.pending = {}
      return a
    })()
  : null

// Merge the frozen-or-live security half with the always-live preferences.
export function loadAccess(): Access { return { ...(BOOT_SECURITY ?? readSecurity()), ...readPrefs() } }

function writeJsonAtomic(path: string, obj: unknown): void {
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

export function saveAccess(a: Access): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  // Preferences are always persisted — even under static mode, so /settings keeps working.
  const prefs: Record<string, unknown> = {}
  for (const k of PREF_KEYS) if (a[k] !== undefined) prefs[k] = a[k]
  writeJsonAtomic(PREFS_FILE, prefs)
  _accessFileCache.delete(PREFS_FILE)   // invalidate cache — don't wait on mtime resolution
  // Security half is frozen under static mode (tamper-proof allowlist); writable otherwise.
  if (STATIC) return
  writeJsonAtomic(ACCESS_FILE, { dmPolicy: a.dmPolicy, allowFrom: a.allowFrom, groups: a.groups, pending: a.pending })
  _accessFileCache.delete(ACCESS_FILE)
}

export function pruneExpired(a: Access): boolean {
  const now = Date.now(); let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) { delete a.pending[code]; changed = true }
  }
  return changed
}

export type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

export function gate(ctx: Context): GateResult {
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

// Gate for command handlers. Allows a private chat (DM allowlist/pairing, as before) OR the bound
// forum-topics command-center group from an allowlisted sender — so slash commands work inside the
// group, not just in a DM. (Name kept for its many call sites; it now covers both contexts.)
export function dmCommandGate(ctx: Context): { access: Access; senderId: string } | null {
  if (!ctx.from) return null
  const senderId = String(ctx.from.id)
  const access = loadAccess()
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access)
  if (access.dmPolicy === 'disabled') return null
  const chatType = ctx.chat?.type
  if (chatType === 'private') {
    if (access.dmPolicy === 'allowlist' && !access.allowFrom.includes(senderId)) return null
    return { access, senderId }
  }
  // Bound command-center group: commands run for allowlisted senders (per-group allowlist if set,
  // else the global allowlist). Only the ONE group registered via /bind qualifies.
  if ((chatType === 'group' || chatType === 'supergroup') && String(ctx.chat!.id) === getGroupChatId()) {
    const policy = access.groups[String(ctx.chat!.id)]
    const allowed = policy?.allowFrom?.length ? policy.allowFrom.includes(senderId) : access.allowFrom.includes(senderId)
    if (allowed) return { access, senderId }
  }
  return null
}

export function isMentioned(ctx: Context, extraPatterns?: string[]): boolean {
  const botUsername = deps.getBotUsername()
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
