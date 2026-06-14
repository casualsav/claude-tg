// SessionStart hook: stamp this Claude Code session's transcript path onto its tmux pane
// (@tg_transcript), so the bridge daemon reads THIS session's replies instead of "newest .jsonl
// in the project dir" — which cross-talks the moment two sessions share a cwd (Track B).
//
// Claude Code hands hooks a JSON blob on stdin that includes transcript_path and cwd; $TMUX_PANE
// names the pane the session runs in. SessionStart also fires on /clear and resume, so the stamp
// follows the session onto its new transcript file. Outside tmux there's nothing to stamp.
//
// HIJACK GUARD: any process that inherits this pane's $TMUX_PANE also fires this hook — notably
// headless `claude -p` children an agent spawns (e.g. a test harness running runs in /tmp). Those
// would "last-write-wins" the pane's stamp onto their own throwaway transcript, and the daemon
// then relays the wrong file — the real session's replies silently stop. So we only stamp when the
// session's cwd matches the pane's real cwd; a child running elsewhere (the observed /tmp case) is
// refused. The interactive pane session's cwd always equals the pane's current path.
//
// Registered in ~/.claude/settings.json next to the ensure-daemon SessionStart hook (see
// off-mcp/INSTALL.md) — user-level, because off-MCP work sessions are plugin-less and would
// never see a plugin-shipped hook.
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'

const pane = process.env.TMUX_PANE
if (!pane) process.exit(0)

let input = ''
for await (const chunk of process.stdin) input += chunk
let path = '', cwd = ''
try { const j = JSON.parse(input); path = j?.transcript_path ?? ''; cwd = j?.cwd ?? '' } catch { /* malformed input → nothing to stamp */ }
if (!path) process.exit(0)

// Resolve symlinks and drop any trailing slash so the comparison is canonical.
const norm = (p: string) => { try { return realpathSync(p) } catch { return p.replace(/\/+$/, '') } }

// Refuse to hijack the stamp from a foreign session: if this session's cwd doesn't match the
// pane's real cwd, it's a child/headless run that merely inherited $TMUX_PANE — leave the pane's
// stamp on its true interactive session. Only guard when we can read both sides; if the pane cwd
// is unreadable (pane already gone) the set-option below would no-op anyway.
if (cwd) {
  try {
    const paneCwd = execFileSync('tmux', ['display-message', '-p', '-t', pane, '#{pane_current_path}'], { timeout: 2000 }).toString().trim()
    if (paneCwd && norm(paneCwd) !== norm(cwd)) process.exit(0)
  } catch { /* can't read pane cwd → fall through and attempt the stamp (old behavior) */ }
}

try { execFileSync('tmux', ['set-option', '-p', '-t', pane, '@tg_transcript', path], { timeout: 2000 }) } catch { /* pane gone / no tmux server */ }
