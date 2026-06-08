# Install troubleshooting log

Real issues hit installing this bridge on a fresh machine, with root cause, the workaround
used, and a suggested repo-side fix. Off-MCP mode, Linux aarch64, bun 1.3.14, Claude Code
2.1.168, Python 3.12 (PEP 668 externally-managed), tmux 3.4.

State dir: `~/.claude/channels/telegram/` · plugin cache:
`~/.claude/plugins/cache/better-claude-plugins/telegram/0.0.6/`

---

## 1. Private repo — `git clone` over HTTPS fails
**Symptom:** `git clone https://github.com/...` → `fatal: could not read Username for
'https://github.com'`.
**Cause:** repo is private; plain git has no credentials.
**Fix:** `gh repo clone casualsav/better-claude-telegram` (uses the authenticated `gh` token).
**Repo idea:** note the `gh` clone in the README for private/preview installs.

## 2. Stale/partial plugin cache → grammy `EACCES` (the big one)
**Symptom:** daemon launches then dies immediately. `daemon.log`:
`error: EACCES while resolving package 'debug' from
'~/.bun/install/cache/grammy@1.43.0@@@1/out/platform.node.js'`. Reproducible, not a race.
**Cause chain:**
- The plugin cache dir held only the `.ts` files — **no `package.json`, `bun.lock`, or
  `node_modules`** (a partial copy).
- `ensure-daemon.ts` launches the daemon with `spawn('bun', [daemonPath])` — **no `bun install`
  step**. So `bun daemon.ts` relies on bun's on-the-fly auto-install.
- With no lockfile present, auto-install resolved `grammy: ^1.21.0` to the **latest, 1.43.0**,
  which fails `require("debug")` resolution under bun with `EACCES` (all files were readable —
  it's a bun resolution bug for that grammy build, not a real permission wall).
**Fix:** copy `package.json` + `bun.lock` into the cache version dir and run `bun install`
there. The lockfile pins grammy **1.41.1**, which resolves cleanly. After that the daemon
starts and logs `polling as @<bot>`.
**Repo fix (DONE):** `ensure-daemon` now (a) writes a pinned `package.json` (`grammy: 1.41.1`)
into the cache dir when one is absent — the cache copy ships only `.ts` files, so without this
`bun install` has nothing to pin against — then (b) runs `bun install` before launching the
daemon. With the manifest present the install resolves the known-good grammy instead of floating
to the crashing 1.43.0. Still worth shipping a lockfile-pinned `node_modules` in the plugin
package so the install can be skipped entirely.

## 3. Off-MCP bootstrap deadlock (daemon never starts on a clean install)
**Symptom:** after restart, nothing brings the daemon up; `tg` never appears.
**Cause:** the `SessionStart` hook runs `~/.claude/channels/telegram/ensure-daemon.js`, but that
launcher is only written by the daemon **on its first run** (`daemon.ts`
`provisionOffMcpTooling`, ~line 798). In pure off-MCP nothing else spawns the daemon first, so
on a clean install the hook no-ops (file absent) and the daemon never starts — chicken-and-egg.
**Fix:** pre-write the state-dir `ensure-daemon.js` from the daemon's own template (it globs the
cache for `ensure-daemon.ts` at runtime, so it's version-independent). Then the first hook fire
finds the cache and spawns the daemon, which idempotently rewrites the same file.
**Repo fix:** have `off-mcp/INSTALL.md` step 2 write the launcher, or ship it, or point the hook
directly at the cache's `ensure-daemon.ts`.

## 4. Local Whisper on a PEP 668 (externally-managed) Python
**Symptom:** `pip install faster-whisper` would be refused on the system Python.
**Cause:** Python 3.12 marks the env externally-managed (PEP 668).
**Fix:** matched the daemon's own fallback (`provisionWhisper`, ~line 2705): created a venv at
`STATE_DIR/whisper-venv`, installed `faster-whisper` there, and recorded
`TELEGRAM_WHISPER_PYTHON=<venv>/bin/python` in `.env` (daemon checks this path in
`whisperReady`). Verified `import faster_whisper` (1.2.1). Model large-v3-turbo, cpu, int8.
**Repo note:** the daemon already auto-installs on first voice note; pre-provisioning just avoids
the first-use delay. Working as designed — documented here for completeness.

## 5. `scripts/setup-alias.sh` adds the wrong alias for off-MCP (resolved)
**Symptom (historical):** the alias script wrote the MCP/channel-load launcher for off-MCP.
**Resolved:** `setup-alias.sh` is mode-aware — off-MCP is now
`alias claude-tg='claude --dangerously-skip-permissions'` (bypass/autonomy; the plugin's MCP
ships disabled so the session is already plugin-less, and the flag is the daemon's adopt signature).

## 6. Inbound delivery needs a bridge-signature tmux pane (most common "it's not working")
**Symptom:** bot is paired and polling, but Telegram messages never reach a Claude session.
**Cause:** off-MCP delivers inbound by **typing into a tmux pane**. The daemon auto-discovers a
pane only if its `claude` argv carries the bridge signature — `--dangerously-skip-permissions`
(the `claude-tg` alias; `isPluginlessClaude`, `daemon.ts`).
A bare `claude` pane, or a Claude session **not running inside tmux**, is never adopted — so
there's nowhere to deliver.
**Extra gotcha:** spawning the session **detached** (e.g. `tmux new-session -d`) lands on the
**first-run theme picker / onboarding**, which blocks the chat prompt; a detached spawn can't get
past it, so the pane is never drivable.
**Fix:** launch the work session **interactively** in tmux and complete onboarding once:
```sh
source ~/.bashrc        # load the claude-tg alias
tmux new -s tg          # or attach to existing tmux
claude-tg               # = claude --dangerously-skip-permissions ; pick a theme on first run
```
The daemon then discovers and adopts the pane (log: `adopted off-MCP pane …`), announces the
session to Telegram, and inbound starts flowing. Note: the *dev/terminal* session you ran the
install from is **not** the bridge target and cannot receive Telegram messages.
**Repo idea:** when a message arrives with no adoptable pane, have the bot reply with a hint
("no active session — launch `claude-tg` in tmux"). Consider detecting the onboarding screen and
surfacing a clearer state than silent non-delivery.

---

## Final working config (off-MCP)
- Bot **@yourbot**, locked to Telegram ID `123456789` (allowlist).
- `.env` (chmod 600): token, `TELEGRAM_TRANSCRIPT_OUTBOUND=1`, local Whisper (large-v3-turbo /
  cpu / int8) via the venv python; `access.json`: renderMarkdown + autoContinue on.
- `settings.json`: marketplace + `enabledPlugins` + `SessionStart` ensure-daemon hook. MCP server
  left disabled (`mcp.json.disabled`). `~/.claude/CLAUDE.md`: off-MCP convention appended.
- Daemon runs detached from the cache (PPID 1), `polling as @yourbot`; `tg` CLI on
  PATH; `tg react 0 0 👍` → `chat 0 is not allowlisted` (proves the wire + access gate).
- **Remaining user step:** run `claude-tg` interactively in tmux to give the daemon a pane.
