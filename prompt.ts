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
export type PromptInfo = { question: string; options: PromptOption[]; multiSelect: boolean }

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[mGKHFJABCDsuhl]/g, '').replace(/\x1b\([AB]/g, '')
}

// A line that is nothing but box-drawing chars / whitespace (a border or divider).
const BOXY_LINE = /^[╭╮╰╯─│\s]*$/
// Glyphs that begin a tool-result / output / bullet line — never a question.
const RESULT_GLYPH = /^[⎿⏺●○◉└├▪▸•·◦]/
// Footer under a single-select prompt. Anchored on the list-navigation wording
// ("Enter to select", "↑/↓ to navigate") rather than the generic "Esc to cancel",
// which yes/no confirmation dialogs share — those are deliberately NOT relayed.
const SELECT_HINT = /enter to select|↑\/↓|\bto navigate\b/i
// Footer under a multi-select prompt: options are toggled with Space, so the hint
// reads "Space to select · …". The Space-toggle wording is what distinguishes a
// real multi-select from a confirm dialog's "Enter to confirm".
const MULTI_HINT = /space to (?:select|toggle|check)/i
// Checkbox glyphs in the option block — a second tell for multi-select.
const CHECKBOX_GLYPH = /[☐☑▢▣◻◼⬜✅]/
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
      options.push({ label: (m[2] ?? m[1]).replace(/\s*│\s*$/, '').trim() })
    } else if (options.length > 0) {
      if (line.trim() === '') continue          // blank gap between options
      if (BOXY_LINE.test(line)) continue        // divider / border between options
      if (INDENTED.test(line)) { attachDescription(options, line); continue }
      break                                      // a real non-option line ends the block
    }
  }
  return options.length >= 2 ? options : null
}

export function detectUserPrompt(paneText: string): PromptInfo | null {
  const lines = paneText.split('\n').map(l => stripAnsi(l).trimEnd())

  // Find the live select-menu footer: the lowest line carrying the hint, which
  // must sit at the bottom of the pane. A footer with more than one non-blank
  // line below it is scrollback (a scrolled-up past prompt), not the active one.
  let footerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SELECT_HINT.test(lines[i]) || MULTI_HINT.test(lines[i])) { footerIdx = i; break }
  }
  if (footerIdx === -1) return null
  let nonBlankBelow = 0
  for (let i = footerIdx + 1; i < lines.length; i++) if (lines[i].trim()) nonBlankBelow++
  if (nonBlankBelow > 1) return null

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
  const options = parseOptions(region, NUMBERED_RE) ?? parseOptions(region, INK_RE)
  if (!options) return null

  const question = findQuestionAbove(lines, topOpt - 1)
  if (!question) return null

  const multiSelect = MULTI_HINT.test(lines[footerIdx]) || region.some(l => CHECKBOX_GLYPH.test(l))
  return { question, options, multiSelect }
}
