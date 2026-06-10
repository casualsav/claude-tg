# Forum-topics mode — one Telegram topic per Claude Code session

**Status:** design / in progress. Goal: run the bridge in a single Telegram **forum supergroup**
where **each Claude Code session is its own topic** (thread), instead of multiplexing every session
through one DM with a global "focused session".

## Why forum topics (not channels)

Telegram broadcast *channels* are one-way and can't host an interactive session. The right primitive
is a **supergroup with Topics enabled** (a "forum"): it gets N threaded topics, each addressable by
`message_thread_id`, and the Bot API can manage them (`createForumTopic`, `editForumTopic`,
`closeForumTopic`, `reopenForumTopic`, `deleteForumTopic`). Every `sendMessage`/reaction/pin takes a
`message_thread_id`, so routing is just "carry the right thread id." The bot must be an **admin with
the Manage Topics right**.

## Core model

- **One supergroup = the command center. One topic = one session.**
- **General topic = the global/control channel:** session overview, `/new`, `/settings`, `/update`,
  access/pairing. Messages in General carry no `message_thread_id` (or the forum's default), so we
  treat "no thread id" as the global scope.
- **Per-session commands act on their topic's session** (`/mode`, `/model`, `/cost`, `/context`,
  `/compact`, `/stop`, `/terminal`, `/stream`) — no global focus needed; the topic *is* the selector.

### The session↔topic map (the heart of the change)

Today the daemon routes everything through a single global `focus.activePaneId`. Forum mode replaces
that with a persistent map. Bind a topic to a **stable session identity, not a pane id** (pane ids
churn across tmux/daemon restarts):

- Stable key = the session's **cwd** (one topic per project/working dir), optionally a user label.
- Store in `STATE_DIR/topics.json`: `{ cwd → { threadId, name, closed } }` plus a reverse index.
- **Inbound:** message's `message_thread_id` → cwd → resolve the live pane for that cwd → inject.
- **Outbound:** the off-MCP transcript watcher emits per-pane; map pane→cwd→threadId and post there
  (replies, activity mirror, permission prompts, status pin).
- **Restart:** reload `topics.json` and re-resolve panes by cwd; nothing is lost.

## Lifecycle

- **Session adopted** (`claude-tg`): if no topic is bound for its cwd, `createForumTopic`
  (title = project dir / git branch), store the mapping, drop a status pin in the new topic.
- **Branch / context change:** `editForumTopic` to rename the topic.
- **Session ends** (pane gone): `closeForumTopic` — keep the history; `reopenForumTopic` if it returns.
- **Per-topic status pin:** each topic carries its own pinned status (session · model · mode + inline
  buttons). Reply keyboards are chat-wide so they can't be per-topic — but we already retired the
  docked control bar, so everything is inline keyboards, which *are* per-topic. 

## Access control

In a group, anyone can post in any topic, so the allowlist must gate **per sender** (the existing
group policy in `ACCESS.md`). Open decision recorded below.

## Opt-in, not a replacement

Detect the mode from the configured chat: if it's a forum supergroup (`chat.is_forum === true`), run
topic mode; otherwise keep today's single-chat/DM behavior. Two-account setups stay one group per
account (separate bots/tokens), as today.

## Gotchas

- Bot needs admin + Manage Topics; topic creation is rate-limited (don't burst).
- General-topic messages have absent/default `message_thread_id` — handle as global scope explicitly.
- Forums cap the number of topics; closing (not deleting) finished sessions keeps it tidy.
- A message posted in the wrong topic routes to the wrong session — binding + clear topic names matter.

## Phased plan

1. **Foundation (no behavior change, flagged):** mode detection + group config; `topics.json` store +
   a small map/module; thin API wrappers (`createTopic`/`closeTopic`/`renameTopic`/`sendToTopic`).
2. **Outbound by topic:** auto-create a topic on session adoption; route transcript replies, the
   activity mirror, and permission prompts to the bound topic; General becomes the control channel.
3. **Inbound by topic:** route messages by `message_thread_id` to the right session; retire the global
   `focus` in topic mode (keep it as the DM-mode fallback).
4. **Lifecycle polish:** rename on branch change, close on end, re-bind on restart, per-topic pins.
5. **Setup + docs:** group-install flow (create forum, add bot as admin, configure chat id) in
   `off-mcp/INSTALL.md`; update README.

## Open decisions

- **Who may drive sessions in the group?** Allowlist-only (same senders as DM) vs any group member.
  *Recommendation: allowlist-only* — a group member not on the allowlist is ignored / told to pair.
