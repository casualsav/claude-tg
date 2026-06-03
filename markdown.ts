// Standard Markdown → Telegram-renderable HTML, plus a chunk-safe splitter.
//
// Claude emits ordinary Markdown; Telegram renders a small HTML subset. We target
// HTML (parse_mode 'HTML') rather than MarkdownV2 because only `& < >` need
// escaping and tags are unambiguous — which is what lets chunkHtml() split a long
// message at an arbitrary point and still hand Telegram balanced markup.
//
// Telegram counts a message's length by its *rendered* text: HTML tags contribute
// nothing, an entity like &lt; counts as one character. chunkHtml budgets by that
// "visible" length so it neither over-splits nor exceeds the 4096 cap.

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}

// Private-use char (U+E000) that cannot appear in Claude's Markdown, used to fence
// code-span placeholders so the emphasis passes don't touch their contents.
const SEN = String.fromCharCode(0xe000)

// Inline formatting. Input text is already HTML-escaped, so the only `<…>` in the
// string are the entity escapes (&lt; etc.) and the tags we insert here.
function inlineMd(escaped: string): string {
  const slots: string[] = []
  const stash = (html: string): string => `${SEN}${slots.push(html) - 1}${SEN}`

  let s = escaped
  // Code spans first so their contents are protected from emphasis parsing.
  s = s.replace(/``([^`]+)``/g, (_, c) => stash(`<code>${c}</code>`))
  s = s.replace(/`([^`]+)`/g, (_, c) => stash(`<code>${c}</code>`))

  // Emphasis. Asterisk forms are unambiguous; underscore forms require word
  // boundaries so snake_case identifiers aren't mangled.
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  s = s.replace(/(^|[^\w])__(.+?)__(?=[^\w]|$)/g, '$1<b>$2</b>')
  s = s.replace(/~~(.+?)~~/g, '<s>$1</s>')
  s = s.replace(/\*(.+?)\*/g, '<i>$1</i>')
  s = s.replace(/(^|[^\w])_(.+?)_(?=[^\w]|$)/g, '$1<i>$2</i>')

  // Links. Link text may already contain inserted tags (no `]`); URLs have no spaces.
  // `u` is already HTML-escaped (inlineMd runs on escaped text); only `"` remains.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${u.replace(/"/g, '&quot;')}">${t}</a>`)

  // Restore code spans.
  s = s.replace(new RegExp(`${SEN}(\\d+)${SEN}`, 'g'), (_, i) => slots[Number(i)])
  return s
}

export function mdToTelegramHtml(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let i = 0
  let quote: string[] | null = null

  const flushQuote = (): void => {
    if (quote) { out.push(`<blockquote>${quote.join('\n')}</blockquote>`); quote = null }
  }

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block.
    const fence = line.match(/^\s*```(\S*)\s*$/)
    if (fence) {
      flushQuote()
      const lang = fence[1]
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { body.push(lines[i]); i++ }
      i++ // skip closing fence (or run off the end)
      const code = escapeHtml(body.join('\n'))
      out.push(lang
        ? `<pre><code class="language-${escapeAttr(lang)}">${code}</code></pre>`
        : `<pre>${code}</pre>`)
      continue
    }

    // Blockquote — accumulate consecutive `>` lines into one element.
    const bq = line.match(/^\s*>\s?(.*)$/)
    if (bq) {
      ;(quote ??= []).push(inlineMd(escapeHtml(bq[1])))
      i++
      continue
    }
    flushQuote()

    // Horizontal rule.
    if (/^\s*([-*_])\1\1+\s*$/.test(line)) { out.push('──────────'); i++; continue }

    // Heading → bold line.
    const h = line.match(/^\s*#{1,6}\s+(.*)$/)
    if (h) { out.push(`<b>${inlineMd(escapeHtml(h[1]))}</b>`); i++; continue }

    // List item — Telegram has no list entity, so render a bullet / keep the number.
    const li = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/)
    if (li) {
      const marker = /^\d+\.$/.test(li[2]) ? `${li[2]} ` : '• '
      out.push(`${li[1]}${marker}${inlineMd(escapeHtml(li[3]))}`)
      i++
      continue
    }

    // Plain line.
    out.push(inlineMd(escapeHtml(line)))
    i++
  }
  flushQuote()
  return out.join('\n')
}

// ---- chunk-safe HTML splitting ----

type Tok =
  | { kind: 'open'; tag: string; raw: string }
  | { kind: 'close'; tag: string }
  | { kind: 'text'; atoms: string[] }

// Split text into atoms where each HTML entity (&…;) is a single indivisible unit,
// so a cut never lands inside an entity. atoms.length == visible character count.
function splitAtoms(text: string): string[] {
  return text.match(/&[a-zA-Z][a-zA-Z0-9]*;|&#\d+;|[\s\S]/g) ?? []
}

function tokenize(html: string): Tok[] {
  const toks: Tok[] = []
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(html))) {
    if (m.index > last) toks.push({ kind: 'text', atoms: splitAtoms(html.slice(last, m.index)) })
    const tag = m[2].toLowerCase()
    toks.push(m[1] === '/' ? { kind: 'close', tag } : { kind: 'open', tag, raw: m[0] })
    last = tagRe.lastIndex
  }
  if (last < html.length) toks.push({ kind: 'text', atoms: splitAtoms(html.slice(last)) })
  return toks
}

// Pick where to cut atoms[start..hardEnd): prefer a paragraph break, then a line
// break, then a space; otherwise a hard cut at hardEnd. Returns the atom index to
// cut *before* (always > start).
function findBreak(atoms: string[], start: number, hardEnd: number): number {
  let para = -1
  let line = -1
  let space = -1
  for (let j = start + 1; j < hardEnd; j++) {
    if (atoms[j] === '\n') { line = j; if (atoms[j - 1] === '\n') para = j }
    else if (atoms[j] === ' ') space = j
  }
  const mid = start + (hardEnd - start) / 2
  if (para > mid) return para
  if (line > mid) return line + 1
  if (space > start) return space + 1
  return hardEnd
}

function tagNameOf(rawOpenTag: string): string {
  return rawOpenTag.match(/^<([a-zA-Z][a-zA-Z0-9-]*)/)![1].toLowerCase()
}

function closeTagFor(rawOpenTag: string): string {
  return `</${tagNameOf(rawOpenTag)}>`
}

// Split rendered HTML into chunks each ≤ limit visible chars and each independently
// valid: tags are never cut, and any tags still open at a boundary are closed and
// reopened in the next chunk (so e.g. a code block longer than the limit becomes
// several `<pre><code …>` blocks with the original language preserved).
export function chunkHtml(html: string, limit: number): string[] {
  const cap = Math.max(1, limit)
  const toks = tokenize(html)
  const chunks: string[] = []
  const open: string[] = [] // raw open-tag strings currently in scope
  let cur = ''
  let vis = 0

  const flush = (reopen: boolean): void => {
    let s = cur
    for (let k = open.length - 1; k >= 0; k--) s += closeTagFor(open[k])
    chunks.push(s)
    cur = ''
    vis = 0
    if (reopen) for (const raw of open) cur += raw // visible length 0
  }

  for (const tok of toks) {
    if (tok.kind === 'open') { cur += tok.raw; open.push(tok.raw) }
    else if (tok.kind === 'close') {
      cur += `</${tok.tag}>`
      if (open.length && tagNameOf(open[open.length - 1]) === tok.tag) open.pop()
    } else {
      const atoms = tok.atoms
      let idx = 0
      while (idx < atoms.length) {
        if (vis >= cap) { flush(true); continue }
        const remaining = cap - vis
        if (atoms.length - idx <= remaining) {
          cur += atoms.slice(idx).join('')
          vis += atoms.length - idx
          idx = atoms.length
        } else {
          const cut = findBreak(atoms, idx, idx + remaining)
          cur += atoms.slice(idx, cut).join('')
          vis += cut - idx
          idx = cut
          flush(true)
        }
      }
    }
  }

  // Close anything still open (balanced input ends with open empty; this is a guard).
  let s = cur
  for (let k = open.length - 1; k >= 0; k--) s += closeTagFor(open[k])
  if (s.length > 0 || chunks.length === 0) chunks.push(s)
  return chunks
}
