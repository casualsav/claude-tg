# Port plan — full DM→group (per-topic) functionality

> **✅ COMPLETE (2026-06-11, v0.1.30).** Both tracks shipped and live-verified. Track A (every
> command/tap/relay topic-aware, incl. per-pane prompt detection for non-focused sessions) landed
> v0.1.19–0.1.28; Track B (session-id re-key via the `@tg_session` pane stamp, per-session
> transcripts via the `stamp-transcript.ts` SessionStart hook writing `@tg_transcript`, `/new`
> sibling sessions with own `proj #2` topics) landed v0.1.29–0.1.30. Extras beyond this plan:
> topic close/reopen + reconcile sweep on session end, 🗑 delete / always-delete, branch-aware
> retitles, user-created topics spawn sessions, thread-aware scheduler. This doc is kept as the
> design record; the original plan follows.

> **Sequencing (decided 2026-06-10).** Split into two tracks. **Track A — make the group fully
> functional with one session per project** — is being implemented now: port every command, tap, and
> relay to be topic-aware on the **existing cwd keying** (no schema change, no transcript change).
> **Track B — multiple sessions in one project (`/new` sibling topics)** — is deferred: it needs the
> session-id re-key (below) *and* per-session transcript resolution, because outbound is read from
> `resolveTranscript(cwd)` (most-recent `.jsonl` in the project dir) — two same-cwd sessions would
> cross-talk. Track B's cleanest fix: a hook that stamps each pane with `@tg_transcript=<path>`
> (Claude Code hands hooks `transcript_path`). The "Topic keying" + `/new` sections below are Track B.

**Goal.** A new user can opt into **forum-topics mode**: one Telegram supergroup, one topic per
Claude Code session. Everything that works in a DM works the same inside each session's topic — type
to drive it, get replies, taps, prompts, status, all scoped to *that* session. **General** is the
control channel (global/overview commands only). DM-only users are unaffected — every change is gated
on `isTopicMode()`.

## Where we are (as of v0.1.14)

The **outbound** spine is built. These already route to the right topic via the existing helpers
`outboundTargetsFor(paneId)` (→ `{chat, thread}[]`) and `topicThreadFor(paneId)`:

- ✅ Inbound by topic — text / voice / photos / files map `message_thread_id → cwd → pane` and drive
  that session (`emitInbound`, daemon ~4961). Topic whose session ended → buffered, not misrouted.
- ✅ Agent reply text → the session's topic (`sendAgentText(..., t.thread)`, ~919/992).
- ✅ Live activity / `/stream` card → the session's topic (v0.1.12).
- ✅ Per-topic "typing…" (v0.1.11) and per-topic pinned status card (v0.1.14; session identity dropped from the card in v0.1.32 — the tab is the session).
- ✅ Eager per-session topic + "session started" notice on discovery (`ensureSessionTopic`).
- ✅ `dmCommandGate` admits the bound group (v0.1.10) — commands *run* in the group.

What's **left** is everything driven from a command/tap/prompt that still assumes a single global
focus. The pattern to kill, repo-wide: handlers read `focus.activePaneId` / `focus.paneWatcher` and
reply to `String(ctx.chat!.id)` (or `ctx.reply` with no thread). In a topic that means "drive the
*focused* session, answer in *General*." Re-target each to the topic's session and reply in-thread.

## Build first — shared command-side plumbing

The outbound helpers exist; the **command/inbound-control** mirror does not. Build these once:

0. **Re-key topics by session-instance id, not cwd** (foundational — see "Topic keying" below). A
   project can now hold **multiple** sessions (via `/new`), each its own topic, so cwd is no longer a
   unique key. `topics.json` becomes `{ sessionId → { threadId, cwd, name, closed, createdAt } }`;
   `getCwdByThread` → `getSessionByThread`, `getTopicByCwd` → `getTopicBySession`, and `paneForCwd` →
   `paneForSession` (resolve the live pane by its stamped session marker, not by cwd scan).
1. **`commandTarget(ctx)` → `{ paneId, watcher, isFocused, replyThread? } | null`** — the inverse of
   `outboundTargetsFor`. Works for both `bot.command` and `callback_query` (read the thread from
   `ctx.message?.message_thread_id` ?? `ctx.callbackQuery?.message?.message_thread_id`).
   - Topic mode + a thread id → `getSessionByThread(thread)` → `paneForSession(sessionId)`;
     `replyThread = thread`; `isFocused = (paneId === focus.activePaneId)`;
     `watcher = isFocused ? focus.paneWatcher : undefined`. Topic exists but its session is gone →
     reply in-thread "session isn't running", return `null`.
   - General (no thread) **or** DM → `focus.activePaneId` / `focus.paneWatcher`; `replyThread =
     undefined`. This preserves today's behavior exactly.
2. **`replyInThread(ctx, text, opts?)`** — `ctx.reply` already auto-threads to the source topic; the
   bug is the handlers that bypass it with `bot.api.sendMessage(String(ctx.chat!.id), …)` (no thread).
   Audit (`grep -n "sendMessage(String(ctx.chat"`) and switch each to `ctx.reply` or pass
   `{ message_thread_id: replyThread }`. Same for the chunked readout sends inside `runReadout`.
3. **`injectToPaneAny(paneId, watcher, text)`** — focused → `injectPaste(paneId, watcher, text)`;
   non-focused → `pasteToPane(paneId, text)` (the scheduler/`outboundTargetsFor` pattern). Non-focused
   panes have **no `PaneWatcher`** — pane-driving commands must use the paste path off-focus; captures
   (`capturePane(paneId)`) work on any pane with no watcher.

## Topic keying — session-instance id (data-model change)

Topics move from cwd-keyed to **session-keyed** so one project can host several sessions, each its own
topic (decided: `/new` in a topic spawns a same-project sibling session/topic).

- **Stable id.** Pane ids churn; cwd isn't unique anymore. Stamp each adopted session with a generated
  `sessionId` token written to a tmux pane option (e.g. `@tg_session`) at `claude-tg` adoption, and
  store it in `topics.json`. It survives daemon restarts (the pane option persists); a tmux-server
  restart drops every pane anyway, so nothing is orphaned.
- **Resolver.** `paneForSession(sessionId)` finds the live pane whose `@tg_session` matches (replacing
  the cwd scan in `paneForCwd`). Inbound (`getCwdByThread` at ~4968) and `outboundTargetsFor`/
  `topicThreadFor` switch to the session key; `ensureSessionTopic`/`ensureTopicFor` create/look up by
  sessionId, with cwd carried as a field for the title.
- **Title.** First session in a cwd → project/branch name; subsequent → ` #2`, ` #3`. `editForumTopic`
  on branch change as today.
- **Migration.** Existing cwd-keyed `topics.json` entries map 1:1 to the first session in each cwd on
  first load (synthesize a sessionId, stamp the matching pane). Tolerant loader already drops malformed
  rows.

## Slash commands to port

Each: target the topic's session via `commandTarget`, drive via `injectToPaneAny`, reply in-thread.
The blocker today is that the readout/mode/relay helpers take `focus.*` implicitly — generalize them
to accept `(paneId, watcher?)`.

- **Read-only (easy):** `/terminal`, `/cost`, `/context` — `doReadout`/`runReadout` (daemon ~2625) and
  the `/terminal` handler (~3025) hardcode `focus.activePaneId`. Take the target pane; type into it via
  the paste path off-focus, then `capturePane`; chunked reply in-thread.
- **`/stop`** — `confirmStop` (~2367) → send `Escape` to the **target** pane, not the focused one.
- **Pane-driving (refactor to take `paneId`, watcher optional):** `/mode` + aliases
  (`/plan` `/auto` `/default` `/acceptedits` `/bypass` `/yolo`), `/model`, `/effort`, `/compact`,
  `/clear`/`/reset`, `/restart`, `/new`. These call `handleModeCommand`/`switchToMode`/`relaySlashCommand`
  with `focus.paneWatcher` (~2256/480/2213); generalize to the target pane + paste path off-focus.
  - **`/new` in a topic spawns a fresh session in that topic's project** (same cwd) and gives it its
    **own new topic** — `createForumTopic` with a disambiguated title (`foo`, then `foo #2`, …). This
    is why topics are re-keyed by session-instance id (step 0); two same-cwd sessions can't share one
    topic. The "Add new session" path (`confirmNewSession`/`newsession` callback, ~2319) must, in topic
    mode, launch in the originating topic's cwd and bind the new pane to a new topic. (`/new` in General
    stays global — focused session's project, as today.)
- **Force-reply round-trips:** `/md`, `/schedule`, `/rename`, session name. The reply key is
  `${chatId}:${messageId}` (`renameReplyTargets`/`nameReplyTargets`/etc.); **also store the thread** so
  both the force-reply prompt *and* its eventual result land back in the originating topic.
- **Stay in General (global control), no per-topic change:** `/sessions`, `/settings`, `/update`,
  `/bind`/`/unbind`, `/start`/`/help`, `/status`, `/resume`, `/autocontinue`, `/mcp`, `/pin`. (These act
  on the whole bridge or list all sessions — General is their home. They may run in a topic too, but
  they don't need a per-session target.)

## Button taps (callback_query) — currently single-focus

`bot.on('callback_query:data')` (~4060) and the `/compact` button (~4097) use `focus.activePaneId`.
Route every per-session callback through `commandTarget(ctx)` so a tap on a **topic's** pin/card acts
on that topic's pane:

- Per-topic status-pin quick actions (Model / Mode / Stop) must target the pin's own topic pane.
- Interactive-prompt taps (`freeTextPrompts` / `chatPrompts`, ~4728/4755/4784) key on
  `${chat}:${message_id}` — already message-scoped, so they resolve correctly; just confirm the
  follow-up reply threads back (it inherits the source message's thread via `ctx.reply`).

## Remaining outbound relays → the session's topic

Three still blast `loadAccess().allowFrom` with no thread; route each to the **originating** session's
topic (fall back to `allowFrom`/General when no topic):

- **Permission prompts** — `relayPermissionToTelegram` (~1842). The origin pane is known
  (`permissionOrigin` by `request_id`) → `outboundTargetsFor(originPane)`. **Highest value.**
- **Interactive prompts / select menus** — `relayPromptToTelegram` (~1772).
- **Login / auth-URL prompts** — `relayAuthUrlToTelegram` (~1928).
- **Usage-limit banners, unread pings, pre-flush sends** (~945/1768) → the session's topic.

## Access / pairing in the group

- `dmCommandGate` admits the bound group (v0.1.10). Confirm **per-sender** gating holds inside topics:
  a non-allowlisted member posting in any topic is ignored / told to pair; the existing group policy in
  `ACCESS.md` governs. Pairing replies should thread back to where they were sent.
- Decision (from `docs/forum-topics.md`): **allowlist-only** drives sessions; group membership alone
  doesn't. Keep that.

## Caveats

- **Watcher/mirror are single-focus.** Non-focused panes have no `PaneWatcher` → drive via
  `pasteToPane`, capture directly. The rich activity mirror already follows the focused pane; per-topic
  cards landed in v0.1.12/0.1.14.
- **Keep DM mode byte-identical** — every branch gated on `isTopicMode()`; the General/no-thread path
  must reduce to exactly today's `focus.*` behavior.

## Suggested order (each step deployable + testable on its own)

1. **Re-key topics by session-instance id** (topics.ts schema + resolver + migration) — the foundation
   `/new` and multi-session topics depend on. Then `commandTarget` + `replyInThread` audit +
   `injectToPaneAny`. (No behavior change in DM/General.)
2. Read-only: `/terminal`, `/cost`, `/context`.
3. `/stop`.
4. Pane-driving: `/mode*`, `/model`, `/effort`, `/compact`, `/clear`, `/restart`, and `/new` (spawns a
   same-project sibling session + its own topic).
5. Force-reply thread persistence: `/md`, `/schedule`, `/rename`, name.
6. Button taps (callbacks) → `commandTarget`, incl. per-topic pin quick-actions.
7. Relays → topic: permission (first), interactive prompt, auth-URL, banners/pings.
8. Access/pairing-in-topic confirmation pass.

## Test harness

Two sessions (`projects` + `test`). For each ported path: run in the **test** topic → acts on the test
session, reply lands in the test topic; run in **General** → acts on the focused session (unchanged);
run in **DM** → unchanged. Watch especially: non-focused pane injection (paste path, no watcher),
reply threading, and permission/prompt taps landing in the right topic.
