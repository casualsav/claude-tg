// Prompt + permission relay — extracted from daemon.ts (split plan #2).
//
// Renders select/permission prompts as Telegram cards, registers their answer routes in the
// shared state maps, and owns permission-storm batching ("Allow all this turn"). Daemon-shaped
// pieces (the bot, outbound routing, the focused relay cursor, pane key injection) come in via
// initPromptRelay's deps so the pure parts stay unit-testable.
import { Bot, InlineKeyboard } from 'grammy'
import { escapeHtml } from './markdown.ts'
import { sleep } from './proc.ts'
import { capturePane, paneCwd, paneAlive, type PaneWatcher } from './pane-io.ts'
import { focus, pendingMultiSelect, freeTextPrompts, chatPrompts } from './state.ts'
import { loadAccess } from './access.ts'
import { finalRepliesAfter } from './transcript.ts'
import { detectPermissionPrompt, onNormalPrompt, type PromptInfo, type PromptOption, type PermissionPrompt } from './prompt.ts'

type PromptRelayDeps = {
  bot: Bot
  outboundTargetsFor: (paneId: string | null) => Promise<Array<{ chat: string; thread?: number }>>
  flushPendingText: () => Promise<void>
  transcriptForPane: (pane: string | null, cwd: string | null) => Promise<string | null>
  lastRelayedUuid: () => string
  resetPromptDedup: (paneId: string | null) => void
  verifyPromptClosed: (paneId?: string | null) => Promise<void>
  paneKeys: (paneId: string, keys: string[], settle?: [number, number]) => Promise<boolean>
}
let deps: PromptRelayDeps
export function initPromptRelay(d: PromptRelayDeps): void { deps = d }

// Render a prompt as Telegram HTML: bold question, then each numbered option with
// its description (if any) as plain italic text beneath it (no blockquote).
export function renderPromptHtml(prompt: PromptInfo): string {
  const lines = [`❓ <b>${escapeHtml(prompt.question)}</b>`]
  if (prompt.tabbed) lines.push('<i>One of several questions — answer this one to move to the next.</i>')
  else if (prompt.multiSelect) lines.push('<i>Pick one or more, then tap ✅ Submit.</i>')
  lines.push('')
  prompt.options.forEach((opt, i) => {
    if (i > 0) lines.push('')   // blank line between options so they read as separate items
    lines.push(`<b>${i + 1}.</b> ${escapeHtml(opt.label)}`)
    if (opt.description) lines.push(`<i>${escapeHtml(opt.description)}</i>`)
  })
  // The "Type something" button only rides on the single-select keyboard; multi-select
  // shows checkboxes + Submit (no free-text button), so don't advertise it there.
  if (prompt.freeText && !prompt.multiSelect) lines.push('', '✏️ <i>…or tap “Type something” to write your own answer.</i>')
  return lines.join('\n')
}

// Permission request as a self-contained message: the tool name as the heading,
// then its description and (pretty-printed, length-capped) input, then "Approve?".
// All the context is inline so there's no separate "see more" step.
export function formatPermission(tool_name: string, description: string, input_preview: string): string {
  let pretty: string
  try { pretty = JSON.stringify(JSON.parse(input_preview), null, 2) } catch { pretty = input_preview }
  const parts = [`🔐 <b>${escapeHtml(tool_name)}</b>`, '']
  if (description.trim()) parts.push(escapeHtml(description), '')
  if (pretty.trim()) {
    const capped = pretty.length > 1500 ? pretty.slice(0, 1500) + '\n…(truncated)' : pretty
    parts.push(`<pre>${escapeHtml(capped)}</pre>`, '')
  }
  parts.push('<b>Approve?</b>')
  return parts.join('\n')
}

// Toggle keyboard for a multi-select prompt: a checkbox button per option (3 per
// row) plus a Submit button. ☑ marks currently-selected indices.
export function multiSelectKeyboard(options: PromptOption[], selected: Set<number>): InlineKeyboard {
  const kb = new InlineKeyboard()
  options.forEach((_, i) => {
    kb.text(`${selected.has(i) ? '☑' : '☐'} ${i + 1}`, `msel:${i + 1}`)
    if ((i + 1) % 3 === 0) kb.row()
  })
  kb.row().text('✅ Submit', 'msel:submit')
  return kb
}

// Numbered-option keyboard for a single-answer prompt (3 per row). `prefix` is the
// callback namespace — `prompt` for an ordinary single-select (digit-driven) or
// `mq` for a multi-question tab (arrow-driven). A ✏️ Type-something button is
// appended when the prompt offers free text.
export function singleAnswerKeyboard(prompt: PromptInfo, prefix: 'prompt' | 'mq'): InlineKeyboard {
  const kb = new InlineKeyboard()
  prompt.options.forEach((_, i) => {
    kb.text(String(i + 1), `${prefix}:${i + 1}`)
    if ((i + 1) % 3 === 0) kb.row()
  })
  if (prompt.freeText) kb.row().text('✏️ Type something', 'ftext')
  // Always offer "Chat about this" — if the menu has a literal option for it we select that,
  // otherwise we Esc-dismiss the question (see the chat handler).
  kb.row().text('💬 Chat about this', 'chat')
  return kb
}

export async function relayPromptToTelegram(prompt: PromptInfo, paneId: string | null = focus.activePaneId): Promise<void> {
  if (!paneId) return
  // Route to the requesting session's own topic in forum mode; DM mode → the allowlist.
  const targets = await deps.outboundTargetsFor(paneId)
  if (targets.length === 0) return

  // The menu is detected from the PANE the instant it appears, but the message Claude wrote just
  // before an AskUserQuestion lands in the transcript a beat later — and that message is the CONTEXT
  // for the question, so it must arrive FIRST. Wait up to 2s for it to land (breaking the moment it
  // does, so there's no fixed penalty), then flush it before sending the menu. Permission/login
  // prompts take their own instant paths, so only these select menus ever wait — and only until the
  // preamble shows up. Focused pane only: the flush rides the focused relay cursor; aux panes'
  // text is relayed by auxRelayTick on its own cadence (final replies only).
  if (paneId === focus.activePaneId) {
    const cwd = await paneCwd(paneId).catch(() => null)
    const file = await deps.transcriptForPane(paneId, cwd)
    for (let waited = 0; file && waited < 2000; waited += 250) {
      if (finalRepliesAfter(file, deps.lastRelayedUuid()).some(r => r.uuid && r.uuid !== deps.lastRelayedUuid())) break
      await sleep(250)
    }
    await deps.flushPendingText()   // preamble text must land before the menu
  }
  const text = renderPromptHtml(prompt)

  for (const { chat, thread } of targets) {
    const extra = thread ? { message_thread_id: thread } : {}
    try {
      let sent
      if (prompt.multiSelect) {
        const selected = new Set<number>()
        sent = await deps.bot.api.sendMessage(chat, text, {
          parse_mode: 'HTML', ...extra,
          reply_markup: multiSelectKeyboard(prompt.options, selected),
        })
        pendingMultiSelect.set(`${chat}:${sent.message_id}`, {
          paneId, options: prompt.options, selected,
        })
      } else {
        sent = await deps.bot.api.sendMessage(chat, text, {
          parse_mode: 'HTML', ...extra,
          reply_markup: singleAnswerKeyboard(prompt, prompt.tabbed ? 'mq' : 'prompt'),
        })
      }
      // Remember the prompt so a ✏️ tap knows how to reach its free-text field: the
      // option sits `options.length` Down presses past the first one. "Chat about
      // this" sits one further down again.
      if (prompt.freeText) {
        freeTextPrompts.set(`${chat}:${sent.message_id}`, {
          paneId, downCount: prompt.options.length, tabbed: prompt.tabbed, question: prompt.question,
        })
      }
      // Register chat-dismiss for every question. If the menu carries its own "Chat about this"
      // option we select it (downCount past the options + free-text); otherwise we Esc-dismiss.
      chatPrompts.set(`${chat}:${sent.message_id}`, prompt.chat
        ? { paneId, downCount: prompt.options.length + 1, tabbed: prompt.tabbed, useEscape: false }
        : { paneId, downCount: 0, tabbed: prompt.tabbed, useEscape: true })
    } catch (e) {
      process.stderr.write(`daemon: prompt relay to ${chat} failed: ${e}\n`)
    }
  }
}

// An option's button face: a leading emoji by intent (Yes / Yes-allow-all / No), the label
// trimmed of its "(shift+tab)" hint and capped so it fits a Telegram button.
export function permButtonLabel(opt: { n: number; label: string }): string {
  const bare = opt.label.replace(/\s*\([^)]*\)\s*$/, '').trim()
  const low = bare.toLowerCase()
  const icon = low === 'yes' ? '✅' : low.startsWith('yes') ? '🔁' : low.startsWith('no') ? '❌' : '•'
  const short = bare.length > 38 ? bare.slice(0, 37) + '…' : bare
  return `${icon} ${short}`
}

// ---- Permission-storm batching (ROADMAP #13) ----
// A turn that raises N permission prompts costs N taps. From the 2nd prompt of a turn, offer
// "Allow all this turn": once armed, subsequent prompts in that turn auto-answer option 1
// (the plain Allow) with a quiet note instead of a card. Disarmed when the pane returns to a
// normal prompt (turn over) — see sweepPermStorms. Toggle: settings → ⚡ Batch allow (default on).
export const permStorms = new Map<string, { count: number; armed: boolean; lastQ?: string; offered?: boolean }>()
export function batchAllowEnabled(): boolean { return loadAccess().batchAllow !== false }
export async function sweepPermStorms(): Promise<void> {
  for (const [pane, _storm] of permStorms) {
    try {
      if (!(await paneAlive(pane))) { permStorms.delete(pane); continue }
      const cap = await capturePane(pane).catch(() => '')
      if (cap && onNormalPrompt(cap) && !detectPermissionPrompt(cap)) permStorms.delete(pane)   // turn over
    } catch { permStorms.delete(pane) }
  }
}

// Relay a permission prompt to Telegram: the question, a short preview of what's being
// approved, and a button per option (callback pperm:<n>) that injects that choice into the
// pane. One button per row — the labels (esp. "allow all this session") are long.
export async function relayPermissionToTelegram(perm: PermissionPrompt, paneId: string | null = focus.activePaneId): Promise<void> {
  if (!paneId) return
  // Route to the requesting session's own topic in forum mode; DM mode → the allowlist.
  const targets = await deps.outboundTargetsFor(paneId)
  if (targets.length === 0) return

  const storm = permStorms.get(paneId) ?? { count: 0, armed: false }
  // A pane repaint can re-relay the SAME prompt — only a different question advances the storm.
  if (storm.lastQ !== perm.question) { storm.count++; storm.lastQ = perm.question }
  permStorms.set(paneId, storm)
  if (batchAllowEnabled() && storm.armed) {
    // Armed mid-turn → answer option 1 directly; leave a quiet breadcrumb instead of a card.
    await deps.paneKeys(paneId, ['1', 'Enter'], [300, 5000])
    deps.resetPromptDedup(paneId)
    await deps.verifyPromptClosed(paneId)
    for (const { chat, thread } of targets) {
      void deps.bot.api.sendMessage(chat, `⚡ Auto-allowed: <i>${escapeHtml(perm.question.slice(0, 120))}</i>`,
        { parse_mode: 'HTML', disable_notification: true, ...(thread ? { message_thread_id: thread } : {}) }).catch(() => {})
    }
    return
  }

  if (paneId === focus.activePaneId) await deps.flushPendingText()   // preamble must land before the approve/deny menu (focused relay cursor only)
  const parts = [`🔐 <b>${escapeHtml(perm.question)}</b>`]
  if (perm.preview) parts.push(`<blockquote>${escapeHtml(perm.preview)}</blockquote>`)
  const body = parts.join('\n')

  const kb = new InlineKeyboard()
  for (const opt of perm.options) kb.text(permButtonLabel(opt), `pperm:${opt.n}`).row()

  process.stderr.write(`daemon: relaying permission prompt (${perm.options.length} opts) “${perm.question}” to ${targets.map(t => t.chat + (t.thread ? `#${t.thread}` : '')).join(',')}\n`)
  for (const { chat, thread } of targets) {
    try {
      await deps.bot.api.sendMessage(chat, body, { parse_mode: 'HTML', reply_markup: kb, ...(thread ? { message_thread_id: thread } : {}) })
      // From the storm's 2nd distinct prompt, also offer the turn-wide allow (once per turn).
      if (batchAllowEnabled() && storm.count >= 2 && !storm.armed && !storm.offered) {
        storm.offered = true
        await deps.bot.api.sendMessage(chat, '⚡ Several permission prompts this turn.',
          { reply_markup: new InlineKeyboard().text('✅ Allow all this turn', `pstorm:${paneId}`), disable_notification: true, ...(thread ? { message_thread_id: thread } : {}) }).catch(() => {})
      }
    } catch (e) {
      process.stderr.write(`daemon: permission relay to ${chat} failed: ${e}\n`)
    }
  }
}