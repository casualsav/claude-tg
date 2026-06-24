// webapp.ts — Files Mini App backend. A small Bun.serve HTTP server that serves the static SPA bundle
// and a JSON file API, authenticated by Telegram Mini App `initData` (HMAC-signed with the bot token)
// and gated to the bridge allowlist. Bound to localhost; a tunnel (cloudflared quick tunnel or
// Tailscale Funnel, set up by the daemon) fronts it with public HTTPS. Read endpoints are always on;
// write endpoints (edit / delete-to-trash / mkdir / rename) require `canWrite` (TELEGRAM_WEBAPP_WRITE,
// default off): they overwrite to a `.bak`, move deletions to a trash dir (recoverable), and audit
// every mutation to daemon.log. Dependencies are injected so this module stays decoupled and testable.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { readdir, stat, realpath, writeFile, copyFile, rename, mkdir, cp, rm } from 'node:fs/promises'
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
  resolveStart?: (token: string) => string | null   // map a deep-link startapp token → starting cwd
  canWrite?: boolean                       // enable write endpoints (TELEGRAM_WEBAPP_WRITE); default false → read-only
  trashDir?: string                        // /api/rm moves deletions here (recoverable); required when canWrite
  maxWriteBytes?: number                   // /api/write size cap (default 2 MiB)
  maxUploadBytes?: number                  // /api/upload size cap (default 50 MiB)
  // ---- Console tabs (Settings / Usage / Diff). Injected by the daemon so this stays a thin HTTP
  // layer (no daemon internals imported); each wraps a reused daemon function. All optional —
  // missing dep ⇒ the endpoint 404s and that tab just stays empty. settings WRITES gate on canWrite.
  readSettings?: () => Promise<SettingsView> | SettingsView          // current prefs/state for the Settings tab
  setSetting?: (userId: string, key: string, value: unknown) => Promise<string | null> | string | null   // apply one change (userId = toggling user, for any notice routing); returns an error string or null on ok
  readUsage?: () => Promise<UsageView> | UsageView                   // context %/cost/tokens/limits/budget for the Usage tab
  readDiff?: () => Promise<DiffView> | DiffView                      // focused session's working-tree diff (does NOT post to Telegram)
}

// Settings tab payload: each toggle is {value, editable} so the SPA renders the live state and only
// shows mutation controls for the writable ones (mode/model/effort are read-only here — they drive
// the tmux pane). `write` mirrors canWrite (server-side mutation gate).
export interface SettingsView {
  write: boolean
  settings: Record<string, { value: unknown; editable: boolean; options?: string[]; label?: string }>
}
export interface UsageView {
  ctxPct: number | null; tokens: string | null; cost: string | null
  h5: { pct: number; reset: string } | null; d7: { pct: number; reset: string } | null
  budget: { spent: number; cap: number | null } | null
}
export interface DiffView { clean: boolean; stat: string; diff: string; untracked: string[]; cwd: string | null; error?: string }

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
  // Keep every other field (incl. `signature` and `query_id`) in the data-check-string: Telegram's
  // HMAC `hash` is computed over ALL fields except `hash`. Excluding `signature` (a Bot API 8.0+ field)
  // makes the string differ from what Telegram signed → 'bad signature' 401s on real launches.
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

// Pick a non-colliding path for an upload: foo.png → "foo (1).png", "foo (2).png", … so dropping a
// file into a folder never silently clobbers an existing one (uploads are additive by intent).
async function uniquePath(p: string): Promise<string> {
  if (!(await stat(p).catch(() => null))) return p
  const dir = dirname(p), base = basename(p)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  for (let i = 1; i < 1000; i++) {
    const cand = join(dir, `${stem} (${i})${ext}`)
    if (!(await stat(cand).catch(() => null))) return cand
  }
  return join(dir, `${stem}-${Date.now()}${ext}`)
}

// matches a simple glob (*, ?) OR a case-insensitive substring against a basename
function makeMatcher(q: string): (name: string) => boolean {
  if (/[*?]/.test(q)) {
    const re = new RegExp('^' + q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
    return name => re.test(name)
  }
  const lq = q.toLowerCase()
  return name => name.toLowerCase().includes(lq)
}

async function handleApi(req: Request, url: URL, deps: WebappDeps, userId: string): Promise<Response> {
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
    return json({ path: dir, parent: dir === sep ? null : dirname(dir), entries, write: !!deps.canWrite })
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

  // Deep-link launch (t.me/<bot>?startapp=<token>): the SPA gets the token as initData.start_param and
  // exchanges it here for the session's cwd (paths don't fit the 64-char startapp limit). Tokens are
  // minted + held by the daemon (see resolveStart); unknown/expired → 404.
  if (url.pathname === '/api/resolve') {
    const cwd = deps.resolveStart?.(url.searchParams.get('token') || '') ?? null
    return cwd ? json({ cwd }) : json({ error: 'unknown or expired token' }, 404)
  }

  // ---- Console reads (auth-gated like every /api/*; no canWrite needed) ----
  if (url.pathname === '/api/settings') {
    if (!deps.readSettings) return json({ error: 'unavailable' }, 404)
    return json(await deps.readSettings())
  }
  if (url.pathname === '/api/usage') {
    if (!deps.readUsage) return json({ error: 'unavailable' }, 404)
    return json(await deps.readUsage())
  }
  if (url.pathname === '/api/diff') {
    if (!deps.readDiff) return json({ error: 'unavailable' }, 404)
    return json(await deps.readDiff())
  }

  // ---- Settings mutation (POST; gated by canWrite, same as the file writes) ----
  if (url.pathname === '/api/settings/set') {
    if (!deps.canWrite) return json({ error: 'read-only', reason: 'editing disabled (set TELEGRAM_WEBAPP_WRITE=1)' }, 403)
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
    if (!deps.setSetting) return json({ error: 'unavailable' }, 404)
    const body = await req.json().catch(() => null) as { key?: unknown; value?: unknown } | null
    if (!body || typeof body.key !== 'string') return json({ error: 'bad body' }, 400)
    deps.log(`webapp: setting ${body.key}=${JSON.stringify(body.value)} user=${userId}`)
    const err = await deps.setSetting(userId, body.key, body.value)
    return err ? json({ error: err }, 400) : json({ ok: true })
  }

  // ---- Upload from device (POST multipart; gated by canWrite). Separate from the JSON write group
  // below because the body is multipart/form-data (a `dir` field + the `file` blob), not JSON. The
  // filename is reduced to a basename and validated; collisions auto-dedup so an upload never clobbers. ----
  if (url.pathname === '/api/upload') {
    if (!deps.canWrite) return json({ error: 'read-only', reason: 'editing disabled (set TELEGRAM_WEBAPP_WRITE=1)' }, 403)
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
    const form = await req.formData().catch(() => null)
    const file = form?.get('file')
    if (!form || !(file instanceof File)) return json({ error: 'no file' }, 400)
    const dir = await canon(String(form.get('dir') || ''))
    const dst = await stat(dir).catch(() => null)
    if (!dst || !dst.isDirectory()) return json({ error: 'not a directory' }, 404)
    const name = basename(file.name || 'upload')
    if (!name || name === '.' || name === '..' || /[\/\0]/.test(name)) return json({ error: 'bad name' }, 400)
    const max = deps.maxUploadBytes ?? 50 * 1024 * 1024
    if (file.size > max) return json({ error: 'too large', reason: `max ${Math.floor(max / 1048576)} MiB` }, 413)
    const target = await uniquePath(join(dir, name))
    await writeFile(target, Buffer.from(await file.arrayBuffer()))
    deps.log(`webapp: upload path=${target} bytes=${file.size} user=${userId}`)
    return json({ ok: true, path: target, name: basename(target), size: file.size })
  }

  // ---- Write endpoints (POST; gated by canWrite = TELEGRAM_WEBAPP_WRITE, default off) ----
  // Whole-FS like reads (the session already has full FS access), but guarded: explicit opt-in flag,
  // overwrite backs the prior contents up to `.bak`, delete moves to a trash dir (recoverable), every
  // mutation is audited. Paths are canonicalized by canon(); new-folder/rename names can't contain `/`.
  if (['/api/write', '/api/rm', '/api/mkdir', '/api/rename'].includes(url.pathname)) {
    if (!deps.canWrite) return json({ error: 'read-only', reason: 'editing disabled (set TELEGRAM_WEBAPP_WRITE=1)' }, 403)
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
    const body = await req.json().catch(() => null) as Record<string, unknown> | null
    if (!body) return json({ error: 'bad body' }, 400)
    const audit = (m: string) => deps.log(`webapp: ${m} user=${userId}`)

    if (url.pathname === '/api/write') {
      const file = await canon(String(body.path || ''))
      const content = String(body.content ?? '')
      if (Buffer.byteLength(content, 'utf-8') > (deps.maxWriteBytes ?? 2 * 1024 * 1024)) return json({ error: 'too large' }, 413)
      const st = await stat(file).catch(() => null)
      if (st?.isDirectory()) return json({ error: 'is a directory' }, 400)
      if (st && body.mtime != null && Math.abs(st.mtimeMs - Number(body.mtime)) > 1)
        return json({ error: 'conflict', reason: 'file changed on disk since you opened it — reopen it', mtime: st.mtimeMs }, 409)
      if (st) await copyFile(file, `${file}.bak`).catch(() => {})       // keep the prior contents recoverable
      await writeFile(file, content, 'utf-8')
      const ns = await stat(file)
      audit(`write path=${file} bytes=${ns.size}${st ? ' (.bak saved)' : ' (new file)'}`)
      return json({ ok: true, path: file, size: ns.size, mtime: ns.mtimeMs })
    }

    if (url.pathname === '/api/rm') {
      const target = await canon(String(body.path || ''))
      if (!(await stat(target).catch(() => null))) return json({ error: 'not found' }, 404)
      if (!deps.trashDir) return json({ error: 'no trash dir configured' }, 500)
      await mkdir(deps.trashDir, { recursive: true })
      const dest = join(deps.trashDir, `${Date.now()}__${encodeURIComponent(target)}`)
      try { await rename(target, dest) }
      catch { await cp(target, dest, { recursive: true }); await rm(target, { recursive: true, force: true }) }   // cross-device fallback
      audit(`trash path=${target} → ${dest}`)
      return json({ ok: true, trashed: dest })
    }

    if (url.pathname === '/api/mkdir') {
      const name = String(body.name || '')
      if (!name || name === '.' || name === '..' || /[\/\0]/.test(name)) return json({ error: 'bad name' }, 400)
      const dir = join(await canon(String(body.path || '')), name)
      await mkdir(dir)
      audit(`mkdir path=${dir}`)
      return json({ ok: true, path: dir })
    }

    if (url.pathname === '/api/rename') {
      const newName = String(body.newName || '')
      if (!newName || newName === '.' || newName === '..' || /[\/\0]/.test(newName)) return json({ error: 'bad name' }, 400)
      const src = await canon(String(body.path || ''))
      const dest = join(dirname(src), newName)
      if (await stat(dest).catch(() => null)) return json({ error: 'target exists' }, 409)
      await rename(src, dest)
      audit(`rename ${src} → ${dest}`)
      return json({ ok: true, from: src, to: dest })
    }
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
      let userId = ''
      // Auth gates the API only. The static SPA shell carries no data, and the initial document load
      // can't send the initData header (it lives in the URL hash, invisible to the server) — so the
      // SPA reads initData client-side and signs every /api/* call. All file access is behind the API.
      if (isApi) {
        const initData = extractInitData(req)
        const v = initData ? verifyInitData(initData, deps.token, deps.maxInitDataAgeSec) : { ok: false, reason: 'no initData' } as InitDataResult
        if (!v.ok) {
          deps.log(`webapp: auth fail reason=${v.reason} keys=[${initData ? [...new URLSearchParams(initData).keys()].sort().join(',') : 'EMPTY'}]`)
          return json({ error: 'unauthorized', reason: v.reason }, 401)
        }
        if (!deps.isAllowed(v.userId!)) { deps.log(`webapp: denied user ${v.userId} (not in allowlist)`); return json({ error: 'forbidden' }, 403) }
        userId = v.userId!
      }
      try {
        return isApi ? await handleApi(req, url, deps, userId) : await handleStatic(url, deps)
      } catch (e) {
        deps.log(`webapp: ${url.pathname} error: ${(e as Error).message}`)
        return json({ error: 'server error' }, 500)
      }
    },
  })
  deps.log(`webapp: listening on http://127.0.0.1:${deps.port}`)
  return server
}
