// Tests for the Files Mini App backend auth (the security-critical part). Run: bun test webapp.test.ts
import { test, expect } from 'bun:test'
import { createHmac } from 'node:crypto'
import { verifyInitData } from './webapp.ts'

const TOKEN = '123456:TEST-bot-token'

// Build a correctly-signed initData string the way Telegram does, for round-trip testing.
function sign(fields: Record<string, string>, token = TOKEN): string {
  const dcs = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(token).digest()
  const hash = createHmac('sha256', secret).update(dcs).digest('hex')
  const p = new URLSearchParams(fields); p.set('hash', hash)
  return p.toString()
}

const now = () => Math.floor(Date.now() / 1000)
const user = JSON.stringify({ id: 42, first_name: 'A' })

test('accepts a correctly-signed, fresh initData and extracts the user id', () => {
  const r = verifyInitData(sign({ auth_date: String(now()), user }), TOKEN)
  expect(r.ok).toBe(true)
  expect(r.userId).toBe('42')
})

test('rejects a tampered field (signature no longer matches)', () => {
  const good = sign({ auth_date: String(now()), user })
  const tampered = good.replace(/user=[^&]*/, `user=${encodeURIComponent(JSON.stringify({ id: 999 }))}`)
  expect(verifyInitData(tampered, TOKEN).ok).toBe(false)
})

test('rejects a valid signature from the wrong bot token', () => {
  const r = verifyInitData(sign({ auth_date: String(now()), user }, 'other:token'), TOKEN)
  expect(r.ok).toBe(false)
  expect(r.reason).toBe('bad signature')
})

test('rejects stale initData', () => {
  const r = verifyInitData(sign({ auth_date: String(now() - 7200), user }), TOKEN, 3600)
  expect(r.reason).toBe('stale')
})

test('rejects missing hash and missing user', () => {
  expect(verifyInitData(`auth_date=${now()}&user=${encodeURIComponent(user)}`, TOKEN).ok).toBe(false)
  const noUser = sign({ auth_date: String(now()) })
  expect(verifyInitData(noUser, TOKEN).reason).toBe('no user')
})

test('end-to-end: server serves ls/read for an allowlisted, signed request and 401s otherwise', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { startWebapp } = await import('./webapp.ts')

  const dir = await mkdtemp(join(tmpdir(), 'webapp-'))
  await writeFile(join(dir, 'hello.txt'), 'hi there')
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>files</title>')
  const server = startWebapp({ token: TOKEN, isAllowed: id => id === '42', log: () => {}, staticDir: dir, port: 0 })
  const base = `http://127.0.0.1:${server.port}`
  const auth = { Authorization: `tma ${sign({ auth_date: String(now()), user })}` }
  try {
    // static shell is served WITHOUT auth (initData lives in the URL hash; server can't see it)
    const shell = await fetch(`${base}/`)
    expect(shell.status).toBe(200)
    expect(await shell.text()).toContain('<title>files</title>')

    const ls = await (await fetch(`${base}/api/ls?path=${encodeURIComponent(dir)}`, { headers: auth })).json()
    expect(ls.entries.some((e: { name: string }) => e.name === 'hello.txt')).toBe(true)

    const rd = await (await fetch(`${base}/api/read?path=${encodeURIComponent(join(dir, 'hello.txt'))}`, { headers: auth })).json()
    expect(rd.content).toBe('hi there')

    expect((await fetch(`${base}/api/ls?path=/`)).status).toBe(401)   // API: no initData
    const wrongUser = { Authorization: `tma ${sign({ auth_date: String(now()), user: JSON.stringify({ id: 7 }) })}` }
    expect((await fetch(`${base}/api/ls?path=/`, { headers: wrongUser })).status).toBe(403)   // API: not allowlisted
  } finally { server.stop(true) }
})

test('serves the real SPA bundle from webapp/ at /', async () => {
  const { startWebapp } = await import('./webapp.ts')
  const { join } = await import('node:path')
  const server = startWebapp({ token: TOKEN, isAllowed: () => true, log: () => {}, staticDir: join(import.meta.dir, 'webapp'), port: 0 })
  try {
    const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text()
    expect(html).toContain('telegram-web-app.js')
    expect(html).toContain('id="list"')
  } finally { server.stop(true) }
})
