// Low-level tmux / pane I/O adapter.
//
// This is the single seam through which the bridge reads from and drives a session's
// terminal. It is deliberately side-effect free and importable (unlike daemon.ts, which
// boots the bot on import), so the fragile screen-scraping + key-injection primitives can
// be unit-tested and mocked in one place. Higher-level pane logic that depends on daemon
// state (PaneWatcher, injection guards, the focused-pane registry) stays in daemon.ts and
// calls down into these primitives.
import { exec, sleep, hashText } from './proc.ts'

// Capture the visible pane contents (joined wrapped lines, ANSI preserved).
export async function capturePane(paneId: string): Promise<string> {
  const { stdout } = await exec('tmux', ['capture-pane', '-p', '-t', paneId, '-J'], { timeout: 3000 })
  return stdout
}

// Pane validation + injection guard (opus-direct Block B).
export async function paneAlive(paneId: string): Promise<boolean> {
  try {
    const { stdout } = await exec('tmux', ['display-message', '-p', '-t', paneId, '#{pane_id}'], { timeout: 2000 })
    return stdout.trim() === paneId
  } catch { return false }
}

export async function sendKeys(paneId: string, keys: string[]): Promise<boolean> {
  if (!(await paneAlive(paneId))) return false
  await exec('tmux', ['send-keys', '-t', paneId, ...keys], { timeout: 2000 })
  return true
}

// Send a literal string into the pane (tmux -l), so codes/URLs with characters
// that would otherwise be read as key names ("Enter", "C-c", "-foo") are typed
// verbatim. The trailing `--` guards strings that begin with a dash.
export async function sendKeysLiteral(paneId: string, text: string): Promise<boolean> {
  if (!(await paneAlive(paneId))) return false
  await exec('tmux', ['send-keys', '-l', '-t', paneId, '--', text], { timeout: 2000 })
  return true
}

// Move the option cursor down `n` rows, one press at a time. Sending the Downs as
// a single batch makes this TUI coalesce/drop them (the cursor doesn't move), so we
// space them out and let it settle before the caller's follow-up key.
export async function navigateDown(paneId: string, n: number): Promise<void> {
  if (n <= 0) return
  for (let i = 0; i < n; i++) {
    await sendKeys(paneId, ['Down'])
    await sleep(140)
  }
  await waitForSettle(paneId, 150, 2000)
}

// Block until the pane stops changing (its capture hash is stable for two polls) or
// `maxMs` elapses. Used after a key injection so the resulting redraw isn't mistaken
// for a new prompt/event.
export async function waitForSettle(paneId: string, pollMs: number, maxMs: number): Promise<void> {
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

export async function windowHeightOf(paneId: string): Promise<number | null> {
  try {
    const { stdout } = await exec('tmux', ['display-message', '-p', '-t', paneId, '#{window_height}'], { timeout: 2000 })
    const n = parseInt(stdout.trim(), 10)
    return Number.isFinite(n) ? n : null
  } catch { return null }
}

export async function resizeWindowOf(paneId: string, rows: number): Promise<boolean> {
  try {
    const { stdout } = await exec('tmux', ['display-message', '-p', '-t', paneId, '#{window_id}'], { timeout: 2000 })
    const win = stdout.trim()
    if (!win) return false
    await exec('tmux', ['resize-window', '-t', win, '-y', String(rows)], { timeout: 2000 })
    return true
  } catch { return false }
}

// Return a window to AUTOMATIC client-following size, undoing any manual `resize-window -y`. This is
// the robust restore after the /cost grow-to-80: a daemon crash/restart between grow and the restore
// would otherwise leave the window pinned tall, where Claude renders into a giant pane and the
// statusline (which the pin scraper reads) is unreadable. Idempotent — a no-op on a normal window.
export async function autoSizeWindowOf(paneId: string): Promise<boolean> {
  try {
    const { stdout } = await exec('tmux', ['display-message', '-p', '-t', paneId, '#{window_id}'], { timeout: 2000 })
    const win = stdout.trim()
    if (!win) return false
    await exec('tmux', ['resize-window', '-t', win, '-A'], { timeout: 2000 })   // -A: size to the largest attached client
    return true
  } catch { return false }
}

export async function paneCommand(paneId: string): Promise<string> {
  try { const { stdout } = await exec('tmux', ['display-message', '-p', '-t', paneId, '#{pane_current_command}'], { timeout: 2000 }); return stdout.trim() } catch { return '' }
}

// Pane cwd with a short TTL cache — paneCwd is hit on every relay tick, and the tmux
// round-trip dominates. The cache is local to this module (the only reader of it).
const PANE_CWD_TTL_MS = 5_000
const _paneCwdCache = new Map<string, { at: number; cwd: string | null }>()
export async function paneCwd(paneId: string): Promise<string | null> {
  const hit = _paneCwdCache.get(paneId)
  if (hit && Date.now() - hit.at < PANE_CWD_TTL_MS) return hit.cwd
  try {
    const { stdout } = await exec('tmux', ['display-message', '-p', '-t', paneId, '#{pane_current_path}'], { timeout: 2000 })
    const cwd = stdout.trim() || null
    _paneCwdCache.set(paneId, { at: Date.now(), cwd })
    return cwd
  } catch { return null }
}

// PaneWatcher — ONE poll loop per active session (opus-direct Block C). Captures the pane every
// 800ms; when the content hash changes it fires onEvent, and onPoll fires every tick (even when
// unchanged) to drive a live working signal. All daemon coupling enters through the constructor
// callbacks, so the loop itself depends only on the pane-io primitives.
export class PaneWatcher {
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
