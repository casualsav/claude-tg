## Claude-tg

<p align="center">
  <img src="assets/telegram-demo.jpg" width="380" alt="Claude Code driven from Telegram — live thinking, pinned status card with model, usage and context">
</p>

## Requirements

- [Claude Code](https://claude.com/claude-code) installed and logged in.
- [Bun](https://bun.sh) (the runtime; dependencies install on first launch).
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- `tmux` — required for some features. Core messaging works without it via MCP.
- Linux or macOS (on Windows, run inside [WSL2](https://learn.microsoft.com/windows/wsl/) — native Windows has no `tmux`).

## Installation: 

Start Claude in a tmux session, drop the link to this repo and tell Claude "install this here." It will walk you through installation and download any dependencies if missing.

## Launch

The installer adds the alias claude-tg, which runs Claude with the identifier for the daemon to pick up the session. After going through the initial install, run the alias inside a tmux session, then send a message to the Telegram bot.

For multi-session, add the Telegram bot as an admin with full rights in a Telegram group with topics enabled and send /bind in the general chat. Every new topic you make then opens a new session and lets you specify where it runs. 

## Usage

Send text, media, slash commands, and voice messages through Telegram. In multi-session mode, adding new group topics starts a new session, deleting a topic closes that session. 

These commands are added by the bridge. Everything else is Claude Code's own — see below.

| Command | What it does |
| --- | --- |
| `/start` | Welcome + full feature guide (and pairing steps if not paired) |
| `/stop` | Interrupt the current task — sends Esc (alias `/esc`) |
| `/cancel` | Clear a stuck force-reply prompt (e.g. an unanswered "name a folder") |
| `/back` | Get a stuck session — an editor, a pager, or an unrecognized screen — back to the Claude prompt |
| `/restart` | Restart & resume the session (`/restart all` for every active session) |
| `/resume` | List recent sessions with last-activity times; tap one to relaunch |
| `/new` | Start a fresh conversation in the session |
| `/files` | Browse, download, and edit files in the session's folder (web Mini App) |
| `/find <text>` | Search every session's conversation; tap a hit to resume |
| `/cron <when>` | Schedule a message for later (`/cron 12h` · `every 09:00` · `cancel`; alias `/schedule`) |
| `/queue <prompt>` | Per-session backlog — runs when the session goes idle (`/queue clear`) |
| `/loop <goal>` | Re-run a goal until its check passes (`status` · `stop` · `resume`) |
| `/terminal` | Show recent terminal activity (40 lines) |
| `/md` | Create a `.md` file in the working dir, then reply with its contents |
| `/budget` | Daily $ cap with 80%/100% warnings (`/budget 20` · `off`) |
| `/account` | Claude accounts — list, `add <name>`, `remove <name>` (multi-account) |
| `/status` | Re-post the pinned status card at the bottom (`/pin` toggles it) |
| `/health` | Bridge vitals — instance, uptime, panes, queues, watchdog |
| `/stream` | Live-activity card style: `thoughts` · `actions` · `off` |
| `/voice` | Voice-note replies on/off |
| `/settings` | Channel settings panel — Claude.ai accounts, GitHub accounts, voice transcription, and more |
| `/update` | Update menu with a button for each — `/update tg` updates the bridge, `/update claude` updates Claude itself |

**Mode shortcuts:** `/mode` opens the permission-mode switcher; `/plan` `/auto` `/default` `/acceptedits` `/bypass` jump straight to one.

**Everything else is Claude Code's own** — `/model`, `/effort`, `/compact`, `/context`, `/cost`, `/usage`, `/diff`, `/rewind`, and any others — relayed straight through to the session.


## Upgrading

Just run `/update tg` from inside the bot to update the bridge. Bonus: `/update claude` updates Claude itself, and bare `/update` opens a menu with a button for each.

## Uninstalling

Run `/telegram:configure uninstall` for a guided teardown.


## License

MIT — see [`LICENSE`](./LICENSE).
