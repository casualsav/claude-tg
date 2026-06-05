// Transcript parsing — the off-MCP outbound path. Fixtures are throwaway JSONL files.
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { latestFinalReply, finalRepliesAfter, currentTurnActivity, finalReplyForInjected } from './transcript.ts'

function fixture(entries: object[]): string {
  const f = join(mkdtempSync(join(tmpdir(), 'tg-transcript-')), 'session.jsonl')
  writeFileSync(f, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  return f
}
const user = (text: string, uuid: string) => ({ type: 'user', uuid, message: { content: text } })
const asst = (text: string, uuid: string) => ({ type: 'assistant', uuid, message: { content: [{ type: 'text', text }] } })
const tool = (name: string, input: unknown, uuid: string) => ({ type: 'assistant', uuid, message: { content: [{ type: 'tool_use', name, input }] } })

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

test('finalReplyForInjected returns the conclusion to a specific injected message', () => {
  const f = fixture([
    user('earlier', 'u0'), asst('nope', 'a0'),
    user('please do X', 'u1'), asst('let me check', 'a1'), asst('did X', 'a2'),
    user('next', 'u2'),
  ])
  expect(finalReplyForInjected(f, 'please do X')).toBe('did X')
})
