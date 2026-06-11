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

## 4. Morning digest
One scheduled card across all sessions: what each did, what's blocked on you, cost, limit burn.
All the data already exists (transcripts, usage snapshots, statusline).

## 5. Cross-session search — ✅ DONE (v0.1.69)
`/find <text>` greps every transcript; tap a hit to resume that session. Solves "which chat was
that in?" at 10+ sessions.

## 6. Rewind relay
Surface Claude Code's checkpoint/rewind as buttons ("undo last turn's edits") so a bad change
doesn't force a terminal visit.

## 7. Budget guardrail
Daily $ cap on top of the existing limit warnings: auto-pause sessions + ping at the cap.

## 8. Screenshot fallback
When prompt detection can't parse a TUI screen, send a rendered image of the pane instead of
failing silently — the escape hatch that makes full-remote trustworthy.
