// Transcript parsing — the off-MCP outbound path. Fixtures are throwaway JSONL files.
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { latestFinalReply, finalRepliesAfter, turnInProgress, currentTurnActivity, currentTurnFeed, finalReplyForInjected } from './transcript.ts'

function fixture(entries: object[]): string {
  const f = join(mkdtempSync(join(tmpdir(), 'tg-transcript-')), 'session.jsonl')
  writeFileSync(f, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  return f
}
const user = (text: string, uuid: string) => ({ type: 'user', uuid, message: { content: text } })
// A conclusion text block (stop_reason end_turn) by default; pass 'tool_use' for mid-turn narration.
const asst = (text: string, uuid: string, stop: string = 'end_turn') => ({ type: 'assistant', uuid, message: { stop_reason: stop, content: [{ type: 'text', text }] } })
const narr = (text: string, uuid: string) => asst(text, uuid, 'tool_use')
const tool = (name: string, input: unknown, uuid: string) => ({ type: 'assistant', uuid, message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name, input }] } })
// A subagent (sidechain) text block — same transcript, but never the session's own reply.
const sub = (text: string, uuid: string) => ({ type: 'assistant', uuid, isSidechain: true, message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } })

test('latestFinalReply returns the last assistant text block', () => {
  const f = fixture([user('hi', 'u1'), asst('hello', 'a1'), asst('world', 'a2')])
  expect(latestFinalReply(f)).toEqual({ uuid: 'a2', text: 'world' })
})

test('latestFinalReply skips a tool-only tail (still working)', () => {
  const f = fixture([asst('done', 'a1'), tool('Bash', { command: 'ls' }, 't1')])
  expect(latestFinalReply(f)?.text).toBe('done')
})

test('finalRepliesAfter with an empty cursor returns every turn conclusion', () => {
  const f = fixture([
    user('q1', 'u1'), asst('mid', 'a1'), asst('end1', 'a2'),
    user('q2', 'u2'), asst('end2', 'a3'),
  ])
  expect(finalRepliesAfter(f, '').map(x => x.text)).toEqual(['end1', 'end2'])
})

test('finalRepliesAfter after a uuid returns only later conclusions', () => {
  const f = fixture([
    user('q1', 'u1'), asst('end1', 'a1'),
    user('q2', 'u2'), asst('end2', 'a2'),
  ])
  expect(finalRepliesAfter(f, 'a1').map(x => x.text)).toEqual(['end2'])
})

test('finalRepliesAfter with a lost cursor returns just the latest (no backlog dump)', () => {
  const f = fixture([user('q', 'u1'), asst('only', 'a1')])
  expect(finalRepliesAfter(f, 'gone').map(x => x.text)).toEqual(['only'])
})

test('currentTurnActivity summarises the latest turn’s tool calls', () => {
  const f = fixture([
    user('go', 'u1'),
    tool('Bash', { command: 'echo hi' }, 't1'),
    tool('Read', { file_path: '/x/y.ts' }, 't2'),
  ])
  expect(currentTurnActivity(f)).toEqual([
    { tool: 'Bash', detail: 'echo hi' },
    { tool: 'Read', detail: '/x/y.ts' },
  ])
})

test('currentTurnActivity renders TodoWrite as the in-progress task', () => {
  const todos = [
    { content: 'a', status: 'completed', activeForm: 'Doing a' },
    { content: 'b', status: 'in_progress', activeForm: 'Doing b' },
  ]
  const f = fixture([user('go', 'u1'), tool('TodoWrite', { todos }, 't1')])
  expect(currentTurnActivity(f)[0]).toEqual({ tool: 'TodoWrite', detail: 'Doing b' })
})

test('currentTurnActivity renders a todo count when nothing is in progress', () => {
  const todos = [{ content: 'a', status: 'pending', activeForm: 'Doing a' }, { content: 'b', status: 'pending', activeForm: 'Doing b' }]
  const f = fixture([user('go', 'u1'), tool('TodoWrite', { todos }, 't1')])
  expect(currentTurnActivity(f)[0].detail).toBe('2 tasks')
})

test('finalRepliesAfter is the relay reply: the turn’s last text block, trailing tool and all', () => {
  // Claude writes the reply, then ends the turn with a trailing tool call (e.g. a todo update /
  // `tg react`) and an empty end_turn — the reply text carries a 'tool_use' stop_reason. It must
  // still relay as the reply (not get swallowed as narration).
  const f = fixture([
    user('q', 'u1'),
    narr('here is the answer', 'a1'),               // reply, but stop_reason tool_use (a tool follows)
    tool('TodoWrite', { todos: [] }, 't1'),
    { type: 'assistant', uuid: 'a2', message: { stop_reason: 'end_turn', content: [] } },  // empty tail
  ])
  expect(finalRepliesAfter(f, '').map(x => x.text)).toEqual(['here is the answer'])
})

test('turnInProgress: true while mid-tool, false once a conclusion lands', () => {
  const working = fixture([user('q', 'u1'), narr('working', 'a1'), tool('Bash', {}, 't1')])
  expect(turnInProgress(working)).toBe(true)
  const done = fixture([user('q', 'u1'), narr('working', 'a1'), tool('Bash', {}, 't1'), asst('done', 'a2')])
  expect(turnInProgress(done)).toBe(false)
})

test('turnInProgress: a no-tool turn concludes immediately (no card)', () => {
  const f = fixture([user('q', 'u1'), asst('answer', 'a1')])
  expect(turnInProgress(f)).toBe(false)
})

test('currentTurnFeed interleaves narration + tools, dropping the conclusion text', () => {
  const f = fixture([user('q', 'u1'), narr('looking', 'a1'), tool('Read', { file_path: '/x' }, 't1'), asst('done', 'a2')])
  // 'done' is the conclusion (relayed as its own message) — it must NOT appear in the card.
  expect(currentTurnFeed(f)).toEqual([
    { kind: 'text', text: 'looking' },
    { kind: 'tool', tool: 'Read', detail: '/x', lines: null },
  ])
})

test('currentTurnFeed(concluded) drops a trailing-tool reply so it never folds into the card', () => {
  // The reply ('the answer') has a 'tool_use' stop_reason because a TodoWrite follows it. Live
  // (concluded=false) it shows as a thought; once concluded it's the relayed reply, so the card
  // must drop it — otherwise the final message folds into the stream.
  const f = fixture([
    user('q', 'u1'),
    narr('checking things', 'a1'),
    tool('Read', { file_path: '/x' }, 't1'),
    narr('the answer', 'a2'),                       // the reply (tool_use because a tool follows)
    tool('TodoWrite', { todos: [] }, 't2'),
  ])
  expect(currentTurnFeed(f, false).some(i => i.kind === 'text' && i.text === 'the answer')).toBe(true)
  expect(currentTurnFeed(f, true).some(i => i.kind === 'text' && i.text === 'the answer')).toBe(false)
  expect(currentTurnFeed(f, true).some(i => i.kind === 'text' && i.text === 'checking things')).toBe(true)
})

test('finalReplyForInjected returns the conclusion to a specific injected message', () => {
  const f = fixture([
    user('earlier', 'u0'), asst('nope', 'a0'),
    user('please do X', 'u1'), asst('let me check', 'a1'), asst('did X', 'a2'),
    user('next', 'u2'),
  ])
  expect(finalReplyForInjected(f, 'please do X')).toBe('did X')
})

test('turnInProgress: an injected meta user entry (Skill instructions) is not a turn boundary', () => {
  // A Skill call injects its instructions as a user entry with isMeta:true mid-turn. Treating it
  // as a boundary made the turn read "not working" until the next assistant entry — which split
  // the live mirror card in two. The anchor must stay on the real prompt.
  const meta = { type: 'user', uuid: 'm1', isMeta: true, message: { content: 'Base directory for this skill: …' } }
  const f = fixture([user('go', 'u1'), narr('thinking', 'a1'), tool('Skill', { command: 'graphify' }, 't1'), meta])
  expect(turnInProgress(f)).toBe(true)
})

test('currentTurnFeed: an injected meta user entry does not reset the feed', () => {
  const meta = { type: 'user', uuid: 'm1', isMeta: true, message: { content: 'skill instructions' } }
  const f = fixture([user('go', 'u1'), narr('before skill', 'a1'), meta, narr('after skill', 'a2')])
  expect(currentTurnFeed(f).map(i => i.kind === 'text' ? i.text : i.tool)).toEqual(['before skill', 'after skill'])
})

test('multi-root: resolveTranscript picks the newest across roots; find/list carry the root', () => {
  const { mkdtempSync, mkdirSync, utimesSync } = require('node:fs')
  const rootA = mkdtempSync(join(tmpdir(), 'tg-rootA-'))
  const rootB = mkdtempSync(join(tmpdir(), 'tg-rootB-'))
  const proj = '-projects-x'
  mkdirSync(join(rootA, proj)); mkdirSync(join(rootB, proj))
  const fa = join(rootA, proj, 'aaa.jsonl'), fb = join(rootB, proj, 'bbb.jsonl')
  writeFileSync(fa, JSON.stringify({ type: 'user', cwd: '/projects/x', message: { content: 'hi a' } }) + '\n')
  writeFileSync(fb, JSON.stringify({ type: 'user', cwd: '/projects/x', message: { content: 'hi b' } }) + '\n')
  const old = (Date.now() - 60_000) / 1000
  utimesSync(fa, old, old)   // make rootA's file older so rootB's wins

  const { resolveTranscript, findSessionCwd, listRecentSessions } = require('./transcript.ts')
  expect(resolveTranscript('/projects/x', [rootA, rootB])).toBe(fb)
  expect(findSessionCwd('aaa', [rootA, rootB])).toEqual({ cwd: '/projects/x', root: rootA })
  const recents = listRecentSessions(10, [rootA, rootB])
  expect(recents.map((r: { sessionId: string; root: string }) => [r.sessionId, r.root])).toEqual([['bbb', rootB], ['aaa', rootA]])
})
