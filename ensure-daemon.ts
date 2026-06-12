#!/usr/bin/env bun
// Ensure the telegram daemon(s) AND their watchdog(s) are running, independent of any MCP shim.
// Run from a SessionStart hook. Idempotent: only spawns what's actually down.
//
// Multi-instance: a user can run several independent bridges (different bots) on one machine, each
// in its own state dir `~/.claude/channels/telegram` (slot 1) or `telegram<N>` (slot N), with its
// own .env/token/access.json/socket. We enumerate every such dir that holds a bot token and ensure
// a daemon + watchdog for each, scoped via TELEGRAM_STATE_DIR. Slots with no token are skipped (an
// unconfigured bridge has nothing to poll). Each daemon is spawned detached (survives the session);
// each watchdog keeps its own daemon alive between sessions / after a crash.
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { readdirSync, openSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const CHANNELS_DIR = join(homedir(), '.claude', 'channels')

// Newest plugin-cache copy of daemon.ts (version dirs sort ascending; take the last).
// Marketplace id: pocket-claude after the rename; falls back to the old id on machines that
// haven't re-added the marketplace yet.
const MKT_IDS = ['pocket-claude', 'better-claude-plugins']
function findDaemon(): string | null {
  const cacheRoot = join(homedir(), '.claude', 'plugins', 'cache')
  const base = MKT_IDS.map(n => join(cacheRoot, n, 'telegram')).find(p => existsSync(p))
    ?? join(cacheRoot, MKT_IDS[0], 'telegram')
  let versions: string[]
  // Only real version dirs (x.y.z) — never a backup/temp dir like 0.0.6.bak-… or .build-…,
  // which would otherwise sort highest and get launched. Numeric sort so 0.0.10 > 0.0.9.
  try { versions = readdirSync(base).filter(v => /^\d+\.\d+\.\d+$/.test(v)) } catch { return null }
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  for (const v of versions.reverse()) {
    const p = join(base, v, 'daemon.ts')
    if (existsSync(p)) return p
  }
  return null
}

// Every configured bridge instance: a `telegram` or `telegram-<id>` state dir whose .env carries a
// bot token (id is a number or a name — `telegram-2`, `telegram-work`; legacy `telegram<id>` too).
function instanceDirs(): string[] {
  let names: string[]
  try { names = readdirSync(CHANNELS_DIR) } catch { return [] }
  const dirs: string[] = []
  for (const name of names) {
    if (!/^telegram([-_]?[A-Za-z0-9]+)?$/.test(name)) continue
    const dir = join(CHANNELS_DIR, name)
    try {
      const env = readFileSync(join(dir, '.env'), 'utf8')
      if (/^\s*TELEGRAM_BOT_TOKEN\s*=\s*\S/m.test(env)) dirs.push(dir)
    } catch {}   // no .env / unreadable → not a configured instance
  }
  return dirs
}

function socketAlive(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createConnection(socketPath)
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
    setTimeout(() => { s.destroy(); resolve(false) }, 1500)
  })
}

// `?? ''` keeps the type plain string for the closures below (control-flow narrowing from the
// module-level exit guard doesn't reach into functions); the guard still exits on not-found.
const daemonPath = findDaemon() ?? ''
if (!daemonPath) { process.stderr.write('ensure-daemon: daemon.ts not found in plugin cache\n'); process.exit(1) }
const daemonDir = dirname(daemonPath)
const watchdogPath = join(daemonDir, 'watchdog.ts')

// Deps live in the cache dir and are shared by all instances, so bootstrap them once. A partial
// cache copy (no node_modules) makes `bun daemon.ts` auto-install on the fly, which floats grammy
// to a build that crashes with `EACCES … resolving 'debug'`. Drop a pinned manifest + install
// against it so the known-good versions win. Idempotent: skipped when deps are already present.
function ensureDeps(log: number): void {
  const pkgPath = join(daemonDir, 'package.json')
  if (!existsSync(pkgPath)) {
    writeFileSync(pkgPath, JSON.stringify({
      name: 'claude-channel-telegram-daemon',
      private: true,
      type: 'module',
      dependencies: { grammy: '1.41.1', '@modelcontextprotocol/sdk': '^1.0.0' },
    }, null, 2) + '\n', { mode: 0o644 })
    process.stderr.write(`ensure-daemon: wrote pinned package.json to ${daemonDir}\n`)
  }
  if (!existsSync(join(daemonDir, 'node_modules', 'grammy'))) {
    process.stderr.write(`ensure-daemon: installing daemon deps in ${daemonDir}\n`)
    const r = spawnSync('bun', ['install', '--no-summary'], { cwd: daemonDir, stdio: ['ignore', log, log] })
    if (r.status !== 0) process.stderr.write(`ensure-daemon: bun install exited ${r.status}\n`)
  }
}

// Bring up one instance (daemon + watchdog) scoped to its state dir. Only spawns what's down.
//
// Zombie hygiene: the WATCHDOG is the child-subreaper that adopts + reaps orphaned bridge
// processes. A daemon spawned HERE re-parents to PID 1 when this hook exits — and a PID 1 that
// never wait()s (`sleep infinity` in a container) keeps it as a PERMANENT zombie after its next
// restart, along with everything it leaked. So bring the watchdog up first and let IT spawn the
// daemon inside its own subtree: a fresh watchdog ticks on boot; a running one gets a SIGUSR1
// "check now". A watchdog whose pid file lacks the `usr1` capability marker predates that handler
// (an unhandled SIGUSR1 would kill it) — replace it with the current build instead of signaling.
async function ensureInstance(stateDir: string, log: number): Promise<void> {
  const env = { ...process.env, TELEGRAM_STATE_DIR: stateDir }
  const daemonDown = !(await socketAlive(join(stateDir, 'daemon.sock')))
  if (existsSync(watchdogPath)) {
    const pidFile = join(stateDir, 'watchdog.pid')
    let wdPid = 0, canUsr1 = false
    try {
      const raw = readFileSync(pidFile, 'utf8')
      wdPid = parseInt(raw, 10)
      canUsr1 = /\busr1\b/.test(raw)
      if (wdPid > 1) process.kill(wdPid, 0)
      else wdPid = 0
    } catch { wdPid = 0 }
    if (wdPid && daemonDown && !canUsr1) {
      try { process.kill(wdPid, 'SIGTERM') } catch {}
      await new Promise(r => setTimeout(r, 300))   // let it unlink its pid file so the new one boots
      wdPid = 0
      process.stderr.write(`ensure-daemon: replaced pre-usr1 watchdog for ${stateDir}\n`)
    }
    if (!wdPid) {
      const child = spawn('bun', [watchdogPath], { detached: true, stdio: ['ignore', log, log], env })
      child.unref()
      process.stderr.write(`ensure-daemon: launched watchdog for ${stateDir} (pid ${child.pid}) — it brings up the daemon\n`)
    } else if (daemonDown) {
      try { process.kill(wdPid, 'SIGUSR1') } catch {}
      process.stderr.write(`ensure-daemon: daemon down for ${stateDir} — nudged watchdog ${wdPid} to respawn it\n`)
    }
    return
  }
  // No watchdog in this cache (very old build) — spawn the daemon directly, as before.
  if (daemonDown) {
    const child = spawn('bun', [daemonPath], { detached: true, stdio: ['ignore', log, log], env })
    child.unref()
    process.stderr.write(`ensure-daemon: launched daemon ${daemonPath} for ${stateDir} (pid ${child.pid})\n`)
  }
}

const dirs = instanceDirs()   // every configured (token-bearing) instance dir; all exist
if (dirs.length === 0) process.exit(0)   // nothing configured yet → nothing to launch

ensureDeps(openSync(join(dirs[0], 'daemon.log'), 'a'))   // deps are shared (cache dir) — bootstrap once
for (const dir of dirs) {
  await ensureInstance(dir, openSync(join(dir, 'daemon.log'), 'a'))   // per-instance log in its state dir
}

process.exit(0)
