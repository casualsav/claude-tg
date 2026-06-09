// Statusline parsing — lift Claude Code's custom statusLine metrics straight out of a pane
// capture (context %, tokens, cost, session/api time, 5h/7d rate-limit windows, effort, think).
//
// This is pure screen-scraping over the pane text (stripAnsi + regex), so it lives on its own
// where it can be unit-tested against fixed captures. The daemon feeds it a capture and renders
// the result into the session pin / effort picker.
import { stripAnsi } from './prompt.ts'

export type StatuslineData = {
  ctxPct: number | null
  tokens: string | null
  cost: string | null
  sessionTime: string | null
  apiTime: string | null
  h5: { pct: number; reset: string } | null
  d7: { pct: number; reset: string } | null
  effort: string | null   // ε:<level> from the statusline
  think: boolean          // ✻think badge present
}

const STATUS_DUR = '(\\d+h\\d+m|\\d+m\\d+s|\\d+h|\\d+m|\\d+s)'

// Render a 0-100 percentage as a fixed-width filled/empty bar (█/░) for the pin.
export function pinBar(pct: number, width = 10): string {
  const p = Math.max(0, Math.min(100, pct))
  const filled = Math.round((p / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

// The contiguous non-empty, non-border lines directly above the pane's last footer hint — i.e.
// the custom statusline's slot. null when there's no statusline there (the line above the footer
// is the input-box border) or the pane is in a transient state.
function statuslineBlock(paneText: string): string | null {
  const lines = paneText.split('\n').map(l => stripAnsi(l).replace(/\s+$/, ''))
  let last = lines.length - 1
  while (last >= 0 && !lines[last].trim()) last--
  if (last < 1) return null
  const out: string[] = []
  for (let i = last - 1; i >= 0 && last - i <= 6; i--) {
    const l = lines[i]
    if (!l.trim()) break
    if (/^[\s─━│┃┌┐└┘├┤┬┴┼╭╮╰╯╶╴╵╷]+$/.test(l)) break   // input-box border — statusline ends here
    out.unshift(l)
  }
  return out.length ? out.join('\n') : null
}

export function parseStatusline(paneText: string): StatuslineData | null {
  const block = statuslineBlock(paneText)
  if (!block) return null
  const str = (re: RegExp): string | null => { const m = block.match(re); return m?.[1] ?? null }
  const up = str(/↑\s*([\d.]+[kKmM]?)/), down = str(/↓\s*([\d.]+[kKmM]?)/)
  const costRaw = str(/\$\s*([\d.]+)/)
  const limit = (re: RegExp): { pct: number; reset: string } | null => {
    const m = block.match(re); return m ? { pct: parseInt(m[1], 10), reset: m[2] } : null
  }
  const data: StatuslineData = {
    ctxPct: (() => { const m = block.match(/ctx\D*?(\d+)\s*%/i); return m ? parseInt(m[1], 10) : null })(),
    tokens: up || down ? `↑${up ?? '?'} ↓${down ?? '?'}` : null,
    cost: costRaw ? `$${parseFloat(costRaw).toFixed(2)}` : null,
    sessionTime: str(new RegExp(`\\$[\\d.]+[^|]*\\|\\s*\\D*?${STATUS_DUR}`)),  // first duration after cost
    apiTime: str(new RegExp(`api\\s+${STATUS_DUR}`, 'i')),
    h5: limit(new RegExp(`5h\\D*?(\\d+)\\s*%\\D*?${STATUS_DUR}`)),
    d7: limit(new RegExp(`7d\\D*?(\\d+)\\s*%\\D*?${STATUS_DUR}`)),
    effort: str(/ε:\s*(\w+)/),
    think: /✻\s*think/i.test(block),
  }
  const empty = data.ctxPct == null && !data.tokens && !data.cost && !data.sessionTime && !data.h5 && !data.d7
  return empty ? null : data
}
