// Prompt detection from pane captures — select menus vs permission dialogs. Pure functions.
import { test, expect } from 'bun:test'
import { stripAnsi, isSubmitScreen, detectUserPrompt, detectPermissionPrompt, detectLoginPrompt, isUsageLimitChoice, detectEditorState, onNormalPrompt, detectModelUnavailable } from './prompt.ts'

test('stripAnsi removes CSI escape sequences', () => {
  expect(stripAnsi('\x1b[1mbold\x1b[0m text')).toBe('bold text')
})

test('detectModelUnavailable extracts the offending model name', () => {
  const pane = '● Claude Fable 5 is currently unavailable. Learn more:\n  https://www.anthropic.com/news/fable-mythos-access'
  expect(detectModelUnavailable(pane)).toBe('Fable 5')
  expect(detectModelUnavailable('\x1b[1m● Claude Opus 9 is currently unavailable\x1b[0m')).toBe('Opus 9')
  expect(detectModelUnavailable('❯ /model opus')).toBe(null)
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

test('detectUserPrompt relays the plan-approval prompt (shift+tab footer, no ↑↓ wording)', () => {
  const pane = [
    'Claude has written up a plan and is ready to execute. Would you like to proceed?',
    '',
    '   ❯ 1. Yes, and bypass permissions',
    '     2. Yes, manually approve edits',
    '     3. No, refine with Ultraplan on Claude Code on the web',
    '     4. Tell Claude what to change',
    '        shift+tab to approve with this feedback',
    '',
    '   ctrl+g to edit in  Vim  · ~/.claude/plans',
  ].join('\n')
  const p = detectUserPrompt(pane)
  expect(p).not.toBeNull()
  expect(p!.question).toContain('Would you like to proceed?')
  expect(p!.options.map(o => o.label)).toEqual([
    'Yes, and bypass permissions',
    'Yes, manually approve edits',
    'No, refine with Ultraplan on Claude Code on the web',
    'Tell Claude what to change',
  ])
  expect(p!.multiSelect).toBe(false)
})

test('detectUserPrompt returns null when there is no live select footer', () => {
  expect(detectUserPrompt('just some terminal output\n❯ \n')).toBeNull()
})

test('detectEditorState recognises vim, nano, and a pager — and ignores a normal prompt', () => {
  const vim = ['# my plan', 'do the thing', '~', '~', '~', '~', '"plan.md" 2L, 21C', '-- INSERT --'].join('\n')
  expect(detectEditorState(vim)?.kind).toBe('vim')

  const nano = [
    '  GNU nano 7.2            plan.md',
    'edit me',
    '^G Get Help   ^O Write Out   ^W Where Is   ^K Cut',
    '^X Exit       ^R Read File   ^\\ Replace    ^U Paste',
  ].join('\n')
  expect(detectEditorState(nano)?.kind).toBe('nano')

  const pager = ['line one', 'line two', 'lines 1-2/2 (END)', ':'].join('\n')
  expect(detectEditorState(pager)?.kind).toBe('pager')

  // A normal Claude prompt (input box) must NOT read as an editor.
  const normal = ['╭───────────╮', '❯ ', '╰───────────╯', '? for shortcuts'].join('\n')
  expect(detectEditorState(normal)).toBeNull()
  expect(onNormalPrompt(normal)).toBe(true)
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

test('detectLoginPrompt parses the login-method menu (Esc-to-cancel footer only)', () => {
  const pane = [
    '  Login',
    '  Claude Code can be used with your Claude subscription or billed based',
    '  on API usage through your Console account.',
    '  Select login method:',
    '  _ 1. Claude account with subscription • Pro, Max, Team, or Enterprise',
    '    2. Anthropic Console account • API usage billing',
    '    3. 3rd-party platform • Amazon Bedrock, Microsoft Foundry, or Vertex AI',
    '  Esc to cancel',
  ].join('\n')
  const p = detectLoginPrompt(pane)
  expect(p).not.toBeNull()
  expect(p!.options).toHaveLength(3)
  expect(p!.options[0].label).toContain('Claude account with subscription')
  expect(p!.options[2].label).toContain('3rd-party platform')
})

test('detectLoginPrompt ignores an ordinary Esc-to-cancel screen', () => {
  expect(detectLoginPrompt('Pick a fruit\n  1. Apple\n  2. Banana\n  Esc to cancel')).toBeNull()
})

test('isUsageLimitChoice matches the live usage-limit menu', () => {
  const pane = [
    '   What do you want to do?',
    '   _ 1. Stop and wait for limit to reset',
    '     2. Upgrade your plan',
    '     3. Upgrade to Team plan',
    '   Enter to confirm • Esc to cancel',
  ].join('\n')
  expect(isUsageLimitChoice(pane)).toBe(true)
})

test('isUsageLimitChoice ignores a scrolled-up past menu and unrelated confirms', () => {
  const scrolled = [
    '   1. Stop and wait for limit to reset',
    '   Enter to confirm • Esc to cancel',
    '',
    '● back to work, output here',
    '  and more output below',
  ].join('\n')
  expect(isUsageLimitChoice(scrolled)).toBe(false)
  expect(isUsageLimitChoice('Save changes?\n  1. Yes\n  2. No\n  Enter to confirm')).toBe(false)
})

test('detectLoginPrompt needs the menu live at the bottom (not scrolled up)', () => {
  const pane = [
    '  Select login method:',
    '  1. Claude account with subscription',
    '  2. Anthropic Console account',
    '  Esc to cancel',
    '',
    '● now doing something else entirely',
    '  more output below the old menu',
  ].join('\n')
  expect(detectLoginPrompt(pane)).toBeNull()
})
