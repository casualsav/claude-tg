// richmsg.ts — Bot API 10.1 "Rich Messages" outbound, behind the `richMessages` pref (default on — opt out with false).
//
// Telegram 10.1 renders native tables / headings / code / collapsible sections from a single
// `rich_message` field of type InputRichMessage = { markdown? | html?, … } — no block tree to send;
// the server parses structure from the markdown/HTML string. grammy 1.41.1 has no types/methods for
// these yet, so we call the raw HTTP API. Decoupled + unit-testable (like tunnel.ts/webapp.ts):
// pure payload shaping here, network only via callTelegram. The daemon keeps the HTML/chunk path as
// the fallback (any error here falls back), so flag-off behavior is byte-identical to today.

// InputRichMessage: exactly one of markdown/html is required (verified against the 10.1 schema).
export type InputRichMessage = {
  markdown?: string
  html?: string
  is_rtl?: boolean
  skip_entity_detection?: boolean
}

// Claude already emits markdown, so the default carrier is `markdown`. Kept trivial so switching to
// an html variant later is a one-line change (toInputRichMessage(text, 'html')).
export function toInputRichMessage(text: string, mode: 'markdown' | 'html' = 'markdown'): InputRichMessage {
  return mode === 'html' ? { html: text } : { markdown: text }
}

// Raw Bot API caller: POST JSON to api.telegram.org, return the parsed `result`, throw on ok:false
// or a non-2xx. One place owns the URL/JSON shape so callers stay declarative.
export async function callTelegram<T = unknown>(token: string, method: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  let body: { ok?: boolean; result?: T; description?: string; error_code?: number }
  try { body = await res.json() as typeof body } catch { throw new Error(`${method}: non-JSON response (HTTP ${res.status})`) }
  if (!body.ok) throw new Error(`${method} failed: ${body.error_code ?? res.status} ${body.description ?? ''}`.trim())
  return body.result as T
}

// A grammy-ish Message; we only ever read message_id off the result.
export type RichMessage = { message_id: number; [k: string]: unknown }

// Options shared by sendRichMessage / buildSendPayload. replyToMessageId emits reply_parameters so
// the rich path can honor reply-to (same chat) the way the HTML path does.
export type SendRichOpts = {
  messageThreadId?: number
  replyToMessageId?: number
  disableNotification?: boolean
  businessConnectionId?: string
}

// sendRichMessage — works in DM AND in forum supergroups/channels (supports message_thread_id), so
// it covers both DM and topic mode. Returns the sent Message.
export function sendRichMessage(
  token: string,
  chatId: string | number,
  richMessage: InputRichMessage,
  opts?: SendRichOpts,
): Promise<RichMessage> {
  return callTelegram<RichMessage>(token, 'sendRichMessage', buildSendPayload(chatId, richMessage, opts))
}

// Exported for testing: the exact wire payload sendRichMessage builds (no network).
export function buildSendPayload(
  chatId: string | number,
  richMessage: InputRichMessage,
  opts?: SendRichOpts,
): Record<string, unknown> {
  return {
    chat_id: chatId,
    rich_message: richMessage,
    ...(opts?.messageThreadId !== undefined ? { message_thread_id: opts.messageThreadId } : {}),
    ...(opts?.replyToMessageId !== undefined ? { reply_parameters: { message_id: opts.replyToMessageId } } : {}),
    ...(opts?.disableNotification ? { disable_notification: true } : {}),
    ...(opts?.businessConnectionId ? { business_connection_id: opts.businessConnectionId } : {}),
  }
}

// sendRichMessageDraft — PRIVATE CHAT ONLY (unsupported in supergroups/channels). Streaming = call
// repeatedly reusing the SAME non-zero draft_id with growing content; Telegram animates the diff. The
// draft is a 30s ephemeral preview with NO server message id — finalize by sending the full content
// via sendRichMessage. Returns Boolean.
export function sendRichMessageDraft(
  token: string,
  chatId: number,
  draftId: number,
  richMessage: InputRichMessage,
  opts?: { messageThreadId?: number },
): Promise<boolean> {
  return callTelegram<boolean>(token, 'sendRichMessageDraft', buildDraftPayload(chatId, draftId, richMessage, opts))
}

// Exported for testing: the sendRichMessageDraft wire payload (no network).
export function buildDraftPayload(
  chatId: number,
  draftId: number,
  richMessage: InputRichMessage,
  opts?: { messageThreadId?: number },
): Record<string, unknown> {
  return {
    chat_id: chatId,
    draft_id: draftId,
    rich_message: richMessage,
    ...(opts?.messageThreadId !== undefined ? { message_thread_id: opts.messageThreadId } : {}),
  }
}

// editMessageText now accepts rich_message instead of text — edit a previously-sent rich message
// (works in topics too). Returns the edited Message (or true for inline messages, which we don't use).
export function editRichMessage(
  token: string,
  chatId: string | number,
  messageId: number,
  richMessage: InputRichMessage,
): Promise<RichMessage> {
  return callTelegram<RichMessage>(token, 'editMessageText', buildEditPayload(chatId, messageId, richMessage))
}

// Exported for testing: the editMessageText (rich) wire payload (no network).
export function buildEditPayload(chatId: string | number, messageId: number, richMessage: InputRichMessage): Record<string, unknown> {
  return { chat_id: chatId, message_id: messageId, rich_message: richMessage }
}
