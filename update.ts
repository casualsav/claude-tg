#!/usr/bin/env bun
// Self-contained self-updater for the off-MCP Telegram bridge. Runs DETACHED (spawned by the
// daemon's /update command or `tg update`), because it restarts the very daemon that launched it
// and rebuilds the cache dir the daemon runs from — so it must not depend on the daemon being
// alive, and must not live-import anything from the cache dir it's about to replace. Only node
// builtins + global fetch; it loads its own .env and talks to Telegram over raw HTTP.
//
//   bun update.ts <chat_id> [check]
//
// Flow: fetch the marketplace clone → if behind, build a fresh cache dir from it (copy + deps +
// type-check) → swap it in → restart via ensure-daemon → health-check the new daemon → on failure
// roll back to the previous dir. Progress + result are DM'd to <chat_id>. `check` only reports.
import { execFileSync, execSync, spawn } from 'node:child_process'
import {
  chmodSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()
const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(HOME, '.claude', 'channels', 'telegram')
const ENV_FILE = join(STATE_DIR, '.env')
const LOG_FILE = join(STATE_DIR, 'daemon.log')
const PENDING_EVENTS = join(STATE_DIR, 'pending-events.jsonl')
const SOCKET = join(STATE_DIR, 'daemon.sock')
// Marketplace id (also the plugin-cache dir name).
const MKT_ID = 'claude-tg'
const MP = join(HOME, '.claude', 'plugins', 'marketplaces', MKT_ID)
const CACHE_BASE = join(HOME, '.claude', 'plugins', 'cache', MKT_ID, 'telegram')
const BACKUP_BASE = join(HOME, '.claude', 'plugins', 'cache', MKT_ID, 'telegram-backups')
const SEMVER = /^\d+\.\d+\.\d+$/
const HEALTH_TIMEOUT_MS = 45_000

const [, , chatId, modeArg, seedMsgId] = process.argv
const checkOnly = modeArg === 'check'
let newSha = ''

// ---- .env (for the bot token) ----
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}
const TOKEN = process.env.TELEGRAM_BOT_TOKEN

// ---- helpers ----
const log = (s: string) => { try { writeFileSync(LOG_FILE, `[${new Date().toISOString()}] update: ${s}\n`, { flag: 'a' }) } catch {} }

// One Bot API call (sendMessage / editMessageText). Returns the result object (carrying
// message_id for a fresh send) or null on any failure / when there's nothing to message.
async function tgCall(method: string, body: Record<string, unknown>): Promise<{ message_id?: number } | null> {
  if (!TOKEN || !chatId) return null
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, parse_mode: 'HTML', ...body }),
    })
    return ((await r.json()) as { result?: { message_id?: number } }).result ?? null
  } catch { return null }
}

// A SINGLE status line that edits ITSELF as the update moves through its stages
// (checking → building → restarting) — one updating message instead of a pile of them.
// First call sends; later calls edit it in place.
// Seeded by the daemon (it posts the "♻️ Updating…" bubble and passes its id): edit THAT message
// in place so /update is a single message start-to-finish. Unseeded (legacy/other callers) → null,
// and the first progress() sends a fresh one.
let progressMsgId: number | null = Number(seedMsgId) || null
async function progress(text: string): Promise<void> {
  log(text.replace(/\n/g, ' '))
  if (progressMsgId == null) progressMsgId = (await tgCall('sendMessage', { text }))?.message_id ?? null
  else await tgCall('editMessageText', { message_id: progressMsgId, text })
}

// Terminal FAILURE/rollback outcomes fold INTO the single status line (edit it in place), so a failed
// /update stays one message start-to-finish. progress() falls back to a fresh send when there's no
// status line yet (no seed and nothing posted).
async function notify(text: string): Promise<void> { await progress(text) }

// The SUCCESS "finished" line is the exception: it posts as its OWN fresh message instead of folding
// into the status line, so the in-place line stays on its last step (♻️ Restarting…) and the ✅ lands
// as a new bubble (it pings, and survives the menu refresh) after the bridge has come back up.
async function sendFresh(text: string): Promise<void> {
  log(text.replace(/\n/g, ' '))
  await tgCall('sendMessage', { text })
}

const git = (args: string[], cwd = MP) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function newestSemverDir(): string | null {
  try {
    const dirs = readdirSync(CACHE_BASE).filter(d => SEMVER.test(d) && existsSync(join(CACHE_BASE, d, 'daemon.ts')))
    dirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    return dirs.length ? dirs[dirs.length - 1] : null
  } catch { return null }
}

function killBridge(): void {
  for (const pat of ['telegram/[^/]*/daemon\\.ts', 'telegram/[^/]*/watchdog\\.ts']) {
    try { execSync(`pkill -f '${pat}'`) } catch {}
  }
  for (const f of [SOCKET, join(STATE_DIR, 'daemon.pid'), join(STATE_DIR, 'watchdog.pid')]) {
    try { rmSync(f) } catch {}
  }
}

function launchBridge(dir: string): void {
  const fd = openSync(LOG_FILE, 'a')
  const child = spawn('bun', [join(dir, 'ensure-daemon.ts')], { detached: true, stdio: ['ignore', fd, fd], env: process.env })
  child.unref()
}

// Watch the log (from a byte offset captured before restart) for the daemon's "polling as" line.
async function waitHealthy(offset: number): Promise<boolean> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(1500)
    try {
      const buf = readFileSync(LOG_FILE)
      const tail = buf.subarray(Math.min(offset, buf.length)).toString('utf8')
      if (/telegram daemon: polling as @/.test(tail)) return true
    } catch {}
  }
  return false
}

const logSize = () => { try { return statSync(LOG_FILE).size } catch { return 0 } }
const shortVer = (sha: string) => sha.slice(0, 7)

// ---- Re-sync installed COPIES that live outside the plugin cache ----
// The daemon code updates with the cache, but two files are copied into ~/.claude at install
// time and otherwise go stale across versions: the off-mcp convention block in CLAUDE.md and
// the statusline script. Refresh both from the just-updated clone so convention/statusline
// changes ship with /update. Conservative: only touches files that already exist / already
// carry our block, never creates where the user opted out, never clobbers a custom statusline.
const GLOBAL_MD = join(HOME, '.claude', 'CLAUDE.md')
const STATUSLINE_DEST = join(HOME, '.claude', 'statusline-command.sh')
const STATUSLINE_SIG = 'Claude Code status line'   // header line unique to our script
const CONV_BEGIN = '<!-- BEGIN claude-tg (off-mcp convention — auto-synced by /update; edits inside are overwritten) -->'
const CONV_END = '<!-- END claude-tg -->'
// First line of off-mcp/CLAUDE.md across its lifetimes (legacy, marker-less installs).
const CONV_HEADINGS = ['# Telegram bridge (no MCP)', '# Reachable over Telegram (no MCP)']

function syncInstalledCopies(): string[] {
  const notes: string[] = []
  // 1. Convention block in ~/.claude/CLAUDE.md.
  try {
    const template = readFileSync(join(MP, 'off-mcp', 'CLAUDE.md'), 'utf8').trim()
    const wrapped = `${CONV_BEGIN}\n${template}\n${CONV_END}`
    if (existsSync(GLOBAL_MD)) {
      const cur = readFileSync(GLOBAL_MD, 'utf8')
      // Match a marker block under ANY past name (by its signature) and rewrite it to the
      // current pair, so renaming the project never doubles the block.
      const mk = cur.match(/<!-- BEGIN (\S+) \(off-mcp convention — auto-synced by \/update; edits inside are overwritten\) -->/)
      const begin = mk?.[0] ?? CONV_BEGIN, end = mk ? `<!-- END ${mk[1]} -->` : CONV_END
      const b = cur.indexOf(begin), e = cur.indexOf(end)
      if (b !== -1 && e !== -1 && e > b) {
        // Already marker-wrapped → swap the block in place.
        const next = cur.slice(0, b) + wrapped + cur.slice(e + end.length)
        if (next !== cur) { writeFileSync(GLOBAL_MD, next); notes.push('refreshed the off-mcp convention in CLAUDE.md') }
      } else {
        // Legacy, marker-less: replace from our heading to the next top-level "# " (or EOF),
        // migrating it into markers. Our block has only the one top-level heading, so this is
        // exact. Content before/after the block is preserved.
        const heading = CONV_HEADINGS.find(h => cur.includes(h))
        const hi = heading ? cur.indexOf(heading) : -1
        if (heading && hi !== -1) {
          const after = cur.indexOf('\n# ', hi + heading.length)
          const tail = after === -1 ? '' : cur.slice(after + 1)
          writeFileSync(GLOBAL_MD, cur.slice(0, hi) + wrapped + (tail ? '\n\n' + tail : '\n'))
          notes.push('migrated + refreshed the off-mcp convention in CLAUDE.md')
        }
      }
    }
  } catch {}
  // 2. Statusline script — only overwrite our own (signature-guarded), never a user's custom one.
  try {
    const src = join(MP, 'statusline-command.sh')
    if (existsSync(STATUSLINE_DEST) && existsSync(src)) {
      const dest = readFileSync(STATUSLINE_DEST, 'utf8')
      if (dest.includes(STATUSLINE_SIG) && dest !== readFileSync(src, 'utf8')) {
        cpSync(src, STATUSLINE_DEST); try { chmodSync(STATUSLINE_DEST, 0o755) } catch {}
        notes.push('refreshed statusline-command.sh')
      }
    }
  } catch {}
  return notes
}

async function main(): Promise<void> {
  if (!existsSync(join(MP, '.git'))) { await notify('❌ Update: marketplace clone not found — is the plugin installed?'); return }

  // 1. Fetch + compare.
  await progress(checkOnly ? '🔍 Checking for updates…' : '♻️ Updating the Telegram bridge — checking…')
  let localSha: string, remoteSha: string, branch: string
  try {
    git(['fetch', '--quiet', 'origin'])
    branch = git(['rev-parse', '--abbrev-ref', 'HEAD']) || 'main'
    localSha = git(['rev-parse', 'HEAD'])
    remoteSha = git(['rev-parse', `origin/${branch}`])
  } catch (e) { await notify(`❌ Update: git fetch failed.\n<code>${String(e).slice(0, 300)}</code>`); return }

  if (localSha === remoteSha) { await progress(`✅ Already up to date (<code>${shortVer(localSha)}</code>).`); return }

  const ahead = (() => { try { return git(['rev-list', '--count', `${localSha}..${remoteSha}`]) } catch { return '?' } })()
  if (checkOnly) {
    await progress(`⬆️ Update available: <code>${shortVer(localSha)}</code> → <code>${shortVer(remoteSha)}</code> (${ahead} commit(s)).\nSend /update to apply.`)
    return
  }

  // 2. Apply: hard-reset the managed clone to the remote tip.
  try { git(['reset', '--hard', `origin/${branch}`]) } catch (e) { await notify(`❌ Update: git reset failed.\n<code>${String(e).slice(0, 300)}</code>`); return }
  let newVer = '0.0.0'
  try { newVer = JSON.parse(readFileSync(join(MP, '.claude-plugin', 'plugin.json'), 'utf8')).version ?? newVer } catch {}
  newSha = git(['rev-parse', 'HEAD'])

  const oldVer = newestSemverDir()
  const oldGitref = oldVer ? (() => { try { return readFileSync(join(CACHE_BASE, oldVer, '.gitref'), 'utf8').trim() } catch { return oldVer } })() : '(none)'
  await progress(`♻️ Building <b>v${newVer}</b> (<code>${shortVer(newSha)}</code>)…`)

  // 3. Build into a temp dir from the clone (everything except .git / node_modules / tests), install deps.
  mkdirSync(CACHE_BASE, { recursive: true })
  mkdirSync(BACKUP_BASE, { recursive: true })
  const tmp = join(CACHE_BASE, `.build-${process.pid}`)
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  try {
    cpSync(MP, tmp, {
      recursive: true,
      filter: (src) => {
        const b = src.split('/').pop() ?? ''
        if (b === '.git' || b === 'node_modules') return false
        if (/\.test\.ts$/.test(b)) return false
        return true
      },
    })
    writeFileSync(join(tmp, '.gitref'), newSha + '\n', { mode: 0o644 })
    execSync('bun install --no-summary', { cwd: tmp, stdio: 'ignore' })
    // Type-check the new daemon before we dare run it.
    execSync('bun build daemon.ts --target=bun >/dev/null', { cwd: tmp })
  } catch (e) {
    try { rmSync(tmp, { recursive: true, force: true }) } catch {}
    await notify(`❌ Update: build/type-check failed — <b>not</b> applied, still on v${oldVer ?? '?'}.\n<code>${String(e).slice(0, 400)}</code>`)
    return
  }

  // 4. Swap the new dir in (backing up anything already at that version).
  const target = join(CACHE_BASE, newVer)
  let preBackup: string | null = null
  if (existsSync(target)) {
    preBackup = join(BACKUP_BASE, `${newVer}-pre-${Date.now()}`)
    renameSync(target, preBackup)
  }
  renameSync(tmp, target)

  // 5. Restart on the new dir and health-check.
  await progress(`♻️ Restarting on <b>v${newVer}</b>…`)
  const offset = logSize()
  try { writeFileSync(PENDING_EVENTS, '') } catch {}   // don't replay buffered inbound across the restart
  killBridge()
  await sleep(1200)
  launchBridge(target)

  if (await waitHealthy(offset)) {
    const synced = syncInstalledCopies()
    const extra = synced.length ? `\n\nAlso ${synced.join('; ')}. Start a new session to pick up convention changes.` : ''
    await sendFresh(`✅ Updated <code>${shortVer(oldGitref)}</code> → <code>${shortVer(newSha)}</code> (<b>v${newVer}</b>).${extra}`)
    // Prune build/backups, keep the immediate predecessor as a manual fallback.
    if (preBackup) { try { rmSync(preBackup, { recursive: true, force: true }) } catch {} }
    return
  }

  // 6. Rollback.
  await progress('⚠️ New build didn’t come up — rolling back…')
  killBridge()
  await sleep(1000)
  try { rmSync(target, { recursive: true, force: true }) } catch {}
  if (preBackup) { try { renameSync(preBackup, target) } catch {} }   // restore same-version predecessor
  const rbDir = newestSemverDir()
  const rbOffset = logSize()
  if (rbDir) launchBridge(join(CACHE_BASE, rbDir))
  const rbOk = await waitHealthy(rbOffset)
  await notify(rbOk
    ? `↩️ Rolled back to <b>v${rbDir}</b> (<code>${shortVer(oldGitref)}</code>). The update was not applied.`
    : `🛑 Rollback also failed to come up. Manual recovery needed — check <code>daemon.log</code>.`)
}

main().catch(async e => { await notify(`❌ Update crashed: <code>${String(e).slice(0, 300)}</code>`) })
