// webapp.ts — Files Mini App backend (Phase 1, read-only). A small Bun.serve HTTP server that
// serves the static SPA bundle and a JSON file API, authenticated by Telegram Mini App `initData`
// (HMAC-signed with the bot token) and gated to the bridge allowlist. Bound to localhost; a
// cloudflared quick tunnel (set up by the daemon) fronts it with public HTTPS. Editing is NOT here —
// it is a chat-based grammy flow (see docs/files-mini-app.md §9.2). Dependencies are injected so this
// module stays decoupled from daemon internals and unit-testable.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { readdir, stat, realpath } from 'node:fs/promises'
import { resolve, basename, dirname, join, sep } from 'node:path'

export interface WebappDeps {
  token: string                            // bot token — the HMAC key for initData validation
  isAllowed: (userId: string) => boolean   // allowlist gate (e.g. loadAccess().allowFrom.includes)
  log: (msg: string) => void               // diagnostics/audit → daemon.log
  staticDir: string                        // dir holding the prebuilt SPA bundle (index.html + assets)
  port: number                             // localhost bind port
  maxInitDataAgeSec?: number               // reject initData older than this (default 3600)
  maxReadBytes?: number                    // text read cap (default 512 KiB)
  maxFind?: number                         // find result cap (default 500)
}

export interface InitDataResult { ok: boolean; userId?: string; reason?: string }

// Telegram Mini App initData check: secret = HMAC_SHA256(key="WebAppData", msg=botToken);
// expected = HMAC_SHA256(key=secret, msg=data_check_string), where data_check_string is every
// field except `hash`, formatted "key=value", sorted, joined by "\n". Constant-time compared.
export function verifyInitData(initData: string, token: string, maxAgeSec = 3600): InitDataResult {
  let params: URLSearchParams
  try { params = new URLSearchParams(initData) } catch { return { ok: false, reason: 'unparseable' } }
  const hash = params.get('hash')
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return { ok: false, reason: 'no/bad hash' }
  params.delete('hash')
  params.delete('signature')   // Ed25519 third-party sig (Bot API 8.0+) is not part of the HMAC string
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(token).digest()
  const expected = createHmac('sha256', secret).update(dcs).digest('hex')
  const a = Buffer.from(expected, 'hex'), b = Buffer.from(hash.toLowerCase(), 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad signature' }
  const authDate = Number(params.get('auth_date') || 0)
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return { ok: false, reason: 'stale' }
  let userId: string | undefined
  try { const id = JSON.parse(params.get('user') || '{}').id; if (id != null) userId = String(id) } catch {}
  if (!userId) return { ok: false, reason: 'no user' }
  return { ok: true, userId }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

// Whole-FS browsing is intentional (the session already has full FS access — see the design doc), so
// there is no jail; we only canonicalize and guard against unreadable/odd paths. NUL bytes are refused.
async function canon(p: string): Promise<string> {
  if (!p || p.includes('\0')) throw new Error('bad path')
  const abs = resolve(p)
  try { return await realpath(abs) } catch { return abs }   // may not exist yet (caller stats it)
}

const isProbablyBinary = (buf: Uint8Array): boolean => {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

const SKIP_FIND = new Set(['.git', 'node_modules', '.cache', '.next', 'dist', 'build'])

// matches a simple glob (*, ?) OR a case-insensitive substring against a basename
function makeMatcher(q: string): (name: string) => boolean {
  if (/[*?]/.test(q)) {
    const re = new RegExp('^' + q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
    return name => re.test(name)
  }
  const lq = q.toLowerCase()
  return name => name.toLowerCase().includes(lq)
}

async function handleApi(url: URL, deps: WebappDeps): Promise<Response> {
  const maxRead = deps.maxReadBytes ?? 512 * 1024
  const maxFind = deps.maxFind ?? 500

  if (url.pathname === '/api/ls') {
    const dir = await canon(url.searchParams.get('path') || '/')
    const st = await stat(dir).catch(() => null)
    if (!st || !st.isDirectory()) return json({ error: 'not a directory' }, 404)
    const ents = await readdir(dir, { withFileTypes: true })
    const entries = await Promise.all(ents.map(async d => {
      const full = join(dir, d.name)
      const s = await stat(full).catch(() => null)   // follows symlinks; null on dangling
      const type = d.isDirectory() || s?.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'symlink' : 'file'
      return { name: d.name, type, size: s?.size ?? 0, mtime: s?.mtimeMs ?? 0 }
    }))
    entries.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name))
    return json({ path: dir, parent: dir === sep ? null : dirname(dir), entries })
  }

  if (url.pathname === '/api/read') {
    const file = await canon(url.searchParams.get('path') || '')
    const st = await stat(file).catch(() => null)
    if (!st || !st.isFile()) return json({ error: 'not a file' }, 404)
    if (st.size > maxRead) return json({ path: file, size: st.size, mtime: st.mtimeMs, truncated: true, tooLarge: true })
    const buf = new Uint8Array(await Bun.file(file).arrayBuffer())
    if (isProbablyBinary(buf)) return json({ path: file, size: st.size, mtime: st.mtimeMs, binary: true })
    return json({ path: file, size: st.size, mtime: st.mtimeMs, encoding: 'utf-8', content: new TextDecoder().decode(buf) })
  }

  if (url.pathname === '/api/download') {
    const file = await canon(url.searchParams.get('path') || '')
    const st = await stat(file).catch(() => null)
    if (!st || !st.isFile()) return json({ error: 'not a file' }, 404)
    return new Response(Bun.file(file), {
      headers: { 'content-disposition': `attachment; filename="${basename(file).replace(/"/g, '')}"` },
    })
  }

  if (url.pathname === '/api/find') {
    const root = await canon(url.searchParams.get('root') || '/')
    const q = (url.searchParams.get('q') || '').trim()
    if (!q) return json({ matches: [] })
    const match = makeMatcher(q)
    const matches: string[] = []
    const queue: string[] = [root]
    let visited = 0
    while (queue.length && matches.length < maxFind && visited < 20000) {
      const d = queue.shift()!; visited++
      const ents = await readdir(d, { withFileTypes: true }).catch(() => [])
      for (const e of ents) {
        if (e.isSymbolicLink()) continue                 // don't follow symlinks (loop safety)
        if (e.isDirectory()) { if (!SKIP_FIND.has(e.name)) queue.push(join(d, e.name)); continue }
        if (match(e.name)) { matches.push(join(d, e.name)); if (matches.length >= maxFind) break }
      }
    }
    return json({ root, q, matches, capped: matches.length >= maxFind })
  }

  return json({ error: 'unknown endpoint' }, 404)
}

// Serve the static SPA for any non-API path (single-page app: unknown paths fall back to index.html).
async function handleStatic(url: URL, deps: WebappDeps): Promise<Response> {
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
  if (rel.includes('..')) return new Response('forbidden', { status: 403 })
  const candidate = join(deps.staticDir, rel)
  const f = Bun.file(candidate)
  if (await f.exists()) return new Response(f)
  return new Response(Bun.file(join(deps.staticDir, 'index.html')))   // SPA fallback
}

// initData arrives as `Authorization: tma <initData>` on API calls. (It cannot gate the initial
// document load: Telegram delivers initData in the URL hash fragment, which the browser never sends
// to the server — only client JS sees it, then attaches it to each /api/* call.)
function extractInitData(req: Request): string | null {
  const auth = req.headers.get('authorization') || ''
  return auth.startsWith('tma ') ? auth.slice(4) : null
}

export function startWebapp(deps: WebappDeps): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port: deps.port,
    hostname: '127.0.0.1',                 // localhost only; the tunnel provides public ingress
    async fetch(req) {
      const url = new URL(req.url)
      const isApi = url.pathname.startsWith('/api/')
      // Auth gates the API only. The static SPA shell carries no data, and the initial document load
      // can't send the initData header (it lives in the URL hash, invisible to the server) — so the
      // SPA reads initData client-side and signs every /api/* call. All file access is behind the API.
      if (isApi) {
        const initData = extractInitData(req)
        const v = initData ? verifyInitData(initData, deps.token, deps.maxInitDataAgeSec) : { ok: false, reason: 'no initData' } as InitDataResult
        if (!v.ok) return json({ error: 'unauthorized', reason: v.reason }, 401)
        if (!deps.isAllowed(v.userId!)) { deps.log(`webapp: denied user ${v.userId} (not in allowlist)`); return json({ error: 'forbidden' }, 403) }
      }
      try {
        return isApi ? await handleApi(url, deps) : await handleStatic(url, deps)
      } catch (e) {
        deps.log(`webapp: ${url.pathname} error: ${(e as Error).message}`)
        return json({ error: 'server error' }, 500)
      }
    },
  })
  deps.log(`webapp: listening on http://127.0.0.1:${deps.port}`)
  return server
}
