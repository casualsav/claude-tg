// Pure renderer for the DM "Clauding…" draft. No network/IO. Run: bun test clauding.test.ts
import { test, expect } from 'bun:test'
import { CLAUDING_SPINNER, claudingFrame, fmtTokens, claudingStatus } from './clauding.ts'

test('claudingFrame cycles the locked 6-frame spinner and wraps', () => {
  expect([...Array(7)].map((_, i) => claudingFrame(i))).toEqual(['✶', '✻', '✽', '✶', '✽', '✻', '✶'])
  expect(CLAUDING_SPINNER.length).toBe(6)
  expect(claudingFrame(-1)).toBe('✻')   // negative-safe (last frame)
})

test('fmtTokens: raw below 1000, one-decimal k above', () => {
  expect(fmtTokens(0)).toBe('0')
  expect(fmtTokens(999)).toBe('999')
  expect(fmtTokens(1000)).toBe('1.0k')
  expect(fmtTokens(39502)).toBe('39.5k')
  expect(fmtTokens(205836)).toBe('205.8k')
})

test('claudingStatus floors elapsed to 5s and shows spinner + tokens', () => {
  expect(claudingStatus({ tick: 0, elapsedSec: 3.9, output: 39502, context: 205836 }))
    .toBe('✶ **Clauding…** · 0s · ↑ 39.5k · 205.8k ctx')
  expect(claudingStatus({ tick: 1, elapsedSec: 7, output: 1200, context: 50000 }))
    .toBe('✻ **Clauding…** · 5s · ↑ 1.2k · 50.0k ctx')
})

test('claudingStatus appends activity bullets and honors a custom word', () => {
  expect(claudingStatus({ tick: 2, elapsedSec: 12, output: 0, context: 0, word: 'Pondering', activity: ['Reading `x.ts`', 'Running tests'] }))
    .toBe('✽ **Pondering…** · 10s · ↑ 0 · 0 ctx\n\n• Reading `x.ts`\n• Running tests')
})
