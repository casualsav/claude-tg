# Testing in a clean container

To validate a branch before merging to `main`, install the plugin in an isolated
container that has nothing else installed — so you exercise the real
`/plugin install` path, not just the source tree.

## ⚠️ Use a separate test bot token

Telegram allows **only one poller per bot token**. If the test container uses
your production bot's token, its daemon will fight your real bot (HTTP 409) and
knock the live one offline. Create a throwaway bot with
[@BotFather](https://t.me/BotFather) and use *that* token here.

## Recipe

In the clean container:

```bash
# 1. Clone the branch under test (it carries .claude-plugin/marketplace.json)
git clone -b <branch> https://github.com/casualsav/better-claude-telegram
```

Then, in a Claude Code session in that container:

```
# 2. Register the local clone as a marketplace and install the plugin
/plugin marketplace add ./better-claude-telegram
/plugin install telegram@better-claude-plugins

# 3. Configure a fresh channel (test token, then pick a transcription backend)
/telegram:configure <TEST_bot_token>
/telegram:configure transcribe
```

Restart the Claude Code session so the plugin loads (its MCP server and the
`/telegram:*` skills).

## What to verify

- The `telegram` MCP server connects and the `/telegram:configure` and
  `/telegram:access` commands resolve.
- DM the test bot → you get a pairing code → `/telegram:access pair <code>` →
  the bot confirms you're in.
- Send a normal message; Claude replies; the **typing indicator** stays on while
  it works.
- **Markdown rendering:** ask Claude to reply with bold, a list, a link, and a
  fenced code block — confirm they render natively. Then
  `/telegram:access set renderMarkdown false` and confirm replies fall back to
  plain text on the next message.
- Send a **voice note**; it arrives transcribed (or, if transcription is off, you
  get the one-time enable hint).
- `/stop` interrupts a running task.
- Reactions: set `ackReaction` via `/telegram:access set ackReaction 👀` and
  confirm the bot reacts to your messages; confirm Claude can react too.
- Check `~/.claude/channels/telegram/daemon.log` for clean startup and no errors.
