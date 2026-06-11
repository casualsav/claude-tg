import { test, expect } from 'bun:test'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { prettyModel, lastModelInTranscript, lastTodosInTranscript, modeBadge, pinMessageGone, statusKeyboard } from './status-card.ts'

const tmp = mkdtempSync(join(tmpdir(), 'sc-test-'))

test('prettyModel reduces ids to the family word', () => {
  expect(prettyModel('claude-opus-4-8')).toBe('Opus')
  expect(prettyModel('claude-fable-5')).toBe('Fable')
  expect(prettyModel(null)).toBe(null)
  expect(prettyModel('weird-model')).toBe('weird-model')
})

test('lastModelInTranscript picks the last non-synthetic model', () => {
  const f = join(tmp, 't1.jsonl')
  writeFileSync(f, [
    '{"message":{"model":"claude-opus-4-8"}}',
    '{"message":{"model":"claude-fable-5"}}',
    '{"message":{"model":"<synthetic>"}}',
  ].join('\n'))
  expect(lastModelInTranscript(f)).toBe('claude-fable-5')
  expect(lastModelInTranscript(join(tmp, 'missing.jsonl'))).toBe(null)
})

test('lastTodosInTranscript reads the latest TodoWrite state', () => {
  const f = join(tmp, 't2.jsonl')
  const todo = (todos: unknown) => JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos } }] } })
  writeFileSync(f, [
    todo([{ status: 'pending', content: 'a' }]),
    todo([
      { status: 'completed', content: 'a' },
      { status: 'in_progress', content: 'b', activeForm: 'Doing b' },
      { status: 'pending', content: 'c' },
    ]),
  ].join('\n'))
  expect(lastTodosInTranscript(f)).toEqual({ total: 3, done: 1, active: 'Doing b' })
  const empty = join(tmp, 't3.jsonl')
  writeFileSync(empty, '{"message":{"content":[]}}')
  expect(lastTodosInTranscript(empty)).toBe(null)
})

test('modeBadge stays short for the pin preview', () => {
  expect(modeBadge('bypassPermissions')).toBe('🛡yolo')
  expect(modeBadge('default')).toBe('🛡default')
})

test('pinMessageGone matches only gone-pin errors', () => {
  expect(pinMessageGone({ description: 'Bad Request: message to edit not found' })).toBe(true)
  expect(pinMessageGone({ description: 'Bad Request: message is not modified' })).toBe(false)
})

test('statusKeyboard carries the st:* quick actions', () => {
  const rows = statusKeyboard().inline_keyboard
  const datas = rows.flat().map(b => 'callback_data' in b ? b.callback_data : '')
  expect(datas).toContain('st:model')
  expect(datas).toContain('st:pinoff')
})
