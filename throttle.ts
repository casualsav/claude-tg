// Per-chat send governor (token bucket) + flood tracking, installed as a grammy API transformer so it
// fronts EVERY outbound message/edit without touching call sites.
//
// Why: Telegram flood-limits a group chat to ~20 message events/min (DMs are far higher). The bridge
// runs several live self-editing cards against the same chat — the compaction card, the activity
// mirror, and the pinned statusline — plus replies, permission prompts, and reactions. Each spent that
// budget independently with no coordination, so a busy turn blew past the limit and Telegram answered
// 429 (retry_after 9-24s). The relay's blocking backoff then stalled the *reply* behind that window, so
// the whole bridge felt slow. The governor paces per chat so the flood can't happen in the first place;
// isChatFlooded lets the cosmetic editors stand down while a 429 window is open, leaving the budget for
// user-facing sends.
import type { Bot, Transformer } from 'grammy'
import { AsyncLocalStorage } from 'node:async_hooks'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// Methods that create or modify a visible message — the ones that count toward the per-chat flood
// limit, so the governor paces them. sendChatAction (typing) is exempt from the limit AND high-
// frequency (a ping every ~2.5s), so it is deliberately left unpaced; reactions are rare acks, also
// left unpaced. Everything still funnels through the catch below, so a 429 on ANY method marks flood.
const PACED_METHODS = new Set<string>([
  'sendMessage', 'sendPhoto', 'sendDocument', 'sendVideo', 'sendAnimation', 'sendVoice', 'sendAudio',
  'sendMediaGroup', 'copyMessage', 'forwardMessage',
  'editMessageText', 'editMessageCaption', 'editMessageMedia', 'editMessageReplyMarkup',
])

// Token bucket per chat. `cap` is the burst a chat absorbs instantly (a reply plus a couple of card
// edits arriving together) before pacing kicks in; `refillMs` is the steady-state spacing once the
// burst is spent. Groups: ~18/min sustained (well under Telegram's ~20). DMs: ~55/min.
type Bucket = { tokens: number; last: number }
const buckets = new Map<string, Bucket>()
function params(chat: string): { cap: number; refillMs: number } {
  return chat.startsWith('-') ? { cap: 4, refillMs: 3300 } : { cap: 8, refillMs: 1100 }
}
// Cosmetic sends (the live activity mirror's frame edits) run inside asLowPriority so the governor
// lets them stand aside while higher-priority sends — a new session's setup messages, replies,
// prompts — are waiting on the same per-chat budget. The mirror just resumes a beat later; the brief
// structural burst gets the budget. The flag rides AsyncLocalStorage so it reaches the transformer
// (which runs inside the wrapped bot.api call) without plumbing a param through every call site.
const lowPrioCtx = new AsyncLocalStorage<true>()
export function asLowPriority<T>(fn: () => Promise<T>): Promise<T> { return lowPrioCtx.run(true, fn) }

// How many higher-priority sends are currently waiting on each chat's budget. A cosmetic send yields
// its turn while this is non-zero (capped, so the mirror can't be starved indefinitely).
const highWaiters = new Map<string, number>()
function adjustHigh(chat: string, d: number): void {
  const n = (highWaiters.get(chat) ?? 0) + d
  if (n <= 0) highWaiters.delete(chat); else highWaiters.set(chat, n)
}

async function acquire(chat: string, method: string): Promise<void> {
  const low = lowPrioCtx.getStore() === true
  const { cap, refillMs } = params(chat)
  const waitStart = Date.now()
  if (!low) adjustHigh(chat, +1)
  try {
    for (;;) {
      const now = Date.now()
      let b = buckets.get(chat)
      if (!b) { b = { tokens: cap, last: now }; buckets.set(chat, b) }
      const gained = Math.floor((now - b.last) / refillMs)
      if (gained > 0) { b.tokens = Math.min(cap, b.tokens + gained); b.last += gained * refillMs }
      // A cosmetic send yields while any higher-priority send for this chat is queued, so structural /
      // user-facing sends never wait behind decoration. An 8s ceiling releases it anyway so a chat
      // that never goes quiet can't starve the mirror outright.
      const yielding = low && (highWaiters.get(chat) ?? 0) > 0 && Date.now() - waitStart < 8000
      // The check-and-take is synchronous (no await between the test and the decrement), so concurrent
      // callers can't double-spend a token.
      if (b.tokens > 0 && !yielding) {
        b.tokens -= 1
        if (!low) { const w = Date.now() - waitStart; if (w > 2000) process.stderr.write(`governor: ${method} to ${chat} waited ${w}ms (high-prio)\n`) }
        return
      }
      await sleep(yielding ? 200 : Math.max(50, b.last + refillMs - now))
    }
  } finally {
    if (!low) adjustHigh(chat, -1)
  }
}

// Chats currently inside a 429 retry_after window. Cosmetic editors (cards, pins) skip their edits
// while a chat is flooded so the recovering budget goes to replies/prompts, not decoration.
const floodUntil = new Map<string, number>()
export function isChatFlooded(chat: string): boolean { return Date.now() < (floodUntil.get(chat) ?? 0) }
export function noteFlood(chat: string, retryAfterSec: number): void {
  floodUntil.set(chat, Date.now() + Math.max(1, retryAfterSec) * 1000)
}

// Install the governor on a bot's API. Call once, right after the bot is constructed, before any sends.
export function installSendGovernor(bot: Bot): void {
  const governor: Transformer = async (prev, method, payload, signal) => {
    const chat = (payload as { chat_id?: unknown }).chat_id
    const chatStr = chat == null ? null : String(chat)
    if (chatStr && PACED_METHODS.has(method)) await acquire(chatStr, method)
    try {
      return await prev(method, payload, signal)
    } catch (e) {
      const err = e as { error_code?: number; parameters?: { retry_after?: number } }
      if (err?.error_code === 429 && chatStr) {
        const ra = Number(err.parameters?.retry_after)
        if (Number.isFinite(ra)) noteFlood(chatStr, ra)
      }
      throw e
    }
  }
  bot.api.config.use(governor)
}
