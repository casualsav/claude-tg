// Forum-topics runtime — the live half of topic mode (the pure session<->topic store is
// topics.ts). Owns session-instance identity (the @tg_session pane stamp), topic lifecycle
// (create / close / reopen / retitle / reconcile), per-topic typing, and outbound routing
// (which chat+thread a session's output goes to). Extracted from daemon.ts so the DM and
// group paths are physically separate; the daemon wires the grammy Bot in via initTopicRuntime.
import { InlineKeyboard, type Bot } from 'grammy'
import { basename } from 'node:path'
import { exec } from './proc.ts'
import { paneCwd, paneAlive } from './pane-io.ts'
import { escapeHtml } from './markdown.ts'
import { loadAccess } from './access.ts'
import {
  genSessionId, isTopicMode, getGroupChatId, getTopicBySession, findTopicByCwd,
  setTopic, updateTopic, removeTopic, listTopics,
} from './topics.ts'
import { focus, offMcpPanes, sessions } from './state.ts'

let bot: Bot
export function initTopicRuntime(b: Bot): void { bot = b }

// Resolve a forum topic's session to a live pane: thread id → cwd (the topic map) → the off-MCP pane
// running in that cwd. Prefers the focused pane when it matches. Returns null if no live pane is in
// that cwd (the session ended) — the caller buffers rather than misrouting to another session.
async function paneForCwd(cwd: string): Promise<string | null> {
  if (focus.activePaneId && (await paneCwd(focus.activePaneId).catch(() => null)) === cwd) return focus.activePaneId
  for (const p of offMcpPanes) {
    if ((await paneCwd(p).catch(() => null)) === cwd) return p
  }
  return null
}


// ---- Session-instance identity (Track B foundation) ----
// Every pane gets a generated sessionId stamped as a tmux pane option, so the identity survives
// daemon restarts (tmux holds it) and one project can host several sessions, each its own topic.
// The cache also remembers ids for panes that have DIED — that's how close-on-end finds the topic.
const SESSION_PANE_OPT = '@tg_session'
const paneSessionCache = new Map<string, string>()   // paneId → sessionId (kept after pane death)

// Stamp a pane with a known sessionId (tmux option + cache) — used when a pane is spawned for a
// pre-bound topic, so discovery resolves it straight to that topic instead of minting a fresh id.
export async function stampPaneSession(pane: string, sid: string): Promise<void> {
  try { await exec('tmux', ['set-option', '-p', '-t', pane, SESSION_PANE_OPT, sid], { timeout: 2000 }); paneSessionCache.set(pane, sid) } catch {}
}

// The pane's session id: cache → pane option → mint/adopt + stamp. An unstamped pane first tries
// to adopt an existing topic entry for its cwd that no other live pane has claimed (this is the
// lazy migration of pre-Track-B cwd-keyed entries and the tmux-restart re-attach); otherwise a
// fresh id is minted. `stampIfMissing: false` is the read-only probe (no mint, no stamp).
export async function sessionForPane(pane: string, stampIfMissing = true): Promise<string | null> {
  const hit = paneSessionCache.get(pane)
  if (hit) return hit
  try {
    const { stdout } = await exec('tmux', ['show-options', '-pqv', '-t', pane, SESSION_PANE_OPT], { timeout: 2000 })
    const stamped = stdout.trim()
    if (stamped) { paneSessionCache.set(pane, stamped); return stamped }
  } catch { return null }   // pane gone — only the cache could answer, and it didn't
  if (!stampIfMissing) return null
  const cwd = await paneCwd(pane).catch(() => null)
  const cand = cwd ? findTopicByCwd(cwd) : undefined
  const claimed = cand && [...paneSessionCache.entries()].some(([p, s]) => s === cand.sessionId && p !== pane)
  const sid = cand && !claimed ? cand.sessionId : genSessionId()
  try { await exec('tmux', ['set-option', '-p', '-t', pane, SESSION_PANE_OPT, sid], { timeout: 2000 }) } catch { return null }
  paneSessionCache.set(pane, sid)
  return sid
}

// The live pane carrying `sessionId` — cache first, then the live panes' stamps (covers a daemon
// restart), then the entry's cwd as a last resort (a tmux restart drops pane options; only an
// unstamped pane may be adopted that way, so a sibling's pane is never grabbed).
export async function paneForSession(sessionId: string): Promise<string | null> {
  for (const [p, s] of paneSessionCache) {
    if (s === sessionId) {
      if (await paneAlive(p)) return p
      break   // recorded pane is dead — fall through to the scans
    }
  }
  for (const p of [...offMcpPanes]) {
    if ((await sessionForPane(p, false)) === sessionId) return p
  }
  const t = getTopicBySession(sessionId)
  if (t) {
    const p = await paneForCwd(t.cwd)
    if (p && !(await sessionForPane(p, false))) {
      try { await exec('tmux', ['set-option', '-p', '-t', p, SESSION_PANE_OPT, sessionId], { timeout: 2000 }) } catch {}
      paneSessionCache.set(p, sessionId)
      return p
    }
  }
  return null
}

// ---- Forum-topics outbound routing (phase 2b) ----
// Map a session to its forum topic, creating it on first use. Returns the topic's thread id, or
// undefined if creation failed (caller falls back to the General topic).
async function ensureTopicFor(group: string, sessionId: string, cwd: string): Promise<number | undefined> {
  const existing = getTopicBySession(sessionId)
  if (existing) {
    if (existing.closed) {
      try { await bot.api.reopenForumTopic(group, existing.threadId); updateTopic(sessionId, { closed: false }) } catch {}
    }
    return existing.threadId
  }
  const base = basename(cwd) || 'session'
  // Same-cwd siblings each get their own topic — disambiguate the title: "proj", "proj #2", …
  const siblings = listTopics().filter(e => e.cwd === cwd && !e.closed && e.sessionId !== sessionId).length
  const name = siblings > 0 ? `${base} #${siblings + 1}` : base
  try {
    const t = await bot.api.createForumTopic(group, name)
    setTopic(sessionId, { threadId: t.message_thread_id, cwd, name, closed: false, createdAt: Date.now() })
    process.stderr.write(`daemon: created topic "${name}" (thread ${t.message_thread_id}) for ${cwd} [${sessionId}]\n`)
    return t.message_thread_id
  } catch (e) {
    process.stderr.write(`daemon: createForumTopic failed for ${cwd}: ${e}\n`)
    return undefined
  }
}

// Where a session's outbound should go. DM mode → the allowlisted DM chats (no thread). Topic mode →
// the bound group, threaded to the session's own topic (created on first use; General if unresolvable).
export async function outboundTargetsFor(paneId: string | null): Promise<Array<{ chat: string; thread?: number }>> {
  const dmTargets = () => loadAccess().allowFrom.map(chat => ({ chat }))
  if (!isTopicMode()) return dmTargets()
  const group = getGroupChatId()
  if (!group) return dmTargets()
  const sid = paneId ? await sessionForPane(paneId) : null
  const cwd = paneId ? await paneCwd(paneId).catch(() => null) : null
  if (!sid || !cwd) return [{ chat: group }]
  return [{ chat: group, thread: await ensureTopicFor(group, sid, cwd) }]
}

// Eagerly give a freshly-discovered session its topic (don't wait for its first reply) and post a
// "session started" notice the user can reply to — so a new session is addressable from the group
// immediately. Idempotent + in-flight-guarded so concurrent discovery paths create exactly one topic
// and post exactly one notice. No-op outside topic mode.
const topicEnsureInFlight = new Set<string>()
export async function ensureSessionTopic(paneId: string): Promise<void> {
  if (!isTopicMode()) return
  const group = getGroupChatId()
  if (!group) return
  const sid = await sessionForPane(paneId)
  const cwd = await paneCwd(paneId).catch(() => null)
  if (!sid || !cwd) return
  if (getTopicBySession(sid) || topicEnsureInFlight.has(sid)) return   // already have it / creating it
  topicEnsureInFlight.add(sid)
  try {
    const thread = await ensureTopicFor(group, sid, cwd)
    if (thread) await bot.api.sendMessage(group,
      `🆕 <b>Session started</b>\n<code>${escapeHtml(cwd)}</code>\n\nType in this topic to drive this session.`,
      { parse_mode: 'HTML', message_thread_id: thread }).catch(() => {})
  } finally {
    topicEnsureInFlight.delete(sid)
  }
}

// Session ended → close its topic (history stays; ensureTopicFor reopens it if the session
// returns). The pane is already gone, so its id comes from the session cache (entries persist
// after death for exactly this). The paneAlive re-check guards against a transient tmux blip
// mass-pruning the registry and close/reopen-flapping topics.
export async function closeTopicForPane(pane: string): Promise<void> {
  if (!isTopicMode()) return
  const group = getGroupChatId()
  if (!group) return
  if (await paneAlive(pane)) return   // transient registry miss, not a real death
  const sid = paneSessionCache.get(pane)
  if (!sid) return
  const t = getTopicBySession(sid)
  if (!t || t.closed) return
  await closeTopicEntry(group, sid, t)
}

// A worktree session that ended cleanly leaves no reason to keep the worktree — remove it so
// <repo>-wt/ doesn't accumulate. Uncommitted changes keep it, with a note in the topic.
async function cleanupWorktree(group: string, t: { threadId: number; worktree?: { repo: string; path: string } }): Promise<void> {
  const wt = t.worktree
  if (!wt) return
  try {
    const dirty = (await exec('git', ['-C', wt.path, 'status', '--porcelain'], { timeout: 5000 })).stdout.trim()
    if (dirty) {
      await bot.api.sendMessage(group, `🌿 Worktree kept at <code>${wt.path}</code> — it has uncommitted changes.`,
        { parse_mode: 'HTML', message_thread_id: t.threadId }).catch(() => {})
      return
    }
    await exec('git', ['-C', wt.repo, 'worktree', 'remove', wt.path], { timeout: 10000 })
    process.stderr.write(`daemon: removed clean worktree ${wt.path}\n`)
  } catch (e) { process.stderr.write(`daemon: worktree cleanup failed for ${wt.path}: ${e}\n`) }
}

async function closeTopicEntry(group: string, sessionId: string, t: { threadId: number; cwd: string; name: string; worktree?: { repo: string; path: string } }): Promise<void> {
  await cleanupWorktree(group, t)
  // Opt-in auto-delete: the tab disappears entirely (Telegram has no "hide" for bots — delete is
  // the only way off the list, and it erases the topic's history). Default keeps close+reopen.
  if (loadAccess().topicOnEnd === 'delete') {
    try {
      await bot.api.deleteForumTopic(group, t.threadId)
      removeTopic(sessionId)
      process.stderr.write(`daemon: deleted topic "${t.name}" for ${t.cwd} (topicOnEnd=delete)\n`)
    } catch (e) { process.stderr.write(`daemon: deleteForumTopic failed for ${t.cwd}: ${e}\n`) }
    return
  }
  const kb = new InlineKeyboard()
    .text('🗑 Delete topic', `topicdel:${t.threadId}`)
    .text('🗑 Always delete', `topicdelalways:${t.threadId}`)
  await bot.api.sendMessage(group, '🏁 <b>Session ended</b> — topic closed. It reopens automatically if a session comes back to this project.\n\nDelete removes the tab (and this topic’s history); Always delete does that for every ended session from now on.',
    { parse_mode: 'HTML', message_thread_id: t.threadId, reply_markup: kb }).catch(() => {})
  try {
    await bot.api.closeForumTopic(group, t.threadId)
    updateTopic(sessionId, { closed: true })
    process.stderr.write(`daemon: closed topic "${t.name}" for ${t.cwd}\n`)
  } catch (e) { process.stderr.write(`daemon: closeForumTopic failed for ${t.cwd}: ${e}\n`) }
}

// Backstop for deaths the event path can't see: a session that exits while the daemon is down or
// restarting leaves its topic open forever (the new process never had the pane in its registry,
// so no death event ever fires — exactly what a deploy-window exit looks like). Sweep every OPEN
// topic on the discovery tick and close any with no live session in its cwd. Two consecutive
// misses (~2 ticks) before closing, so a transient tmux blip can't flap a healthy topic.
const topicMissCounts = new Map<string, number>()
export async function reconcileTopics(panes: string[]): Promise<void> {
  if (!isTopicMode()) return
  const group = getGroupChatId()
  if (!group) return
  const liveSids = new Set<string>()
  for (const p of panes) {
    const sid = await sessionForPane(p)   // stamps unstamped panes as a side effect — idempotent
    if (sid) liveSids.add(sid)
  }
  for (const s of sessions.values()) {   // MCP-shim sessions hold topics too — don't close theirs
    if (s.paneId) { const sid = await sessionForPane(s.paneId); if (sid) liveSids.add(sid) }
  }
  for (const t of listTopics()) {
    if (t.closed || liveSids.has(t.sessionId)) { topicMissCounts.delete(t.sessionId); continue }
    const misses = (topicMissCounts.get(t.sessionId) ?? 0) + 1
    if (misses < 2) { topicMissCounts.set(t.sessionId, misses); continue }
    topicMissCounts.delete(t.sessionId)
    await closeTopicEntry(group, t.sessionId, t)
  }
}

// Keep topic titles in step with the working tree: "dir" on the default branch, "dir · branch"
// elsewhere, renamed via editForumTopic when the branch changes (checked on the slow discovery
// tick; the per-cwd cache means one git call per project per tick and an edit only on change).
export const topicBranchCache = new Map<string, string>()   // sessionId → last branch we titled with
export async function refreshTopicTitles(panes: string[]): Promise<void> {
  if (!isTopicMode()) return
  const group = getGroupChatId()
  if (!group) return
  for (const pane of panes) {
    const sid = await sessionForPane(pane, false)
    if (!sid) continue
    const t = getTopicBySession(sid)
    if (!t || t.closed) continue
    const cwd = (await paneCwd(pane).catch(() => null)) ?? t.cwd
    let branch = ''
    try { branch = (await exec('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 2000 })).stdout.trim() } catch { /* not a git repo */ }
    if (topicBranchCache.get(sid) === branch) continue
    topicBranchCache.set(sid, branch)
    const num = / #(\d+)/.exec(t.name)?.[1]   // keep a sibling's "#2" through branch renames
    const folder = basename(cwd) || 'session'
    // Preserve the user's capitalization: a topic named "Brains" over folder …/brains (the
    // folder is the lowercased+dashed form of the typed topic name) keeps its name through
    // branch renames and daemon restarts — only a real folder change replaces the base.
    const curBase = t.name.replace(/ · [^·]*$/, '').replace(/ #\d+$/, '')
    const norm = (s: string) => s.trim().toLowerCase().replace(/[\\/\0\s]+/g, '-')
    const stem = norm(curBase) === folder.toLowerCase() ? curBase : folder
    const base = stem + (num ? ` #${num}` : '')
    // A repo pulled into the topic's folder often checks out a default branch named like the
    // topic itself — "Proj · Proj" says nothing twice. Suffix only an informative branch.
    const want = branch && !['main', 'master', 'HEAD'].includes(branch) && norm(branch) !== norm(stem)
      ? `${base} · ${branch}` : base
    if (want === t.name) continue
    try {
      await bot.api.editForumTopic(group, t.threadId, { name: want })
      updateTopic(sid, { name: want })
      process.stderr.write(`daemon: renamed topic for ${cwd} → "${want}"\n`)
    } catch (e) { process.stderr.write(`daemon: editForumTopic failed for ${cwd}: ${e}\n`) }
  }
}

// The existing topic thread for a pane's session (no creation) — for per-topic typing/pins.
export async function topicThreadFor(paneId: string | null): Promise<{ group: string; thread: number } | null> {
  if (!isTopicMode() || !paneId) return null
  const group = getGroupChatId()
  if (!group) return null
  const sid = await sessionForPane(paneId, false)
  if (!sid) return null
  const t = getTopicBySession(sid)
  if (!t || t.closed) return null
  return { group, thread: t.threadId }
}

// Show "typing…" in a session's own topic while it works (topic mode). Telegram's action expires
// after ~5s; the relay loops re-emit each tick (~1.5s) so it stays lit for the whole turn.
export async function emitTopicTyping(paneId: string | null): Promise<void> {
  const t = await topicThreadFor(paneId)
  if (!t) return
  await bot.api.sendChatAction(t.group, 'typing', { message_thread_id: t.thread }, AbortSignal.timeout(1500)).catch(() => {})
}

