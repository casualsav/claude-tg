// Forum-topics domain module — phase 1 foundation. See docs/forum-topics.md.
//
// Persists the session<->topic map for forum-topics mode (one Telegram topic per Claude Code
// session). This module is PURE storage + lookups: no grammy here, so it's unit-testable without a
// bot. The daemon wires the Bot API side (createForumTopic, sendMessage with message_thread_id) in a
// later phase; this module just owns the mapping and the "are we in topic mode?" flag.
//
// Topics are keyed by the session's **cwd** — the stable identity across tmux/daemon restarts (pane
// ids churn, cwd doesn't). One topic per working dir / project.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STATE_DIR } from './common.ts'

export const TOPICS_FILE = join(STATE_DIR, 'topics.json')

export type TopicEntry = {
  threadId: number      // Telegram message_thread_id of the forum topic
  name: string          // last title we set (project dir / git branch)
  closed: boolean       // session ended → topic closed but kept for history (reopen if it returns)
  createdAt: number
}

export type TopicStore = {
  groupChatId: string | null            // the forum supergroup; null = not configured → not in topic mode
  topics: Record<string, TopicEntry>    // keyed by cwd
}

let store: TopicStore = { groupChatId: null, topics: {} }
let loaded = false
let persist = true   // disabled by _resetForTest so unit tests never write to the real STATE_DIR

function save(): void {
  if (!persist) return
  try { writeFileSync(TOPICS_FILE, JSON.stringify(store), { mode: 0o600 }) } catch {}
}

// Load + validate from disk (tolerant: drops malformed entries rather than throwing). Cached after
// the first read; mutators keep the in-memory copy and disk in sync.
export function loadTopics(): TopicStore {
  try {
    const raw = JSON.parse(readFileSync(TOPICS_FILE, 'utf8')) as Partial<TopicStore>
    const topics: Record<string, TopicEntry> = {}
    for (const [cwd, e] of Object.entries(raw?.topics ?? {})) {
      const t = e as Partial<TopicEntry>
      if (t && typeof t.threadId === 'number') {
        topics[cwd] = {
          threadId: t.threadId,
          name: typeof t.name === 'string' ? t.name : '',
          closed: t.closed === true,
          createdAt: typeof t.createdAt === 'number' ? t.createdAt : 0,
        }
      }
    }
    store = { groupChatId: typeof raw?.groupChatId === 'string' ? raw.groupChatId : null, topics }
  } catch { /* missing/corrupt → keep the empty default */ }
  loaded = true
  return store
}

function ensureLoaded(): void { if (!loaded) loadTopics() }

// ---- mode / group ----
export function isTopicMode(): boolean { ensureLoaded(); return store.groupChatId !== null }
export function getGroupChatId(): string | null { ensureLoaded(); return store.groupChatId }
export function setGroupChatId(chatId: string | null): void {
  ensureLoaded()
  if (store.groupChatId === chatId) return
  store.groupChatId = chatId
  save()
}

// ---- session <-> topic map ----
export function getTopicByCwd(cwd: string): TopicEntry | undefined { ensureLoaded(); return store.topics[cwd] }

export function getCwdByThread(threadId: number): string | undefined {
  ensureLoaded()
  for (const [cwd, e] of Object.entries(store.topics)) if (e.threadId === threadId) return cwd
  return undefined
}

export function setTopic(cwd: string, entry: TopicEntry): void { ensureLoaded(); store.topics[cwd] = entry; save() }

export function updateTopic(cwd: string, patch: Partial<TopicEntry>): void {
  ensureLoaded()
  const cur = store.topics[cwd]
  if (!cur) return
  store.topics[cwd] = { ...cur, ...patch }
  save()
}

export function removeTopic(cwd: string): void { ensureLoaded(); delete store.topics[cwd]; save() }

export function listTopics(): Array<{ cwd: string } & TopicEntry> {
  ensureLoaded()
  return Object.entries(store.topics).map(([cwd, e]) => ({ cwd, ...e }))
}

// Test seam: set the in-memory store directly, mark it loaded, and disable disk persistence so
// mutators in tests don't write to the real STATE_DIR/topics.json.
export function _resetForTest(s?: TopicStore): void {
  store = s ?? { groupChatId: null, topics: {} }
  loaded = true
  persist = false
}
