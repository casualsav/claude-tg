#!/usr/bin/env bun
// One-shot deploy: bump version → sync the checkout into the plugin cache + marketplace mirror →
// type-check in the cache → restart the live daemon → verify it came up on the new code.
//
// Why this exists: the live daemon runs from ~/.claude/plugins/cache, NOT this checkout, and the
// cache is keyed by the version string. Shipping code without bumping `version` in BOTH
// .claude-plugin/plugin.json and marketplace.json leaves every install running its cached old
// build forever (Claude Code sees "version already installed" and never re-copies). This script
// makes that ritual atomic and unforgettable.
//
//   bun run deploy            # bump patch (0.0.56 → 0.0.57), sync, type-check, restart
//   bun run deploy minor      # 0.0.56 → 0.1.0
//   bun run deploy major      # 0.0.56 → 1.0.0
//   bun run deploy 0.1.2      # set an explicit version
//   bun run deploy --no-restart            # ship to cache but leave the running daemon alone
//   bun run deploy --commit "msg"          # also git add -A && commit && push after a clean deploy
//
// Type-check runs against the cache copy BEFORE the checkout's version files are touched, so a
// failed build never mutates your working tree.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const GRAMMY_PIN = '1.41.1' // keep in sync with package.json + ensure-daemon.ts

const REPO = dirname(import.meta.dir) // scripts/ → repo root
// Marketplace id (also the plugin-cache dir name).
const MKT_ID = 'claude-tg'
const CACHE_BASE = join(homedir(), '.claude', 'plugins', 'cache', MKT_ID, 'telegram')
const MKT = join(homedir(), '.claude', 'plugins', 'marketplaces', MKT_ID)
const DAEMON_PID = join(homedir(), '.claude', 'channels', 'telegram', 'daemon.pid')
const PLUGIN_JSON = join('.claude-plugin', 'plugin.json')
const MARKET_JSON = join('.claude-plugin', 'marketplace.json')

function die(msg: string): never { console.error(`\n✗ ${msg}`); process.exit(1) }
function step(msg: string) { console.log(`• ${msg}`) }

function sh(cmd: string, args: string[], cwd?: string) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8' })
}

// `origin` (casualsav/claude-tg) is the single source of truth AND the marketplace end-user installs
// pull from — so a plain `git push` to origin both ships the code and releases it. No mirror/dual-push.

// ---- args ----
const argv = process.argv.slice(2)
const noRestart = argv.includes('--no-restart')
const commitIdx = argv.indexOf('--commit')
const commitMsg = commitIdx >= 0 ? argv[commitIdx + 1] : null
if (commitIdx >= 0 && !commitMsg) die('--commit needs a message: --commit "ui: …"')
const bumpArg = argv.find(a => !a.startsWith('--') && a !== commitMsg) ?? 'patch'

// ---- compute the new version ----
const VERSION_RE = /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/
const pluginSrc = readFileSync(join(REPO, PLUGIN_JSON), 'utf8')
const curMatch = pluginSrc.match(VERSION_RE)
if (!curMatch) die(`couldn't find a version in ${PLUGIN_JSON}`)
const cur = curMatch[2]

function nextVersion(from: string, kind: string): string {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind
  const [maj, min, pat] = from.split('.').map(Number)
  if (kind === 'major') return `${maj + 1}.0.0`
  if (kind === 'minor') return `${maj}.${min + 1}.0`
  if (kind === 'patch') return `${maj}.${min}.${pat + 1}`
  die(`unknown bump "${kind}" — use patch | minor | major | x.y.z`)
}
const next = nextVersion(cur, bumpArg)
console.log(`\n🚀 deploy ${cur} → ${next}\n`)

// ---- the exact set of files that ships (git-tracked) ----
const lsf = sh('git', ['ls-files', '-z'], REPO)
if (lsf.status !== 0) die(`git ls-files failed: ${lsf.stderr}`)
const tracked = lsf.stdout.split('\0').filter(Boolean)

// Replace only the version string (regex, not JSON round-trip) so file formatting/escaping is kept.
function patchVersion(path: string, to: string) {
  const src = readFileSync(path, 'utf8')
  if (!VERSION_RE.test(src)) die(`version string not found in ${path}`)
  const out = src.replace(VERSION_RE, `$1${to}$3`)
  if (out !== src) Bun.write(path, out) // already at target after a mirror sync → harmless no-op
}

function syncTrackedInto(dest: string) {
  mkdirSync(dest, { recursive: true })
  // Stream the tracked files through tar (REPO → dest). tar preserves each file's relative subdir
  // (like `cp --parents`) but OVERWRITES unconditionally — `cp -f`/`--remove-destination` proved
  // unreliable here, intermittently failing "cannot create regular file: File exists" when the dest
  // already holds a file from the cloned cache dir. The NUL-separated list goes via a temp file so
  // any filename is handled safely; pipefail makes a failing producer tar abort the deploy.
  const listFile = join(tmpdir(), `bct-deploy-${process.pid}-${Date.now()}.list`)
  writeFileSync(listFile, tracked.join('\0'))
  try {
    const r = spawnSync('bash', ['-c',
      'set -o pipefail; tar -C "$1" --null -T "$2" -cf - | tar -C "$3" -xf -',
      'bash', REPO, listFile, dest], { encoding: 'utf8' })
    if (r.status !== 0) die(`tar sync into ${dest} failed: ${r.stderr || r.stdout}`)
  } finally {
    try { rmSync(listFile, { force: true }) } catch {}
  }
}

// ---- 1. prepare the new cache dir (clone deps from the newest existing version, if any) ----
const newCache = join(CACHE_BASE, next)
const freshCache = !existsSync(newCache)
if (freshCache) {
  const versions = (() => {
    try { return readdirSync(CACHE_BASE).filter(v => /^\d+\.\d+\.\d+$/.test(v)) } catch { return [] }
  })().sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const seed = versions.at(-1)
  if (seed) {
    step(`cloning cache ${seed} → ${next} (carries node_modules/bun.lock)`)
    const r = sh('cp', ['-a', join(CACHE_BASE, seed), newCache])
    if (r.status !== 0) die(`cloning cache dir failed: ${r.stderr}`)
  } else {
    step(`no existing cache version to clone — creating ${next} from scratch`)
    mkdirSync(newCache, { recursive: true })
  }
}

// ---- 2. sync the checkout into the cache copy, then stamp its manifests to the new version ----
step(`syncing ${tracked.length} tracked files → cache/${next}`)
syncTrackedInto(newCache)
patchVersion(join(newCache, PLUGIN_JSON), next)
patchVersion(join(newCache, MARKET_JSON), next)

// ---- 3. make sure deps are present in the cache (mirror ensure-daemon's self-heal) ----
const pkgPath = join(newCache, 'package.json')
if (!existsSync(pkgPath)) {
  Bun.write(pkgPath, JSON.stringify({
    name: 'claude-channel-telegram-daemon', private: true, type: 'module',
    dependencies: { grammy: GRAMMY_PIN, '@modelcontextprotocol/sdk': '^1.0.0' },
  }, null, 2) + '\n')
}
if (!existsSync(join(newCache, 'node_modules', 'grammy'))) {
  step('installing daemon deps in the cache (grammy ' + GRAMMY_PIN + ')')
  const r = sh('bun', ['install', '--no-summary'], newCache)
  if (r.status !== 0) die(`bun install in cache failed:\n${r.stderr}`)
}

// ---- 4. type-check in the cache (grammy resolves there). Failure here never touches the checkout ----
step('type-checking (bun build daemon.ts --target=bun)')
const build = sh('bun', ['build', 'daemon.ts', '--target=bun'], newCache)
if (build.status !== 0) {
  if (freshCache) rmSync(newCache, { recursive: true, force: true })
  die(`type-check failed — checkout left untouched:\n${build.stderr || build.stdout}`)
}
// bun build only transpiles — it has shipped unimported identifiers before. The real typecheck
// runs in the CHECKOUT (same files just synced; typescript + @types/bun are devDeps there).
step('type-checking (tsc --noEmit)')
const tsc = sh('bunx', ['tsc', '--noEmit'], REPO)
if (tsc.status !== 0) {
  if (freshCache) rmSync(newCache, { recursive: true, force: true })
  die(`tsc failed — checkout left untouched:\n${(tsc.stdout || tsc.stderr).slice(0, 4000)}`)
}
step('type-check OK')
// Unit tests gate the ship too — they're fast (<1s) and cover the extracted domains.
step('running unit tests (bun test)')
const tests = sh('bun', ['test'], REPO)
if (tests.status !== 0) {
  if (freshCache) rmSync(newCache, { recursive: true, force: true })
  die(`tests failed — checkout left untouched:\n${(tests.stderr || tests.stdout).slice(-4000)}`)
}
step('tests OK')

// ---- 5. build passed: now stamp the checkout + marketplace mirror ----
patchVersion(join(REPO, PLUGIN_JSON), next)
patchVersion(join(REPO, MARKET_JSON), next)
step(`bumped checkout ${PLUGIN_JSON} + ${MARKET_JSON} → ${next}`)
if (existsSync(MKT)) {
  syncTrackedInto(MKT)
  patchVersion(join(MKT, PLUGIN_JSON), next)
  patchVersion(join(MKT, MARKET_JSON), next)
  step('synced marketplace mirror')
}

// ---- 6. restart the live daemon (the watchdog respawns it from the newest cache version) ----
function cmdlineOf(pid: number): string {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ') } catch {}
  const r = sh('ps', ['-p', String(pid), '-o', 'args=']); return r.status === 0 ? r.stdout.trim() : ''
}
if (noRestart) {
  step('--no-restart: leaving the running daemon as-is')
} else if (!existsSync(DAEMON_PID)) {
  step('no daemon.pid found — nothing running to restart (a session start will launch the new code)')
} else {
  const oldPid = parseInt(readFileSync(DAEMON_PID, 'utf8').trim(), 10)
  step(`restarting daemon (old pid ${oldPid})`)
  try { process.kill(oldPid, 'SIGTERM') } catch {}
  // Wait for the old process to actually exit (and release the socket) so ensure-daemon sees it
  // down. Then proactively respawn from the new cache rather than waiting on the watchdog's lazy
  // 20s poll — ensure-daemon is idempotent and gates on socket liveness, so it won't race the
  // watchdog into a double-spawn.
  for (let i = 0; i < 20; i++) { Bun.sleepSync(250); try { process.kill(oldPid, 0) } catch { break } }
  const ed = join(newCache, 'ensure-daemon.ts')
  if (existsSync(ed)) { step('respawning via ensure-daemon'); sh('bun', [ed], newCache) }
  let newPid = 0
  for (let i = 0; i < 60; i++) { // up to ~30s: covers bun startup + the watchdog fallback path
    Bun.sleepSync(500)
    let p = 0
    try { p = parseInt(readFileSync(DAEMON_PID, 'utf8').trim(), 10) } catch {}
    if (p && p !== oldPid) { try { process.kill(p, 0); newPid = p; break } catch {} }
  }
  if (!newPid) die(`daemon did not come back within 30s — check ~/.claude/channels/telegram for logs`)
  const line = cmdlineOf(newPid)
  if (!line.includes(`/${next}/`)) {
    console.error(`⚠ daemon respawned (pid ${newPid}) but not from cache/${next}:\n  ${line}`)
    console.error(`  (a stale .pid or a higher cache version may be winning — check ${CACHE_BASE})`)
  } else {
    step(`daemon up: pid ${newPid} on cache/${next}`)
  }
}

// ---- 7. optional commit + push ----
if (commitMsg) {
  step('committing + pushing')
  const add = sh('git', ['add', '-A'], REPO); if (add.status !== 0) die(`git add failed: ${add.stderr}`)
  const body = `${commitMsg}\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
  const c = sh('git', ['commit', '-q', '-m', body], REPO); if (c.status !== 0) die(`git commit failed: ${c.stderr || c.stdout}`)
  const p = sh('git', ['push'], REPO); if (p.status !== 0) die(`git push failed: ${p.stderr}`)
  step('pushed → origin (releases to installs)')
}

console.log(`\n✓ deployed ${next}${commitMsg ? ' (committed + pushed)' : ''}`)
if (!commitMsg) console.log(`  next: git add -A && git commit -m "…(v${next})" && git push`)
