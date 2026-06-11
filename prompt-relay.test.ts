import { test, expect } from 'bun:test'
import { renderPromptHtml, permButtonLabel, singleAnswerKeyboard, permStorms } from './prompt-relay.ts'

test('renderPromptHtml: question bold, options numbered, descriptions quoted', () => {
  const html = renderPromptHtml({
    question: 'Pick one', options: [{ label: 'A' }, { label: 'B', description: 'second' }],
    multiSelect: false, tabbed: false, freeText: false, chat: false,
  } as never)
  expect(html).toContain('<b>Pick one</b>')
  expect(html).toContain('1.')
  expect(html).toContain('<blockquote>second</blockquote>')
})

test('permButtonLabel: icons by intent, hints stripped, capped', () => {
  expect(permButtonLabel({ n: 1, label: 'Yes' })).toBe('✅ Yes')
  expect(permButtonLabel({ n: 2, label: 'Yes, allow all edits during this session (shift+tab)' })).toMatch(/^🔁 Yes, allow all/)
  expect(permButtonLabel({ n: 3, label: 'No, and tell Claude what to do differently' })).toMatch(/^❌ No/)
  expect(permButtonLabel({ n: 1, label: 'x'.repeat(60) }).length).toBeLessThanOrEqual(42)
})

test('singleAnswerKeyboard routes answers through the given prefix', () => {
  const kb = singleAnswerKeyboard({
    question: 'Q', options: [{ label: 'One' }, { label: 'Two' }],
    multiSelect: false, tabbed: true, freeText: false, chat: false,
  } as never, 'mq')
  const datas = kb.inline_keyboard.flat().map(b => 'callback_data' in b ? b.callback_data : '')
  expect(datas).toContain('mq:1')
  expect(datas).toContain('mq:2')
})

test('permStorms map is shared state the daemon can arm', () => {
  permStorms.set('%99', { count: 2, armed: false })
  expect(permStorms.get('%99')!.armed).toBe(false)
  permStorms.delete('%99')
})
