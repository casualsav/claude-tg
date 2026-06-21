import { test, expect } from 'bun:test'
import { parseStatusline, pinBar, parseWorkingLine, parseDoneLine } from './statusline.ts'

// A realistic capture: regular output, a blank line, the statusline slot, then the footer hint.
const STATUSLINE = 'ctx 45%  ↑1.2k ↓3.4k  $0.42 | 2h30m  api 1m30s  5h 60% ↻ 3h  7d 20% ↻ 12h  ε: high  ✻ think'
const pane = (line: string) => ['regular pane output', '', line, '? for shortcuts'].join('\n')

test('parseStatusline pulls every field out of the slot above the footer', () => {
  const d = parseStatusline(pane(STATUSLINE))!
  expect(d).not.toBeNull()
  expect(d.ctxPct).toBe(45)
  expect(d.tokens).toBe('↑1.2k ↓3.4k')
  expect(d.cost).toBe('$0.42')
  expect(d.sessionTime).toBe('2h30m')
  expect(d.apiTime).toBe('1m30s')
  expect(d.h5).toEqual({ pct: 60, reset: '3h' })
  expect(d.d7).toEqual({ pct: 20, reset: '12h' })
  expect(d.effort).toBe('high')
  expect(d.think).toBe(true)
})

test('parseStatusline tolerates a partial statusline (missing fields → null fields)', () => {
  const d = parseStatusline(pane('ctx 12%  $1.05'))!
  expect(d.ctxPct).toBe(12)
  expect(d.cost).toBe('$1.05')
  expect(d.tokens).toBe(null)
  expect(d.h5).toBe(null)
  expect(d.effort).toBe(null)
  expect(d.think).toBe(false)
})

test('parseStatusline lifts the model from the identity line (versioned match wins, lowercase paths ignored)', () => {
  const cap = ['output', '', 'user@host:/home/u/opus-test (main) | Opus 4.8 | ⌨NORMAL', STATUSLINE, '? for shortcuts'].join('\n')
  expect(parseStatusline(cap)!.model).toBe('Opus 4.8')
  expect(parseStatusline(pane('user@host:~/code | Fable 5\n' + STATUSLINE))!.model).toBe('Fable 5')
  expect(parseStatusline(pane(STATUSLINE))!.model).toBe(null)
})

test('parseStatusline returns null when the line above the footer is the input-box border', () => {
  const noStatus = ['some content', '╭───────────────╮', '> type here'].join('\n')
  expect(parseStatusline(noStatus)).toBe(null)
})

test('parseStatusline returns null when nothing parseable is present', () => {
  expect(parseStatusline(['just', 'plain', 'text'].join('\n'))).toBe(null)
  expect(parseStatusline('')).toBe(null)
})

test('parseStatusline normalizes cost to 2 decimals', () => {
  expect(parseStatusline(pane('ctx 5%  $3'))!.cost).toBe('$3.00')
  expect(parseStatusline(pane('ctx 5%  $1.2'))!.cost).toBe('$1.20')
})

test('parseWorkingLine lifts the verb + tokens from the spinner line', () => {
  const cap = [
    '  some tool output',
    '✽ Harmonizing… (19m 20s · ↓ 84.4k tokens)',
    '─────────────',
    '❯ ',
  ].join('\n')
  expect(parseWorkingLine(cap)).toEqual({ verb: 'Harmonizing', tokens: '↓84.4k' })
})

test('parseWorkingLine keeps the last (lowest) spinner line and tolerates no tokens', () => {
  const cap = ['✻ Pondering… (3s · ↑ 1.2k tokens)', 'output', '✶ Moonwalking… (12s)'].join('\n')
  expect(parseWorkingLine(cap)).toEqual({ verb: 'Moonwalking', tokens: null })
})

test('parseWorkingLine returns null without an active spinner line', () => {
  expect(parseWorkingLine('✻ Sautéed for 1m 17s\n❯ ')).toBeNull()   // past-tense line, no paren group
  expect(parseWorkingLine('just output\n❯ ')).toBeNull()
})

test('parseDoneLine lifts the past-tense verb + duration from the completed-turn line', () => {
  expect(parseDoneLine('output\n✻ Baked for 9m 59s\n❯ ')).toEqual({ verb: 'Baked', duration: '9m 59s' })
  expect(parseDoneLine('✻ Sautéed for 1m 17s')).toEqual({ verb: 'Sautéed', duration: '1m 17s' })
  expect(parseDoneLine('· Churned for 45s')).toEqual({ verb: 'Churned', duration: '45s' })
  expect(parseDoneLine('just output, no summary')).toBeNull()
})

test('pinBar renders a fixed-width filled/empty bar', () => {
  expect(pinBar(50, 10)).toBe('█████░░░░░')
  expect(pinBar(0, 10)).toBe('░░░░░░░░░░')
  expect(pinBar(100, 10)).toBe('██████████')
})

test('pinBar clamps out-of-range percentages', () => {
  expect(pinBar(-20, 10)).toBe('░░░░░░░░░░')
  expect(pinBar(150, 10)).toBe('██████████')
})
