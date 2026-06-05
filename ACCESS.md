# Telegram — Access & Delivery

A Telegram bot is publicly addressable. Anyone who finds its username can DM it, and without a gate those messages would flow straight into your assistant session. The access model described here decides who gets through.

By default, a DM from an unknown sender triggers **pairing**: the bot replies with a 6-character code and drops the message. You run `/telegram:access pair <code>` from your assistant session to approve them. Once approved, their messages pass through.

All state lives in `~/.claude/channels/telegram/access.json`. The `/telegram:access` skill commands edit this file; the server re-reads it on every inbound message, so changes take effect without a restart. Set `TELEGRAM_ACCESS_MODE=static` to pin config to what was on disk at boot (pairing is unavailable in static mode since it requires runtime writes).

## At a glance

| | |
| --- | --- |
| Default policy | `pairing` |
| Sender ID | Numeric user ID (e.g. `123456789`) |
| Group key | Supergroup ID (negative, `-100…` prefix) |
| `ackReaction` quirk | Fixed whitelist only; non-whitelisted emoji silently do nothing |
| Config file | `~/.claude/channels/telegram/access.json` |

## DM policies

`dmPolicy` controls how DMs from senders not on the allowlist are handled.

| Policy | Behavior |
| --- | --- |
| `pairing` (default) | Reply with a pairing code, drop the message. Approve with `/telegram:access pair <code>`. |
| `allowlist` | Drop silently. No reply. Useful if the bot's username is guessable and pairing replies would attract spam. |
| `disabled` | Drop everything, including allowlisted users and groups. |

```
/telegram:access policy allowlist
```

## User IDs

Telegram identifies users by **numeric IDs** like `123456789`. Usernames are optional and mutable; numeric IDs are permanent. The allowlist stores numeric IDs.

Pairing captures the ID automatically. To find one manually, have the person message [@userinfobot](https://t.me/userinfobot), which replies with their ID. Forwarding any of their messages to @userinfobot also works.

```
/telegram:access allow 123456789
/telegram:access remove 123456789
```

## Groups

Groups are off by default. Opt each one in individually.

```
/telegram:access group add -1001234567890
```

Supergroup IDs are negative numbers with a `-100` prefix, e.g. `-1001234567890`. They're not shown in the Telegram UI. To find one, either add [@RawDataBot](https://t.me/RawDataBot) to the group temporarily (it dumps a JSON blob including the chat ID), or add your bot and run `/telegram:access` to see recent dropped-from groups.

With the default `requireMention: true`, the bot responds only when @mentioned or replied to. Pass `--no-mention` to process every message, or `--allow id1,id2` to restrict which members can trigger it.

```
/telegram:access group add -1001234567890 --no-mention
/telegram:access group add -1001234567890 --allow 123456789,987654321
/telegram:access group rm -1001234567890
```

**Privacy mode.** Telegram bots default to a server-side privacy mode that filters group messages before they reach your code: only @mentions and replies are delivered. This matches the default `requireMention: true`, so it's normally invisible. Using `--no-mention` requires disabling privacy mode as well: message [@BotFather](https://t.me/BotFather), send `/setprivacy`, pick your bot, choose **Disable**. Without that step, Telegram never delivers the messages regardless of local config.

## Mention detection

In groups with `requireMention: true`, any of the following triggers the bot:

- A structured `@botusername` mention
- A reply to one of the bot's messages
- A match against any regex in `mentionPatterns`

```
/telegram:access set mentionPatterns '["^hey claude\\b", "\\bassistant\\b"]'
```

## Delivery

Configure outbound behavior with `/telegram:access set <key> <value>`.

**`ackReaction`** reacts to inbound messages on receipt. Telegram accepts only a **fixed whitelist** of reaction emoji; anything else is silently ignored. The full Bot API list:

> 👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡

```
/telegram:access set ackReaction 👀
/telegram:access set ackReaction ""
```

**`replyToMode`** controls threading on chunked replies. When a long response is split, `first` (default) threads only the first chunk under the inbound message; `all` threads every chunk; `off` sends all chunks standalone.

**`textChunkLimit`** sets the split threshold. Telegram rejects messages over 4096 characters.

**`chunkMode`** chooses the split strategy: `length` cuts exactly at the limit; `newline` prefers paragraph boundaries.

**`renderMarkdown`** (default `true`) renders the standard Markdown in Claude's replies as native Telegram formatting — bold, italic, inline/block code, links, headings, lists, blockquotes. Claude just writes normal Markdown; no escaping needed. Set `false` to deliver replies as plain text. Read live, so changes apply on the next message.

**`terminalMirror`** (default `"tools"`) controls the live activity mirror — one self-updating message of what Claude is doing. `"tools"` shows the tool feed (💻 terminal, 📋 todo, 📖 read, ✏️ edit…) read straight from the transcript (zero usage); `"digest"` shows Claude's recent `●` narration blocks scraped from the pane; `"off"` disables it. An agent progress bar (`tg progress`) takes over the view when active.

## Voice transcription

Voice notes and audio files can be transcribed to text before they reach the session, so you can talk to Claude instead of typing. Transcription runs entirely outside Claude — a local model or a hosted API — so it never consumes Claude usage; only the resulting text enters the conversation (the same cost as if you had typed it). If transcription is disabled or fails, the message falls back to a placeholder plus the `attachment_file_id`.

The guided way to set this up is `/telegram:configure transcribe`, which asks which backend you want, collects the API key or installs the local engine, and writes `.env` for you. The daemon reads these settings live on each voice message, so changes apply immediately — no restart.

Under the hood it's environment variables in `~/.claude/channels/telegram/.env`. `TELEGRAM_TRANSCRIBE` selects the backend:

| Value | Backend | Setup |
| --- | --- | --- |
| `off` (default) | none | Voice/audio arrive as placeholders. |
| `local` | faster-whisper, on this machine | `pip install faster-whisper`. No API key, fully private, free. Same model weights as Groq — identical quality at the same model size; CPU is slower for large models. |
| `groq` | Groq Whisper API | Set `GROQ_API_KEY`. Free tier, very fast, `whisper-large-v3-turbo`. |
| `openai` | OpenAI Whisper API | Set `OPENAI_API_KEY`. `whisper-1`, ~$0.006/min. |

```
# ~/.claude/channels/telegram/.env
TELEGRAM_TRANSCRIBE=local
TELEGRAM_TRANSCRIBE_MODEL=large-v3-turbo   # optional; defaults per backend
```

Optional keys:

- **`TELEGRAM_TRANSCRIBE_MODEL`** — model override. Defaults: `base` (local), `whisper-large-v3-turbo` (groq), `whisper-1` (openai).
- **`TELEGRAM_WHISPER_PYTHON`** — Python interpreter for the local backend (default `python3`).
- **`TELEGRAM_WHISPER_DEVICE`** / **`TELEGRAM_WHISPER_COMPUTE`** — local device (`cpu`/`cuda`/`auto`) and compute type (`int8`, `float16`, …).

When a message was transcribed, the inbound `<channel>` tag carries `attachment_transcribed="true"` and the transcript is in the message body.

## Skill reference

| Command | Effect |
| --- | --- |
| `/telegram:access` | Print current state: policy, allowlist, pending pairings, enabled groups. |
| `/telegram:access pair a4f91c` | Approve pairing code `a4f91c`. Adds the sender to `allowFrom` and sends a confirmation on Telegram. |
| `/telegram:access deny a4f91c` | Discard a pending code. The sender is not notified. |
| `/telegram:access allow 123456789` | Add a user ID directly. |
| `/telegram:access remove 123456789` | Remove from the allowlist. |
| `/telegram:access policy allowlist` | Set `dmPolicy`. Values: `pairing`, `allowlist`, `disabled`. |
| `/telegram:access group add -1001234567890` | Enable a group. Flags: `--no-mention` (also requires disabling privacy mode), `--allow id1,id2`. |
| `/telegram:access group rm -1001234567890` | Disable a group. |
| `/telegram:access set ackReaction 👀` | Set a config key: `ackReaction`, `replyToMode`, `textChunkLimit`, `chunkMode`, `renderMarkdown`, `mentionPatterns`. |

## Config file

`~/.claude/channels/telegram/access.json`. Absent file is equivalent to `pairing` policy with empty lists, so the first DM triggers pairing.

```jsonc
{
  // Handling for DMs from senders not in allowFrom.
  "dmPolicy": "pairing",

  // Numeric user IDs allowed to DM.
  "allowFrom": ["123456789"],

  // Groups the bot is active in. Empty object = DM-only.
  "groups": {
    "-1001234567890": {
      // true: respond only to @mentions and replies.
      // false also requires disabling privacy mode via BotFather.
      "requireMention": true,
      // Restrict triggers to these senders. Empty = any member (subject to requireMention).
      "allowFrom": []
    }
  },

  // Case-insensitive regexes that count as a mention.
  "mentionPatterns": ["^hey claude\\b"],

  // Emoji from Telegram's fixed whitelist. Empty string disables.
  "ackReaction": "👀",

  // Threading on chunked replies: first | all | off
  "replyToMode": "first",

  // Split threshold. Telegram rejects > 4096.
  "textChunkLimit": 4096,

  // length = cut at limit. newline = prefer paragraph boundaries.
  "chunkMode": "newline",

  // Render Claude's Markdown as native Telegram formatting. false = plain text.
  "renderMarkdown": true
}
```
