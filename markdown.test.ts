// Markdown → Telegram HTML and the chunk-safe splitter. Pure functions, no I/O.
import { test, expect } from 'bun:test'
import { escapeHtml, mdToTelegramHtml, chunkHtml } from './markdown.ts'

test('escapeHtml escapes & < > (and leaves quotes alone)', () => {
  expect(escapeHtml('a < b & c > d "e"')).toBe('a &lt; b &amp; c &gt; d "e"')
})

test('inline emphasis: bold, italic, code, strikethrough', () => {
  expect(mdToTelegramHtml('**b**')).toBe('<b>b</b>')
  expect(mdToTelegramHtml('*i*')).toBe('<i>i</i>')
  expect(mdToTelegramHtml('`c`')).toBe('<code>c</code>')
  expect(mdToTelegramHtml('~~s~~')).toBe('<s>s</s>')
})

test('snake_case identifiers are not italicised', () => {
  expect(mdToTelegramHtml('call foo_bar_baz now')).toBe('call foo_bar_baz now')
})

test('links render as anchors', () => {
  expect(mdToTelegramHtml('[site](https://x.io)')).toBe('<a href="https://x.io">site</a>')
})

test('headings become bold lines', () => {
  expect(mdToTelegramHtml('## Title here')).toBe('<b>Title here</b>')
})

test('list items get a bullet; ordered items keep their number', () => {
  expect(mdToTelegramHtml('- one')).toBe('• one')
  expect(mdToTelegramHtml('1. one')).toBe('1. one')
})

test('fenced code block keeps its language', () => {
  expect(mdToTelegramHtml('```ts\nconst x = 1\n```')).toBe('<pre><code class="language-ts">const x = 1</code></pre>')
})

test('fenced code block without a language', () => {
  expect(mdToTelegramHtml('```\nplain\n```')).toBe('<pre>plain</pre>')
})

test('html specials in body text are escaped', () => {
  expect(mdToTelegramHtml('a < b && c')).toBe('a &lt; b &amp;&amp; c')
})

test('emphasis inside a code span is left literal', () => {
  expect(mdToTelegramHtml('`a*b*c`')).toBe('<code>a*b*c</code>')
})

test('chunkHtml leaves a short message as a single chunk', () => {
  expect(chunkHtml('<b>hi</b>', 100)).toEqual(['<b>hi</b>'])
})

test('chunkHtml splits long text under the visible limit, balancing tags', () => {
  const chunks = chunkHtml('<b>' + 'x'.repeat(50) + '</b>', 20)
  expect(chunks.length).toBeGreaterThan(1)
  for (const c of chunks) {
    // each chunk is independently valid: the bold tag is reopened/closed
    expect((c.match(/<b>/g) ?? []).length).toBe((c.match(/<\/b>/g) ?? []).length)
    // visible length (tags stripped) never exceeds the limit
    expect(c.replace(/<[^>]+>/g, '').length).toBeLessThanOrEqual(20)
  }
})
