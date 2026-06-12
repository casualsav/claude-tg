// GitHub CLI (gh) auth from Telegram — multi-account login/switch/logout.
// gh's web device-code flow needs a TTY (it prompts "Press Enter to open …"), so the login runs
// in a throwaway detached tmux session: we scrape the one-time code off the pane, relay it to
// Telegram, press Enter for it, and poll the pane until gh reports the outcome. Side-effect free
// on import (daemon.ts is not), so the status parser is unit-testable.
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { exec, sleep } from './proc.ts'
import { capturePane } from './pane-io.ts'
import { stripAnsi } from './prompt.ts'
import { STATE_DIR } from './common.ts'

export type GhAccount = { host: string; user: string; active: boolean }

// The gh binary to drive: a PATH install wins; otherwise the bridge-managed copy (provisionGh
// below) so the whole flow works on a host where nobody ever installed gh from a terminal.
const GH_DIR = join(STATE_DIR, 'gh')
const GH_MANAGED_BIN = join(GH_DIR, 'gh')
export function ghBin(): string {
  return existsSync(GH_MANAGED_BIN) ? GH_MANAGED_BIN : 'gh'
}

// Download the latest gh release binary into the state dir (~12MB, no root needed) — same
// self-provisioning pattern as Piper. Idempotent; throws with a short reason on failure.
export async function provisionGh(): Promise<void> {
  if (await ghInstalled()) return
  if (process.platform !== 'linux') throw new Error('auto-install only works on Linux — install gh from https://cli.github.com')
  mkdirSync(GH_DIR, { recursive: true })
  const arch = (await exec('uname', ['-m'], { timeout: 2000 })).stdout.trim()
  const a = arch === 'aarch64' || arch === 'arm64' ? 'arm64' : 'amd64'
  const rel = await fetch('https://api.github.com/repos/cli/cli/releases/latest',
    { headers: { 'user-agent': 'pocket-claude' } })
  if (!rel.ok) throw new Error(`couldn't look up the latest gh release (HTTP ${rel.status})`)
  const tag = ((await rel.json()) as { tag_name?: string }).tag_name   // e.g. v2.62.0
  if (!tag) throw new Error('release lookup returned no version tag')
  const ver = tag.replace(/^v/, '')
  const tarball = join(GH_DIR, 'gh.tar.gz')
  const url = `https://github.com/cli/cli/releases/download/${tag}/gh_${ver}_linux_${a}.tar.gz`
  await exec('curl', ['-fsSL', '-o', tarball, url], { timeout: 300_000, maxBuffer: 1 << 20 })
  await exec('tar', ['-xzf', tarball, '-C', GH_DIR, '--strip-components=2', `gh_${ver}_linux_${a}/bin/gh`], { timeout: 60_000 })
  try { unlinkSync(tarball) } catch {}
  if (!(await ghInstalled())) throw new Error('gh installed but won\'t run')
}

// Parse `gh auth status` output. Modern gh (≥2.40, multi-account):
//   ✓ Logged in to github.com account alice (keyring)
//   - Active account: true
// Older single-account format ("✓ Logged in to github.com as alice (oauth_token)") parses too —
// its one account is the active one.
export function parseGhAuthStatus(out: string): GhAccount[] {
  const accounts: GhAccount[] = []
  for (const raw of stripAnsi(out).split('\n')) {
    const line = raw.trim()
    const m = /^✓ Logged in to (\S+) (account|as) (\S+)/.exec(line)
    if (m) { accounts.push({ host: m[1], user: m[3], active: m[2] === 'as' }); continue }
    const a = /^- Active account: (true|false)/.exec(line)
    if (a && accounts.length) accounts[accounts.length - 1].active = a[1] === 'true'
  }
  return accounts
}

export async function ghInstalled(): Promise<boolean> {
  try { await exec(ghBin(), ['--version'], { timeout: 5000 }); return true } catch { return false }
}

// All known gh accounts. `gh auth status` exits 1 when nothing is logged in, and its report has
// moved between stdout and stderr across versions — parse both, on success or failure alike.
export async function ghAccounts(): Promise<GhAccount[]> {
  try {
    const { stdout, stderr } = await exec(ghBin(), ['auth', 'status'], { timeout: 15000 })
    return parseGhAuthStatus(`${stdout}\n${stderr}`)
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return parseGhAuthStatus(`${err.stdout ?? ''}\n${err.stderr ?? ''}`)
  }
}

function shortErr(e: unknown): string {
  const err = e as { stderr?: string; message?: string }
  return (err.stderr || err.message || String(e)).trim().split('\n')[0].slice(0, 200)
}

// null = ok; otherwise the first error line for the user.
export async function ghSwitch(user: string): Promise<string | null> {
  try { await exec(ghBin(), ['auth', 'switch', '--hostname', 'github.com', '--user', user], { timeout: 10000 }); return null }
  catch (e) { return shortErr(e) }
}

export async function ghLogout(user: string): Promise<string | null> {
  try { await exec(ghBin(), ['auth', 'logout', '--hostname', 'github.com', '--user', user], { timeout: 10000 }); return null }
  catch (e) { return shortErr(e) }
}

const GH_LOGIN_TMUX = 'tg-gh-login'
export type GhLoginResult = { ok: true; user: string } | { ok: false; error: string }

// Run the device-code login end to end. onCode fires once the one-time code is on screen —
// the caller relays it to Telegram; the promise resolves when gh finishes (the user authorized
// on github.com — nothing is typed back) or the code expires. One login at a time: a fresh run
// replaces any stale leftover session.
export async function runGhLogin(onCode: (code: string, url: string) => void): Promise<GhLoginResult> {
  await exec('tmux', ['kill-session', '-t', GH_LOGIN_TMUX], { timeout: 3000 }).catch(() => {})
  // BROWSER=true makes gh's "opening browser" step succeed silently (no GUI on the host); gh then
  // simply polls GitHub until the user authorizes from their own device. The exit marker + sleep
  // keep the pane alive after gh exits so the final output stays capturable.
  const cmd = `BROWSER=true '${ghBin().replace(/'/g, `'\\''`)}' auth login --hostname github.com --git-protocol https --web --skip-ssh-key 2>&1; echo "GH_EXIT=$?"; sleep 600`
  let pane: string
  try {
    const { stdout } = await exec('tmux',
      ['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', GH_LOGIN_TMUX, '-x', '200', '-y', '50', cmd], { timeout: 5000 })
    pane = stdout.trim()
    if (!pane) throw new Error('no pane id')
  } catch (e) {
    return { ok: false, error: `couldn't start the login process (${shortErr(e)})` }
  }
  const capture = async () => stripAnsi(await capturePane(pane).catch(() => ''))
  const lastLines = (cap: string) =>
    cap.split('\n').map(l => l.trim()).filter(l => l && !/^GH_EXIT=/.test(l)).slice(-2).join(' · ').slice(0, 200)
  try {
    // Phase 1: gh asks GitHub for a device code — scrape it (a few seconds).
    let code = '', url = 'https://github.com/login/device'
    const codeDeadline = Date.now() + 30_000
    while (Date.now() < codeDeadline) {
      await sleep(700)
      const cap = await capture()
      const exit = /GH_EXIT=(\d+)/.exec(cap)
      if (exit && exit[1] !== '0') return { ok: false, error: lastLines(cap) || 'gh exited before producing a code' }
      const m = /one-time code: ([A-Z0-9-]{4,})/i.exec(cap)
      if (m) {
        code = m[1]
        const u = /(https:\/\/\S*github\.com\/login\/device\S*)/.exec(cap)
        if (u) url = u[1].replace(/[).,]+$/, '')
        break
      }
      // gh asks Y/n confirms (e.g. "Authenticate Git with your GitHub credentials?") even with
      // every flag supplied — answer yes so the device code can appear. The (Y/n) marker is gone
      // from the line once answered, so this never double-fires.
      if (/\(Y\/n\)\s*$/m.test(cap)) await exec('tmux', ['send-keys', '-t', pane, 'y', 'Enter'], { timeout: 3000 }).catch(() => {})
    }
    if (!code) return { ok: false, error: 'no sign-in code appeared — is the gh CLI installed and able to reach github.com?' }
    await exec('tmux', ['send-keys', '-t', pane, 'Enter'], { timeout: 3000 }).catch(() => {})   // its "Press Enter to open …" prompt
    onCode(code, url)
    // Phase 2: gh polls GitHub until the user authorizes; device codes expire after ~15 min.
    const doneDeadline = Date.now() + 16 * 60_000
    while (Date.now() < doneDeadline) {
      await sleep(2000)
      const cap = await capture()
      const u = /Logged in as (\S+)/.exec(cap)
      if (u) return { ok: true, user: u[1] }
      const exit = /GH_EXIT=(\d+)/.exec(cap)
      if (exit) {
        if (exit[1] === '0') return { ok: true, user: '' }   // succeeded but the name scrolled off
        return { ok: false, error: lastLines(cap) || 'gh exited without logging in' }
      }
    }
    return { ok: false, error: 'the code expired before the login was authorized — start again' }
  } finally {
    await exec('tmux', ['kill-session', '-t', GH_LOGIN_TMUX], { timeout: 3000 }).catch(() => {})
  }
}
