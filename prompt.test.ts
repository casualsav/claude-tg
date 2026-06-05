// Prompt detection from pane captures — select menus vs permission dialogs. Pure functions.
import { test, expect } from 'bun:test'
import { stripAnsi, isSubmitScreen, detectUserPrompt, detectPermissionPrompt } from './prompt.ts'

test('stripAnsi removes CSI escape sequences', () => {
  expect(stripAnsi('\x1b[1mbold\x1b[0m text')).toBe('bold text')
})

test('isSubmitScreen matches the review/submit tab only', () => {
  expect(isSubmitScreen('  Ready to submit your answers?  ')).toBe(true)
  expect(isSubmitScreen('some other screen')).toBe(false)
})

test('detectUserPrompt parses a numbered select menu', () => {
  const pane = [
    'Which fruit do you prefer?',
    '  1. Apple',
    '  2. Banana',
    '  3. Cherry',
    '  ↑/↓ to navigate · Enter to select',
  ].join('\n')
  const p = detectUserPrompt(pane)
  expect(p).not.toBeNull()
  expect(p!.question).toBe('Which fruit do you prefer?')
  expect(p!.options.map(o => o.label)).toEqual(['Apple', 'Banana', 'Cherry'])
  expect(p!.multiSelect).toBe(false)
})

test('detectUserPrompt returns null when there is no live select footer', () => {
  expect(detectUserPrompt('just some terminal output\n❯ \n')).toBeNull()
})

test('detectPermissionPrompt parses a Yes/No confirmation', () => {
  const pane = [
    '● Bash',
    'Run `ls -la`?',
    'Do you want to run this command?',
    '  1. Yes',
    "  2. Yes, and don't ask again",
    '  3. No',
    '  Esc to cancel · Tab to amend',
  ].join('\n')
  const p = detectPermissionPrompt(pane)
  expect(p).not.toBeNull()
  expect(p!.question).toBe('Do you want to run this command?')
  expect(p!.options.map(o => o.label)).toEqual(['Yes', "Yes, and don't ask again", 'No'])
  expect(p!.preview).toContain('Run `ls -la`?')
})

test('detectPermissionPrompt ignores a plain numbered list (no Yes/No shape)', () => {
  const pane = [
    'Pick a number?',
    '  1. Red',
    '  2. Green',
    '  Esc to cancel · Tab to amend',
  ].join('\n')
  expect(detectPermissionPrompt(pane)).toBeNull()
})
