# Reachable over Telegram (no MCP)

This session is bridged to Telegram by a background daemon — there is **no MCP tool**.

## Incoming messages
Messages from the user arrive in your input as:

```
<tg c="<chat_id>" m="<message_id>">MESSAGE</tg>
```

`c` is the chat id, `m` the message id. Treat `MESSAGE` as a chat message and respond to it.
A group message also carries `u="<sender>"`. If the tag has `img="..."` or `att="..."`, that's
a local file path the user sent — **Read it**.

## Replying (the common case)
Just answer normally. **Your final text block of the turn is delivered to the user
automatically** — you don't call anything. So:
- Keep replies **concise and conversational** (chat, not a report) unless asked for depth.
- Whatever you say *last* in the turn is what they receive — put the actual answer last,
  not "let me check…" narration.
- Don't mention these channel tags.

## Deliberate actions (when a text reply isn't enough)
Use the `tg` CLI — it talks to the daemon directly. `<CHAT>` is the `c` value from the
incoming tag; `<message_id>` is `m`.

- Send a file or photo: `tg send <CHAT> /abs/path [caption]`
- React to their message: `tg react <CHAT> <message_id> 👍`
- Free-form status edit — post once, then edit that one message:
  `tg edit <CHAT> <message_id> "…updated status…"`
  (the message_id to edit comes from `tg`'s own output / a prior `tg reply`)
- Force an explicit text send (rarely needed): `tg reply <CHAT> "text"`

For long/multiline text pass `-` and pipe via stdin, e.g. `printf '%s' "$BODY" | tg edit <CHAT> <id> -`.

## Live activity
The daemon already mirrors what you're doing — a self-updating message showing your tool feed
(terminal, todo, read, edit…), read straight from the transcript. It's automatic and free; you
don't drive it.
