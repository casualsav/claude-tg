import { test, expect } from 'bun:test'
import { parseDuration, formatDuration, fmtWhen } from './time.ts'

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

test('fmtWhen renders a fixed UTC instant deterministically', () => {
  // 2026-06-08T01:30:00Z
  const ts = Date.UTC(2026, 5, 8, 1, 30, 0)
  expect(fmtWhen(ts)).toBe('Jun 8, 01:30 UTC')
})
