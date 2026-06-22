# Spec: Files Mini App (browse · find · edit from Telegram)

Status: **proposal / plan** (branch `feat/files-mini-app`). Not yet implemented.

## 1. Goal
Give a paired user a real **filesystem explorer + editor** from Telegram: browse any directory
the session can reach (rooted at the session's repo cwd, navigable to the whole FS), **find** files,
**view/preview/download** them, and **edit** them. Delivered as a **Telegram Mini App** (Web App) —
an in-Telegram HTML/JS UI — rather than inline-keyboard button grids, because a tree view + a real
code editor (cursor, syntax highlighting, in-place edits, search) is dramatically better for this than
tap-menus.

The daemon is the perfect backend: it is a long-lived process that already has full FS access (the
same access the `--dangerously-skip-permissions` sessions have). The Mini App itself cannot touch the
filesystem — per Telegram's model it only talks to **our** backend — so all FS work stays in the daemon.

## 2. Why Mini App over inline keyboards / Rich Messages
- **Inline keyboards**: zero infra, but clunky — pagination, 64-byte callback-data limits, no real
  editor. Kept as the **no-infra baseline** (see Phase 0), not the primary path.
- **Rich Messages** (Bot API 10.1, 2026-06-11: `sendRichMessage` / `sendRichMessageDraft`): better
  *display* (collapsible blocks, tables, streaming) but not interactive nav/edit, renders only on
  updated clients, and post-dates our pinned grammy (1.41.1). Use later to prettify chat-side previews.
- **Mini App** (Bot API 6.0+ for `web_app` buttons; storage/fullscreen extras in 8.0/9.0): full custom
  UI. The right tool for browse + find + edit.

## 3. Architecture
```
Telegram client ──(opens web_app button URL)──▶ Mini App SPA (static HTML/JS/CSS)
        ▲                                              │
        │ initData (HMAC-signed with bot token)        │ fetch /api/* with initData header
        │                                              ▼
   grammy bot  ◀──────────────  Bun.serve HTTP server (in the daemon process)
   (existing)                    ├─ serves the static SPA bundle
                                 └─ JSON file API (ls/read/write/find/download)
                                          │ validates initData → allowlist
                                          ▼
                                   local filesystem
        ▲
        │ public HTTPS URL required by Telegram for web_app
   cloudflared quick-tunnel (bundled, zero-config, ephemeral URL)  ── or ──  user domain/reverse-proxy
```
- **New module `webapp.ts`** — `Bun.serve` HTTP server: static bundle + `/api/*` handlers + initData
  auth. Started by the daemon only when enabled.
- **Tunnel — DECIDED: bundled cloudflared quick tunnel** (`webapp.ts` or `tunnel.ts`). The daemon
  spawns/tracks `cloudflared tunnel --url http://127.0.0.1:<port>`, parses the assigned
  `https://*.trycloudflare.com` URL, and — since quick-tunnel URLs are **ephemeral** — injects the
  **current** URL into the `web_app` button at send time (and/or `setChatMenuButton`) rather than
  persisting it. No Cloudflare account, domain, DNS, or inbound ports; outbound-only, TLS at CF's edge.
  - **Binary acquisition:** prefer a system `cloudflared` if present; else auto-fetch the right
    platform/arch build from Cloudflare's GitHub releases on first enable, **checksum-pinned**, cached
    under the channel dir. (Air-gapped: user drops the binary in manually.)
  - **Alternatives (documented, not default):** a user-provided stable URL via `WEBAPP_PUBLIC_URL`
    (domain + reverse proxy, or a Cloudflare *named* tunnel); or **Tailscale** — `Serve` for a fully
    private `*.ts.net` URL when the phone is on the tailnet (TLS terminates on the box; never public),
    `Funnel` for a stable public URL. These trade setup for stability/privacy; cloudflared is the
    zero-config default.
- **Launch** — a `/files` command posts a message with an inline `web_app` button (and/or set the chat
  **menu button**) opening the SPA. The session's starting cwd is passed via the `startapp`/URL param;
  it is re-validated server-side from the topic→session→cwd mapping, never trusted from the client.
- **Frontend** — small static SPA: file tree (left) + **read-only** viewer/preview (right) + search box,
  plus per-file actions (⬇️ Download, ✏️ Edit → hands off to the chat edit flow). Syntax-highlighted
  viewer (e.g. highlight.js — read-only, no editor component). Theme synced to Telegram via
  `Telegram.WebApp.themeParams`. Shipped as a prebuilt static bundle (no runtime build step).

## 4. Auth (this is a file read/write API over a public URL — treat as security-critical)
- On launch Telegram provides `initData`, HMAC-SHA256 signed with the **bot token**. The SPA sends it
  on every API call (e.g. `Authorization: tma <initData>`).
- The daemon validates each request: recompute the HMAC over the sorted data-check-string, compare to
  `hash`; reject if mismatched or `auth_date` is stale (> N minutes). Extract `user.id` and **require it
  in `loadAccess().allowFrom`** — the same gate as every other bridge action. (Group/topic mode: also
  confirm membership/policy.)
- Defense in depth: bind `Bun.serve` to `127.0.0.1` and reach it only through the tunnel; rate-limit
  writes; **audit every write to `daemon.log`** (path, user, bytes); resolve real paths and reject
  traversal/symlink escapes beyond an allowed root set; optional sensitive-path denylist
  (`~/.ssh`, `*.env`, credential files) — though note the session can already read those, so this is
  belt-and-suspenders, default off with a warning.
- The bot token is the HMAC key and is already secret — never log it; never expose it to the SPA.

## 5. Daemon file API (v1)
All endpoints require valid initData; all resolve+canonicalize paths and refuse escapes.
- `GET  /api/ls?path=…` → `{ path, parent, entries:[{name,type:"dir|file|symlink",size,mtime}] }` (dirs first).
- `GET  /api/read?path=…` → `{ path, size, mtime, encoding, truncated, content }` for text; binary/large → metadata + `downloadUrl`.
- `GET  /api/download?path=…` → raw bytes, `Content-Disposition: attachment`.
- `GET  /api/find?root=…&q=…&max=…` → `{ matches:[path…] }` (name/glob match, capped; skips `.git`,
  `node_modules` by default with a toggle).
- `GET  /api/ls` also returns `write: <bool>` so the SPA renders edit/delete controls only when enabled.
- **Write endpoints (POST; require `TELEGRAM_WEBAPP_WRITE=1`, default off; whole-FS like reads; each
  canonicalizes its path and is audited to `daemon.log`):**
  - `POST /api/write` `{ path, content, mtime? }` → save a text file; backs the prior contents up to
    `<path>.bak`; if `mtime` is sent and the on-disk mtime differs → `409` (optimistic concurrency).
  - `POST /api/rm` `{ path }` → move the file/dir into the trash dir (`~/.tg-trash`, recoverable) — **not**
    a hard delete.
  - `POST /api/mkdir` `{ path, name }` → create a subfolder (`name` may not be `.`/`..` or contain `/`).
  - `POST /api/rename` `{ path, newName }` → rename in place (same name rules; refuses to overwrite).

## 6. Config (opt-in; off by default)
In `~/.claude/channels/telegram/.env` / `access.json`:
- `WEBAPP_ENABLED=true|false` (default false — adds a network surface, so explicit opt-in).
- `WEBAPP_TUNNEL=cloudflared|tailscale|none` (env **default `cloudflared`** = zero-config quick tunnel,
  but its URL rotates each run → **DM-only**; **`tailscale`** = a stable Funnel `*.ts.net` URL the daemon
  reads from `tailscale status` (funnel set up once at install via `tailscale funnel --bg <port>`) → works
  **in-group** and is the **recommended install pick**; `none` = use `WEBAPP_PUBLIC_URL`).
- `WEBAPP_PUBLIC_URL=https://…` (stable domain / named tunnel; overrides cloudflared).
- `WEBAPP_PORT=…` (localhost bind port; default e.g. 8787).
- `WEBAPP_WRITE=true|false` (default false → read-only). When on, the Mini App gains in-app **edit /
  delete-to-trash / new-folder / rename**; deletions go to `~/.tg-trash` (recoverable), overwrites keep
  a `.bak`, every mutation is audited to `daemon.log`.

## 7. Phasing
- **Phase 0 — inline baseline:** ~~inline-keyboard explorer~~ **skipped** (decided 2026-06-15). Mini App only.
- **Phase 1 — Mini App read-only:** `webapp.ts` server + `/api/ls|read|download|find` + initData auth +
  bundled cloudflared quick tunnel + static SPA (tree + view/preview/download) + `/files` launch button.
- **Phase 2 — chat-based editing:** the "✏️ Edit" affordance → `/api/edit-request` → daemon posts the
  edit prompt (small: code block + force_reply; large: document round-trip) → `writeFile` helper does
  `.bak` + audit-log + mtime check. No in-app editor.
- **Phase 3 — polish:** in-app search UX, Rich-Message chat previews, guarded `mkdir`/`rename`/`delete`,
  Tailscale + stable named-tunnel docs.

## 8. Dependencies & unknowns
- **cloudflared**: bundle the binary vs require the user to install it? Quick tunnels need no account but
  give an ephemeral URL (handled by injecting the live URL into buttons). Decide bundling + platform matrix.
- **grammy 1.41.1**: `web_app` inline buttons + `setChatMenuButton` are old (Bot API 6.0) → supported.
  Rich Messages are not (out of v1).
- **CodeMirror 6** bundle size + mobile ergonomics (tree + editor on a phone). Prebuild + vendor the bundle.
- **Deploy loop**: a static SPA bundle + `webapp.ts` are new tracked files synced to the cache; the
  type-check (`bun build daemon.ts`) must include `webapp.ts`; the cache needs the bundle present.
- **Multi-instance**: each bridge instance needs its own port + tunnel (mirror the `@tg_bridge` instance id).

## 9. Open questions (for the human)
1. ~~**Tunnel**: bundle `cloudflared` or require a domain?~~ **DECIDED (2026-06-15): bundled cloudflared
   quick tunnel** (zero-config, ephemeral URL injected into the button). Tailscale Serve/Funnel + a
   user-provided `WEBAPP_PUBLIC_URL` kept as documented alternatives.
   **UPDATE (2026-06-15): install now offers three options, with Tailscale Funnel as the recommended
   default** — `cloudflared` (zero-config but **DM-only**, since its rotating URL can't be registered as
   the BotFather Main Mini App), **`tailscale` Funnel** (free, stable `*.ts.net`, no domain → in-group),
   or a custom domain via `WEBAPP_PUBLIC_URL` (in-group, fully self-owned). `WEBAPP_TUNNEL=tailscale` is
   implemented in `tunnel.ts` (`tailscaleFunnelUrl`): the unprivileged daemon only *reads* the URL; the
   funnel is established once during install. The env-level default stays `cloudflared` so enabling the
   webapp by hand (no Tailscale present) still works.
2. ~~**Editing default**: in-app write vs ask-Claude?~~ **DECIDED: chat-based editing, NO in-app editor.**
   - **Small files (≤4096 chars):** bot posts the current contents in a markdown code block (Telegram's
     native tap-to-copy) + a `force_reply`; the user pastes, edits in the reply box, and sends → write.
   - **Large files:** bot sends the file as a **document** with a note; the user edits it locally and
     **sends the edited file back as an attachment** → write. (Avoids the 4096-char cap on BOTH the
     outbound code block AND the inbound reply, which Telegram would split into multiple messages.
     Inbound file fetch is capped ~20 MB by the Bot API — fine for text/code.) Reuses the bridge's
     existing "user sent a file" handling.
   - Writes go through a shared helper: write a `.bak`, audit to `daemon.log`, optimistic-concurrency on
     mtime. The Mini App's role is browse/view/download; its "✏️ Edit" button just asks the daemon to
     post the edit prompt into the chat — the write itself is a daemon (grammy) handler, not a web API.
   **UPDATE (2026-06-15): superseded — now an in-app editor.** With the Mini App working in-group, the
   chat round-trip was the wrong call. Editing is in-app: tap a text file → editable textarea → Save →
   `POST /api/write` (carries the mtime → `409` on conflict; backs up to `.bak`). Delete (→ `~/.tg-trash`,
   recoverable), new-folder, and rename are in-app too (see §5). All gated by `TELEGRAM_WEBAPP_WRITE=1`
   (default off), initData-auth'd + audited; binary/oversize files stay download-only. No chat-based edit
   / `/api/edit-request`.
3. ~~**Sensitive-path guard**~~ **DECIDED: no hard block** (the session already has full FS access);
   **audit-log every write** + a **soft warning** when editing `*.env` / under `~/.ssh` / obvious secrets.
4. ~~**Baseline / Phase 0**~~ **DECIDED: skip the inline-keyboard explorer.** Mini App only.

## 10. Shipped beyond v1 (2026-06-15)
- **Console tabs** — the Mini App is now a 4-tab console (Files / Settings / Usage / Diff): ONE Main Mini
  App with client-side tabs. New `webapp.ts` endpoints (`/api/settings` + `/api/settings/set`, `/api/usage`,
  `/api/diff`) call daemon-injected deps (`webappReadSettings`/`webappSetSetting`/`webappReadUsage`/
  `webappReadDiff`) that reuse `loadAccess`/`parseStatusline`/budget/`sendDiff` logic. Reads inherit the
  initData+allowlist auth; settings mutations also gate on `WEBAPP_WRITE`. Writable toggles: voice, mcp,
  sessionPin, stream/replyMode (mode/model/effort are read-only — they drive the pane).
- **Rich Messages (Bot API 10.1)** — outbound replies can render natively (tables/headings/code) via
  `sendRichMessage` (`richmsg.ts`, raw HTTP — grammy 1.41.1 has no 10.1 types). Always on (no toggle),
  honored whenever markdown rendering is enabled. The markdown→HTML/chunk path is the fallback; the rich
  path falls back to HTML on any error (a reply never drops) and honors `renderMarkdown:false`. Works in DM
  AND topics (`sendRichMessage` supports `message_thread_id`). **Deferred:** live draft-streaming via
  `sendRichMessageDraft` — it's private-chat-only (can't stream into supergroup topics), so the helper
  exists but isn't wired into the MirrorCard. Verified live: the API returns `ok:true` for this bot.
