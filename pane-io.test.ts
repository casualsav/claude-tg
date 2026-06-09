import { test, expect, mock, beforeEach, afterAll } from 'bun:test'
import * as realProc from './proc.ts'

// Capture the REAL proc functions before installing the global mock below. bun's mock.module
// is process-wide and pre-loads all test files, so these reals must be grabbed eagerly here;
// they back the proc.ts unit tests at the bottom of this file (kept in one file so the mock
// can't leak into them).
const realExec = realProc.exec
const realSleep = realProc.sleep
const realHash = realProc.hashText

// Record every exec('tmux', [...]) the adapter issues, and let each test stub the result.
// proc.ts is mocked so no real tmux/process is touched — this is the seam Phase 1 created.
let execCalls: Array<[string, string[]]> = []
let execImpl: (cmd: string, args: string[]) => Promise<{ stdout: string }>

mock.module('./proc.ts', () => ({
  exec: (cmd: string, args: string[]) => {
    execCalls.push([cmd, args])
    return execImpl(cmd, args)
  },
  sleep: (_ms: number) => Promise.resolve(),
  // identity hash keeps waitForSettle's stability check easy to reason about
  hashText: (s: string) => s,
}))

const pane = await import('./pane-io.ts')

afterAll(() => {
  mock.module('./proc.ts', () => realProc)
})

beforeEach(() => {
  execCalls = []
  execImpl = async () => ({ stdout: '' })
})

test('capturePane requests the joined pane and returns raw stdout', async () => {
  execImpl = async () => ({ stdout: 'line1\nline2\n' })
  const out = await pane.capturePane('%1')
  expect(out).toBe('line1\nline2\n')
  expect(execCalls[0]).toEqual(['tmux', ['capture-pane', '-p', '-t', '%1', '-J']])
})

test('paneAlive is true when tmux echoes the same pane id, false otherwise', async () => {
  execImpl = async () => ({ stdout: '%7\n' })
  expect(await pane.paneAlive('%7')).toBe(true)
  execImpl = async () => ({ stdout: '%9\n' })
  expect(await pane.paneAlive('%7')).toBe(false)
})

test('paneAlive swallows tmux errors as false', async () => {
  execImpl = async () => { throw new Error('no server') }
  expect(await pane.paneAlive('%1')).toBe(false)
})

test('sendKeys refuses to send into a dead pane', async () => {
  execImpl = async () => { throw new Error('dead') } // paneAlive -> false
  expect(await pane.sendKeys('%1', ['Enter'])).toBe(false)
  // only the paneAlive probe ran, never send-keys
  expect(execCalls.some(([, a]) => a.includes('send-keys'))).toBe(false)
})

test('sendKeys forwards keys when the pane is alive', async () => {
  execImpl = async (_c, a) => ({ stdout: a.includes('#{pane_id}') ? '%1\n' : '' })
  expect(await pane.sendKeys('%1', ['C-c'])).toBe(true)
  const send = execCalls.find(([, a]) => a.includes('send-keys'))
  expect(send?.[1]).toEqual(['send-keys', '-t', '%1', 'C-c'])
})

test('sendKeysLiteral uses tmux -l with a -- guard', async () => {
  execImpl = async (_c, a) => ({ stdout: a.includes('#{pane_id}') ? '%1\n' : '' })
  expect(await pane.sendKeysLiteral('%1', '-foo')).toBe(true)
  const send = execCalls.find(([, a]) => a.includes('send-keys'))
  expect(send?.[1]).toEqual(['send-keys', '-l', '-t', '%1', '--', '-foo'])
})

test('windowHeightOf parses an int and returns null on garbage', async () => {
  execImpl = async () => ({ stdout: '42\n' })
  expect(await pane.windowHeightOf('%1')).toBe(42)
  execImpl = async () => ({ stdout: 'xx\n' })
  expect(await pane.windowHeightOf('%1')).toBe(null)
})

test('resizeWindowOf returns false when no window id comes back', async () => {
  execImpl = async () => ({ stdout: '\n' })
  expect(await pane.resizeWindowOf('%1', 80)).toBe(false)
})

test('resizeWindowOf resizes the resolved window and returns true', async () => {
  execImpl = async (_c, a) => ({ stdout: a.includes('#{window_id}') ? '@3\n' : '' })
  expect(await pane.resizeWindowOf('%1', 80)).toBe(true)
  const resize = execCalls.find(([, a]) => a.includes('resize-window'))
  expect(resize?.[1]).toEqual(['resize-window', '-t', '@3', '-y', '80'])
})

test('paneCommand trims, and returns empty string on error', async () => {
  execImpl = async () => ({ stdout: '  node \n' })
  expect(await pane.paneCommand('%1')).toBe('node')
  execImpl = async () => { throw new Error('x') }
  expect(await pane.paneCommand('%1')).toBe('')
})

test('paneCwd caches within the TTL (one tmux call for two reads)', async () => {
  execImpl = async () => ({ stdout: '/work/dir\n' })
  expect(await pane.paneCwd('%cache-a')).toBe('/work/dir')
  expect(await pane.paneCwd('%cache-a')).toBe('/work/dir')
  const cwdCalls = execCalls.filter(([, a]) => a.includes('#{pane_current_path}'))
  expect(cwdCalls.length).toBe(1)
})

test('paneCwd returns null on tmux failure', async () => {
  execImpl = async () => { throw new Error('gone') }
  expect(await pane.paneCwd('%cache-b')).toBe(null)
})

test('navigateDown sends nothing for n<=0', async () => {
  await pane.navigateDown('%1', 0)
  expect(execCalls.length).toBe(0)
})

test('waitForSettle returns once the capture hash is stable', async () => {
  execImpl = async () => ({ stdout: 'steady' }) // identity hash => stable immediately
  const t0 = Date.now()
  await pane.waitForSettle('%1', 1, 2000)
  expect(Date.now() - t0).toBeLessThan(1500)
})

// --- PaneWatcher ---

test('PaneWatcher.withInjection runs the wrapped fn and returns its value', async () => {
  execImpl = async () => ({ stdout: 'pane contents' })
  const w = new pane.PaneWatcher('%1', () => {}, () => {})
  const result = await w.withInjection(async () => 'done')
  expect(result).toBe('done')
})

test('PaneWatcher.withInjection re-baselines the hash with a capture afterward', async () => {
  execImpl = async () => ({ stdout: 'pane contents' })
  const w = new pane.PaneWatcher('%2', () => {}, () => {})
  await w.withInjection(async () => {})
  // the finally block captures the pane to reset lastHash
  expect(execCalls.some(([, a]) => a.includes('capture-pane') && a.includes('%2'))).toBe(true)
})

test('PaneWatcher.withInjection still resets injecting + returns even if the fn throws', async () => {
  execImpl = async () => ({ stdout: 'x' })
  const w = new pane.PaneWatcher('%3', () => {}, () => {})
  await expect(w.withInjection(async () => { throw new Error('boom') })).rejects.toThrow('boom')
  // a subsequent injection still works (injecting flag was cleared in finally)
  expect(await w.withInjection(async () => 1)).toBe(1)
})

test('PaneWatcher start/stop lifecycle is safe', () => {
  const w = new pane.PaneWatcher('%4', () => {}, () => {})
  expect(() => { w.start(); w.stop() }).not.toThrow()
  expect(() => w.stop()).not.toThrow()   // double stop is harmless
})

// --- proc.ts primitives (real implementations captured before the mock) ---

test('proc.hashText is deterministic md5 hex', () => {
  expect(realHash('abc')).toBe('900150983cd24fb0d6963f7d28e17f72')
  expect(realHash('abc')).toBe(realHash('abc'))
  expect(realHash('abc')).not.toBe(realHash('abd'))
})

test('proc.sleep resolves after at least the requested delay', async () => {
  const t0 = Date.now()
  await realSleep(30)
  expect(Date.now() - t0).toBeGreaterThanOrEqual(25)
})

test('proc.exec runs a real command and returns stdout', async () => {
  const { stdout } = await realExec('echo', ['hello'])
  expect(stdout.trim()).toBe('hello')
})

test('proc.exec rejects on a failing command', async () => {
  await expect(realExec('false', [])).rejects.toBeDefined()
})
