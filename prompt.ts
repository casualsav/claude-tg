// Detect Claude Code's interactive prompts from a captured tmux pane, so the
// daemon can relay them to Telegram as inline buttons. Pure and dependency-free
// → unit-testable in isolation.
//
// We relay only *genuine, live* selection prompts (AskUserQuestion and the
// equivalent option menus it renders). The one reliable signal is the footer
// hint a select menu prints as the last thing on screen — "Enter to select ·
// ↑/↓ to navigate · Esc to cancel" (single) or "Space to select · …" (multi).
// Claude Code's ordinary UI — assistant ● bullets, tool output, numbered text,
// the ❯ input cursor, box-drawing frames — never carries that footer, and a
// past prompt that has scrolled up always has live content below its footer. So
// we anchor on a footer sitting at the very bottom of the pane and read the
// option block directly above it. Everything else is left alone.

// An option carries its short label plus the indented description AskUserQuestion
// renders beneath it (when present).
export type PromptOption = { label: string; description?: string }
// `options` holds only the *real* answer options. AskUserQuestion auto-appends two
// meta-options — "Type something" (free text) and "Chat about this" — which we
// strip out: the free-text one is surfaced via `freeText` and driven separately,
// "Chat about this" is dropped. `tabbed` marks a multi-question prompt, which
// renders one question per tab and is driven by arrow-key navigation rather than
// digit selection (see the daemon's drive logic).
export type PromptInfo = {
  question: string
  options: PromptOption[]
  multiSelect: boolean
  tabbed: boolean
  freeText: boolean
  chat: boolean
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[mGKHFJABCDsuhl]/g, '').replace(/\x1b\([AB]/g, '')
}

// One capture, many detectors: every relay tick runs the same pane text through the whole
// detector chain (working/limited/user/permission/login/…), and each detector independently
// split + ANSI-stripped the full capture. Memoize the stripped lines for the most recent
// capture — the chain passes the SAME string, so the === hit is a reference check and the
// strip happens once per capture instead of once per detector. Single entry by design: a
// second pane's capture just recomputes (correctness never depends on a hit). Callers treat
// the returned array as read-only.
let _linesKey = ''
let _linesVal: string[] = []
export function paneLines(paneText: string): string[] {
  if (paneText === _linesKey && _linesVal.length) return _linesVal
  _linesKey = paneText
  _linesVal = paneText.split('\n').map(l => stripAnsi(l).trimEnd())
  return _linesVal
}

// A line that is nothing but box-drawing chars / whitespace (a border or divider).
const BOXY_LINE = /^[╭╮╰╯─│\s]*$/
// Glyphs that begin a tool-result / output / bullet line — never a question.
const RESULT_GLYPH = /^[⎿⏺●○◉└├▪▸•·◦]/
// Footer under a single-select prompt. Anchored on the list-navigation wording
// ("Enter to select", "↑/↓ to navigate") rather than the generic "Esc to cancel",
// which yes/no confirmation dialogs share — those are deliberately NOT relayed.
// The plan-approval prompt ("Claude has written up a plan … Would you like to proceed?")
// is a real single-select whose footer carries NONE of that wording — it reads
// "shift+tab to approve with this feedback" (and a "ctrl+g to edit … ~/.claude/plans"
// line below), so without this anchor it never relays and the user hangs on it.
const SELECT_HINT = /enter to select|↑\/↓|\bto navigate\b|shift\+tab to approve/i
// Footer under a multi-select prompt: options are toggled with Space, so the hint
// reads "Space to select · …". The Space-toggle wording is what distinguishes a
// real multi-select from a confirm dialog's "Enter to confirm".
const MULTI_HINT = /space to (?:select|toggle|check)/i
// Checkbox glyphs in the option block — a second tell for multi-select.
const CHECKBOX_GLYPH = /[☐☑▢▣◻◼⬜✅]/
// Some Claude Code builds (e.g. v2.1.x) render multi-select boxes as ASCII "[ ]" / "[x]" /
// "[✔]" AND reuse the single-select footer wording ("Enter to select"), so the bracket box
// is the only multi-select tell. Anchored at an option's start (after its number) so a
// literal "[x]" inside option prose can't trip it.
const BRACKET_BOX_OPT = /^\s*(?:│\s*)?(?:[❯►▶]\s*)?\d+[.)]\s+\[[ xX✔✓]\]/
// A leading checkbox token on a parsed label, stripped so labels read cleanly and the
// meta-option labels ("Type something" / "Chat about this") still match after the box.
const LEADING_BOX = /^\[[ xX✔✓]\]\s*/
// Footer wording unique to a multi-question (tabbed) AskUserQuestion: the user
// moves between question tabs with Tab/arrow keys, so the hint reads "Tab/Arrow
// keys to navigate". A single-question prompt's hint reads "↑/↓ to navigate".
const TABBED_HINT = /tab\/arrow/i
// Chrome that can legitimately appear BELOW an active prompt's footer and must not be mistaken for
// "new content" (which would mean the prompt is a scrolled-up past one). Covers: the persistent
// statusline (identity "user@host … |", the ε: line, the 5h/7d rate-window bars), box borders, the
// plan-approval extras ("ctrl+g to edit … plans", "shift+tab to approve/cycle"), and mode/agent
// hints. The plan-approval prompt keeps the working statusline rendered beneath it, so without this
// the footer reads several lines of "content" below and the prompt is wrongly dropped (never relayed).
const BELOW_CHROME = new RegExp(
  [
    /ctrl\+\w to edit/, /shift\+tab to (cycle|approve)/, /for agents\b/, /for shortcuts\b/,
    /esc to (cancel|interrupt|undo|clear)/, /\b(plan mode on|accept edits on|bypass permissions on|normal mode)\b/,
    /^\s*ε:/, /↻/, /\b[57][hd]\b/, /@[^|]+\|/,
    /^[\s│┃─━┌┐└┘├┤┬┴┼╭╮╰╯╶╴╵╷▔▁▂▃▄▅▆▇█]+$/,
  ].map(r => r.source).join('|'),
  'i',
)
// The two meta-options AskUserQuestion auto-appends below the real choices: a
// free-text entry and a "chat instead" escape hatch. Matched on their exact
// labels (a trailing period is rendered on the free-text one).
const FREE_TEXT_LABEL = /^type something\.?$/i
const CHAT_LABEL = /^chat about this\.?$/i
// An option's wrapped description: deeper indentation than the option line itself,
// tolerating one leading box border. The normal in-box prefix is "│ " (one space),
// so a description needs ≥2 spaces after the optional border to qualify.
const INDENTED = /^\s*│?\s{2,}\S/

// Numbered option: "1. opt" / "2) opt", tolerating the box border and cursor that
// frame a real prompt ("│ ❯ 1. opt │"). The primary AskUserQuestion shape.
const NUMBERED_RE = /^\s*(?:│\s*)?(?:[❯►▶]\s*)?(\d+)[.)]\s+(.+)$/
// Ink / inquirer ❯ ● ○ style, plus checkbox glyphs for multi-select — the marker
// is itself the option anchor. Fallback for menus that don't number their options.
const INK_RE = /^\s*(?:│\s*)?[❯►●◉☑▣◼✅]\s+(.+)$|^\s*(?:│\s*)?[○◯☐▢◻⬜]\s+(.+)$/

// Walk upward from `start` and gather the contiguous question text — it may wrap
// across several lines — stopping at a blank line, box border, or tool-output
// line. Strips surrounding box chars and a leading ? / ❓. '' if none.
function findQuestionAbove(relevant: string[], start: number): string {
  const collected: string[] = []
  for (let i = start; i >= Math.max(0, start - 8); i--) {
    const raw = relevant[i] ?? ''
    if (!raw.trim() || BOXY_LINE.test(raw)) { if (collected.length) break; else continue }
    const inner = raw.replace(/^[\s>│]*/, '').replace(/[\s│]*$/, '').trim()
    if (!inner || RESULT_GLYPH.test(inner)) { if (collected.length) break; else continue }
    collected.unshift(inner.replace(/^[?❓]\s*/, '').trim())
  }
  // Drop a leading header chip: AskUserQuestion renders a short (≤12-char) category
  // label above the question, which otherwise gets glued onto the question text.
  // Guarded by length + lack of terminal punctuation so real question lines stay.
  if (collected.length >= 2 && collected[0].length <= 14 && !/[?.!:]$/.test(collected[0])) {
    collected.shift()
  }
  return collected.join(' ').trim()
}

// Attach an indented description line to the most recently collected option,
// appending (space-joined) if the description itself wraps across lines.
function attachDescription(options: PromptOption[], text: string): void {
  const last = options[options.length - 1]
  if (!last) return
  const clean = text.replace(/^[\s│]*/, '').replace(/[\s│]*$/, '').trim()
  if (!clean) return
  last.description = last.description ? `${last.description} ${clean}` : clean
}

// Forward-parse an option region into options + descriptions, using `re` as the
// option matcher. AskUserQuestion renders an indented description under each
// option and a divider before its meta-options, so we capture indented lines as
// descriptions and skip blanks / borders between options. Returns null if the
// region holds fewer than two options.
function parseOptions(region: string[], re: RegExp): PromptOption[] | null {
  const options: PromptOption[] = []
  for (const line of region) {
    const m = line.match(re)
    if (m) {
      options.push({ label: (m[2] ?? m[1]).replace(/\s*│\s*$/, '').trim().replace(LEADING_BOX, '').trim() })
    } else if (options.length > 0) {
      if (line.trim() === '') continue          // blank gap between options
      if (BOXY_LINE.test(line)) continue        // divider / border between options
      if (INDENTED.test(line)) { attachDescription(options, line); continue }
      break                                      // a real non-option line ends the block
    }
  }
  return options.length >= 2 ? options : null
}

// The final tab of a multi-question prompt: a read-only review of the chosen
// answers with "Submit answers" / "Cancel" options. It's not a question to relay —
// the daemon recognises it to auto-submit once every question is answered — and its
// "Ready to submit your answers?" line appears nowhere else.
export function isSubmitScreen(paneText: string): boolean {
  return paneLines(paneText).some(l => /ready to submit your answers/i.test(l))
}

export function detectUserPrompt(paneText: string): PromptInfo | null {
  // The review/submit tab carries the same select-menu footer as a question, but
  // it's driven programmatically, not relayed — keep it out of detection entirely.
  if (isSubmitScreen(paneText)) return null

  const lines = paneLines(paneText)

  // Find the live select-menu footer: the lowest line carrying the hint, which
  // must sit at the bottom of the pane. A footer with more than one non-blank
  // line below it is scrollback (a scrolled-up past prompt), not the active one.
  let footerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SELECT_HINT.test(lines[i]) || MULTI_HINT.test(lines[i])) { footerIdx = i; break }
  }
  if (footerIdx === -1) return null
  // A real prompt sits at the bottom; the only thing allowed below its footer is chrome — the
  // persistent statusline (which plan-approval keeps rendered beneath it), box borders, the
  // "ctrl+g to edit … plans" line, mode/agent hints. More than one line of actual CONTENT below
  // means this footer belongs to a scrolled-up past prompt, not the active one.
  let contentBelow = 0
  for (let i = footerIdx + 1; i < lines.length; i++) {
    const l = lines[i]
    if (!l.trim() || BELOW_CHROME.test(l)) continue
    contentBelow++
  }
  if (contentBelow > 1) return null

  // Walk up from the footer across the option block — option lines, their indented
  // descriptions, and the blank/divider lines between them — recording the topmost
  // option line. The walk stops at the question (non-indented prose), which the
  // option matchers and the box/indent skips don't accept.
  let topOpt = -1
  for (let i = footerIdx - 1; i >= 0; i--) {
    const line = lines[i]
    if (NUMBERED_RE.test(line) || INK_RE.test(line)) { topOpt = i; continue }
    if (!line.trim() || BOXY_LINE.test(line) || INDENTED.test(line)) continue
    break
  }
  if (topOpt === -1) return null

  // Parse the block from the topmost option down to the footer, preferring numbered
  // options (AskUserQuestion) and falling back to ink markers.
  const region = lines.slice(topOpt, footerIdx)
  const parsed = parseOptions(region, NUMBERED_RE) ?? parseOptions(region, INK_RE)
  if (!parsed) return null

  // Split off the auto-appended meta-options. They always trail the real choices,
  // so the real options keep their natural 1..k numbering (and "Type something"
  // sits at position k+1, which the daemon reaches with k Down presses).
  const freeText = parsed.some(o => FREE_TEXT_LABEL.test(o.label))
  const chat = parsed.some(o => CHAT_LABEL.test(o.label))
  const options = parsed.filter(o => !FREE_TEXT_LABEL.test(o.label) && !CHAT_LABEL.test(o.label))
  if (options.length === 0 && !freeText) return null

  const question = findQuestionAbove(lines, topOpt - 1)
  if (!question) return null

  const multiSelect = MULTI_HINT.test(lines[footerIdx])
    || region.some(l => CHECKBOX_GLYPH.test(l) || BRACKET_BOX_OPT.test(l))
  const tabbed = TABBED_HINT.test(lines[footerIdx])
  return { question, options, multiSelect, tabbed, freeText, chat }
}

// ---- Permission / confirmation prompts (a different shape from select menus) ----
// CC asks "Do you want to <create file / run cmd / fetch …>?" with numbered Yes / Yes-
// allow-all / No options and a footer "Esc to cancel · Tab to amend" — note the footer
// carries NO "Enter to select / ↑↓" wording, so detectUserPrompt never matches it. The
// off-MCP daemon relays these so the user can approve/deny from Telegram without the
// terminal. `preview` is a best-effort one-glance summary of what's being approved.
export type PermissionOption = { n: number; label: string }
export type PermissionPrompt = { question: string; preview: string; options: PermissionOption[] }

const PERM_FOOTER = /esc to cancel\s*·\s*tab to amend/i
const PERM_QUESTION = /^(do you want to .+\?)$/i
const PERM_OPT = /^\s*(?:❯\s*)?(\d+)\.\s+(.+?)\s*$/
// A dashed diff divider (skipped inside the preview); a solid ──── box rule ends it.
const DASH_DIVIDER = /^[\s╌┄┈─—-]*$/
const SOLID_RULE = /^[\s─]{4,}$/

export function detectPermissionPrompt(paneText: string): PermissionPrompt | null {
  const lines = paneLines(paneText)

  // The permission footer, at the very bottom (≤1 non-blank line below → live, not a
  // scrolled-up past prompt).
  let footerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PERM_FOOTER.test(lines[i])) { footerIdx = i; break }
  }
  if (footerIdx === -1) return null
  let belowNonBlank = 0
  for (let i = footerIdx + 1; i < lines.length; i++) if (lines[i].trim()) belowNonBlank++
  if (belowNonBlank > 1) return null

  // Numbered options directly above the footer.
  const options: PermissionOption[] = []
  let topOptIdx = -1
  for (let i = footerIdx - 1; i >= 0; i--) {
    if (!lines[i].trim()) { if (options.length) break; else continue }
    const m = lines[i].match(PERM_OPT)
    if (m) { options.unshift({ n: Number(m[1]), label: m[2].trim() }); topOptIdx = i; continue }
    break
  }
  if (options.length < 2 || topOptIdx < 0) return null
  // Require the Yes…/No shape so a numbered text list can't masquerade as a permission.
  const labels = options.map(o => o.label.toLowerCase())
  if (!labels.some(l => l.startsWith('yes')) || !labels.some(l => l.startsWith('no'))) return null

  // The "Do you want …?" question just above the options.
  let question = '', questionIdx = -1
  for (let i = topOptIdx - 1; i >= 0; i--) {
    const t = lines[i].trim()
    if (!t) continue
    const m = t.match(PERM_QUESTION)
    if (m) { question = m[1].trim(); questionIdx = i }
    break
  }
  if (!question) return null

  // Preview: the action block above the question — clean lines up to the box's solid rule
  // or the ● tool header, skipping dashed diff rulers. Best-effort, capped.
  const preview: string[] = []
  for (let i = questionIdx - 1; i >= 0 && preview.length < 8; i--) {
    const raw = lines[i]
    if (SOLID_RULE.test(raw) || /^\s*●/.test(raw)) break
    if (DASH_DIVIDER.test(raw)) continue
    const clean = raw.replace(/^[\s│╭╮╰╯>]*/, '').replace(/[\s│]*$/, '').trim()
    if (clean) preview.unshift(clean)
  }

  return { question, preview: preview.join('\n').slice(0, 400), options }
}

// ---- /login method menu (a third shape) ----
// Claude's "Select login method" screen carries only an "Esc to cancel" footer — NO select-menu
// wording ("Enter to select / ↑↓") and NO permission "· Tab to amend" — so neither detector above
// matches it. It shows up at first-run onboarding AND whenever the user runs /login later. We
// detect it on its own (a distinctive header + numbered options) and relay the actual options as
// buttons. Selecting drives the pane; whatever the option needs next (an OAuth link, or terminal
// typing for an API key / 3rd-party platform) is surfaced separately.
const LOGIN_ANCHOR = /select login method|select login|log ?in with|how would you like to (?:log|sign) ?in|claude account with subscription|anthropic console account/i
// Numbered option, tolerating the highlight cursor Claude draws (a leading "_", "❯", "►", "•").
const LOGIN_OPT = /^\s*(?:│\s*)?(?:[_❯►▶•]\s*)?(\d+)[.)]\s+(.+?)\s*$/

export function detectLoginPrompt(paneText: string): { options: PromptOption[] } | null {
  const lines = paneLines(paneText)
  if (!lines.some(l => LOGIN_ANCHOR.test(l))) return null

  // The "Esc to cancel" footer, live at the very bottom (≤1 non-blank line below).
  let footerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/esc to cancel/i.test(lines[i])) { footerIdx = i; break }
  }
  if (footerIdx === -1) return null
  let belowNonBlank = 0
  for (let i = footerIdx + 1; i < lines.length; i++) if (lines[i].trim()) belowNonBlank++
  if (belowNonBlank > 1) return null

  // The contiguous numbered options directly above the footer.
  const opts: PromptOption[] = []
  for (let i = footerIdx - 1; i >= 0; i--) {
    const m = lines[i].match(LOGIN_OPT)
    if (m) { opts.unshift({ label: m[2].replace(/\s*│\s*$/, '').trim() }); continue }
    if (!lines[i].trim()) { if (opts.length) break; else continue }   // blank gap is fine until options start
    if (opts.length) break                                            // a real non-option line ends the block
  }
  return opts.length >= 2 ? { options: opts } : null
}

// ---- Usage-limit "what do you want to do?" menu (auto-dismissed, never relayed) ----
// When Claude hits a usage limit mid-turn it can pop a blocking menu:
//   What do you want to do?
//   _ 1. Stop and wait for limit to reset
//     2. Upgrade your plan
//     3. Upgrade to Team plan
//   Enter to confirm • Esc to cancel
// Its footer is "Enter to confirm" (not "Enter to select" / "· Tab to amend"), so neither prompt
// detector matches it — and left alone it wedges the terminal, so a scheduled/queued message can
// never inject. The daemon auto-confirms option 1 ("Stop and wait…", the highlighted default) to
// clear it. We recognise it by its distinctive first option + a live "Enter to confirm" footer.
const USAGE_CHOICE_OPT = /stop and wait for (?:the )?limit to reset/i
export function isUsageLimitChoice(paneText: string): boolean {
  const lines = paneLines(paneText)   // trimEnd-only delta vs the old un-trimmed strip — all tests here are trailing-ws-insensitive
  let footerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/enter to confirm/i.test(lines[i])) { footerIdx = i; break }
  }
  if (footerIdx === -1) return false
  let belowNonBlank = 0
  for (let i = footerIdx + 1; i < lines.length; i++) if (lines[i].trim()) belowNonBlank++
  if (belowNonBlank > 1) return false   // scrolled-up past menu, not the live one
  return lines.slice(0, footerIdx).some(l => USAGE_CHOICE_OPT.test(l))
}

// The /plugin "Will install:" scope menu:
//     > Install for you (user scope)
//       Install for all collaborators on this repository (project scope)
//       Install for you, in this repo only (local scope)
//       Back to plugin list
//      Enter to select • Esc to go back
// It carries the standard select footer ("Enter to select"), so detectUserPrompt would relay it as a
// question — but installing a plugin you just chose is a confirmation, not a decision to offload to
// chat, and the highlighted default is exactly the scope we want (user). The daemon auto-confirms it
// with Enter. We only fire when the cursor (❯/>) is actually sitting on the user-scope row, so a user
// who navigates to a different scope (or "Back") in the terminal is never overridden.
const PLUGIN_USER_SCOPE = /install for you \(user scope\)/i
export function isPluginInstallUserScope(paneText: string): boolean {
  const lines = paneLines(paneText)
  let footerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/enter to select/i.test(lines[i])) { footerIdx = i; break }
  }
  if (footerIdx === -1) return false
  let belowNonBlank = 0
  for (let i = footerIdx + 1; i < lines.length; i++) if (lines[i].trim()) belowNonBlank++
  if (belowNonBlank > 1) return false   // scrolled-up past the live menu
  const region = lines.slice(0, footerIdx)
  if (!region.some(l => PLUGIN_USER_SCOPE.test(l))) return false
  return region.some(l => /^\s*[>❯●]\s*install for you \(user scope\)/i.test(l))
}

// ---- External editor / pager detection ----
// Some pane states CAPTURE the keyboard, so the bridge's normal "type the message + Enter" lands in
// the wrong place and the user is silently stranded (e.g. the plan prompt's "ctrl+g to edit" opens
// $EDITOR). We classify the three common captors so the daemon can offer a guided way out instead of
// mistyping into them. Deliberately conservative — the caller also gates on !onNormalPrompt so a
// false hit can never block a ready Claude prompt.
export type EditorState = { kind: 'vim' | 'nano' | 'pager'; label: string }
export function detectEditorState(paneText: string): EditorState | null {
  const lines = paneLines(paneText)
  if (!lines.length) return null
  const tail = lines.slice(-8)
  const joined = tail.join('\n')
  const last = (lines[lines.length - 1] ?? '').trim()

  // nano: its bottom two rows are ^X/^O/^G/^W/^K shortcut columns — a row with ≥2 "^<LETTER>"
  // tokens plus at least one of the signature ones is unmistakable.
  if (tail.some(l => (l.match(/\^[A-Z]\b/g) ?? []).length >= 2) && /\^(X|O|G|W|K)\b/.test(joined)) {
    return { kind: 'nano', label: 'nano' }
  }
  // vim: an explicit mode line, or ≥3 "~" empty-line fillers down the left margin (vim's hallmark).
  if (/^-- (INSERT|REPLACE|VISUAL|VISUAL LINE|VISUAL BLOCK)( --)?\s*$/im.test(joined)) return { kind: 'vim', label: 'Vim' }
  if (lines.filter(l => /^~\s*$/.test(l)).length >= 3) return { kind: 'vim', label: 'Vim' }

  // pager (less / man / git's pager): the bottom line is a lone ":" prompt, "(END)", a
  // "lines i-j/k" status, or a "--More--" footer.
  if (last === ':' || last === '(END)' || /\(END\)$/.test(last) || /--More--/.test(joined) || /\blines \d+-\d+\/\d+/.test(joined)) {
    return { kind: 'pager', label: 'a pager' }
  }
  return null
}

// ---- Mode detection (moved from daemon.ts — pure pane-text parsers) ----

export type CcMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'

export function detectCurrentMode(paneText: string): CcMode {
  const lines = paneLines(paneText)
  // Drop the "✗ Auto-update failed…" footer line first — its "Auto" otherwise matches the
  // auto-mode test, making every mode read as 'auto' (broke the /mode picker's live update).
  const footer = lines.slice(-5).filter(l => !/auto-update/i.test(l)).join(' ').toLowerCase()
  if (/bypass|dangerously.?skip|yolo/i.test(footer)) return 'bypassPermissions'
  if (/\bplan\s*(mode)?\b/i.test(footer)) return 'plan'
  if (/\bauto\b/i.test(footer)) return 'auto'
  if (/accept.?edit/i.test(footer)) return 'acceptEdits'
  return 'default'
}

// The session is pinned to a model the account can't use — renamed, deprecated, or access pulled.
// Claude Code prints "Claude <Model> is currently unavailable. Learn more: …" and then EVERY action
// (resume, /compact, even /model) fails with it, wedging the session in an error loop. Returns the
// offending model name so the daemon can alert the user (who must /model to a working one). Matched
// loosely (the "Learn more" URL varies per model) but anchored on the exact Claude Code phrasing.
export function detectModelUnavailable(paneText: string): string | null {
  const m = stripAnsi(paneText).match(/Claude ([^\n]+?) is currently unavailable/i)
  return m ? m[1].trim() : null
}

// True when the LIVE interactive /compact is running on the pane. Claude Code renders, in the footer
// slot above the input box:
//     · Compacting conversation…
//       ▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 10%
// — a "Compacting conversation…" line above a ▰/▱ (filled/empty parallelogram) progress bar that
// carries an inline NN%. (An internal "compacting history (N tokens)" string exists in the CLI binary
// but is a DIFFERENT, non-interactive code path — NOT what /compact shows, which is why keying on it
// never fired. The original detector keyed on a ═/━ box-bar + a STANDALONE % — also wrong: the bar is
// ▰/▱ and the % sits on the bar line.) We require BOTH the phrase AND the ▰/▱ bar within the footer
// tail: the parallelogram bar never appears in prose, code, or our own chat, so pairing it with the
// phrase is what makes this robust against the content-only matches that looped before. A finished
// compaction shows "Compacted" (no bar), so the line is gone and the card self-resolves.
const FOOTER_TAIL = 18
export function detectCompacting(paneText: string): boolean {
  const tail = stripAnsi(paneText).split('\n').filter(l => l.trim()).slice(-FOOTER_TAIL)
  return tail.some(l => /compacting conversation/i.test(l)) && tail.some(l => /[▰▱]{3,}/.test(l))
}

// Claude Code's real compaction percentage — the NN% on the ▰/▱ bar line — so the card mirrors genuine
// progress instead of a synthetic animation. Only the bar line is read, so the statusline's own
// percentages (ctx 0%/1000k, 5h 1%, …) can't be misread. null when no bar line is present.
export function compactPercent(paneText: string): number | null {
  const tail = stripAnsi(paneText).split('\n').filter(l => l.trim()).slice(-FOOTER_TAIL)
  for (const l of tail) {
    if (!/[▰▱]/.test(l)) continue
    const m = /(\d{1,3})\s*%/.exec(l)
    if (m) return Math.max(0, Math.min(100, parseInt(m[1], 10)))
  }
  return null
}

// True when the pane is at Claude Code's normal prompt (input box visible), where reading or
// changing the mode is valid. A settings/config screen or another modal lacks this footer, so
// detectCurrentMode would there fall through to a false 'default' — mode ops guard on this and
// report "another screen" instead of silently switching/mis-reporting.
export function onNormalPrompt(paneText: string): boolean {
  const lines = paneLines(paneText)
  const tail = lines.slice(-8).join('\n').toLowerCase()
  if (/shift\+tab to cycle|\? for shortcuts|esc to interrupt/.test(tail)) return true
  // The footer hint rotates with CC version/state ("← for agents", "@ for file paths", …), so all
  // of the phrases above can be absent at a perfectly normal prompt (this bounced /mode with a
  // false "another screen"). Accept the input box itself as proof: a "❯" prompt row directly
  // between two box-border rows. Menus and pickers render "❯" as the cursor on an option row
  // inside a list — question above, sibling options below — never bordered on both sides.
  const t = lines.slice(-12)
  for (let i = 1; i + 1 < t.length; i++) {
    if (/^\s*❯/.test(t[i]) && /^\s*[─━╭╰└┌├╮╯|]/.test(t[i - 1]) && /^\s*[─━╭╰└┌├╮╯|]/.test(t[i + 1])) return true
  }
  return false
}
