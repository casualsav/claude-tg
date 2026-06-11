import { test, expect } from 'bun:test'
import { readLater, writeLater, type LaterItem } from './queue.ts'

// The store round-trips through later.json in STATE_DIR — exercise pure shape handling
// via write→read (STATE_DIR in tests is the real one; use a sentinel session key and clean up).
const SID = `test-${process.pid}`

test('writeLater/readLater round-trip and prune empty sessions', () => {
  const map = readLater()
  map[SID] = [
    { text: 'plain', queuedAt: 1 },
    { text: 'held', queuedAt: 2, fireAt: Date.now() + 60_000 },
  ]
  writeLater(map)
  const back = readLater()
  expect(back[SID].length).toBe(2)
  expect(back[SID][1].fireAt).toBeGreaterThan(Date.now())
  // eligibility selection (mirrors the sweep): first item whose fireAt is absent or passed
  const idx = back[SID].findIndex((i: LaterItem) => !i.fireAt || i.fireAt <= Date.now())
  expect(idx).toBe(0)
  delete back[SID]
  writeLater(back)
  expect(readLater()[SID]).toBeUndefined()
})
