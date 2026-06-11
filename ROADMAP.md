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

## 4. Morning digest — ✅ DONE (v0.1.71)
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
