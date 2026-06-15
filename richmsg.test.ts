// Tests for Bot API 10.1 rich-message payload shaping. Pure functions only — no network.
// Run: bun test richmsg.test.ts
import { test, expect } from 'bun:test'
import { toInputRichMessage, buildSendPayload, buildDraftPayload, buildEditPayload } from './richmsg.ts'

test('toInputRichMessage defaults to a markdown carrier (Claude emits markdown)', () => {
  expect(toInputRichMessage('# Hello')).toEqual({ markdown: '# Hello' })
})

test('toInputRichMessage can carry html instead (one-line switch later)', () => {
  expect(toInputRichMessage('<b>Hi</b>', 'html')).toEqual({ html: '<b>Hi</b>' })
})

test('buildSendPayload: minimal payload has chat_id + rich_message and nothing else', () => {
  expect(buildSendPayload('123', { markdown: 'x' })).toEqual({ chat_id: '123', rich_message: { markdown: 'x' } })
})

test('buildSendPayload: message_thread_id is included only when set (topics)', () => {
  expect(buildSendPayload('123', { markdown: 'x' }, { messageThreadId: 42 })).toEqual({
    chat_id: '123', rich_message: { markdown: 'x' }, message_thread_id: 42,
  })
  // thread 0 is a real General-topic id → must still be emitted (presence, not truthiness).
  expect(buildSendPayload('123', { markdown: 'x' }, { messageThreadId: 0 })).toHaveProperty('message_thread_id', 0)
  expect(buildSendPayload('123', { markdown: 'x' }, {})).not.toHaveProperty('message_thread_id')
})

test('buildSendPayload: disable_notification + business_connection_id only when provided', () => {
  expect(buildSendPayload('123', { markdown: 'x' }, { disableNotification: true, businessConnectionId: 'biz' })).toEqual({
    chat_id: '123', rich_message: { markdown: 'x' }, disable_notification: true, business_connection_id: 'biz',
  })
  expect(buildSendPayload('123', { markdown: 'x' }, { disableNotification: false })).not.toHaveProperty('disable_notification')
})

test('buildDraftPayload: carries chat_id, draft_id, rich_message (and optional thread)', () => {
  expect(buildDraftPayload(123, 7, { markdown: 'draft' })).toEqual({
    chat_id: 123, draft_id: 7, rich_message: { markdown: 'draft' },
  })
  expect(buildDraftPayload(123, 7, { markdown: 'draft' }, { messageThreadId: 9 })).toHaveProperty('message_thread_id', 9)
})

test('buildEditPayload: edits a sent rich message via message_id + rich_message', () => {
  expect(buildEditPayload('123', 555, { markdown: 'edited' })).toEqual({
    chat_id: '123', message_id: 555, rich_message: { markdown: 'edited' },
  })
})
