import { test, expect } from 'bun:test'
import {
  toolBadge, recentAssistantBlocks, renderToolsMirror, renderThoughtsMirror,
  renderHybridMirror, renderDigestMirror, splitThoughtParagraphs, renderToolRun,
} from './mirror.ts'
import type { Activity, FeedItem } from './transcript.ts'

// These display helpers are pure (no initMirror/deps needed) — characterizing the mirror's
// most bug-prone surface: tool badging, ● block parsing, and the per-mode card rendering.

test('toolBadge maps known tools, falls back to 🔧 for unknown', () => {
  expect(toolBadge('Bash')).toEqual(['💻', 'terminal'])
  expect(toolBadge('Read')).toEqual(['📖', 'read'])
  expect(toolBadge('SomethingNew')).toEqual(['🔧', 'SomethingNew'])
})

test('toolBadge keyword-matches mcp__ actions, strips browser_ prefix', () => {
  expect(toolBadge('mcp__pw__browser_navigate')).toEqual(['🌐', 'navigate'])
  expect(toolBadge('mcp__pw__browser_screenshot')).toEqual(['📸', 'screenshot'])
  expect(toolBadge('mcp__pw__browser_click')).toEqual(['👆', 'click'])
  expect(toolBadge('mcp__srv__frobnicate')).toEqual(['🔌', 'frobnicate'])
})

test('recentAssistantBlocks parses ● blocks, keeps indented continuation, skips ⎿', () => {
  const raw = [
    '● First thing',
    '  more first',
    '  ⎿ tool output ignored',
    '● Second thing',
    'unindented line ends the block',
  ].join('\n')
  expect(recentAssistantBlocks(raw, 8)).toEqual([
    '● First thing\n  more first',
    '● Second thing',
  ])
})

test('recentAssistantBlocks keeps only the last `max` blocks', () => {
  const raw = ['● a', '● b', '● c'].join('\n')
  expect(recentAssistantBlocks(raw, 2)).toEqual(['● b', '● c'])
})

test('renderToolsMirror lists the latest 10 tools and a Done summary', () => {
  const acts: Activity[] = Array.from({ length: 12 }, (_, i) => ({ tool: 'Read', detail: `f${i}` }))
  const out = renderToolsMirror(acts, true)
  const lines = out.split('\n')
  expect(lines.length).toBe(11)                // 10 tools + Done
  expect(lines[0]).toContain('f2')             // oldest two (f0,f1) fell off
  expect(lines.at(-1)).toBe('✅ <b>Done</b> · 12 steps')
})

test('renderToolsMirror pluralizes a single step correctly', () => {
  expect(renderToolsMirror([{ tool: 'Bash', detail: 'ls' }], true)).toContain('1 step')
})

test('renderThoughtsMirror leads with 💭, folds tools into a summary, appends Done', () => {
  const feed: FeedItem[] = [
    { kind: 'text', text: 'thinking hard' },
    { kind: 'tool', tool: 'Bash', detail: 'ls' },
  ]
  const out = renderThoughtsMirror(feed, true)
  expect(out.startsWith('<blockquote>💭')).toBe(true)   // thoughts render shaded in a blockquote
  expect(out).toContain('thinking hard')
  expect(out).toContain('Ran 1 shell command')   // the tool call folds into the aggregate line
  expect(out).not.toContain('Bash')
  expect(out).toContain('✅ <b>Done</b>')
})

test('renderThoughtsMirror with no narration shows the tool summary and Done', () => {
  expect(renderThoughtsMirror([{ kind: 'tool', tool: 'Bash', detail: 'x' }], true))
    .toBe('<i>Ran 1 shell command</i>\n\n✅ <b>Done</b>')
})

test('renderToolRun aggregates search/read/bash and lists edits with line deltas', () => {
  const run: Array<Extract<FeedItem, { kind: 'tool' }>> = [
    { kind: 'tool', tool: 'Grep', detail: 'foo' }, { kind: 'tool', tool: 'Glob', detail: '*.ts' },
    { kind: 'tool', tool: 'Grep', detail: 'bar' },
    { kind: 'tool', tool: 'Read', detail: '/a/b.ts' }, { kind: 'tool', tool: 'Read', detail: '/a/c.ts' },
    { kind: 'tool', tool: 'Bash', detail: 'ls' }, { kind: 'tool', tool: 'Bash', detail: 'pwd' },
    { kind: 'tool', tool: 'Edit', detail: '/x/status-card.ts', lines: 3 },
    { kind: 'tool', tool: 'WebFetch', detail: 'https://e.com' },
  ]
  const lines = renderToolRun(run)
  expect(lines[0]).toBe('<i>Searched 3 patterns, read 2 files, ran 2 shell commands, fetch</i>')
  expect(lines[1]).toBe('✏️ <code>status-card.ts</code> <i>+3</i>')
})

test('renderHybridMirror interleaves thoughts and tool badges', () => {
  const feed: FeedItem[] = [
    { kind: 'text', text: 'planning' },
    { kind: 'tool', tool: 'Edit', detail: 'a.ts' },
  ]
  const out = renderHybridMirror(feed, false)
  expect(out).toContain('🗨️ planning')   // thoughts carry the 🗨️ marker to set them apart from tools
  expect(out).toContain('✏️ edit')
  expect(out).toContain('a.ts')
})

test('renderDigestMirror shows live/idle header + blocks', () => {
  expect(renderDigestMirror('', false)).toBe('🖥️ <b>Session</b> · live')
  expect(renderDigestMirror('', true)).toBe('🖥️ <b>Session</b> · idle')
  expect(renderDigestMirror('● hi there', false)).toContain('hi there')
})

test('renderThoughtsMirror counts visual paragraphs, never more than 10', () => {
  // 10 feed items but the first has two paragraphs — the window must cap VISUAL thoughts at 10,
  // so a 10-item feed with a multi-paragraph item can't render 11.
  const feed: FeedItem[] = [
    { kind: 'text', text: 'p1\n\np2' },
    ...Array.from({ length: 9 }, (_, i) => ({ kind: 'text' as const, text: `p${i + 3}` })),
  ]
  const out = renderThoughtsMirror(feed, false)
  expect(out).not.toContain('p1\n')   // oldest paragraph fell off (p1 alone — p10/p11 contain "p1")
  for (const p of ['p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10', 'p11']) expect(out).toContain(p)
})

test('splitThoughtParagraphs keeps fenced code blocks glued', () => {
  const t = 'intro\n\n```\ncode line 1\n\ncode line 2\n```\n\noutro'
  expect(splitThoughtParagraphs(t)).toEqual(['intro', '```\ncode line 1\n\ncode line 2\n```', 'outro'])
})
