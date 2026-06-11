// Account registry + pane-account derivation. The registry file is pointed at a temp dir via
// initAccounts; addAccount itself is untested here (it writes real dirs under $HOME).
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initAccounts, listAccounts, accountByName, accountForTranscript, accountForProjectsDir,
  allProjectsDirs, ACCOUNT_NAME_RE, MAIN_CONFIG_DIR,
} from './accounts.ts'

function freshRegistry(reg?: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tg-accounts-'))
  initAccounts(dir)
  if (reg) writeFileSync(join(dir, 'accounts.json'), JSON.stringify(reg))
  return dir
}

test('no registry → just the main account', () => {
  freshRegistry()
  expect(listAccounts()).toEqual([{ name: 'main', configDir: MAIN_CONFIG_DIR }])
  expect(accountByName('work')).toBeNull()
})

test('registry accounts list after main; bad names/values dropped', () => {
  freshRegistry({ work: '/home/u/.claude-work', 'bad name!': '/x', main: '/evil', nope: 42 as unknown as string })
  const names = listAccounts().map(a => a.name)
  expect(names).toEqual(['main', 'work'])
  expect(accountByName('work')?.configDir).toBe('/home/u/.claude-work')
})

test('accountForTranscript matches the owning projects root, longest prefix wins', () => {
  freshRegistry({ work: join(MAIN_CONFIG_DIR + '-work') })
  const workFile = join(MAIN_CONFIG_DIR + '-work', 'projects', '-projects-x', 's1.jsonl')
  const mainFile = join(MAIN_CONFIG_DIR, 'projects', '-projects-x', 's2.jsonl')
  expect(accountForTranscript(workFile).name).toBe('work')
  expect(accountForTranscript(mainFile).name).toBe('main')
  expect(accountForTranscript('/somewhere/else.jsonl').name).toBe('main')
})

test('accountForProjectsDir + allProjectsDirs round-trip', () => {
  freshRegistry({ work: '/home/u/.claude-work' })
  const roots = allProjectsDirs()
  expect(roots).toEqual([join(MAIN_CONFIG_DIR, 'projects'), '/home/u/.claude-work/projects'])
  expect(accountForProjectsDir(roots[1]).name).toBe('work')
  expect(accountForProjectsDir('/unknown/projects').name).toBe('main')
})

test('account names are safe tokens', () => {
  expect(ACCOUNT_NAME_RE.test('work')).toBe(true)
  expect(ACCOUNT_NAME_RE.test('w-2_x')).toBe(true)
  expect(ACCOUNT_NAME_RE.test('-lead')).toBe(false)
  expect(ACCOUNT_NAME_RE.test('has space')).toBe(false)
  expect(ACCOUNT_NAME_RE.test('a'.repeat(17))).toBe(false)
})
