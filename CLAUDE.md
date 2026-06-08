# better-claude-telegram

A Claude Code ↔ Telegram bridge. Drive a Claude Code session from Telegram — send messages and
files, get replies with native formatting, approve permission prompts with a tap, switch modes,
watch a live activity feed, and interrupt a task. It ships built-in access control (pairing,
allowlists, group policy).

Its **off-MCP mode** runs your *work* sessions plugin-less (no per-request MCP context tax):
inbound is typed into the session's tmux pane, replies are read back from the transcript, and a
`tg` CLI handles file-send / react / edit / progress. The daemon **auto-discovers** the
plugin-less pane — no manual pinning.

## 👉 If the user wants to install / set up / configure this
Follow **[`off-mcp/INSTALL.md`](off-mcp/INSTALL.md)** step by step — it is written for *you*
(an agent) to execute. In short:
1. **Interview the user first** (bot token from @BotFather, their Telegram numeric ID, voice
   transcription, render-Markdown, auto-continue) and write `~/.claude/channels/telegram/.env`
   + `access.json` — before anything restarts.
2. Add the marketplace + enable the plugin + add the `SessionStart` daemon hook in
   `~/.claude/settings.json`, and append `off-mcp/CLAUDE.md` to `~/.claude/CLAUDE.md`.
3. Have the user restart Claude Code once → the daemon comes up fully configured.
4. Launch a bridge session with `claude-tg` (auto-added alias for
   `tmux set -p @tg_bridge 1; claude --allow-dangerously-skip-permissions` — the `@tg_bridge` tmux
   pane option is the adopt marker (decoupled from claude's args), bypass is switchable on demand;
   `claude-yolo` is the full-bypass-from-launch variant) — the daemon finds it automatically.

Don't guess config values — ask. The only non-automatable bits are getting the token from the
human and the one Claude Code restart; do everything else yourself.

## Layout (for working on the repo)
- `daemon.ts` — the long-lived grammy bot + access gate + tmux pane driver + off-MCP outbound
  (the bulk of the code).
- `shim.ts` — the MCP server; used only in plugin/MCP mode (off-MCP bypasses it).
- `transcript.ts` — off-MCP outbound: read replies + activity from Claude Code's transcript JSONL.
- `tgctl.ts` — the `tg` actions CLI; `ensure-daemon.ts` — standalone daemon relauncher.
- `prompt.ts` — detect interactive prompts (select / permission) from a pane capture.
- `common.ts` (shared types/paths), `markdown.ts` (Markdown → Telegram HTML).
- `off-mcp/INSTALL.md` (setup) + `off-mcp/CLAUDE.md` (the convention every plugin-less session reads).
- `ACCESS.md` (access control), `TESTING.md`.

**Deploy loop** (the live daemon runs from the plugin cache, not this checkout): edit `.ts` here →
**`bun run deploy [patch|minor|major|x.y.z]`** (default `patch`) → test live → commit. The script
(`scripts/deploy.ts`) does the whole ritual atomically: bumps `version` in both
`.claude-plugin/plugin.json` and `marketplace.json`, syncs the git-tracked files into the cache
(`~/.claude/plugins/cache/better-claude-plugins/telegram/<ver>/`) + the marketplace mirror,
installs deps if missing, type-checks in the cache (`bun build daemon.ts --target=bun` — grammy
resolves only there), then restarts the daemon (the watchdog/SessionStart hook respawns it from the
newest cache version) and verifies it came back on the new version. The type-check runs **before**
the checkout's version files are stamped, so a failed build never dirties the working tree. Flags:
`--no-restart` (ship to cache without touching the live daemon) and `--commit "msg"` (commit + push
after a clean deploy). Commits end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

Doing it by hand (only if the script can't run): copy the changed `.ts` to the cache `<ver>` dir +
the marketplace dir → `bun build daemon.ts --target=bun` to type-check → restart the daemon
(`kill "$(cat ~/.claude/channels/telegram/daemon.pid)"`; the watchdog / SessionStart hook respawns
it) → test, then bump the version (next paragraph) and commit.

**Releasing (so end-user installs actually get the change) — DON'T SKIP:** the plugin cache is
**keyed by the version string**. If you ship code without bumping `version` in **both**
`.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, every existing install keeps
running its cached old build forever (Claude Code sees "version already installed" and never
re-copies, even after the marketplace pulls your new HEAD). So **bump the version on every shipped
change**, then push. `bun run deploy` does this bump for you (both files); if you ever ship by hand,
do it yourself. End-users upgrading a same-version cache must force-refresh (see
`off-mcp/INSTALL.md` §0.6).

**The cache needs deps, not just `.ts`.** A fresh cache copy is often only the `.ts` files — no
`package.json`/`bun.lock`/`node_modules` — so `bun daemon.ts` floats grammy to a build that crashes
with `EACCES … resolving 'debug'`. `ensure-daemon.ts` self-heals (writes a pinned `package.json` +
`bun install` before launch), and `bun run deploy` seeds a fresh `<ver>` cache by cloning the
newest existing version dir (carrying `node_modules`/`bun.lock`) — but when hand-copying to a cache
dir, also copy `package.json` + `bun.lock` and run `bun install` there so grammy pins to **1.41.1**.
Keep the grammy version pinned in `package.json`, in `ensure-daemon.ts`'s generated manifest, and in
`scripts/deploy.ts`'s `GRAMMY_PIN` in sync.
