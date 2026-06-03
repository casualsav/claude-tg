import { chmodSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Buffer } from 'node:buffer'

export const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const APPROVED_DIR = join(STATE_DIR, 'approved')
export const ENV_FILE = join(STATE_DIR, '.env')
export const INBOX_DIR = join(STATE_DIR, 'inbox')
export const SOCKET_PATH = join(STATE_DIR, 'daemon.sock')
export const DAEMON_PID_FILE = join(STATE_DIR, 'daemon.pid')
export const PENDING_EVENTS_FILE = join(STATE_DIR, 'pending-events.jsonl')

// Load .env into process.env — real env wins. Runs at import time.
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

// Newline-delimited JSON framing (opus-direct).
// JSON.stringify never emits a raw newline inside strings (control chars are
// escaped as \n → "\\n"), so '\n' is an unambiguous frame delimiter.
export function frame(obj: unknown): string {
  return JSON.stringify(obj) + '\n'
}

export function makeLineReader<T = unknown>(
  onMessage: (msg: T) => void,
  onParseError?: (line: string, err: unknown) => void,
): (chunk: Buffer | string) => void {
  let buf = ''
  return (chunk: Buffer | string) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.length === 0) continue
      try {
        onMessage(JSON.parse(line) as T)
      } catch (err) {
        if (onParseError) onParseError(line, err)
      }
    }
  }
}

// Fingerprint the plugin's source so the shim can tell whether a long-lived
// daemon is running stale code (i.e. the plugin was upgraded under it) and
// transparently restart it. Hashes every .ts file in the plugin dir, so any
// code change to the daemon or a module it imports changes the fingerprint.
// Returns '' if the dir can't be read — callers treat that as "don't restart".
export function computeCodeFingerprint(dir: string): string {
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.ts')).sort()
    const h = createHash('sha256')
    for (const f of files) {
      h.update(f); h.update('\0'); h.update(readFileSync(join(dir, f)))
    }
    return h.digest('hex').slice(0, 16)
  } catch {
    return ''
  }
}

// Wire protocol types (opus-direct).
export type ShimToDaemon =
  | { t: 'subscribe'; paneId: string | null }
  | { t: 'call'; id: string; name: string; args: Record<string, unknown> }
  | { t: 'permission_request'; params: {
      request_id: string; tool_name: string; description: string; input_preview: string } }

export type DaemonToShim =
  | { t: 'hello'; version?: string }   // version = daemon's code fingerprint
  | { t: 'detached' }                    // a newer shim subscribed; stop expecting events
  | { t: 'inbound'; params: InboundParams }
  | { t: 'permission'; params: { request_id: string; behavior: 'allow' | 'deny' } }
  | { t: 'result'; id: string; ok: boolean; text: string }

export type InboundParams = {
  content: string
  meta: Record<string, string>   // chat_id, message_id?, user, user_id, ts, image_path?, attachment_*
}
