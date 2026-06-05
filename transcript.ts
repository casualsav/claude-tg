// Read Claude Code session transcripts — the off-MCP outbound path. Instead of the
// agent calling an MCP reply tool, the daemon reads what the agent said from CC's
// per-session JSONL transcript and relays it. Each line is one event; assistant `text`
// blocks are the real reply (thinking / tool_use / tool_result are separate types and
// never relayed). Every entry carries `type`, `timestamp`, `cwd`, `sessionId`.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

type Entry = { type?: string; uuid?: string; timestamp?: string; cwd?: string; message?: { content?: unknown } }

// Text content of an entry: a bare string, or the joined `text` blocks of a content
// array (tool_use / thinking blocks contribute nothing).
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')
  return ''
}

// A resumable session: id, its working dir, last-activity time, and a short title (the
// first real user message). For the /resume picker.
export type RecentSession = { sessionId: string; cwd: string; mtime: number; title: string }

// The most-recently-active sessions across every project, newest first. Stat is cheap, so we
// stat them all to sort, then read only the top `limit` for cwd + title.
export function listRecentSessions(limit: number): RecentSession[] {
  let projectDirs: string[]
  try { projectDirs = readdirSync(PROJECTS_DIR) } catch { return [] }
  const files: { path: string; sessionId: string; mtime: number }[] = []
  for (const d of projectDirs) {
    let names: string[]
    try { names = readdirSync(join(PROJECTS_DIR, d)) } catch { continue }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue
      const path = join(PROJECTS_DIR, d, n)
      try { files.push({ path, sessionId: n.slice(0, -6), mtime: statSync(path).mtimeMs }) } catch {}
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  return files.slice(0, limit).map(f => {
    let cwd = '', title = ''
    try {
      for (const l of readFileSync(f.path, 'utf8').split('\n')) {
        if (!l.trim()) continue
        let e: Entry
        try { e = JSON.parse(l) } catch { continue }
        if (!cwd && e.cwd) cwd = e.cwd
        // First human-typed message, skipping channel tags, slash commands, and synthetic
        // entries (command output / caveats) that aren't real prompts.
        if (!title && e.type === 'user') {
          const t = textOf(e.message?.content).replace(/\s+/g, ' ').trim()
          if (t && !/^[<\/#]/.test(t) && !/^Caveat:/i.test(t)) title = t.slice(0, 60)
        }
        if (cwd && title) break
      }
    } catch {}
    return { sessionId: f.sessionId, cwd, mtime: f.mtime, title }
  })
}

// The working dir a session was recorded in (read from its transcript), for relaunching it
// with `claude --resume <id>` in the right folder. Null if the session can't be found.
export function findSessionCwd(sessionId: string): string | null {
  let projectDirs: string[]
  try { projectDirs = readdirSync(PROJECTS_DIR) } catch { return null }
  for (const d of projectDirs) {
    const path = join(PROJECTS_DIR, d, `${sessionId}.jsonl`)
    if (!existsSync(path)) continue
    try {
      for (const l of readFileSync(path, 'utf8').split('\n')) {
        if (!l.trim()) continue
        try { const e = JSON.parse(l) as Entry; if (e.cwd) return e.cwd } catch {}
      }
    } catch {}
    return null
  }
  return null
}

// CC stores a session at ~/.claude/projects/<cwd with '/' → '-'>/<sessionId>.jsonl.
// Resolve the live transcript for a pane's cwd as the most-recently-written .jsonl in
// that project dir (the active session), verifying its last entry's cwd matches.
export function resolveTranscript(cwd: string): string | null {
  const dir = join(PROJECTS_DIR, cwd.replace(/\//g, '-'))
  let files: string[]
  try { files = readdirSync(dir).filter(f => f.endsWith('.jsonl')) } catch { return null }
  let best: string | null = null
  let bestMtime = -1
  for (const f of files) {
    const p = join(dir, f)
    let mt: number
    try { mt = statSync(p).mtimeMs } catch { continue }
    if (mt > bestMtime) { bestMtime = mt; best = p }
  }
  return best
}

// The reply the agent gave to a specific injected message: anchor on the exact text we
// typed in (it lands as a `user`/text entry), then take the LAST assistant `text` block
// before the next user input — the conclusion, not the "let me check…" narration.
// Returns null if the response carried no text (e.g. only tool calls, still working).
export function finalReplyForInjected(file: string, injectedText: string): string | null {
  let lines: string[]
  try { lines = readFileSync(file, 'utf8').split('\n') } catch { return null }
  const entries: Entry[] = []
  for (const l of lines) { if (l.trim()) try { entries.push(JSON.parse(l)) } catch {} }

  // Anchor on the LAST user entry whose text contains what we injected.
  let anchor = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === 'user' && textOf(entries[i].message?.content).includes(injectedText)) { anchor = i; break }
  }
  if (anchor < 0) return null

  let last: string | null = null
  for (let i = anchor + 1; i < entries.length; i++) {
    const e = entries[i]
    if (e.type === 'user' && textOf(e.message?.content).trim()) break  // next turn began
    if (e.type === 'assistant') {
      const t = textOf(e.message?.content).trim()
      if (t) last = t
    }
  }
  return last
}

// One tool call's name + a short representative detail, for the tool-feed mirror mode.
export type Activity = { tool: string; detail: string }

function toolDetail(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  // TodoWrite: show the task in progress (its present-tense activeForm), else the count.
  if (Array.isArray(o.todos)) {
    const todos = o.todos as Array<{ content?: string; activeForm?: string; status?: string }>
    const active = todos.find(t => t?.status === 'in_progress')
    const s = active ? (active.activeForm || active.content || '').trim() : `${todos.length} task${todos.length === 1 ? '' : 's'}`
    return s.length > 56 ? s.slice(0, 55) + '…' : s
  }
  const pick = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.query ?? o.description ?? o.prompt
  const s = (typeof pick === 'string' ? pick : '').replace(/\s+/g, ' ').trim()
  return s.length > 56 ? s.slice(0, 55) + '…' : s
}

// Tool calls made in the current (latest) turn — every assistant `tool_use` block after the
// last real user message (tool_result entries skipped, so a turn spans its tool calls), each
// summarised to name + a short detail. Oldest first.
export function currentTurnActivity(file: string): Activity[] {
  let lines: string[]
  try { lines = readFileSync(file, 'utf8').split('\n') } catch { return [] }
  const entries: Entry[] = []
  for (const l of lines) { if (l.trim()) try { entries.push(JSON.parse(l)) } catch {} }

  let anchor = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === 'user' && textOf(entries[i].message?.content).trim()) { anchor = i; break }
  }
  const acts: Activity[] = []
  for (let i = anchor + 1; i < entries.length; i++) {
    if (entries[i].type !== 'assistant') continue
    const content = entries[i].message?.content
    if (!Array.isArray(content)) continue
    for (const b of content as any[]) {
      if (b?.type === 'tool_use' && typeof b.name === 'string') acts.push({ tool: b.name, detail: toolDetail(b.input) })
    }
  }
  return acts
}

// The most recent assistant `text` block in the transcript, with its entry uuid — the
// conclusion of the latest completed turn when read at idle. Unlike finalReplyForInjected
// this needs no anchor, so it relays proactive messages (status pings, a "done" after a
// long task) too; the caller dedups on the uuid so nothing sends twice. Returns null if
// the tail is tool_use/thinking only (still working) or the transcript is unreadable.
export function latestFinalReply(file: string): { uuid: string; text: string } | null {
  let lines: string[]
  try { lines = readFileSync(file, 'utf8').split('\n') } catch { return null }
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim()
    if (!l) continue
    let e: Entry
    try { e = JSON.parse(l) } catch { continue }
    if (e.type !== 'assistant') continue
    const t = textOf(e.message?.content).trim()
    if (t) return { uuid: e.uuid ?? '', text: t }
  }
  return null
}

// Every completed turn's conclusion (the last assistant `text` block before the next user
// message) that appears AFTER the entry with `afterUuid` — used to replay what a session
// said while it was unfocused. Oldest first. If `afterUuid` is gone (compaction/rotation)
// we return just the latest, so a lost cursor never dumps the whole backlog.
export function finalRepliesAfter(file: string, afterUuid: string): { uuid: string; text: string }[] {
  let lines: string[]
  try { lines = readFileSync(file, 'utf8').split('\n') } catch { return [] }
  const entries: Entry[] = []
  for (const l of lines) { if (l.trim()) try { entries.push(JSON.parse(l)) } catch {} }

  const at = afterUuid ? entries.findIndex(e => e.uuid === afterUuid) : -1
  if (afterUuid && at < 0) { const latest = latestFinalReply(file); return latest ? [latest] : [] }

  const out: { uuid: string; text: string }[] = []
  let pending: { uuid: string; text: string } | null = null
  const flush = () => { if (pending) { out.push(pending); pending = null } }
  for (let i = at + 1; i < entries.length; i++) {
    const e = entries[i]
    if (e.type === 'user' && textOf(e.message?.content).trim()) { flush(); continue }  // turn boundary
    if (e.type === 'assistant') { const t = textOf(e.message?.content).trim(); if (t) pending = { uuid: e.uuid ?? '', text: t } }
  }
  flush()
  return out
}
