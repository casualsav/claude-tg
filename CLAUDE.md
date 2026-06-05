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
4. Launch a plugin-less session (`claude --strict-mcp-config --mcp-config '{"mcpServers":{}}'`)
   — the daemon finds it automatically.

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

**Deploy loop** (the live daemon runs from the plugin cache, not this checkout): edit here →
copy the changed `.ts` to the cache (`~/.claude/plugins/cache/better-claude-plugins/telegram/<ver>/`)
and the marketplace dir → `bun build daemon.ts --target=bun` to type-check (grammy resolves only
in the cache) → restart the daemon (`kill "$(cat ~/.claude/channels/telegram/daemon.pid)"`; the
SessionStart hook / a connected shim respawns it) → test live, then commit. Commits end with
`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
