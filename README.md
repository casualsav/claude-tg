# Telegram channel for Claude Code

Talk to a running Claude Code session from Telegram — and let Claude talk back.
This plugin bridges a Telegram bot to your Claude Code session so you can drive
work from your phone: send messages and files, get replies with native
formatting, approve permission prompts with a tap, switch modes, and interrupt a
running task.

It ships built-in access control (pairing, allowlists, group policy), so only
people you approve can reach your session.

> **Running without the MCP server (off-MCP mode):** the bridge can drive a
> plugin-less Claude session so it doesn't pay the per-request MCP context tax —
> inbound is typed into the pane, replies are read back from the transcript, and a
> `tg` CLI handles file-send/react/edit. To set it up (or have a fresh Claude
> install it), see **[`off-mcp/INSTALL.md`](./off-mcp/INSTALL.md)**.

---

## Install

**Let Claude do it.** Clone this repo, open a Claude Code session in it, and say
*"set up the Telegram bridge."* The repo's [`CLAUDE.md`](./CLAUDE.md) tells Claude to follow
[`off-mcp/INSTALL.md`](./off-mcp/INSTALL.md) — it interviews you for the bot token, your
Telegram ID, and a few options, writes the config, installs the plugin + a self-healing
daemon hook, and gets you to a working session. The only things it can't do itself are
getting the bot token from [@BotFather](https://t.me/BotFather) and the single Claude Code
restart.

```sh
git clone https://github.com/casualsav/better-claude-telegram
cd better-claude-telegram && claude   # then: "set up the Telegram bridge"
```

Prefer to do it by hand? [`off-mcp/INSTALL.md`](./off-mcp/INSTALL.md) lists every step.

---

## Features

- **Two-way messaging** — your Telegram messages reach Claude; Claude replies
  back over the bot.
- **Native Markdown rendering** — Claude writes normal Markdown (`**bold**`,
  `` `code` ``, fenced blocks, lists, links); it renders as native Telegram
  formatting. Toggle off per-config or per-message. See
  [`ACCESS.md`](./ACCESS.md).
- **Access control** — DM pairing with one-time codes, allowlists, and per-group
  policy with mention-triggering. Allowlist-first by design. See
  [`ACCESS.md`](./ACCESS.md).
- **Permission prompts** — when Claude needs approval for a tool call, you get an
  inline-keyboard Allow/Deny right in the chat.
- **Mode switching** — change permission mode from Telegram: `/plan`, `/auto`,
  `/default`, `/acceptedits`, `/bypass`, or the interactive `/mode`.
- **Interrupt** — `/stop` sends Esc to the session, cancelling the current turn.
- **Attachments** — send photos and documents in; Claude can attach files back.
- **Voice & audio transcription** — inbound voice/audio notes can be transcribed
  to text before they reach Claude, via a local Whisper model or a hosted API
  (Groq / OpenAI). Runs entirely outside Claude, so it never consumes usage.
- **Multiple sessions** — run several Claude Code sessions and switch between them
  from Telegram (`/sessions`). Start a new one in any folder with the **➕ New
  session** button (This folder / Home / Specify a path).
- **Unread replay** — switch back to a session and the messages it produced while
  unfocused replay automatically; you also get a **💬 ping** (with a one-tap switch
  button) the moment an unfocused session speaks.
- **Pinned control bar** — a pinned status message shows the active session · model ·
  mode, with 🗂️ Sessions / 🧠 Model / 🧭 Mode quick buttons.
- **Live activity mirror** — a single self-updating message shows what Claude is doing
  in real time (💻 terminal, 📋 todo, 📖 read, ✏️ edit, 🔍 search, 🤖 agent…), read
  straight from the transcript so it costs zero usage. On by default; opt out with
  `terminalMirror: "off"`.

## How it works

```
Telegram  ⇄  daemon.ts  ⇄  shim.ts (MCP server)  ⇄  Claude Code session
              (grammy bot,        (the tools Claude
               long-lived)         calls: reply, react, …)
```

- **`shim.ts`** is the MCP server your Claude session talks to. It exposes the
  `reply`, `react`, `download_attachment`, and `edit_message` tools and forwards
  each call to the daemon over a local socket.
- **`daemon.ts`** is a long-lived process that owns the Telegram bot connection.
  It outlives individual Claude sessions (and survives `/reload-plugins`),
  enforces the access gate on every inbound message, and watches the session's
  tmux pane to detect prompts and relay slash commands.
- **`common.ts`** holds the shared wire protocol and state-dir paths;
  **`markdown.ts`** holds the Markdown→Telegram-HTML converter and the
  chunk-safe splitter.
- **`server.ts`** is a legacy standalone (MCP + bot in one process), kept for
  compatibility; the plugin runs the shim+daemon split.

## Requirements

- [Bun](https://bun.sh) (the runtime; dependencies install on first launch).
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- `tmux` — required for mode switching and `/stop` (the daemon reads/controls the
  session pane). Core messaging works without it.
- Optional, for local voice transcription: `faster-whisper` (a venv is fine).

### Platform support

- **Linux** — fully supported.
- **macOS** — fully supported (off-MCP pane discovery reads process args via `ps`
  where there's no `/proc`).
- **Windows** — via **[WSL2](https://learn.microsoft.com/windows/wsl/)** only; it's a
  real Linux environment, so everything works as on Linux. Native Windows is not
  supported (no `tmux`, which the daemon relies on to drive the session pane).

## Install

This is a Claude Code plugin. Add it and install:

```
/plugin marketplace add casualsav/better-claude-telegram
/plugin install telegram@better-claude-plugins
```

(The `marketplace add` argument is the repo path — update it if you rename the
repo. The `@better-claude-plugins` suffix is the marketplace name from
`.claude-plugin/marketplace.json` and is independent of the repo name.)

## Launch

Channels are a research-preview feature, and only channels from the official
`claude-plugins-official` marketplace are on Claude Code's approved allowlist. A
custom channel like this one is blocked until you load it explicitly — otherwise
you'll see `plugin:telegram@better-claude-plugins • not on the approved channels
allowlist`. Launch Claude Code with the development flag (requires Claude Code
v2.1.80+):

```bash
claude --dangerously-load-development-channels plugin:telegram@better-claude-plugins
```

That loads and activates the channel for the session (after a one-time
confirmation prompt). To also skip per-tool permission prompts, add
`--dangerously-skip-permissions`:

```bash
claude --dangerously-load-development-channels plugin:telegram@better-claude-plugins --dangerously-skip-permissions
```

Since you'll run this every session, add an alias. Either drop it in your shell
rc by hand:

```bash
alias claude-tg='claude --dangerously-load-development-channels plugin:telegram@better-claude-plugins --dangerously-skip-permissions'
```

…or run the bundled one-time setup script, which appends that alias to your
`~/.zshrc` or `~/.bashrc` (idempotently):

```bash
bash scripts/setup-alias.sh
```

Then reload your shell (or `source` the rc) and launch with `claude-tg`.

> Note: `/plugin install` can't add the alias for you — plugins are copied to a
> cache and don't run host-shell install scripts. The setup script above is the
> closest one-step equivalent.

## Setup

All setup happens from your Claude Code session via the bundled skills.

1. **Create a bot** with [@BotFather](https://t.me/BotFather) and copy the token.
2. **Save the token:**
   ```
   /telegram:configure <token>
   ```
3. **Pair yourself:** DM your bot anything on Telegram. It replies with a 6-char
   code. Approve it:
   ```
   /telegram:access pair <code>
   ```
   Now your DMs reach the session.
4. **Lock it down** (recommended) once your allowlist is set:
   ```
   /telegram:access policy allowlist
   ```
5. **(Optional) Voice transcription:**
   ```
   /telegram:configure transcribe local      # or: groq | openai | off
   ```

Run `/telegram:configure` with no arguments any time for a status overview and
the recommended next step.

## Usage

Once paired, just message your bot — text goes to Claude, and replies come back
formatted. Bot commands:

| Command | What it does |
| --- | --- |
| `/start` | Welcome + full feature guide (and pairing steps if not paired) |
| `/status` | Check your pairing state |
| `/sessions` | List & switch sessions (`/sessions #` switch · `/sessions name # <label>` rename) |
| `/resume` | List recent sessions with last-activity times; tap one to relaunch (`claude --resume`) |
| `/mode` | Interactive permission-mode switcher (`/mode <name>` jumps straight to one) |
| `/plan` `/auto` `/default` `/acceptedits` `/bypass` | Quick mode switch |
| `/model` | Show the current model (or `/model <name>` to switch) |
| `/stop` | Interrupt the current task (sends Esc) |
| `/new` | Start a fresh conversation in the session |
| `/compact` | Compact the conversation to free up context |
| `/cost` | Usage & cost breakdown |
| `/context` | Token-context usage |
| `/terminal [N]` | Show recent terminal activity (N lines) |
| `/autocontinue` | Auto-send "continue" when the usage limit resets (on/off) |
| `/dock` | Show the docked control-bar keyboard (`/dock off` to hide) |
| `/pin` | Toggle the pinned status message (`/pin on` \| `off`) |
| `/reply <response>` | Type a response into the session, then Enter (e.g. a `/login` code) |

Any other `/slash` command is relayed straight to Claude Code. Photos and
documents you send are made available to Claude to read.

When a flow like `/login` prints a sign-in URL, the bot relays it as a tappable
link; open it, then **reply to that message** with the code (or use `/reply <code>`)
to feed it back into the session.

## Configuration

Access policy and delivery/UX settings live in
`~/.claude/channels/telegram/access.json`, managed by `/telegram:access` and
re-read live on each message. Keys include `dmPolicy`, allowlists, group policy,
`ackReaction`, `replyToMode`, `textChunkLimit`, `chunkMode`, `renderMarkdown`, and
`terminalMirror` (the live activity feed — `"tools"` by default, `"digest"`, or
`"off"`). Full reference: [`ACCESS.md`](./ACCESS.md).

The bot token and transcription settings live in
`~/.claude/channels/telegram/.env` (kept `chmod 600`), managed by
`/telegram:configure`.

## Upgrading

The daemon is long-lived and deliberately survives Claude sessions, so installing
new plugin code doesn't replace the *running* process on its own. To avoid stale
behavior after an upgrade, the shim fingerprints the plugin's source on connect:
if the running daemon started on different code, the shim restarts it
automatically (it `SIGTERM`s the old daemon and respawns from the new code on the
next connect). **So a normal upgrade — update the plugin, start a session — just
works; no manual daemon kill needed.**

The one exception is a **bot-token** change: the token lives in `.env`, not in the
code, so it doesn't move the fingerprint. Apply a token change with the restart
documented in `/telegram:configure` (restart the session, or
`kill "$(cat ~/.claude/channels/telegram/daemon.pid)"`).

## Uninstalling

Run `/telegram:configure uninstall` for a guided teardown. It stops the
long-lived daemon and (if you ask for a full reset) removes the channel state
in `~/.claude/channels/telegram/` — the bot token, allowlist, and pairings.
Keep that state instead if you're just reinstalling/upgrading and want to stay
paired. The skill then prints the plugin-removal commands it can't run itself:

```
/plugin uninstall telegram@better-claude-plugins
/plugin marketplace remove better-claude-plugins
```

Plugins are cached, so to guarantee a fresh fetch on reinstall, also clear
`~/.claude/plugins/marketplaces/better-claude-plugins` and
`~/.claude/plugins/cache/better-claude-plugins`, then re-add the marketplace and
reinstall. Restart Claude Code to apply.

## Security

- Secrets (`.env`) are written `0600` and never echoed back in full.
- Replies can't exfiltrate the channel's own state directory (`assertSendable`).
- The skills will only act on requests from your **terminal session**, never
  from an inbound Telegram message — that boundary is what stops a
  prompt-injected message from reconfiguring access or leaking the token.
- Default policy is `pairing`; the setup flow pushes you toward a locked-down
  `allowlist`.

## Project layout

| File | Role |
| --- | --- |
| `shim.ts` | MCP server Claude talks to (the tools) |
| `daemon.ts` | Long-lived Telegram bot + access gate + session control |
| `common.ts` | Shared wire protocol and state paths |
| `markdown.ts` | Markdown→Telegram-HTML converter + chunk-safe splitter |
| `prompt.ts` | Pane-scrape detection of interactive prompts → Telegram buttons |
| `transcript.ts` | Off-MCP outbound: read replies + live activity from CC's transcript JSONL |
| `*.test.ts` | `bun test` unit suite for the parsers/formatters (markdown, transcript, prompt) |
| `server.ts` | Legacy all-in-one (kept for compatibility) |
| `transcribe_local.py` | Local faster-whisper transcription helper |
| `skills/` | `/telegram:configure` and `/telegram:access` skills |
| `ACCESS.md` | Access-control and delivery-config reference |

## License

Apache-2.0 — see [`LICENSE`](./LICENSE).
