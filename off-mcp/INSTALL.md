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

## 0.6. Upgrading: force-refresh a stale plugin cache (if this plugin was installed before)
The plugin cache is **keyed by the version string** in `.claude-plugin/plugin.json` /
`marketplace.json`. If a previous install left a cache dir and the version string is **unchanged**,
Claude Code treats it as "already installed" and **never re-copies the newer code** — even after the
marketplace clone pulls a newer HEAD. The result: the daemon keeps running a frozen old build, and
repo changes (new commands, fixes) silently never appear. Always do this when any
`~/.claude/plugins/cache/claude-tg/telegram/*/` dir already exists:

1. **Stop the running daemon + watchdog** (otherwise they keep serving old code, and a restart
   would replay buffered inbound):
   ```sh
   for p in $(pgrep -f 'telegram/.*/(daemon|watchdog)\.ts'); do kill "$p"; done
   : > ~/.claude/channels/telegram/pending-events.jsonl   # avoid replaying buffered inbound
   rm -f ~/.claude/channels/telegram/daemon.sock ~/.claude/channels/telegram/*.pid
   ```
2. **Refresh the source the cache is built from** — update the marketplace clone to current HEAD
   (`/plugin marketplace update claude-tg`, or `git -C
   ~/.claude/plugins/marketplaces/claude-tg pull`).
3. **Make sure the version was bumped.** If the marketplace clone's `plugin.json` version equals an
   existing cache dir name, the cache will NOT refresh on its own. The maintainer must bump the
   version on every shipped change (see the repo `CLAUDE.md` "Deploy loop"). If you're installing and
   the version wasn't bumped, **delete the stale cache dir(s)** so the restart re-copies:
   ```sh
   rm -rf ~/.claude/plugins/cache/claude-tg/telegram/*/   # forces a clean re-copy
   ```
4. Continue with the install; Step 4 below verifies the **running** build matches what you expect.

## 0.7. Choose the run mode (off-MCP vs MCP)
This plugin can bridge Telegram two ways. **The default is off-MCP** — present the choice to
the user and let them pick:

| | **Off-MCP** (default) | **MCP** |
| --- | --- | --- |
| Per-request cost | **Zero** — no MCP server; replies are read from the transcript | ~700 tokens of tool schemas **+** an instruction block injected on **every** request |
| Requires | **tmux** (the daemon drives the session's pane) | nothing — works without tmux |
| Launch with | `claude-tg` (off-MCP launch alias; tags the pane `@tg_bridge`) | plain `claude` |
| Functions | **Full** — reply, react, edit, files, permission prompts, every command | Full (identical) |

Both modes expose the exact same features (reactions, file send/receive, permission buttons,
all `/commands`) — off-MCP just routes deliberate actions through the `tg` CLI instead of MCP
tools. **Off-MCP is recommended** unless the user genuinely can't use tmux.

The MCP server ships **disabled** (`mcp.json.disabled`), so off-MCP is the out-of-the-box
default. **Record the user's choice now** — you act on it after the plugin is installed (Step 5):

- **Off-MCP (default):** leave the server disabled; work sessions launch with `claude-tg`.
- **MCP:** after the plugin is installed, **enable it** — rename `mcp.json.disabled` → `.mcp.json`
  in the plugin dir (or run `/telegram:configure mcp on`). Once enabled, the MCP server **loads
  automatically on every plain `claude` launch** — the *only* ways it won't load are starting
  with `--strict-mcp-config`, or turning it off via `/settings` or
  `/telegram:configure mcp off`. Work sessions then launch with **plain `claude`**.

Default to off-MCP.

## 1. Interview the human and write the config (before any restart)
Ask these one by one (don't assume defaults silently — confirm each), then write the two
files below. **You can write them now even though the plugin isn't installed yet** — they
live in the state dir, and the daemon reads them on first start.

**If either file already exists (re-install / upgrade), MERGE — never overwrite wholesale.**
Preserve `.env` keys you didn't just collect (e.g. `TELEGRAM_BANG_SHELL`, TTS API keys) and
keep `access.json`'s pairing/group/prefs state, only adding the interviewed Telegram ID to
`allowFrom`. A blind rewrite here once wiped a working config.

**Questions:**
1. **Bot token** — from @BotFather. (Required.)
2. **Your Telegram numeric user ID** — to lock the bot to you. If they don't know it,
   tell them to DM [@userinfobot](https://t.me/userinfobot), which replies with their ID.
   (If they'd rather pair after restart, skip this and see the note in Step 4.)
3. **Voice transcription of inbound voice/audio notes?** One of:
   - `off` (voice arrives as a placeholder),
   - `local` (Whisper on this machine — **recommend a model from the hardware**, see below),
   - `groq` (ask for **GROQ_API_KEY**; default model `whisper-large-v3-turbo`),
   - `openai` (ask for **OPENAI_API_KEY**; default model `whisper-1`).

   **If they pick `local`, don't just default the model — size it to the machine and present the
   options with a recommendation.** First probe the hardware:
   ```sh
   nproc                                                      # CPU cores
   (command -v nvidia-smi >/dev/null && nvidia-smi -L) || echo "no CUDA GPU"
   free -h | awk '/Mem:/{print $2" RAM"}'
   ```
   The model ladder (smallest/fastest → largest/most accurate): `tiny` → `base` → `small` →
   `medium` → `large-v3`, plus `large-v3-turbo` (a distilled `large-v3`: near-large accuracy, much
   faster). English-only `.en` variants (`tiny.en`…`medium.en`) are slightly better for English at
   the same size. On CPU, latency scales with both model size **and** clip length. **Recommend by
   hardware, then let them choose:**
   - **CUDA GPU present** → `large-v3-turbo`, **device `cuda`** — best accuracy, still fast.
   - **CPU-only, ≤4 cores** → **`small`** (the balanced pick; ~7s on a short note on a 4-core ARM
     box), or `base` for snappier/rougher. `medium`/`large` are painfully slow here (`medium` ≈ 3×
     `small`; a 30–40s note can take a minute+) — only if accuracy clearly outweighs speed.
   - **CPU-only, 5–8 cores** → `small` for chat, or `medium` if they want accuracy and tolerate the
     wait. `large`/`turbo` are GPU territory.
   - **Tight RAM (<4 GB free)** → stay at `small` or below (`medium` peaks ~2 GB, `large` ~4 GB).

   Also pick **device** (`cpu`, or `cuda` only if a GPU was detected) and keep **compute `int8`**
   (good CPU default). Whichever model they choose, **provision it during install** — see
   "If `local`: provision the engine now" right after the config writes below. (The daemon also
   self-heals on the first voice note as a backstop, but provisioning at install is better: it
   makes the first note instant instead of carrying a ~1–3 min install, and the daemon can't
   `sudo apt-get install python3-venv` if `ensurepip` is missing — you can.)
4. **Voice replies (TTS)?** (default off.) Claude's replies can also arrive as Telegram
   voice notes — zero extra Claude usage (it speaks text already written). Mode `off` |
   `digest` (only the daily /digest is spoken) | `all` (every reply). If on, pick an engine:
   - `piper` (recommended) — local & free; the daemon auto-installs the engine + a voice
     (~80MB) when first enabled. No key.
   - `openai` — hosted, ~$0.015/1k chars; ask for **OPENAI_API_KEY**.
   - `elevenlabs` — best voices, priciest; ask for **ELEVENLABS_API_KEY**.

   Write the choice into `access.json` as `"tts": { "mode": "<digest|all>", "engine":
   "<piper|openai|elevenlabs>" }` (omit entirely for off) and any key into `.env`. All of it
   is changeable later from chat: /settings → 🔊 Voice replies.
5. **More than one Claude account?** (default no.) If they have e.g. a personal and a work
   account, collect short names for the extra ones (`work`, lowercase letters/digits/dashes,
   ≤16 chars; the default account is `main` = `~/.claude`). Each maps to its own config dir
   `~/.claude-<name>`. After setup they can launch sessions on any account straight from
   Telegram (/settings → 👤 Accounts → 🚀, or `/account`) — the one-time login link relays into
   the chat, so they never need the terminal for it. Accounts can also be added later with
   `/account add <name>`.
6. **Files Mini App?** (default off.) A built-in file explorer opened from Telegram — browse,
   preview, and download files on the session's machine, right inside the chat. It needs a public
   HTTPS URL to reach the local server; how that URL is obtained is the choice:
   - **Tailscale Funnel** — *recommended; free, and opens inside group chats.* Gives a stable public
     URL with no domain of your own, so the explorer opens in-place in your group/topic. One-time
     setup, mostly automated below: install Tailscale, a quick browser login, flip Funnel on. Best
     balance of zero cost and full functionality.
   - **cloudflared quick tunnel** — *zero setup.* The daemon bundles it; nothing to install or sign
     up for. Trade-off: its URL changes on every restart, so the explorer can only open in a private
     **DM with the bot**, not in the group/topic. Good for single-session use, or if you're fine
     opening files in the DM with the bot rather than in the group.
   - **Custom domain** — *most control/privacy.* If you already own a domain, point it at the app via
     your own reverse proxy for a stable, fully self-owned URL — nothing routed through a third-party
     tunnel. Also opens in-group.
   - **off** — no file explorer.

   The explorer is read-only (browse / preview / download); edits are done chat-side. The Funnel and
   custom-domain options need one extra step — registering the URL as the bot's **Main Mini App** in
   BotFather — handled in "If the Files Mini App is enabled" below.

Markdown rendering is **always on** — Claude's replies are rendered as Telegram formatting; it
isn't a prompt.

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
TELEGRAM_WHISPER_PYTHON=<venv>/bin/python   # local only — written by the provisioning step below
GROQ_API_KEY=<key>                          # groq only
OPENAI_API_KEY=<key>                        # openai only
# Files Mini App — only if enabled (Q6):
TELEGRAM_WEBAPP_ENABLED=1                    # turns the file explorer on
TELEGRAM_WEBAPP_TUNNEL=tailscale            # tailscale = in-group · cloudflared = DM-only (default) · none = use PUBLIC_URL
TELEGRAM_WEBAPP_PUBLIC_URL=https://files.example.com   # custom-domain option only (overrides the tunnel)
```

**Write `~/.claude/channels/telegram/access.json`** locked to their ID (omit this file and
use pairing instead if they didn't give an ID):
```json
{ "dmPolicy": "allowlist", "allowFrom": ["<their-telegram-id>"], "groups": {}, "pending": {},
  "renderMarkdown": true, "richMessages": true }
```

**If they registered extra accounts**, also write `~/.claude/channels/telegram/accounts.json`
(name → config dir) and `mkdir -p` each dir — the daemon seeds each one's `settings.json`
(statusline + hooks) at startup:
```json
{ "work": "/home/<user>/.claude-work" }
```

**If `local`: provision the engine AND download the model now — so it's fully ready before the
first note.** The daemon will self-heal on the first voice note if you skip this (it auto-installs
the engine then), but that makes the user wait ~1–3 min mid-conversation, and the daemon can't
`sudo apt-get install python3-venv` if it's missing. Doing it here makes the first note instant
and gets the prereq sorted. Set it up yourself, in order:

1. **Ensure `python3-venv` (ensurepip) is present** — `python3 -m venv` fails without it
   (`ensurepip is not available`), and PEP 668 system Python can't `pip install faster-whisper`
   directly, so a venv is required. On Debian/Ubuntu:
   ```sh
   python3 -c 'import ensurepip' 2>/dev/null || sudo apt-get update && sudo apt-get install -y python3-venv
   ```
   (If you can't `sudo`, tell the user to run that one line, or fall back to `groq`/`openai`.)
2. **Create the venv + install faster-whisper:**
   ```sh
   VENV=~/.claude/channels/telegram/whisper-venv
   python3 -m venv "$VENV"
   "$VENV/bin/python" -m pip install --quiet --upgrade pip
   "$VENV/bin/python" -m pip install --quiet faster-whisper
   "$VENV/bin/python" -c 'import faster_whisper; print("faster-whisper", faster_whisper.__version__)'
   ```
3. **Record the interpreter in `.env`** so the daemon uses it (not bare `python3`):
   `TELEGRAM_WHISPER_PYTHON=<venv>/bin/python`.
4. **Download the chosen model weights now** so the very first voice note transcribes instantly —
   no one-time download stall when the user starts using the bot. Instantiating the model fetches
   and caches its weights (`small` ≈ 250 MB, `medium` ≈ 1.5 GB, `large` ≈ 3 GB → `~/.cache/huggingface`).
   This needs only faster-whisper (just installed) plus the model name, so it runs **here, before
   the restart**, independent of the plugin cache:
   ```sh
   "$VENV/bin/python" - "<model>" "<cpu|cuda>" <<'PY'
   import sys
   from faster_whisper import WhisperModel
   WhisperModel(sys.argv[1], device=sys.argv[2], compute_type="int8")   # downloads + caches, then exits
   print("✓ weights cached for", sys.argv[1])
   PY
   ```
   Pass the same `<model>` and device you wrote to `.env`. Big models on a slow link take a few
   minutes — it's one-time and unattended, and it's the whole point: everything's ready before the
   user's first note. (Verify with a real transcription after Step 3's restart using the bundled
   helper if you want: `"$VENV/bin/python" "$(ls -d ~/.claude/plugins/cache/claude-tg/telegram/*/ | sort -V | tail -1)transcribe_local.py" <some.oga> <model>`.)

**If the Files Mini App is enabled (Q6): set up reachability now.** The webapp binds
`127.0.0.1:<port>` where `<port>` = `8787` + the bridge instance id (so `8787` for the default
instance, `8788` for a second one). Follow the path the user chose:

- **cloudflared (DM-only):** nothing to provision — the daemon auto-fetches the `cloudflared` binary
  and brings up the quick tunnel on first start. Just ensure `.env` has `TELEGRAM_WEBAPP_ENABLED=1`
  (leave `TELEGRAM_WEBAPP_TUNNEL` unset / `cloudflared`). No BotFather step — `/files` opens in a
  private DM with the bot.

- **Tailscale Funnel (in-group):** a free, stable `*.ts.net` URL. In order:
  1. **Install Tailscale** (skip if `tailscale version` already works). Linux:
     `curl -fsSL https://tailscale.com/install.sh | sh`. macOS: `brew install tailscale` or the App
     Store app. Windows: the official installer.
  2. **Log in:** `sudo tailscale up --operator=$(whoami)` — it prints a `https://login.tailscale.com/…`
     URL; **relay that to the user** to approve in any browser. This is the only login, and it does
     **not** require installing anything on their phone. `--operator` lets later `tailscale` commands
     run without sudo.
  3. **Turn Funnel on for the port:** `tailscale funnel --bg <port>` (prefix `sudo` if it reports a
     permissions error). The first time, Tailscale may print *"Funnel is not enabled on your tailnet"*
     with a `https://login.tailscale.com/f/funnel?node=…` link — **relay that to the user** to click
     once: it's a one-time owner toggle on a web page in the admin console, **not** a device install.
     Then re-run. Confirm with `tailscale funnel status` (shows `https://<host>.<tailnet>.ts.net …
     proxy http://127.0.0.1:<port>`).
  4. **Set `.env`:** `TELEGRAM_WEBAPP_ENABLED=1` and `TELEGRAM_WEBAPP_TUNNEL=tailscale`. The daemon
     reads the `*.ts.net` URL from `tailscale status` itself — leave `TELEGRAM_WEBAPP_PUBLIC_URL` unset.
  5. **Register it in BotFather** (shared step below), URL = the `https://<host>.<tailnet>.ts.net`
     from step 3.

- **Custom domain (in-group):** the user fronts the local port with their own HTTPS reverse proxy
  (nginx / Caddy / a Cloudflare *named* tunnel) → `http://127.0.0.1:<port>`. Then set `.env`:
  `TELEGRAM_WEBAPP_ENABLED=1` and `TELEGRAM_WEBAPP_PUBLIC_URL=https://<their-domain>`. Register that
  domain in BotFather (below).

**Shared BotFather step (Funnel + custom domain only — this is what enables the in-group launch):**
the in-group `/files` button opens the bot's **Main Mini App**, whose URL is set once in BotFather.
Tell the user: **@BotFather → `/mybots` → pick the bot → Bot Settings → Configure Mini App →
Edit/Enable**, and set the URL to the public URL from above. (cloudflared skips this — its URL rotates
each restart, so it can't be registered there, which is exactly why it's DM-only.)

## 2. Install the plugin + wire the hooks/convention
- In `~/.claude/settings.json` add the marketplace, enable the plugin, and add the
  daemon-resilience hook + (optionally) point the model:
```json
"extraKnownMarketplaces": {
  "claude-tg": { "source": { "source": "github", "repo": "casualsav/claude-tg" } }
},
"enabledPlugins": { "telegram@claude-tg": true },
"statusLine": { "type": "command", "command": "bash ~/.claude/statusline-command.sh" },
"hooks": {
  "SessionStart": [ { "hooks": [
    { "type": "command", "command": "bun \"$(ls -d ~/.claude/plugins/cache/claude-tg/telegram/*/ 2>/dev/null | sort -V | tail -1)ensure-daemon.ts\" >/dev/null 2>&1 || true" },
    { "type": "command", "command": "bun \"$(ls -d ~/.claude/plugins/cache/claude-tg/telegram/*/ 2>/dev/null | sort -V | tail -1)stamp-transcript.ts\" >/dev/null 2>&1 || true" }
  ] } ]
}
```
The hook resolves the **newest plugin-cache copy** of `ensure-daemon.ts` itself, so it works on
the very first restart with **nothing pre-written** — in pure off-MCP no shim ever runs, so this
hook is the *only* thing that starts the daemon, and it can't depend on a launcher the daemon
writes only after its first run. (The daemon still drops a `~/.claude/channels/telegram/ensure-daemon.js`
shim on startup for older hooks; the inline glob above just removes the bootstrap dependency on it.)
The second hook (`stamp-transcript.ts`) writes each session's transcript path onto its tmux pane
(`@tg_transcript`) so the daemon relays per session — required for several sessions in one project
(each gets its own forum topic).
- **Install the bundled status line — do it yourself, inline.** It's what populates the pinned
  message's live metrics: the daemon reads the statusline rendered in the session's pane (context
  bar, tokens, cost, session/api time, and the 5h/7d rate-limit bars for Pro/Max). **Set it up
  directly — write the `statusLine` settings entry above and copy the script with the command
  below. Do NOT run the `/statusline` command or hand this off to the `statusline-setup` subagent;
  it's unreliable and has failed installs.** Two steps, both you:
  ```sh
  cp statusline-command.sh ~/.claude/statusline-command.sh && chmod +x ~/.claude/statusline-command.sh
  ```
  and ensure `settings.json` has the `"statusLine"` block shown above (command
  `bash ~/.claude/statusline-command.sh`).
  The script **relies on `python3`** (used to parse Claude Code's session JSON — no jq), and
  degrades to a bare `user@host:cwd` line if `python3` is missing, so confirm `python3` is on PATH.
  **Statusline policy — our layout wins unless theirs is already complete.** The pin needs all of:
  context %, token counts, `$`cost, and the `5h`/`7d` rate-limit %. If the user has **no**
  statusline (the common case — just install it) **or** one that's missing any of those fields,
  install ours (write the `statusLine` entry + copy the script above), overriding theirs. **Only**
  leave an existing statusline untouched if it already shows **all** of those fields (the pin
  parses them from any reasonably-formatted line). When in doubt, install ours.
- Append this repo's `off-mcp/CLAUDE.md` into `~/.claude/CLAUDE.md` so every plugin-less
  session knows how to chat + use `tg`. **Wrap it in these exact marker comments** so `/update`
  can keep it current automatically (the updater swaps the content between them; a marker-less
  legacy block is migrated into markers on the first update):
  ```
  <!-- BEGIN claude-tg (off-mcp convention — auto-synced by /update; edits inside are overwritten) -->
  …contents of off-mcp/CLAUDE.md…
  <!-- END claude-tg -->
  ```

## 3. Restart Claude Code (the one restart)
**Ask the human to restart Claude Code.** On restart it downloads the plugin and the
daemon starts — reading the `.env` + `access.json` you already wrote, so the bot comes up
**fully configured and locked to their ID**, transcription set, off-MCP on.

The plugin cache often arrives as **just the `.ts` files** (no `package.json`/`bun.lock`/
`node_modules`). `ensure-daemon.ts` handles this: before launch it writes a **version-pinned
`package.json`** into the cache dir if absent and runs `bun install`, so grammy resolves to the
known-good **1.41.1** instead of floating to a build that crashes with
`EACCES … resolving 'debug'`. No action needed — but if the daemon ever fails to come up, that
EACCES line in `daemon.log` is the signature; the fix is to let `ensure-daemon` re-run (it's
idempotent) or `bun install` in the cache dir manually.

## 4. Confirm
**Run these checks yourself — do NOT hand the user a terminal checklist. The only thing to ask
the user is to message the bot (last paragraph).**
```sh
pgrep -fa daemon.ts        # one daemon — note the path: it must be the NEWEST version dir
tail -5 ~/.claude/channels/telegram/daemon.log   # want "polling as @<bot>", NOT an EACCES crash
# running build == newest cache version (catches the stale-cache trap from §0.6):
pgrep -fa daemon.ts | grep -o 'telegram/[^/]*/'
ls -d ~/.claude/plugins/cache/claude-tg/telegram/*/ | sort -V | tail -1   # should match
# grammy resolved to the pinned good version (not 1.43.x):
cat "$(ls -d ~/.claude/plugins/cache/claude-tg/telegram/*/ | sort -V | tail -1)node_modules/grammy/package.json" | grep '"version"'
```
If the running daemon path is an **older** version dir than the newest on disk, you're on stale
code — go back to §0.6 and force-refresh. Telegram clients also **cache** the command menu, so
after a refresh the human may need to reopen the chat / tap "/".

**The only user-facing step: ask them to send a message to the bot — it should reply.** (No ID
given in Step 1? Their first DM returns a pairing code; approve with `/telegram:access pair
<code>`, then lock with `/telegram:access policy allowlist`.)

## 5. Run a session — the daemon finds it

**If the user chose MCP mode (Step 0.7), enable it now** — the plugin is installed, so flip the
server on so it auto-loads for every plain `claude` session:
```sh
DIR=$(ls -d ~/.claude/plugins/cache/claude-tg/telegram/*/ | sort -V | tail -1)
[ -f "$DIR/mcp.json.disabled" ] && mv "$DIR/mcp.json.disabled" "$DIR/.mcp.json"   # MCP on
```
Then they launch work sessions with **plain `claude`** (no flag) — the MCP server loads every
time. To later turn it off: `/telegram:configure mcp off` or `/settings`.

> **tmux note for the pinned-message metrics.** The pin's live status card (context bar, cost,
> tokens, 5h/7d limits) is read from the **statusline rendered in the session's pane**, so the
> daemon needs a pane to read. Off-MCP always runs in tmux, so it always has one; MCP mode doesn't
> *require* tmux. An MCP session **running inside tmux** gets the full pin card; an MCP session
> **not** in tmux still works in every other way, but the pin falls back to the identity line only
> (the statusline still shows in their own terminal). For the full pin in MCP mode, run the session
> inside `tmux`.

**Off-MCP (default): explicitly ensure the server stays disabled.** MCP loads purely from the
presence of the plugin's `.mcp.json`, so don't just skip — actively confirm it's renamed aside,
in case a previous install or a re-download left one in place:
```sh
DIR=$(ls -d ~/.claude/plugins/cache/claude-tg/telegram/*/ | sort -V | tail -1)
[ -f "$DIR/.mcp.json" ] && mv "$DIR/.mcp.json" "$DIR/mcp.json.disabled"   # MCP off (off-MCP mode)
```
Off-MCP keeps the plugin's MCP server disabled, so a plain `claude` is already plugin-less — no
`--strict-mcp-config` needed for that anymore.

**Off-MCP (default):** run the work session in a tmux pane, launched so the daemon recognizes it as
a bridge session. The signature the daemon scans for is the **`@tg_bridge` tmux pane option** whose
**value is the instance slot** — a marker set at the tmux layer, so it never touches claude's args
(immune to claude rejecting unknown flags, and decoupled from autonomy mode). **Auto-add the
launcher function that tags the pane then launches** — append to the user's `~/.bashrc` (or
`~/.zshrc`). It takes an optional slot (default `1`), so `claude-tg` is the default bridge and
`claude-tg 2` routes to a second one; an optional second arg pins the session to an alternate
Claude account (`claude-tg 1 work` → `CLAUDE_CONFIG_DIR=~/.claude-work`, see `/account`):
```sh
claude-tg()   { tmux set -p @tg_bridge "${1:-1}" 2>/dev/null; if [ -n "$2" ]; then CLAUDE_CONFIG_DIR="$HOME/.claude-$2" claude --allow-dangerously-skip-permissions; else claude --allow-dangerously-skip-permissions; fi; }  # safe start, bypass on demand
```
Then **tell the user:** launch work sessions with **`claude-tg`**. The `@tg_bridge` pane option is
the bridge marker; the launch flag is the autonomy choice:
- **`claude-tg`** uses `--allow-dangerously-skip-permissions` — Claude starts in a normal mode where
  permission prompts are **relayed to Telegram** (Yes / allow-all / No buttons), and you can switch
  **into full bypass on demand** from the `/mode` picker. The safe, fully-remote-controllable default.

Bypass is optional: a pane tagged with `@tg_bridge` is bridged regardless of the launch
flag. You can switch modes any time (Shift+Tab, or `/mode`); in a
non-bypass mode, permission prompts are relayed to Telegram with **Yes / allow-all / No** buttons to
approve remotely.

That's it — the daemon **auto-discovers** the pane and binds automatically (no `TELEGRAM_FORCE_PANE`,
no restart). Several bridge panes? It asks which to use; to pin one, set `TELEGRAM_FORCE_PANE=<pane
id>` in `.env`. Your own MCP servers still load if you pass them (`claude-tg --mcp-config ~/my-mcp.json`).

## 6. Verify end to end
From Telegram, message the session → you get its reply (read from the transcript), no MCP
loaded. Ask it to "send me a file with `tg`" to confirm outbound actions.

**If inbound never reaches the session (pin shows "No active session"):** the daemon only
auto-adopts a pane carrying the **`@tg_bridge` tmux pane option** (set by the `claude-tg`
alias). A session started with a bare `claude` (no marker) is **not** adopted —
check with `tmux show-options -p @tg_bridge` in the pane, and confirm in `daemon.log` you see
`adopted off-MCP pane …`
or `focus pinned to …`. Fixes, in order of preference: (a) relaunch the work session with `claude-tg`;
or (b) pin the existing pane explicitly — get its id with
`tmux list-panes -a -F '#{pane_id} #{pane_current_command}'`, then set
`TELEGRAM_FORCE_PANE=<pane id>` in `.env` and restart the daemon. (`%`-ids are valid only while
that tmux server lives.) The daemon also DMs a one-time hint when a message arrives with no
adoptable pane.

## 7. (Optional) Multiple GitHub accounts
Only if the human pushes to repos owned by **different GitHub accounts** from these sessions
(e.g. a personal + a work account). Skip it for a single account.

The trap: `gh`'s own git credential helper only ever serves the **active** account's token, so
every HTTPS push authenticates as whoever's active — switching with `gh auth switch` is global and
races across the bridge's parallel sessions. The fix ships in this repo: `bin/gh-multi-credential`,
a credential helper that picks the token **per repo owner** via `gh auth token -u <account>` (which
returns any logged-in account's token regardless of active). No switching, concurrency-safe.

1. The human logs in once per account — the **traditional** path: `gh auth login` (repeat for each).
2. Install the helper to a **stable** path (NOT the version-keyed plugin cache — git points at it by
   absolute path), then enable it for github.com:
   ```bash
   install -m 755 "$(dirname "$(command -v claude-tg 2>/dev/null || echo .)")/../bin/gh-multi-credential" \
     ~/.local/bin/gh-multi-credential 2>/dev/null \
     || install -m 755 bin/gh-multi-credential ~/.local/bin/gh-multi-credential   # run from the repo checkout
   git config --global credential.https://github.com.useHttpPath true
   git config --global --unset-all credential.https://github.com.helper
   git config --global --add        credential.https://github.com.helper ""
   git config --global --add        credential.https://github.com.helper "!$HOME/.local/bin/gh-multi-credential"
   ```
3. By default repo owner == account (`alice/repo` → account `alice`). For orgs/forks you push as a
   different user, add `owner=account` lines to `~/.config/gh-multi-credential.map`. Unknown owners
   fall back to the active account, so cloning anything else still works.
4. Verify routing (token redacted) — each owner should resolve to its own account:
   ```bash
   printf 'protocol=https\nhost=github.com\npath=OWNER/repo.git\n\n' | git credential fill | grep '^username='
   ```
   Revert anytime: re-add the gh helper line (`!$(command -v gh) auth git-credential`) and unset `useHttpPath`.

## What you get, from Telegram
- Two-way chat with the session; send/receive files; inbound voice notes transcribed.
- **Permission prompts** relayed with tap-to-approve buttons.
- **Live activity mirror** — one self-updating message of what Claude is doing (tool feed, read
  from the transcript), on by default.
- **/sessions** (list · `/sessions #` switch · `/sessions name # <label>`), **/mode** & **/model**
  pickers, **/cost**, **/context**, **/stop**, **/new**, **/terminal**.
- **Auto-continue** when a usage limit resets — scheduled automatically on every hit, cancellable via a button on the limit notice (self-verifies + retries).

## Notes
- The daemon runs **standalone** (relaunched by the SessionStart hook), so it survives closing
  sessions and reboots — no MCP session needed to keep it alive.
- `TELEGRAM_FORCE_PANE=<pane>` in the `.env` overrides auto-discovery when you want a specific
  pane.
- **Running more than one bridge for the same user** (several bots, one tmux server): each bridge has
  an **instance id** — a number *or* a name (`2`, `work`). Id `1` is the default
  (`~/.claude/channels/telegram`, marker value `1`); any other id `<id>` lives in
  `~/.claude/channels/telegram-<id>` with its own token/access.json and marker value `<id>`.
  - Configure it from your terminal: **`/telegram:configure work <token>`** (writes the token to
    `telegram-work/.env` and starts that bridge's daemon), then **`/telegram:access work pair <code>`**
    to approve your DM into *its* allowlist — isolated from the default bridge.
  - Launch its work panes with **`claude-tg work`** (the launcher functions take the id). Each daemon
    adopts only panes whose `@tg_bridge` equals its own id, so they never cross-talk. (Inside such a
    session you can drop the id — the skills read it off the pane.) For a memorable shortcut a user
    can add their own wrapper, e.g. `alias work-bot='claude-tg work'`.
  - `ensure-daemon` enumerates every configured instance, so all bridges come back up after a reboot.
