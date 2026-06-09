import { test, expect } from 'bun:test'
import {
  MAX_TIMEOUT, scheduledCount, scheduledListText, scheduledCancelKeyboard,
} from './scheduler.ts'

// Side-effect-free characterization only: these exports read the in-memory queue without
// touching disk or timers. The mutating paths (addScheduled/cancel/fire) write to STATE_DIR
// and arm setTimeout, so they're left to a later fs-injection refactor rather than risking
// real disk writes / dangling timers in the test process.

test('MAX_TIMEOUT is the setTimeout ceiling', () => {
  expect(MAX_TIMEOUT).toBe(2_147_483_647)
})

test('a fresh scheduler queue is empty', () => {
  expect(scheduledCount()).toBe(0)
})

test('empty list text still renders the header', () => {
  expect(scheduledListText()).toContain('Scheduled messages')
})

test('empty cancel keyboard has no buttons', () => {
  const kb = scheduledCancelKeyboard()
  expect(kb.inline_keyboard.flat().length).toBe(0)
})
