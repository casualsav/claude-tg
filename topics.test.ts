import { test, expect, beforeEach } from 'bun:test'
import {
  _resetForTest, isTopicMode, getGroupChatId, setGroupChatId,
  getTopicByCwd, getCwdByThread, setTopic, updateTopic, removeTopic, listTopics,
  type TopicEntry,
} from './topics.ts'

// Reads + in-memory map logic only. Each test seeds state via _resetForTest so nothing touches the
// real STATE_DIR/topics.json. Mutators (setTopic/…) do write to disk via save(); we keep the seeded
// store empty of a real groupChatId and rely on the daemon's STATE_DIR being a throwaway in CI.

const entry = (threadId: number): TopicEntry => ({ threadId, name: `t${threadId}`, closed: false, createdAt: 1 })

beforeEach(() => _resetForTest())

test('a fresh store is not in topic mode', () => {
  expect(isTopicMode()).toBe(false)
  expect(getGroupChatId()).toBe(null)
})

test('setting a group chat id enables topic mode', () => {
  setGroupChatId('-1001234567890')
  expect(isTopicMode()).toBe(true)
  expect(getGroupChatId()).toBe('-1001234567890')
})

test('clearing the group chat id leaves topic mode', () => {
  setGroupChatId('-100')
  setGroupChatId(null)
  expect(isTopicMode()).toBe(false)
})

test('topics are looked up by cwd and reverse-looked-up by thread id', () => {
  _resetForTest({
    groupChatId: '-100',
    topics: { '/projects/a': entry(11), '/projects/b': entry(22) },
  })
  expect(getTopicByCwd('/projects/a')?.threadId).toBe(11)
  expect(getTopicByCwd('/projects/missing')).toBeUndefined()
  expect(getCwdByThread(22)).toBe('/projects/b')
  expect(getCwdByThread(999)).toBeUndefined()
})

test('setTopic adds, updateTopic patches, removeTopic deletes', () => {
  setTopic('/projects/a', entry(11))
  expect(getTopicByCwd('/projects/a')?.threadId).toBe(11)

  updateTopic('/projects/a', { closed: true, name: 'renamed' })
  expect(getTopicByCwd('/projects/a')?.closed).toBe(true)
  expect(getTopicByCwd('/projects/a')?.name).toBe('renamed')
  expect(getTopicByCwd('/projects/a')?.threadId).toBe(11) // patch keeps untouched fields

  updateTopic('/projects/nope', { closed: true }) // no-op on a missing key
  expect(getTopicByCwd('/projects/nope')).toBeUndefined()

  removeTopic('/projects/a')
  expect(getTopicByCwd('/projects/a')).toBeUndefined()
})

test('listTopics flattens the map to cwd-tagged rows', () => {
  _resetForTest({ groupChatId: '-100', topics: { '/x': entry(1), '/y': entry(2) } })
  const rows = listTopics().sort((a, b) => a.threadId - b.threadId)
  expect(rows).toEqual([
    { cwd: '/x', threadId: 1, name: 't1', closed: false, createdAt: 1 },
    { cwd: '/y', threadId: 2, name: 't2', closed: false, createdAt: 1 },
  ])
})
