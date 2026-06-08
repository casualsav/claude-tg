#!/usr/bin/env bun
// Off-MCP actions CLI. A plugin-less session has no MCP reply tool, so it takes
// deliberate Telegram actions — send a file/photo, react, edit a status message — by
// talking to the daemon's unix socket directly with the same {t:'call'} the shim used.
// (Plain text replies are relayed automatically from the transcript; this is the rest.)
//
// <chat> is `.` in a DM (resolves to the sole allowlisted chat) or an explicit id in a group.
//   tgctl send  <chat> <path> [caption|-]     send a file/photo (- reads caption from stdin)
//   tgctl react <chat> <message_id> <emoji>   add an emoji reaction
//   tgctl edit  <chat> <message_id> <text|->   edit a message the bot sent (- reads stdin)
//   tgctl reply <chat> <text|->                send a text message (- reads stdin)
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { frame, makeLineReader, SOCKET_PATH, type ShimToDaemon, type DaemonToShim } from './common.ts'

const fromStdin = (s: string | undefined) => (s === '-' ? readFileSync(0, 'utf8') : s)
const [, , cmd, chat_id, a, b] = process.argv

let name = '', args: Record<string, unknown> = {}
switch (cmd) {
  case 'send':  name = 'reply';        args = { chat_id, files: [a], ...(b != null ? { text: fromStdin(b) } : {}) }; break
  case 'react': name = 'react';        args = { chat_id, message_id: a, emoji: b }; break
  case 'edit':  name = 'edit_message'; args = { chat_id, message_id: a, text: fromStdin(b) }; break
  case 'reply': name = 'reply';        args = { chat_id, text: fromStdin(a) }; break
  // `tg update` / `tg update check` — the second token lands in `chat_id`.
  case 'update': name = 'update';      args = { mode: chat_id === 'check' ? 'check' : 'apply' }; break
  default:
    process.stderr.write('usage: tgctl <send|react|edit|reply|update> ...\n')
    process.exit(2)
}

const id = String(Date.now())
const sock = net.createConnection(SOCKET_PATH)
const timer = setTimeout(() => { process.stderr.write('tgctl: timed out\n'); process.exit(1) }, 30_000)
sock.on('connect', () => sock.write(frame({ t: 'call', id, name, args } satisfies ShimToDaemon)))
sock.on('data', makeLineReader<DaemonToShim>(msg => {
  if (msg.t !== 'result' || msg.id !== id) return   // ignore hello/other frames
  clearTimeout(timer)
  process.stdout.write((msg.ok ? 'ok' : 'error') + (msg.text ? `: ${msg.text}` : '') + '\n')
  sock.destroy()
  process.exit(msg.ok ? 0 : 1)
}))
sock.on('error', e => { process.stderr.write(`tgctl: ${e}\n`); process.exit(1) })
