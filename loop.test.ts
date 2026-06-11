import { test, expect } from 'bun:test'
import {
  parseCheckReply, parseMaxReply, parseBudgetReply, iterationPrompt, decideBoundary,
  readLoops, writeLoops, type LoopRecord,
} from './loop.ts'

// ---- Wizard reply parsing ----

test('parseCheckReply: command vs explicit none', () => {
  expect(parseCheckReply('bun test')).toEqual({ check: 'bun test' })
  expect(parseCheckReply('  none ')).toEqual({})
  expect(parseCheckReply('"unlimited"')).toEqual({})
  expect(parseCheckReply('')).toBeNull()
})

test('parseMaxReply: numbers, unlimited keywords, junk', () => {
  expect(parseMaxReply('25')).toEqual({ max: 25 })
  expect(parseMaxReply('unlimited')).toEqual({})
  expect(parseMaxReply('No Limit')).toEqual({})
  expect(parseMaxReply('∞')).toEqual({})
  expect(parseMaxReply('0')).toBeNull()      // 0 is ambiguous, not "unlimited"
  expect(parseMaxReply('ten')).toBeNull()
  expect(parseMaxReply('3.5')).toBeNull()
})

test('parseBudgetReply: dollars with optional $ and comma decimals', () => {
  expect(parseBudgetReply('5')).toEqual({ budget: 5 })
  expect(parseBudgetReply('$12.50')).toEqual({ budget: 12.5 })
  expect(parseBudgetReply('7,25')).toEqual({ budget: 7.25 })
  expect(parseBudgetReply('"Unlimited"')).toEqual({})
  expect(parseBudgetReply('0')).toBeNull()
  expect(parseBudgetReply('-3')).toBeNull()
  expect(parseBudgetReply('cheap')).toBeNull()
})

// ---- Iteration prompt ----

test('iterationPrompt: marker instruction only in self-report mode', () => {
  const checked = iterationPrompt({ goal: 'fix tests', iter: 2, maxIter: 10, check: 'bun test' })
  expect(checked).toContain('[/loop iteration 2 of 10]')
  expect(checked).toContain('bun test')
  expect(checked).not.toContain('LOOP_DONE')
  const selfReport = iterationPrompt({ goal: 'fix tests', iter: 1 })
  expect(selfReport).toContain('[/loop iteration 1]')
  expect(selfReport).toContain('LOOP_DONE')
})

// ---- Boundary decisions ----

const base = (over: Partial<LoopRecord> = {}): LoopRecord => ({
  goal: 'g', status: 'running', iter: 3, spent: 1, lastReplyUuid: 'u1',
  chat: '1', startedAt: 0, ...over,
})

test('explicit stop outranks everything', () => {
  const d = decideBoundary(base({ status: 'stopping', check: 'true', maxIter: 1, budget: 0.5 }), 'LOOP_DONE', true)
  expect(d).toMatchObject({ action: 'stop', kind: 'user' })
})

test('check success outranks limits (finishing ON the last iteration is "done", not "capped")', () => {
  const d = decideBoundary(base({ check: 'bun test', maxIter: 3, budget: 1 }), 'all green', true)
  expect(d).toMatchObject({ action: 'stop', kind: 'done' })
})

test('LOOP_DONE marker only counts without a check command, and only on its own line', () => {
  expect(decideBoundary(base(), 'done!\nLOOP_DONE\n')).toMatchObject({ action: 'stop', kind: 'done' })
  expect(decideBoundary(base(), 'I will print LOOP_DONE when finished')).toMatchObject({ action: 'continue' })
  // with a check, the failing check wins over the model's claim
  expect(decideBoundary(base({ check: 'bun test', maxIter: 10 }), 'LOOP_DONE', false)).toMatchObject({ action: 'continue' })
})

test('budget and iteration ceilings stop the loop', () => {
  expect(decideBoundary(base({ budget: 1, spent: 1 }), 'progress')).toMatchObject({ action: 'stop', kind: 'limit' })
  expect(decideBoundary(base({ maxIter: 3, iter: 3 }), 'progress')).toMatchObject({ action: 'stop', kind: 'limit' })
  expect(decideBoundary(base({ maxIter: 4, iter: 3, budget: 5, spent: 1 }), 'progress')).toMatchObject({ action: 'continue' })
})

test('unlimited (absent) limits never stop', () => {
  expect(decideBoundary(base({ spent: 9999, iter: 9999 }), 'progress')).toMatchObject({ action: 'continue' })
})

test('no-progress guard pauses on an identical conclusion (whitespace-insensitive)', () => {
  const rec = base({ lastReplyText: 'still stuck on the same error' })
  expect(decideBoundary(rec, '  still   stuck on the\nsame error ')).toMatchObject({ action: 'pause' })
  expect(decideBoundary(rec, 'made progress this time')).toMatchObject({ action: 'continue' })
})

// ---- Store round-trip ----

test('readLoops/writeLoops round-trip and prune', () => {
  const sid = `test-${process.pid}`
  const map = readLoops()
  map[sid] = base({ status: 'confirm' })
  writeLoops(map)
  expect(readLoops()[sid].goal).toBe('g')
  const back = readLoops()
  delete back[sid]
  writeLoops(back)
  expect(readLoops()[sid]).toBeUndefined()
})
