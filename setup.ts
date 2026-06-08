#!/usr/bin/env bun
// Non-agentic installer for the off-MCP Telegram bridge. The agentic off-mcp/INSTALL.md
// stays as the escape hatch for oddball machines; this wizard handles the common 99%
// deterministically: check deps (and install the missing ones), interview, size the local
// Whisper model to the hardware, write config, wire settings.json/statusline/CLAUDE.md,
// verify, and launch the bridge — all before the single Claude Code restart.
//
// Run from the repo checkout: `bun setup.ts` (the install.sh bootstrap ensures bun first).
import { createInterface } from 'node:readline'
import { stdin, stdout } from 'node:process'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, appendFileSync, openSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { STATE_DIR, ENV_FILE, ACCESS_FILE, DAEMON_LOG_FILE, DAEMON_PID_FILE, WATCHDOG_PID_FILE } from './common.ts'
import { probeHardware, recommendWhisper, describeHardware, WHISPER_MODELS, WHISPER_INFO, type WhisperModel } from './hardware.ts'

const REPO = import.meta.dir
const SETTINGS = join(homedir(), '.claude', 'settings.json')
const GLOBAL_CLAUDE_MD = join(homedir(), '.claude', 'CLAUDE.md')
const STATUSLINE_DEST = join(homedir(), '.claude', 'statusline-command.sh')
const MARKER_BEGIN = '<!-- BEGIN better-claude-telegram (off-mcp convention — auto-synced by /update; edits inside are overwritten) -->'
const MARKER_END = '<!-- END better-claude-telegram -->'

// ---- tiny UI helpers ----
const C = { dim: (s: string) => `\x1b[2m${s}\x1b[0m`, b: (s: string) => `\x1b[1m${s}\x1b[0m`,
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`, warn: (s: string) => `\x1b[33m${s}\x1b[0m`, err: (s: string) => `\x1b[31m${s}\x1b[0m` }
// A line reader that survives EOF (Bun's readline/promises question() closes after one read).
// We buffer 'line' events and hand them out on demand; after the stream closes, further asks
// resolve to '' (so a short-fed pipe degrades to defaults instead of throwing).
const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY })
const _lineBuf: string[] = []
const _waiters: ((l: string) => void)[] = []
let _closed = false
rl.on('line', l => { const w = _waiters.shift(); if (w) w(l); else _lineBuf.push(l) })
rl.on('close', () => { _closed = true; while (_waiters.length) _waiters.shift()!('') })
function ask(q: string): Promise<string> {
  stdout.write(`${q} `)
  return new Promise(res => {
    if (_lineBuf.length) res(_lineBuf.shift()!)
    else if (_closed) res('')
    else _waiters.push(res)
  })
}
async function askYN(q: string, def = true): Promise<boolean> {
  const a = (await ask(`${q} ${def ? '[Y/n]' : '[y/N]'}`)).trim().toLowerCase()
  return a === '' ? def : a.startsWith('y')
}
async function askChoice<T extends string>(q: string, opts: { value: T; label: string }[], def: T): Promise<T> {
  console.log(q)
  opts.forEach((o, i) => console.log(`  ${i + 1}. ${o.label}${o.value === def ? C.dim(' (recommended)') : ''}`))
  const a = (await ask('>')).trim()
  if (!a) return def
  const n = parseInt(a, 10)
  if (n >= 1 && n <= opts.length) return opts[n - 1].value
  const m = opts.find(o => o.value === a.toLowerCase())
  return m ? m.value : def
}
function section(t: string) { console.log(`\n${C.b(`── ${t} ──`)}`) }

// ---- shell helpers ----
function which(cmd: string): boolean {
  return spawnSync(platform() === 'win32' ? 'where' : 'command', platform() === 'win32' ? [cmd] : ['-v', cmd],
    { shell: true, stdio: 'ignore' }).status === 0
}
type RunResult = { ok: boolean; out: string; err: string }
function run(cmd: string, args: string[], opts: { timeout?: number } = {}): RunResult {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout ?? 600_000 })
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' }
}
const hasSudo = () => which('sudo') && spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' }).status === 0

// Detect the system package manager and how to install a package with it. Returns null if
// none is found (e.g. a locked-down box) — the caller then routes to the deps fallback.
function pkgInstaller(): { name: string; cmd: string[]; needsSudo: boolean } | null {
  if (platform() === 'darwin' && which('brew')) return { name: 'brew', cmd: ['brew', 'install'], needsSudo: false }
  const linux: [string, string[]][] = [
    ['apt-get', ['apt-get', 'install', '-y']],
    ['dnf', ['dnf', 'install', '-y']],
    ['pacman', ['pacman', '-S', '--noconfirm']],
    ['zypper', ['zypper', 'install', '-y']],
    ['apk', ['apk', 'add']],
  ]
  for (const [bin, cmd] of linux) if (which(bin)) return { name: bin, cmd, needsSudo: true }
  if (which('brew')) return { name: 'brew', cmd: ['brew', 'install'], needsSudo: false } // linuxbrew
  return null
}

// Best-effort install of a system package. true on success. Handles apt's update step and
// prefixes sudo when the manager needs it (and sudo is available).
function installPkg(pkg: string): boolean {
  const pm = pkgInstaller()
  if (!pm) return false
  if (pm.needsSudo && !hasSudo()) return false
  const wrap = (c: string[]) => (pm.needsSudo ? ['sudo', ...c] : c)
  if (pm.name === 'apt-get') run('sudo', ['apt-get', 'update'], { timeout: 120_000 })
  console.log(C.dim(`  installing ${pkg} via ${pm.name}…`))
  const r = run(wrap([...pm.cmd, pkg])[0], wrap([...pm.cmd, pkg]).slice(1), { timeout: 300_000 })
  return r.ok && which(pkg === 'python3-venv' ? 'python3' : pkg)
}

// ---- deps + mode fallback ----
type Mode = 'off-mcp' | 'mcp'

// The crux the user asked for: when tmux can't be auto-installed, DON'T silently drop to MCP.
// Name the missing dep, offer to retry after they install it, and lay out the MCP trade-off
// (what the pin loses without a pane + the per-request token cost) so the choice is informed.
async function tmuxFallback(): Promise<Mode> {
  console.log(C.warn('\n⚠️  tmux is required for off-MCP mode and it could not be installed automatically.'))
  const pm = pkgInstaller()
  console.log(`\noff-MCP drives your Claude session through a tmux pane. Without tmux you have two options:\n`)
  console.log(C.b('  Option A — install tmux yourself, then re-run this installer (recommended):'))
  if (pm) console.log(`     ${pm.needsSudo ? 'sudo ' : ''}${pm.cmd.join(' ')} tmux${pm.needsSudo && !hasSudo() ? C.dim('   (needs sudo rights)') : ''}`)
  else console.log(`     install ${C.b('tmux')} with your system package manager (or conda-forge / a static binary into ~/.local/bin)`)
  console.log(`     then: ${C.b('bun setup.ts')}\n`)
  console.log(C.b('  Option B — use MCP mode instead (no tmux needed), at a cost:'))
  console.log(`     • ${C.b('Per-request token tax')}: ~700 tokens of MCP tool schemas ${C.b('plus')} an instruction`)
  console.log(`       block are injected on ${C.b('every')} request — off-MCP pays ${C.b('zero')}.`)
  console.log(`     • ${C.b('No live status pin')}: the pinned card's metrics (context %, cost, tokens,`)
  console.log(`       5h/7d limit bars) are read from the statusline in the tmux pane. Without tmux the`)
  console.log(`       pin falls back to a plain identity line. (Chat, files, reactions, permission`)
  console.log(`       buttons, the activity mirror, and all /commands still work — those are identical.)`)
  console.log(`     • You can run an MCP session ${C.b('inside')} tmux later to regain the full pin.\n`)
  const choice = await askChoice<'retry' | 'mcp'>('How would you like to proceed?', [
    { value: 'retry', label: 'I\'ll install tmux and re-run — exit now' },
    { value: 'mcp', label: 'Continue in MCP mode (accept the token cost + reduced pin)' },
  ], 'retry')
  if (choice === 'retry') { console.log(C.dim('\nNo changes made. Install tmux and re-run `bun setup.ts`.')); process.exit(0) }
  return 'mcp'
}

async function checkDeps(): Promise<Mode> {
  section('1 · Dependencies')
  // bun is implied — we're running under it. Sanity-check the rest.
  // python3 powers the statusline parser (and local Whisper). Not fatal — statusline degrades —
  // but try to get it.
  if (which('python3')) console.log(C.ok('  ✓ python3'))
  else {
    console.log(C.warn('  • python3 missing — needed for the status pin and local voice; trying to install…'))
    console.log(installPkg('python3') ? C.ok('    ✓ python3 installed') : C.warn('    ⚠ could not install python3 (the status pin will degrade; hosted voice still works)'))
  }
  // tmux is the gate for off-MCP.
  if (which('tmux')) { console.log(C.ok('  ✓ tmux')); return 'off-mcp' }
  console.log(C.warn('  • tmux missing — trying to install…'))
  if (installPkg('tmux')) { console.log(C.ok('    ✓ tmux installed')); return 'off-mcp' }
  return tmuxFallback()
}

// ---- interview ----
type VoiceBackend = 'off' | 'local' | 'groq' | 'openai'
type Config = {
  token: string
  telegramId: string | null
  voice: VoiceBackend
  whisperModel?: WhisperModel
  whisperDevice?: 'cpu' | 'cuda'
  groqKey?: string
  openaiKey?: string
  autoContinue: boolean
  botUsername?: string
}

// Validate a token against Telegram's getMe — confirms it's real and yields the bot's @username.
// Network failure (offline install) is non-fatal: returns { ok: true, offline: true } so we don't
// block setup, just skip the confirmation.
async function validateToken(token: string): Promise<{ ok: boolean; username?: string; offline?: boolean; error?: string }> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(8000) })
    const j = (await r.json()) as { ok: boolean; result?: { username?: string }; description?: string }
    return j.ok ? { ok: true, username: j.result?.username } : { ok: false, error: j.description }
  } catch { return { ok: true, offline: true } }
}

async function interview(): Promise<Config> {
  section('2 · Configuration')
  let token = '', botUsername: string | undefined
  while (!token) {
    token = (await ask('Telegram bot token (from @BotFather):')).trim()
    if (token === '' && _closed) { console.log(C.err('  no token provided — aborting.')); rl.close(); process.exit(1) }
    if (!/^\d+:[\w-]{30,}$/.test(token)) { console.log(C.warn('  that doesn\'t look like a bot token (e.g. 123456:ABC-...) — try again')); token = ''; continue }
    const v = await validateToken(token)
    if (v.offline) console.log(C.dim('  (offline — skipping the token check)'))
    else if (!v.ok) { console.log(C.warn(`  Telegram rejected that token: ${v.error || 'unauthorized'} — try again`)); token = ''; continue }
    else { botUsername = v.username; console.log(C.ok(`  ✓ token valid${botUsername ? ` — @${botUsername}` : ''}`)) }
  }
  console.log(C.dim('  Your numeric Telegram user ID locks the bot to you. Don\'t know it? DM @userinfobot.'))
  console.log(C.dim('  Leave blank to pair after setup instead (first DM returns a code to approve).'))
  const idRaw = (await ask('Your Telegram user ID (blank = pair later):')).trim()
  const telegramId = /^\d+$/.test(idRaw) ? idRaw : null

  const voice = await askChoice<VoiceBackend>('Transcribe inbound voice notes?', [
    { value: 'off', label: 'off — voice arrives as a placeholder' },
    { value: 'local', label: 'local — Whisper on this machine (private, free)' },
    { value: 'groq', label: 'groq — hosted Whisper (needs a GROQ_API_KEY)' },
    { value: 'openai', label: 'openai — hosted Whisper (needs an OPENAI_API_KEY)' },
  ], 'local')

  const cfg: Config = { token, telegramId, voice, autoContinue: true, botUsername }
  if (voice === 'local') await pickWhisperModel(cfg)
  if (voice === 'groq') cfg.groqKey = (await ask('GROQ_API_KEY:')).trim()
  if (voice === 'openai') cfg.openaiKey = (await ask('OPENAI_API_KEY:')).trim()
  cfg.autoContinue = await askYN('Auto-continue when a usage limit resets?', true)
  return cfg
}

// The hardware checker the user asked for: probe, recommend, then let them override.
async function pickWhisperModel(cfg: Config): Promise<void> {
  const probe = probeHardware()
  const rec = recommendWhisper(probe)
  console.log(`\n  ${C.b('Hardware:')} ${describeHardware(probe)}`)
  console.log(`  ${C.b('Recommended:')} ${C.ok(rec.model)} ${C.dim(`(${rec.device})`)} — ${rec.reason}`)
  const useRec = await askYN(`  Use ${rec.model}?`, true)
  if (useRec) { cfg.whisperModel = rec.model; cfg.whisperDevice = rec.device; return }
  console.log('  Pick a model (smallest/fastest → largest/most accurate):')
  WHISPER_MODELS.forEach((m, i) => {
    const info = WHISPER_INFO[m]
    console.log(`    ${i + 1}. ${m}${m === rec.model ? C.dim(' ★') : ''} ${C.dim(`~${info.weightsMB} MB · peak ~${info.peakRamGB} GB RAM`)}`)
  })
  const a = (await ask('  >')).trim()
  const n = parseInt(a, 10)
  cfg.whisperModel = (n >= 1 && n <= WHISPER_MODELS.length ? WHISPER_MODELS[n - 1] : rec.model)
  cfg.whisperDevice = probe.gpu ? (await askYN(`  Use the GPU (cuda) for ${cfg.whisperModel}?`, true) ? 'cuda' : 'cpu') : 'cpu'
}

// ---- config writes ----
function writeConfig(cfg: Config): void {
  section('3 · Writing config')
  mkdirSync(STATE_DIR, { recursive: true })
  const env: string[] = [`TELEGRAM_BOT_TOKEN=${cfg.token}`, 'TELEGRAM_TRANSCRIPT_OUTBOUND=1', `TELEGRAM_TRANSCRIBE=${cfg.voice}`]
  if (cfg.voice === 'local') {
    env.push(`TELEGRAM_TRANSCRIBE_MODEL=${cfg.whisperModel}`, `TELEGRAM_WHISPER_DEVICE=${cfg.whisperDevice}`, 'TELEGRAM_WHISPER_COMPUTE=int8')
  } else if (cfg.voice === 'groq') { env.push('TELEGRAM_TRANSCRIBE_MODEL=whisper-large-v3-turbo', `GROQ_API_KEY=${cfg.groqKey}`) }
  else if (cfg.voice === 'openai') { env.push('TELEGRAM_TRANSCRIBE_MODEL=whisper-1', `OPENAI_API_KEY=${cfg.openaiKey}`) }
  writeFileSync(ENV_FILE, env.join('\n') + '\n', { mode: 0o600 })
  chmodSync(ENV_FILE, 0o600)
  console.log(C.ok(`  ✓ ${ENV_FILE}`))

  const access: Record<string, unknown> = { dmPolicy: cfg.telegramId ? 'allowlist' : 'pairing',
    allowFrom: cfg.telegramId ? [cfg.telegramId] : [], groups: {}, pending: {}, renderMarkdown: true, autoContinue: cfg.autoContinue }
  writeFileSync(ACCESS_FILE, JSON.stringify(access, null, 2) + '\n', { mode: 0o600 })
  console.log(C.ok(`  ✓ ${ACCESS_FILE}${cfg.telegramId ? '' : C.dim(' (pairing mode — approve your first DM after setup)')}`))
}

// ---- settings.json + statusline + CLAUDE.md ----
function patchSettings(mode: Mode): void {
  section('4 · Wiring settings.json + statusline + CLAUDE.md')
  let s: any = {}
  if (existsSync(SETTINGS)) {
    try { s = JSON.parse(readFileSync(SETTINGS, 'utf8')) } catch { console.log(C.err(`  ✗ ${SETTINGS} isn't valid JSON — fix it and re-run`)); process.exit(1) }
    copyFileSync(SETTINGS, SETTINGS + '.bak')  // never clobber without a backup
    console.log(C.dim(`  (backed up existing settings.json → settings.json.bak)`))
  } else mkdirSync(join(homedir(), '.claude'), { recursive: true })

  s.extraKnownMarketplaces = { ...(s.extraKnownMarketplaces || {}),
    'better-claude-plugins': { source: { source: 'github', repo: 'casualsav/better-claude-telegram' } } }
  s.enabledPlugins = { ...(s.enabledPlugins || {}), 'telegram@better-claude-plugins': true }
  s.statusLine = { type: 'command', command: 'bash ~/.claude/statusline-command.sh' }
  const hookCmd = 'bun "$(ls -d ~/.claude/plugins/cache/better-claude-plugins/telegram/*/ 2>/dev/null | sort -V | tail -1)ensure-daemon.ts" >/dev/null 2>&1 || true'
  s.hooks = s.hooks || {}
  const sessionStart = (s.hooks.SessionStart ||= [])
  const already = JSON.stringify(sessionStart).includes('ensure-daemon.ts')
  if (!already) sessionStart.push({ hooks: [{ type: 'command', command: hookCmd }] })
  writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n')
  console.log(C.ok('  ✓ settings.json (marketplace + plugin + SessionStart hook + statusline)'))

  copyFileSync(join(REPO, 'statusline-command.sh'), STATUSLINE_DEST)
  chmodSync(STATUSLINE_DEST, 0o755)
  console.log(C.ok('  ✓ statusline-command.sh'))

  const convention = readFileSync(join(REPO, 'off-mcp', 'CLAUDE.md'), 'utf8').trim()
  const block = `${MARKER_BEGIN}\n${convention}\n${MARKER_END}\n`
  let md = existsSync(GLOBAL_CLAUDE_MD) ? readFileSync(GLOBAL_CLAUDE_MD, 'utf8') : ''
  if (md.includes(MARKER_BEGIN) && md.includes(MARKER_END)) {
    md = md.replace(new RegExp(`${escapeRe(MARKER_BEGIN)}[\\s\\S]*?${escapeRe(MARKER_END)}\\n?`), block)
  } else { md = (md.trimEnd() + '\n\n' + block).trimStart() }
  writeFileSync(GLOBAL_CLAUDE_MD, md)
  console.log(C.ok('  ✓ ~/.claude/CLAUDE.md (off-mcp convention)'))

  if (mode === 'off-mcp') {
    const bashrc = join(homedir(), process.env.SHELL?.includes('zsh') ? '.zshrc' : '.bashrc')
    // Two launch aliases. The adopt marker is `tmux set -p @tg_bridge 1` — a tmux PANE option, so
    // it never touches claude's args (decoupled from the autonomy flag, and immune to claude
    // rejecting unknown flags). The flag that follows only chooses the start mode:
    //  claude-tg   — --allow-dangerously-skip-permissions: starts in a normal mode (prompts relay
    //                to Telegram), bypass is switchable on demand from the /mode picker.
    //  claude-yolo — --dangerously-skip-permissions: starts in full bypass (autonomy from launch).
    const want: [string, string][] = [
      ['claude-tg', "alias claude-tg='tmux set -p @tg_bridge 1 2>/dev/null; claude --allow-dangerously-skip-permissions'"],
      ['claude-yolo', "alias claude-yolo='tmux set -p @tg_bridge 1 2>/dev/null; claude --dangerously-skip-permissions'"],
    ]
    const cur = existsSync(bashrc) ? readFileSync(bashrc, 'utf8') : ''
    const missing = want.filter(([n]) => !new RegExp(`alias ${n}=`).test(cur)).map(([, a]) => a)
    if (missing.length) { appendFileSync(bashrc, `\n${missing.join('\n')}\n`); console.log(C.ok(`  ✓ aliases → ${bashrc} (claude-tg, claude-yolo)`)) }
    else console.log(C.dim('  • claude-tg / claude-yolo aliases already present'))
  }
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ---- main ----
async function main(): Promise<void> {
  console.log(C.b('\n  better-claude-telegram — off-MCP setup\n'))
  const mode = await checkDeps()
  const cfg = await interview()
  writeConfig(cfg)
  patchSettings(mode)

  // Local Whisper: provision the venv + pre-pull weights now (so the first note is instant).
  if (cfg.voice === 'local') await provisionWhisper(cfg)

  // 5 · Verify the daemon works + auto-launch the bridge session, all BEFORE the restart.
  const verified = (mode === 'off-mcp') ? await verifyAndLaunch(cfg) : false

  section(verified ? '6 · Finish' : '5 · Next')
  if (verified) {
    console.log(C.ok('Verified — the daemon is polling Telegram and a bridge session is live.'))
    console.log(`  1. ${C.b('Message your bot now')} — it should reply.${cfg.telegramId ? '' : ' (First DM returns a pairing code; approve it with /telegram:access pair <code>.)'}`)
    console.log(`  2. ${C.b('Restart Claude Code once')} to hand the daemon over to the managed SessionStart hook.`)
    console.log(C.dim(`     (Your bridge session "${BRIDGE_SESSION}" keeps running — re-adopted automatically after the restart. Attach anytime: tmux attach -t ${BRIDGE_SESSION}.)`))
  } else {
    console.log('Config is written and the plugin is wired. To finish:')
    console.log(`  1. ${C.b('Restart Claude Code once')} — the SessionStart hook brings the daemon up, fully configured.`)
    if (mode === 'off-mcp') console.log(`  2. Launch work sessions with ${C.b('claude-tg')} inside ${C.b('tmux')} — the daemon auto-adopts the pane.`)
    else console.log(`  2. ${C.b('MCP mode:')} the wizard left the server enabled; launch work sessions with plain ${C.b('claude')}.`)
    console.log(`  3. Message your bot — it should reply.${cfg.telegramId ? '' : ' (Approve your first DM\'s pairing code with /telegram:access pair <code>.)'}`)
  }
  if (mode === 'off-mcp') {
    console.log(`\n${C.b('Launch aliases')} ${C.dim('(reload your shell or `source` the rc first):')}`)
    console.log(`  ${C.b('claude-tg')}    starts safe — permission prompts relay to Telegram; flip to full bypass on demand from /mode`)
    console.log(`  ${C.b('claude-yolo')}  starts in full bypass — autonomy from the first action`)
    console.log(C.dim('  Both bridge automatically (they tag the pane with the @tg_bridge tmux option). Run either inside tmux.'))
  }
  rl.close()
}

// ---- verify + bridge launch (off-MCP) ----
const BRIDGE_SESSION = 'claude-bridge'

// Bring the bridge up and prove it works before the user restarts: run the daemon straight from
// this checkout (the plugin cache doesn't exist until the restart downloads it), confirm it's
// polling, spawn a tmux work session, and confirm the daemon adopts it. Then stop our checkout
// daemon so the post-restart SessionStart hook owns the managed (cache) one — clean handoff, and
// the bridge tmux session persists across it. Best-effort: any miss degrades to manual next-steps.
async function verifyAndLaunch(cfg: Config): Promise<boolean> {
  section('5 · Verifying + launching the bridge')
  if (!which('claude')) { console.log(C.warn('  • the `claude` CLI isn\'t on PATH — skipping launch. Install Claude Code, then start a session with claude-tg.')); return false }
  if (!(await askYN('  Bring the bridge up and verify now?', true))) return false

  // grammy must resolve for the checkout daemon to start.
  if (!existsSync(join(REPO, 'node_modules', 'grammy'))) {
    console.log(C.dim('  installing daemon deps (bun install)…'))
    if (!run('bun', ['install', '--no-summary'], { timeout: 300_000 }).ok) { console.log(C.warn('  ⚠ bun install failed — skipping verification.')); return false }
  }

  // Launch the daemon from the checkout, detached, into the shared log.
  const logFd = openSyncAppend(DAEMON_LOG_FILE)
  const marker = `\n[setup ${new Date().toISOString()}] launching checkout daemon for verification\n`
  try { appendFileSync(DAEMON_LOG_FILE, marker) } catch {}
  const child = spawn('bun', [join(REPO, 'daemon.ts')], { detached: true, stdio: ['ignore', logFd, logFd], env: process.env })
  child.unref()
  console.log(C.dim(`  daemon launched (pid ${child.pid}) — waiting for it to poll Telegram…`))

  const polling = await waitForLog(/polling as @/, 20_000, marker)
  if (!polling) { console.log(C.warn('  ⚠ daemon didn\'t reach "polling" in time — check ' + DAEMON_LOG_FILE)); stopCheckoutDaemon(); return false }
  console.log(C.ok(`  ✓ daemon polling${cfg.botUsername ? ` as @${cfg.botUsername}` : ''}`))

  // Spawn the bridge work session. The pane tags itself with the @tg_bridge tmux option (the adopt
  // marker); the daemon discovers it from that. Safe default: normal mode, bypass switchable from /mode.
  if (tmuxHasSession(BRIDGE_SESSION)) console.log(C.dim(`  • tmux session "${BRIDGE_SESSION}" already exists — reusing it`))
  else if (run('tmux', ['new-session', '-d', '-s', BRIDGE_SESSION, 'tmux set -p @tg_bridge 1 2>/dev/null; claude --allow-dangerously-skip-permissions']).ok)
    console.log(C.ok(`  ✓ bridge session "${BRIDGE_SESSION}" started`))
  else { console.log(C.warn('  ⚠ couldn\'t start the tmux bridge session — start one with claude-tg after the restart.')); stopCheckoutDaemon(); return false }

  const adopted = await waitForLog(/adopted off-MCP pane|focus pinned to/, 12_000, marker)
  console.log(adopted ? C.ok('  ✓ daemon adopted the bridge pane') : C.warn('  • daemon hasn\'t reported adopting the pane yet (it polls every few seconds — should bind shortly)'))

  // Hand off: stop our checkout daemon so the managed cache daemon takes over on restart.
  stopCheckoutDaemon()
  console.log(C.dim('  stopped the verification daemon — the restart starts the managed one.'))
  return true
}

function openSyncAppend(path: string): number {
  try { return openSync(path, 'a') } catch { return 1 }
}
function tmuxHasSession(name: string): boolean {
  return run('tmux', ['has-session', '-t', name]).ok
}
// Poll a log file for a pattern appearing AFTER our run marker (so we don't match a stale line
// from a previous daemon). Returns true once seen, false on timeout.
async function waitForLog(re: RegExp, timeoutMs: number, after: string): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const log = readFileSync(DAEMON_LOG_FILE, 'utf8')
      const tail = log.slice(log.lastIndexOf(after) + after.length)
      if (re.test(tail)) return true
    } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}
// Stop the checkout daemon + its watchdog (so neither lingers running cache-external code).
function stopCheckoutDaemon(): void {
  for (const f of [DAEMON_PID_FILE, WATCHDOG_PID_FILE]) {
    try { const pid = parseInt(readFileSync(f, 'utf8').trim(), 10); if (pid > 1) process.kill(pid) } catch {}
  }
}

// Provision local Whisper: venv + faster-whisper + download the chosen weights. Mirrors the
// daemon's self-heal path but runs here so install absorbs the one-time cost, not the first note.
async function provisionWhisper(cfg: Config): Promise<void> {
  section('Local Whisper provisioning')
  // ensurepip / python3-venv must be present for a venv.
  if (run('python3', ['-c', 'import ensurepip']).ok === false) {
    console.log(C.warn('  • python3-venv (ensurepip) missing — trying to install…'))
    if (!installPkg('python3-venv')) {
      console.log(C.warn('  ⚠ couldn\'t install python3-venv. Install it (sudo apt-get install -y python3-venv) and re-run, or switch voice to groq/openai. Skipping for now.'))
      return
    }
  }
  const venv = join(STATE_DIR, 'whisper-venv')
  const py = join(venv, 'bin', 'python')
  console.log(C.dim('  creating venv + installing faster-whisper (one-time)…'))
  if (!run('python3', ['-m', 'venv', venv]).ok) { console.log(C.warn('  ⚠ venv creation failed — skipping local provisioning.')); return }
  run(py, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip'])
  if (!run(py, ['-m', 'pip', 'install', '--quiet', 'faster-whisper']).ok) { console.log(C.warn('  ⚠ faster-whisper install failed — skipping.')); return }
  appendFileSync(ENV_FILE, `TELEGRAM_WHISPER_PYTHON=${py}\n`)
  console.log(C.dim(`  downloading ${cfg.whisperModel} weights (~${WHISPER_INFO[cfg.whisperModel!].weightsMB} MB)…`))
  const dl = run(py, ['-c', 'import sys;from faster_whisper import WhisperModel;WhisperModel(sys.argv[1],device=sys.argv[2],compute_type="int8")',
    cfg.whisperModel!, cfg.whisperDevice!], { timeout: 1_200_000 })
  console.log(dl.ok ? C.ok(`  ✓ local Whisper ready (${cfg.whisperModel})`) : C.warn('  ⚠ weight download stalled — it\'ll download on the first note instead.'))
}

main().catch(e => { console.error(C.err(`\nsetup failed: ${e?.stack || e}`)); rl.close(); process.exit(1) })
