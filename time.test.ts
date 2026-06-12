import { test, expect } from 'bun:test'
import { parseDuration, formatDuration, fmtWhen, splitLeadingDuration } from './time.ts'

test('parseDuration sums unit chunks', () => {
  expect(parseDuration('90s')).toBe(90_000)
  expect(parseDuration('12h')).toBe(12 * 36e5)
  expect(parseDuration('1h30m')).toBe(36e5 + 30 * 6e4)
  expect(parseDuration('2d')).toBe(2 * 864e5)
  expect(parseDuration('1w')).toBe(6048e5)
  expect(parseDuration('3d 4h')).toBe(3 * 864e5 + 4 * 36e5)
})

test('parseDuration is case-insensitive', () => {
  expect(parseDuration('1H30M')).toBe(36e5 + 30 * 6e4)
})

test('parseDuration returns null for no/zero duration', () => {
  expect(parseDuration('')).toBe(null)
  expect(parseDuration('soon')).toBe(null)
  expect(parseDuration('0s')).toBe(null)
})

test('formatDuration shows largest units first, drops zeros', () => {
  expect(formatDuration(36e5 + 30 * 6e4)).toBe('1h 30m')
  expect(formatDuration(3 * 864e5 + 4 * 36e5)).toBe('3d 4h')
  expect(formatDuration(45 * 6e4)).toBe('45m')
})

test('formatDuration floors sub-minute to <1m', () => {
  expect(formatDuration(30_000)).toBe('<1m')
  expect(formatDuration(0)).toBe('<1m')
})

test('parseDuration ∘ formatDuration round-trips on minute-aligned values', () => {
  for (const s of ['1h 30m', '2d 5h', '45m']) {
    expect(formatDuration(parseDuration(s)!)).toBe(s)
  }
})

test('splitLeadingDuration separates a leading duration from the message', () => {
  expect(splitLeadingDuration('2h')).toEqual({ ms: 2 * 36e5, rest: '' })
  expect(splitLeadingDuration('2h ping the server')).toEqual({ ms: 2 * 36e5, rest: 'ping the server' })
  expect(splitLeadingDuration('1h30m do the thing')).toEqual({ ms: 36e5 + 30 * 6e4, rest: 'do the thing' })
  expect(splitLeadingDuration('1h 30m run tests')).toEqual({ ms: 36e5 + 30 * 6e4, rest: 'run tests' })
})

test('splitLeadingDuration returns null ms when there is no leading duration', () => {
  expect(splitLeadingDuration('do the thing')).toEqual({ ms: null, rest: 'do the thing' })
  expect(splitLeadingDuration('')).toEqual({ ms: null, rest: '' })
})

test('fmtWhen renders a fixed UTC instant deterministically', () => {
  // 2026-06-08T01:30:00Z
  const ts = Date.UTC(2026, 5, 8, 1, 30, 0)
  expect(fmtWhen(ts)).toBe('Jun 8, 01:30 UTC')
})

import { nextRecurrence, recurrenceLabel } from './time.ts'
import { test as t2, expect as e2 } from 'bun:test'

t2('nextRecurrence daily lands at 09:00 LA wall clock, strictly in the future', () => {
  const after = Date.UTC(2026, 5, 11, 17, 0)   // 10:00 PDT
  const next = nextRecurrence({ kind: 'daily', hh: 9, mm: 0, tz: 'America/Los_Angeles' }, after)
  e2(next).toBe(Date.UTC(2026, 5, 12, 16, 0))  // next day 09:00 PDT = 16:00 UTC
})

t2('nextRecurrence weekdays skips the weekend', () => {
  const friAfternoon = Date.UTC(2026, 5, 12, 20, 0)   // Fri Jun 12 2026, 13:00 PDT
  const next = nextRecurrence({ kind: 'weekdays', hh: 9, mm: 0, tz: 'America/Los_Angeles' }, friAfternoon)
  e2(new Date(next).toUTCString()).toContain('Mon, 15 Jun 2026')
})

t2('nextRecurrence weekly picks the requested dow', () => {
  const after = Date.UTC(2026, 5, 11, 0, 0)
  const next = nextRecurrence({ kind: 'weekly', hh: 8, mm: 30, dow: 0, tz: 'America/Los_Angeles' }, after)
  e2(new Date(next).toUTCString()).toContain('Sun, 14 Jun 2026')
})

t2('recurrenceLabel renders', () => {
  e2(recurrenceLabel({ kind: 'daily', hh: 9, mm: 5, tz: 'UTC' })).toBe('daily 09:05')
  e2(recurrenceLabel({ kind: 'weekly', hh: 7, mm: 0, dow: 5, tz: 'UTC' })).toBe('Fri 07:00')
})

// ---- cron expressions ----
import { parseCron, nextCron, describeCron } from './time.ts'
import { test as t3, expect as e3 } from 'bun:test'

t3('parseCron accepts steps, ranges, lists, names; rejects junk', () => {
  e3(parseCron('*/15 * * * *')).not.toBeNull()
  e3(parseCron('0 9-17 * * mon-fri')).not.toBeNull()
  e3(parseCron('0,30 9 1,15 jan-jun *')).not.toBeNull()
  e3(parseCron('0 9 * * 7')).not.toBeNull()       // 7 = Sunday
  e3(parseCron('* * * *')).toBeNull()             // 4 fields
  e3(parseCron('61 * * * *')).toBeNull()          // minute out of range
  e3(parseCron('* * * * 8')).toBeNull()           // dow out of range
  e3(parseCron('foo * * * *')).toBeNull()
})

t3('nextCron: every 15 min from a known instant', () => {
  const after = Date.UTC(2026, 5, 12, 10, 7)   // 10:07 UTC
  e3(nextCron('*/15 * * * *', after, 'UTC')).toBe(Date.UTC(2026, 5, 12, 10, 15))
})

t3('nextCron: weekday window honors tz and skips the weekend', () => {
  const friEvening = Date.UTC(2026, 5, 13, 2, 0)   // Fri Jun 12 2026, 19:00 PDT
  const next = nextCron('0 9 * * 1-5', friEvening, 'America/Los_Angeles')!
  e3(new Date(next).toUTCString()).toContain('Mon, 15 Jun 2026')
  e3(next).toBe(Date.UTC(2026, 5, 15, 16, 0))      // 09:00 PDT
})

t3('nextCron: dom OR dow when both are restricted (standard cron rule)', () => {
  // Fires on the 15th OR on Mondays. From Sat Jun 13 2026, the next is Mon Jun 15 (both),
  // then from Jun 15 12:01 UTC the next Monday is Jun 22 — before the next 15th (Jul 15).
  const next = nextCron('0 12 15 * 1', Date.UTC(2026, 5, 15, 12, 1), 'UTC')!
  e3(new Date(next).toUTCString()).toContain('Mon, 22 Jun 2026')
})

t3('nextCron: impossible date returns null', () => {
  e3(nextCron('0 0 30 2 *', Date.UTC(2026, 5, 12), 'UTC')).toBeNull()   // Feb 30
})

t3('describeCron labels the common shapes', () => {
  e3(describeCron('*/15 * * * *')).toBe('every 15 min')
  e3(describeCron('0 9 * * *')).toBe('daily 09:00')
  e3(describeCron('30 8 * * 1-5')).toBe('weekdays 08:30')
  e3(describeCron('0 9 1 * *')).toBe('cron 0 9 1 * *')
})
