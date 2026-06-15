// tunnel.ts — front the local webapp with public HTTPS via a cloudflared quick tunnel.
// Quick tunnels need no Cloudflare account or domain: `cloudflared tunnel --url http://127.0.0.1:<port>`
// connects out to Cloudflare's edge and prints an ephemeral https://<rand>.trycloudflare.com URL that
// proxies to the local port. We spawn it, parse that URL, expose it, and relaunch if it dies. Because
// the URL changes per run, the daemon injects the CURRENT url() into the Mini App launch button at
// send time rather than persisting it. See docs/files-mini-app.md §3.

import { spawn, type Subprocess, which } from 'bun'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

// Exclude `api.trycloudflare.com` — cloudflared logs that (its API host) at startup BEFORE the real
// assigned `https://<random-words>.trycloudflare.com` URL, and we must not mistake it for the tunnel.
const TRYCF_RE = /https:\/\/(?!api\.)[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i

// cloudflared prints the assigned URL inside a boxed banner on stderr; pull the first trycloudflare URL.
export function parseTunnelUrl(text: string): string | null {
  const m = text.match(TRYCF_RE)
  return m ? m[0] : null
}

// Locate the cloudflared binary: explicit path → PATH → cached under <stateDir>/bin. Returns null if
// absent (the daemon then logs guidance / falls back to WEBAPP_PUBLIC_URL).
// TODO(phase1): optional checksum-pinned auto-fetch of
// github.com/cloudflare/cloudflared/releases/download/<ver>/cloudflared-<os>-<arch> into <stateDir>/bin
// so the zero-config promise holds without a system install.
export function findCloudflared(stateDir: string, explicit?: string): string | null {
  if (explicit && existsSync(explicit)) return explicit
  const onPath = which('cloudflared')
  if (onPath) return onPath
  const cached = join(stateDir, 'bin', 'cloudflared')
  return existsSync(cached) ? cached : null
}

export interface Tunnel { url(): string | null; stop(): void }

// Spawn cloudflared, stream-scan its output for the trycloudflare URL, and relaunch on exit. `onUrl`
// fires whenever the public URL (re)appears so the daemon can refresh any launch buttons.
export function startTunnel(opts: {
  port: number; bin: string; log: (m: string) => void; onUrl?: (u: string) => void
}): Tunnel {
  let url: string | null = null
  let proc: Subprocess | null = null
  let stopped = false

  const scan = async (stream: ReadableStream<Uint8Array> | undefined) => {
    if (!stream) return
    const dec = new TextDecoder()
    for await (const chunk of stream) {
      const found = parseTunnelUrl(dec.decode(chunk))
      if (found && found !== url) { url = found; opts.log(`tunnel: up at ${url}`); opts.onUrl?.(url) }
    }
  }

  const launch = () => {
    proc = spawn([opts.bin, 'tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${opts.port}`],
      { stdout: 'pipe', stderr: 'pipe' })
    void scan(proc.stdout as ReadableStream<Uint8Array>)
    void scan(proc.stderr as ReadableStream<Uint8Array>)
    void proc.exited.then(code => {
      if (stopped) return
      opts.log(`tunnel: cloudflared exited (code ${code}); relaunching in 2s`)
      url = null
      setTimeout(launch, 2000)
    })
  }
  launch()
  return { url: () => url, stop: () => { stopped = true; try { proc?.kill() } catch {} } }
}
