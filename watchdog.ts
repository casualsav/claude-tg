#!/usr/bin/env bun
// Keep the telegram daemon alive between Claude sessions. The daemon is spawned detached so
// it survives a session closing, but nothing restarts it if it crashes while no session is
// running — this loop does. Self-bootstrapped by ensure-daemon.ts (the SessionStart hook)
// and cross-guarded by the daemon itself, so neither staying down needs a new session.
// Singleton via watchdog.pid; idempotent — only spawns the daemon when its socket is dead.
// Also caps the shared daemon.log so it can't grow without bound.
import net from 'node:net'
import { spawn } from 'node:child_process'
import { readdirSync, statSync, openSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SOCKET_PATH, STATE_DIR, WATCHDOG_PID_FILE, DAEMON_LOG_FILE } from './common.ts'

const CHECK_MS = 20_000
const REAP_MS = 5_000
const LOG_MAX_BYTES = 10 * 1024 * 1024
const LOG_KEEP_BYTES = 2 * 1024 * 1024

// ---- Zombie reaper ("tini-lite") ----
// PID 1 on this host is `sleep infinity`, which never wait()s — so any of our bun processes
// (daemon/update/transcription) that gets orphaned re-parents to PID 1 and becomes a PERMANENT
// zombie (this is what piled up 100+ defunct `bun` entries during debugging). Fix: make the
// watchdog a child-subreaper so future orphaned descendants re-parent to US instead of PID 1,
// then waitpid() them. This lives in the WATCHDOG, never the daemon: the daemon's constant exec()
// calls resolve via libuv's own SIGCHLD/waitpid, and a waitpid(-1) there would steal those and
// hang every tmux capture. The watchdog makes no exec() calls and never awaits its daemon child's
// exit, so reaping is safe here. (Already-orphaned PID-1 zombies can't be adopted retroactively —
// those need a reboot — but no new ones accumulate.)
function setupReaper(): () => void {
  try {
    const { dlopen, FFIType, ptr } = require('bun:ffi') as typeof import('bun:ffi')
    const libc = dlopen('libc.so.6', {
      prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
      waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    })
    libc.symbols.prctl(36 /* PR_SET_CHILD_SUBREAPER */, 1, 0, 0, 0)
    const status = new Int32Array(1)
    return () => {
      try { let n = 0; while (libc.symbols.waitpid(-1, ptr(status), 1 /* WNOHANG */) > 0 && ++n < 4096) { /* reap all ready */ } } catch {}
    }
  } catch (e) {
    process.stderr.write(`watchdog: child-reaper unavailable (${e}) — orphans won't be auto-reaped\n`)
    return () => {}
  }
}
const reapZombies = setupReaper()

// Bail if another watchdog with a live pid already owns the post.
try {
  const pid = parseInt(readFileSync(WATCHDOG_PID_FILE, 'utf8'), 10)
  if (pid > 1 && pid !== process.pid) {
    process.kill(pid, 0)
    process.stderr.write(`watchdog: already running (pid ${pid}), exiting\n`)
    process.exit(0)
  }
} catch {}
// The "usr1" line is a capability marker: ensure-daemon SIGUSR1s a watchdog that advertises it
// (immediate daemon respawn) and replaces one that doesn't — an unhandled SIGUSR1 would kill it.
try { writeFileSync(WATCHDOG_PID_FILE, `${process.pid}\nusr1`, { mode: 0o600 }) } catch {}

// Newest plugin-cache copy of daemon.ts (version dirs sort ascending; take the last).
function findDaemon(): string | null {
  const base = join(homedir(), '.claude', 'plugins', 'cache', 'better-claude-plugins', 'telegram')
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

function socketAlive(): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createConnection(SOCKET_PATH)
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
    setTimeout(() => { s.destroy(); resolve(false) }, 1500)
  })
}

// Cap the log: when it crosses the limit, keep the tail (recent context for the next crash)
// and drop the rest. The big read only happens on the rare draw that's over the limit.
function rotateLog(): void {
  try {
    if (statSync(DAEMON_LOG_FILE).size <= LOG_MAX_BYTES) return
    const data = readFileSync(DAEMON_LOG_FILE)
    writeFileSync(DAEMON_LOG_FILE, data.subarray(data.length - LOG_KEEP_BYTES), { mode: 0o600 })
  } catch {}
}

function spawnDaemon(): void {
  const daemonPath = findDaemon()
  if (!daemonPath) { process.stderr.write('watchdog: daemon.ts not found in plugin cache\n'); return }
  const log = openSync(DAEMON_LOG_FILE, 'a')
  const child = spawn('bun', [daemonPath], { detached: true, stdio: ['ignore', log, log], env: process.env })
  child.unref()
  process.stderr.write(`watchdog: daemon down — launched ${daemonPath} (pid ${child.pid})\n`)
}

async function tick(): Promise<void> {
  rotateLog()
  if (!(await socketAlive())) spawnDaemon()
}

process.on('SIGTERM', () => {
  try { if (parseInt(readFileSync(WATCHDOG_PID_FILE, 'utf8'), 10) === process.pid) unlinkSync(WATCHDOG_PID_FILE) } catch {}
  process.exit(0)
})

process.on('SIGUSR1', () => void tick())   // ensure-daemon's nudge: the daemon is down — respawn it NOW
process.stderr.write(`watchdog: up (pid ${process.pid}), checking every ${CHECK_MS / 1000}s\n`)
reapZombies()                                   // sweep any orphans already adopted at startup
setInterval(reapZombies, REAP_MS).unref?.()     // and keep reaping re-parented orphans
try { process.on('SIGCHLD', reapZombies) } catch {}   // reap the instant an adopted orphan exits (sweep backstops)
await tick()
setInterval(() => void tick(), CHECK_MS)
