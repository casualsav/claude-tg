# Roadmap

Goal: drive multiple Claude Code sessions entirely from a phone — zero terminal after setup.
Ordered roughly by how much terminal-avoidance each feature buys. (Discussed 2026-06-11.)

## 1. Ship the work — ✅ DONE (v0.1.65)
Close the "code is edited but not landed" gap.
- `/diff` — always available: stat summary + chunked syntax-highlighted diff of the session's
  working tree.
- **Ship buttons** (settings toggle, default OFF — agent-managed-git users need zero new noise):
  after a turn that leaves the tree dirty, a small "📝 N files changed +A −D" footer with
  `📄 Diff · ✅ Commit · ⬆️ Push · 🔀 PR` buttons. Commit asks the session's Claude to write the
  message; Push runs `git push`; PR runs `gh pr create` and drops the link.

## 2. Dead-session revival — ✅ DONE (v0.1.67)
A topic whose session died (reboot, crash, deploy window) should revive on message: typing into
it respawns `claude -c` in that cwd and delivers the message, instead of "couldn't reach".

## 3. Queue for later — ✅ DONE (v0.1.68)
`/queue <prompt>` — per-session backlog (/later alias) that injects when the session goes idle. "When you're
free" to complement /schedule's "at 3pm".

## 4. Morning digest — ✅ DONE (v0.1.71) · ❌ REMOVED (v0.1.127)
One scheduled card across all sessions: what each did, what's blocked on you, cost, limit burn.
All the data already exists (transcripts, usage snapshots, statusline).

## 5. Cross-session search — ✅ DONE (v0.1.69)
`/find <text>` greps every transcript; tap a hit to resume that session. Solves "which chat was
that in?" at 10+ sessions.

## 6. Rewind relay — ✅ DONE (v0.1.71)
Surface Claude Code's checkpoint/rewind as buttons ("undo last turn's edits") so a bad change
doesn't force a terminal visit.

## 7. Budget guardrail — ✅ DONE (v0.1.71, warn-only by design)
Daily $ cap on top of the existing limit warnings: auto-pause sessions + ping at the cap.

## 8. Screenshot fallback — ✅ DONE (v0.1.71, as text-screen dump on failed delivery)
When prompt detection can't parse a TUI screen, send a rendered image of the pane instead of
failing silently — the escape hatch that makes full-remote trustworthy.

---

# Wave 2 (approved 2026-06-11)

## 9. Worktree siblings — ✅ DONE (v0.1.83)
Spawning a second session in the same repo shares one working tree — edits collide. Offer
"spawn in a git worktree" on /new and topic-create so same-repo sessions work in parallel
safely (worktree auto-created under e.g. `<repo>-wt/<topic>`, cleaned up on topic close).

## 10. Queue for limit reset — ✅ DONE (v0.1.84)
/queue fires on idle; the other big wait is the 5h usage window. `/queue @reset <prompt>`
fires the moment the limit window rolls over (reset time already parsed for the status card),
so dead hours soak up queued work.

## 11. Recurring schedules — ✅ DONE (v0.1.85)
/schedule is one-shot, /digest is a special-cased daily. Generalize: `/schedule every 09:00
<prompt>` (cron-lite: daily/weekday/weekly) with a dashboard listing + cancel, reusing the
scheduler store.

## 12. Edited message → correction — ✅ DONE (v0.1.86)
Editing a sent Telegram message currently does nothing. Relay the edit as a correction
("✏️ correction to earlier message: …") into the session — matches the instinct of fixing a
typo'd prompt in place.

## 13. Permission-storm batching — ✅ DONE (v0.1.87)
A turn raising N permission prompts costs N taps. When prompts queue up, one card with
"✅ Allow all from this turn" (scoped to that turn, not bypass) plus per-item Deny.

## 14. /health card — ✅ DONE (v0.1.88)
Two daemons, watchdog, version-keyed caches, revival — debugging the meta-layer needs the log.
One card: instance, version, uptime, adopted panes, queue depths, last crash, watchdog state;
covers both accounts' bridges.

## 15. TTS voice replies — ✅ DONE (v0.1.90)
Daemon-side text→speech of outbound replies as Telegram voice notes (local Piper, same
provisioning pattern as Whisper; zero Claude-usage cost). /settings toggle off/digest-only/all;
long replies capped or summarized.

## 16. Session todos in the pin — ✅ DONE (v0.1.89)
Surface the session's internal todo list (TaskCreate/TodoWrite state from the transcript) in
the per-topic status card — see what a working session is grinding through mid-turn.

## 17. Native rich messages (Bot API 10.1) — ✅ P1+P2 DONE (v0.2.48 / v0.2.49) · P3 PLANNED
Render Claude's markdown as native Telegram structure (tables / headings / nested lists /
collapsible / code) instead of the HTML-subset approximation, behind the `richMessages` pref
(default off; /settings toggle). `richmsg.ts` owns the raw 10.1 HTTP calls (grammy 1.41.1 has no
types/methods yet); every call falls back to the existing HTML/chunk path on any error, so
flag-off behavior is byte-identical.

- **P1 — static send, both modes (✅ v0.2.48):** `sendAgentText` (the final relay reply) and the
  `reply` action (`tg reply` / MCP) each send ONE `sendRichMessage` carrying the raw markdown,
  with `message_thread_id` + `reply_parameters`. Works in DM and forum topics — verified live in
  a supergroup with 0 fallbacks.
- **P2 — rich edits, both modes (✅ v0.2.49):** the `edit_message` action edits via
  `editMessageText(rich_message)` so tables/headings survive an edit, with an HTML-edit fallback.
  Only the agent-markdown edit path is routed — the daemon's own HTML status chrome (status
  cards, `/update tg`) stays HTML.
- **P3 — live draft streaming, DM-ONLY (PLANNED).** `sendRichMessageDraft` is written and
  unit-tested in `richmsg.ts` but deliberately unwired: there is no live token source. The daemon
  delivers replies by reading *completed* assistant text from the transcript
  (`finalRepliesAfter` → `sendAgentText`) after the turn concludes, so there is nothing partial
  to stream. Plan for when we wire it:
    1. **Source of partials:** reuse the transcript tail that already drives the live activity
       mirror (`currentTurnFeed` / `currentTurnActivity`). The model's mid-turn narration blocks
       (stop_reason `tool_use`) are the growing text; the concluding block (`end_turn`) is the
       finalize trigger.
    2. **Stream:** on each new narration delta during a turn, in a DM only, call
       `sendRichMessageDraft(token, chatId, draftId, { markdown: cumulativeText })` reusing ONE
       non-zero `draft_id` for the whole turn (Telegram animates the diff; the draft is a 30s
       ephemeral preview with no server message id).
    3. **Finalize:** on turn conclusion send the real message via `sendRichMessage` (the existing
       P1 path); the draft is superseded by the permanent message. Allocate a fresh `draft_id`
       per turn.
    4. **Gate:** DM only — `sendRichMessageDraft` is unsupported in supergroups/channels, so
       groups and topics keep the static P1 path untouched. Gate on chat type (+ a pref; possibly
       fold into the existing `stream` setting).
    5. **Overlap to resolve:** this partly duplicates the live activity-mirror card, which already
       surfaces narration in DM under `stream=thoughts`. Decide whether the rich draft *replaces*
       the mirror card in DM or runs alongside it — likely replaces, to avoid two live surfaces.
    6. **Open Qs:** draft update rate (Telegram's per-chat send budget — see the group
       send-budget governor); a `RichBlockThinking` "thinking" block as the pre-first-token state;
       cleanup if a turn errors mid-stream (the draft auto-expires at 30s, so low risk).
