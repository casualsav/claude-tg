// Update plumbing — extracted from daemon.ts (split plan #6).
//
// Version readers (bridge + Claude), the detached self-updater launcher, and the daily
// update-available notifier. The /update dashboard, updateClaude and session restart stay in
// daemon (they drive panes); the upd:* buttons call back into startUpdate from there.
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, existsSync, openSync, copyFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { Bot, InlineKeyboard } from 'grammy'
import { STATE_DIR, DAEMON_LOG_FILE, readJsonFile, writeJsonFile } from './common.ts'
import { exec } from './proc.ts'
import { escapeHtml } from './markdown.ts'
import { loadAccess } from './access.ts'
import { isTopicMode, getGroupChatId } from './topics.ts'

type UpdatesDeps = { bot: Bot }
let deps: UpdatesDeps
export function initUpdates(d: UpdatesDeps): void { deps = d }

// Kick off a self-update. update.ts rebuilds the cache dir we run from and restarts us, so it
// must outlive this process: copy it to a stable spot outside the cache and spawn it DETACHED.
// `mode` is 'apply' (pull + rebuild + restart, with rollback) or 'check' (report only). All
// progress + the result are DM'd by update.ts to `chatId`.
export function startUpdate(chatId: string, mode: 'apply' | 'check'): { ok: boolean; error?: string } {
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

// This bridge's installed version (the cache dir we run from), read non-agentically.
export function bridgeVersion(): string {
  try { return JSON.parse(readFileSync(join(import.meta.dir, '.claude-plugin', 'plugin.json'), 'utf8')).version ?? '?' } catch { return '?' }
}

// Resolve the claude binary `claude install` actually manages. The native installer writes
// ~/.local/bin/claude (a symlink into ~/.local/share/claude/versions/<v>); a separately-installed
// npm-global claude (e.g. /usr/bin/claude) can sit earlier on the daemon's PATH and shadow it, which
// would make before/after version checks read a binary `claude install` never touches and report a
// bogus "already up to date". Prefer the native path when present; fall back to PATH otherwise.
export function claudeBin(): string {
  const native = join(homedir(), '.local', 'bin', 'claude')
  return existsSync(native) ? native : 'claude'
}

// Installed Claude version — `claude --version` prints "2.1.168 (Claude Code)".
export async function claudeVersion(): Promise<string | null> {
  try { const { stdout } = await exec(claudeBin(), ['--version'], { timeout: 8000 }); return stdout.trim().split(/\s+/)[0] || null } catch { return null }
}

// ---- Proactive update notifications ----
// Daily quiet check for bridge + Claude updates. One card per newly-seen version (deduped via
// UPDATE_NOTIFY_FILE), with one-tap buttons into the EXISTING update flows (upd:bridge /
// upd:claude — apply, progress, health-check, rollback all already non-agentic). Never
// auto-applies; `updateChecks: false` pref disables.
const UPDATE_NOTIFY_FILE = join(STATE_DIR, 'update-notify.json')
// pocket-claude after the rename; old id kept as fallback until this machine re-adds the marketplace.
const MP_DIR = ['pocket-claude', 'better-claude-plugins']
  .map(n => join(homedir(), '.claude', 'plugins', 'marketplaces', n)).find(p => existsSync(p))
  ?? join(homedir(), '.claude', 'plugins', 'marketplaces', 'pocket-claude')

// True only when `latest` is strictly newer — a locally-deployed bridge can run AHEAD of the
// marketplace remote, and `latest !== cur` would announce that as an "update" (a downgrade).
function isNewer(latest: string, cur: string): boolean {
  try { return Bun.semver.order(latest, cur) > 0 } catch { return latest !== cur }
}

export async function checkBridgeUpdate(): Promise<{ cur: string; latest: string } | null> {
  try {
    if (!existsSync(join(MP_DIR, '.git'))) return null
    await exec('git', ['-C', MP_DIR, 'fetch', '--quiet', 'origin'], { timeout: 60_000 })
    const branch = (await exec('git', ['-C', MP_DIR, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 })).stdout.trim() || 'main'
    const remoteJson = (await exec('git', ['-C', MP_DIR, 'show', `origin/${branch}:.claude-plugin/plugin.json`], { timeout: 5000 })).stdout
    const latest = String(JSON.parse(remoteJson).version ?? '')
    const cur = bridgeVersion()
    return latest && isNewer(latest, cur) ? { cur, latest } : null
  } catch { return null }
}

export async function checkClaudeUpdate(): Promise<{ cur: string; latest: string } | null> {
  try {
    const cur = await claudeVersion()
    if (!cur) return null
    const res = await fetch('https://registry.npmjs.org/@anthropic-ai/claude-code/latest', { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return null
    const latest = ((await res.json()) as { version?: string }).version
    return latest && isNewer(latest, cur) ? { cur, latest } : null
  } catch { return null }
}

export async function sweepUpdateChecks(): Promise<void> {
  if (loadAccess().updateChecks === false) return
  const notified = readJsonFile<{ bridge?: string; claude?: string }>(UPDATE_NOTIFY_FILE, {})
  const [b, c] = await Promise.all([checkBridgeUpdate(), checkClaudeUpdate()])
  const newBridge = b && notified.bridge !== b.latest ? b : null
  const newClaude = c && notified.claude !== c.latest ? c : null
  if (!newBridge && !newClaude) return
  const lines = ['🆕 <b>Update available</b>']
  const kb = new InlineKeyboard()
  if (newBridge) { lines.push(`🌉 Bridge <code>${escapeHtml(newBridge.cur)}</code> → <code>${escapeHtml(newBridge.latest)}</code>`); kb.text('🌉 Update bridge', 'upd:bridge') }
  if (newClaude) { lines.push(`🧠 Claude <code>${escapeHtml(newClaude.cur)}</code> → <code>${escapeHtml(newClaude.latest)}</code>`); kb.text('🧠 Update Claude', 'upd:claude') }
  const dests = isTopicMode() && getGroupChatId() ? [getGroupChatId()!] : loadAccess().allowFrom
  for (const chat of dests) {
    await deps.bot.api.sendMessage(chat, lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb, disable_notification: true }).catch(() => {})
  }
  writeJsonFile(UPDATE_NOTIFY_FILE, { bridge: newBridge?.latest ?? notified.bridge, claude: newClaude?.latest ?? notified.claude })
  process.stderr.write(`daemon: update notice posted (bridge ${newBridge?.latest ?? '—'}, claude ${newClaude?.latest ?? '—'})\n`)
}
