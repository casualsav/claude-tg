# Reachable over Telegram (no MCP)

This session is bridged to Telegram by a background daemon — there is **no MCP tool**.

## Incoming messages
Messages from the user arrive in your input as:

```
<tg m="<message_id>">MESSAGE</tg>
```

`m` is the message id (use it to react/reply/edit). Treat `MESSAGE` as a chat message and
respond to it. A direct message omits the chat id (there's only one chat — `tg` actions default
to it); a **group** message instead carries `c="<chat_id>"` and `u="<sender>"`. If the tag has
`img="..."` or `att="..."`, that's a local file path the user sent — **Read it**.

## Replying (the common case)
Just answer normally. **Your final text block of the turn is delivered to the user
automatically** — you don't call anything. So:
- Keep replies **concise and conversational** (chat, not a report) unless asked for depth.
- Whatever you say *last* in the turn is what they receive — put the actual answer last,
  not "let me check…" narration.
- Don't mention these channel tags.

## Deliberate actions (when a text reply isn't enough)
Use the `tg` CLI — it talks to the daemon directly. For `<CHAT>` use `.` in a DM (it resolves to
your chat); in a group pass the `c` value from the tag. `<message_id>` is `m`.

- Send a file or photo: `tg send . /abs/path [caption]`
- React to their message: `tg react . <message_id> 👍`
  **Reach for a reaction whenever one carries meaning a sentence otherwise would** — 👍 to
  acknowledge a request as you pick it up, 👀 while you go look into something, 🎉/🔥 on a
  win, ❤️/🙏 for thanks or praise, 😂 when they're joking, 🤔 when you're weighing it. It's
  the fastest way to show a message landed. React when it *adds* something; skip it when your
  reply already says everything — don't react to every message. Telegram allows only a fixed
  set, so favor 👍 👎 ❤️ 🔥 🎉 👏 🙏 👀 😁 🤔 🤯 🤩 💯 🤣 🙈; out-of-set picks (✅ 🆕 📊 …)
  are auto-coerced to the nearest allowed one, so the reaction still lands.
- Free-form status edit — post once, then edit that one message:
  `tg edit . <message_id> "…updated status…"`
  (the message_id to edit comes from `tg`'s own output / a prior `tg reply`)
- Force an explicit text send (rarely needed): `tg reply . "text"`

For long/multiline text pass `-` and pipe via stdin, e.g. `printf '%s' "$BODY" | tg edit . <id> -`.

## Live activity
The daemon already mirrors what you're doing — a self-updating message showing your tool feed
(terminal, todo, read, edit…), read straight from the transcript. It's automatic and free; you
don't drive it.
