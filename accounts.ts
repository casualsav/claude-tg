// Multi-account support — an "account" is a Claude Code config dir (CLAUDE_CONFIG_DIR).
//
// The default account ("main") is ~/.claude; extra accounts live in their own config dirs
// (convention: ~/.claude-<name>) and are registered in STATE_DIR/accounts.json as
// { "<name>": "<configDir>" }. A session is pinned to an account by CLAUDE_CONFIG_DIR at
// launch (the claude-tg alias' second arg, or spawnSession's configDir), and a PANE's account
// is derived from its stamped @tg_transcript path — the transcript lives under
// <configDir>/projects/, so no extra per-pane marker is needed.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'

export type Account = { name: string; configDir: string }

export const MAIN_CONFIG_DIR = join(homedir(), '.claude')
export const MAIN_ACCOUNT: Account = { name: 'main', configDir: MAIN_CONFIG_DIR }

// Account names ride in tmux options and callback data, so keep them to a safe token.
export const ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,15}$/i

let accountsFile = join(MAIN_CONFIG_DIR, 'channels', 'telegram', 'accounts.json')
export function initAccounts(stateDir: string): void { accountsFile = join(stateDir, 'accounts.json') }

function readRegistry(): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(accountsFile, 'utf8')) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' && ACCOUNT_NAME_RE.test(k) && k !== 'main') out[k] = v
    }
    return out
  } catch { return {} }
}

// Every account, main first. Stable order (registry insertion order) so pickers don't reshuffle.
export function listAccounts(): Account[] {
  return [MAIN_ACCOUNT, ...Object.entries(readRegistry()).map(([name, configDir]) => ({ name, configDir }))]
}

export function accountByName(name: string): Account | null {
  return listAccounts().find(a => a.name === name) ?? null
}

export function projectsDirOf(a: Account): string { return join(a.configDir, 'projects') }

// All accounts' projects roots — what /resume and the cwd-fallback transcript resolver scan.
export function allProjectsDirs(): string[] { return listAccounts().map(projectsDirOf) }

// The account a transcript path belongs to: longest configDir whose projects dir prefixes it.
// (Longest match so ~/.claude-work/projects/… never matches ~/.claude.) Default: main.
export function accountForTranscript(path: string): Account {
  let best = MAIN_ACCOUNT, bestLen = -1
  for (const a of listAccounts()) {
    const root = projectsDirOf(a) + '/'
    if (path.startsWith(root) && root.length > bestLen) { best = a; bestLen = root.length }
  }
  return best
}

// The account owning a projects root (as returned by listRecentSessions). Default: main.
export function accountForProjectsDir(root: string): Account {
  return listAccounts().find(a => projectsDirOf(a) === root) ?? MAIN_ACCOUNT
}

// Register a new account: <name> → ~/.claude-<name> (the claude-tg launcher convention), and
// seed its config dir so bridge sessions work out of the box — the statusline (usage snapshot +
// pin data) and the SessionStart hooks (daemon relauncher + transcript stamp) are read from THIS
// config dir's settings.json, so without the seed an alt-account session would neither stamp its
// transcript (no reply relay) nor report usage. Copied from the main settings.json; hook command
// paths are absolute (plugin cache / state dir), so they work unchanged from any config dir.
export function addAccount(name: string): { ok: true; account: Account } | { ok: false; error: string } {
  if (!ACCOUNT_NAME_RE.test(name)) return { ok: false, error: 'Name must be 1–16 letters/digits/dashes.' }
  if (name === 'main') return { ok: false, error: '"main" is the default account (~/.claude).' }
  if (readRegistry()[name]) return { ok: false, error: `Account "${name}" already exists.` }
  const configDir = join(homedir(), `.claude-${name}`)
  const account = { name, configDir }
  try {
    healAccountConfig(configDir)
    const reg = { ...readRegistry(), [name]: configDir }
    writeFileSync(accountsFile, JSON.stringify(reg, null, 2) + '\n', { mode: 0o600 })
  } catch (e) { return { ok: false, error: String(e) } }
  return { ok: true, account }
}

// Unregister (the config dir + its sessions are left on disk).
export function removeAccount(name: string): boolean {
  const reg = readRegistry()
  if (!reg[name]) return false
  delete reg[name]
  try { writeFileSync(accountsFile, JSON.stringify(reg, null, 2) + '\n', { mode: 0o600 }) } catch { return false }
  return true
}

// Carry statusLine + hooks from the main settings.json into an account's, filling only what's
// missing (never clobbers keys the user set). Idempotent — also run for every registered account
// at daemon startup (healAccountConfigs), which covers accounts registered before the main
// settings.json had its hooks (e.g. during the install interview, which writes hooks later).
export function healAccountConfig(configDir: string): void {
  mkdirSync(configDir, { recursive: true })
  const dest = join(configDir, 'settings.json')
  let cur: Record<string, unknown> = {}
  try { cur = JSON.parse(readFileSync(dest, 'utf8')) } catch {}
  let main: Record<string, unknown> = {}
  try { main = JSON.parse(readFileSync(join(MAIN_CONFIG_DIR, 'settings.json'), 'utf8')) } catch {}
  let changed = false
  for (const k of ['statusLine', 'hooks'] as const) {
    if (cur[k] == null && main[k] != null) { cur[k] = main[k]; changed = true }
  }
  if (changed || !existsSync(dest)) writeFileSync(dest, JSON.stringify(cur, null, 2) + '\n', { mode: 0o600 })
}

export function healAccountConfigs(): void {
  for (const a of listAccounts()) {
    if (a.name === 'main') continue
    try { healAccountConfig(a.configDir) } catch {}
  }
}

// Whether an account has completed /login (credentials present in its config dir).
export function accountLoggedIn(a: Account): boolean {
  return existsSync(join(a.configDir, '.credentials.json'))
}
