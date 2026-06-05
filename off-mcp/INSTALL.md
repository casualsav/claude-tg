# Install: off-MCP Telegram bridge (for an agent to execute)

**You are a Claude Code session setting up the off-MCP Telegram bridge on this
machine.** Follow these steps in order. The goal: this machine's Claude sessions can be
driven from Telegram **without loading the plugin's MCP server**, so they don't pay the
per-request MCP tool/instruction context tax. Inbound is typed into the session's pane;
the reply is read back from its transcript; a tiny `tg` CLI handles file-send/react/edit.

**Gather ALL configuration up front (Step 1) and write it before anything restarts**, so
the single restart in Step 3 brings everything up already configured.

## 0. Prerequisites
- [Bun](https://bun.sh) on PATH and `tmux` (the daemon drives sessions through tmux panes).
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- **Platform:** Linux or macOS. On Windows, run inside [WSL2](https://learn.microsoft.com/windows/wsl/)
  (native Windows has no `tmux`).
- **Sanity-check the checkout first:** from the repo root run `bun test`. It runs the
  parser/formatter unit suite (Markdown→HTML, transcript reading, prompt detection) — no
  token, network, or running daemon needed — and should report all green in well under a
  second. If Bun is missing or a test fails here, fix that before touching the user's config.

## 0.5. Pre-flight: remove the old costly MCP version (if present)
This bridge is the off-MCP successor to the upstream **`telegram@claude-plugins-official`**
plugin, which loads an always-on MCP server and pays a per-request context tax on *every* turn.
This setup doesn't need it, and running both would double-bridge Telegram. Most users won't have
it — but check and offer to remove it before continuing:

1. Look for it in `~/.claude/settings.json` (`enabledPlugins["telegram@claude-plugins-official"]`)
   and the `claude-plugins-official` marketplace in `~/.claude.json`.
2. **Not present** → say so and continue; nothing to do.
3. **Present** → tell the user it's the old costly MCP-mode version and **ask whether to remove it**
   (recommended). On yes, the clean path is having them run
   `/plugin uninstall telegram@claude-plugins-official` in Claude Code; or set that
   `enabledPlugins` entry to `false` to just disable it. On no, continue but warn that both
   versions will try to bridge Telegram at once.

## 1. Interview the human and write the config (before any restart)
Ask these one by one (don't assume defaults silently — confirm each), then write the two
files below. **You can write them now even though the plugin isn't installed yet** — they
live in the state dir, and the daemon reads them on first start.

**Questions:**
1. **Bot token** — from @BotFather. (Required.)
2. **Your Telegram numeric user ID** — to lock the bot to you. If they don't know it,
   tell them to DM [@userinfobot](https://t.me/userinfobot), which replies with their ID.
   (If they'd rather pair after restart, skip this and see the note in Step 4.)
3. **Voice transcription of inbound voice/audio notes?** One of:
   - `off` (voice arrives as a placeholder),
   - `local` (Whisper on this machine — then ask **which model**: default
     `large-v3-turbo`; smaller = faster/less accurate: `tiny`/`base`/`small`/`medium`/
     `large-v3` — and **device** `cpu` or `cuda`),
   - `groq` (ask for **GROQ_API_KEY**; default model `whisper-large-v3-turbo`),
   - `openai` (ask for **OPENAI_API_KEY**; default model `whisper-1`).
4. **Render Claude's Markdown as Telegram formatting?** (default yes.)
5. **Auto-continue when a usage limit resets?** (default yes.)

**Write `~/.claude/channels/telegram/.env`** (`mkdir -p` the dir first; then `chmod 600`
the file — the token is a credential):
```
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_TRANSCRIPT_OUTBOUND=1
# transcription — only if not "off":
TELEGRAM_TRANSCRIBE=<off|local|groq|openai>
TELEGRAM_TRANSCRIBE_MODEL=<model>           # local/groq/openai
TELEGRAM_WHISPER_DEVICE=<cpu|cuda>          # local only
TELEGRAM_WHISPER_COMPUTE=int8               # local only
GROQ_API_KEY=<key>                          # groq only
OPENAI_API_KEY=<key>                        # openai only
```

**Write `~/.claude/channels/telegram/access.json`** locked to their ID (omit this file and
use pairing instead if they didn't give an ID):
```json
{ "dmPolicy": "allowlist", "allowFrom": ["<their-telegram-id>"], "groups": {}, "pending": {},
  "renderMarkdown": <true|false>, "autoContinue": <true|false> }
```

## 2. Install the plugin + wire the hooks/convention
- In `~/.claude/settings.json` add the marketplace, enable the plugin, and add the
  daemon-resilience hook + (optionally) point the model:
```json
"extraKnownMarketplaces": {
  "better-claude-plugins": { "source": { "source": "github", "repo": "casualsav/better-claude-telegram" } }
},
"enabledPlugins": { "telegram@better-claude-plugins": true },
"hooks": {
  "SessionStart": [ { "hooks": [ { "type": "command", "command": "bun ~/.claude/channels/telegram/ensure-daemon.js >/dev/null 2>&1 || true" } ] } ]
}
```
- Append this repo's `off-mcp/CLAUDE.md` into `~/.claude/CLAUDE.md` so every plugin-less
  session knows how to chat + use `tg`.

## 3. Restart Claude Code (the one restart)
**Ask the human to restart Claude Code.** On restart it downloads the plugin and the
daemon starts — reading the `.env` + `access.json` you already wrote, so the bot comes up
**fully configured and locked to their ID**, transcription set, off-MCP on.

## 4. Confirm
```sh
pgrep -fa daemon.ts        # one daemon
command -v tg              # auto-provisioned CLI on PATH
tg react 0 0 👍            # "not allowlisted" error = CLI reaches the daemon
```
Have them DM the bot — it should respond. (No ID given in Step 1? They DM the bot now,
it replies with a pairing code; approve with `/telegram:access pair <code>`, then lock
with `/telegram:access policy allowlist`.)

## 5. Run a session off-MCP — the daemon finds it
Launch the work session **plugin-less** in a tmux pane. The one flag that matters is
`--strict-mcp-config`: it drops the plugin's MCP server (so you don't pay the per-request MCP
context tax) **and** is the signature the daemon scans for to auto-discover the pane.
```sh
claude --strict-mcp-config
```
That's it — the daemon **auto-discovers** the plugin-less pane and binds to it automatically
(no `TELEGRAM_FORCE_PANE`, no restart). If there are several plugin-less panes it asks which to
use; to pin a specific one, set `TELEGRAM_FORCE_PANE=<pane id>` in the `.env` to override.

**Add a `claude-tg` shortcut** (recommended) — drop this in `~/.bashrc` / `~/.zshrc`:
```sh
alias claude-tg='claude --strict-mcp-config'
```
Then `claude-tg` just works. Anything you append rides along:
- **Your own MCP servers** — `--strict-mcp-config` ignores *configured* servers but still loads
  what you pass explicitly, so the per-request tax is gone but you keep your tooling:
  ```sh
  claude-tg --mcp-config ~/my-mcp.json
  ```
- **Skip permission prompts** — `claude-tg --dangerously-skip-permissions`. Otherwise prompts
  are relayed to Telegram with **Yes / allow-all / No** buttons so you can approve remotely.

## 6. Verify end to end
From Telegram, message the session → you get its reply (read from the transcript), no MCP
loaded. Ask it to "send me a file with `tg`" to confirm outbound actions.

## What you get, from Telegram
- Two-way chat with the session; send/receive files; inbound voice notes transcribed.
- **Permission prompts** relayed with tap-to-approve buttons.
- **Live activity mirror** — one self-updating message of what Claude is doing; on long tasks
  the agent can drive a **progress bar** (`tg progress`).
- **/session** (list · `/session #` switch · `/session name # <label>`), **/mode** & **/model**
  pickers, **/cost**, **/context**, **/stop**, **/new**, **/terminal**.
- **Auto-continue** when a usage limit resets (self-verifies + retries).

## Notes
- The daemon runs **standalone** (relaunched by the SessionStart hook), so it survives closing
  sessions and reboots — no MCP session needed to keep it alive.
- `TELEGRAM_FORCE_PANE=<pane>` in the `.env` overrides auto-discovery when you want a specific
  pane.
