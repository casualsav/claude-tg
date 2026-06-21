// clauding.ts — the live "Clauding…" status line for the DM-only rich draft (Bot API 10.1).
// Pure rendering only (no network / no transcript IO) so it's unit-testable; the daemon owns the
// tick loop, the draft send (richmsg.sendRichMessageDraft), and the DM-only gate. Mirrors Claude
// Code's terminal footer: a pulsing spinner + gerund + elapsed + tokens generated this turn.

// Locked spinner (dialed in over Telegram, which renders these dingbats at a uniform width so the
// line doesn't shift as it cycles — the narrow · / * frames from Claude Code's real set were
// dropped for that reason). ONE place owns the frames: Claude Code changes them across versions.
export const CLAUDING_SPINNER = ['✶', '✻', '✽', '✶', '✽', '✻'] as const

// Spinner glyph for an animation tick (the daemon advances `tick` once per draft update).
export function claudingFrame(tick: number): string {
  return CLAUDING_SPINNER[((tick % CLAUDING_SPINNER.length) + CLAUDING_SPINNER.length) % CLAUDING_SPINNER.length]
}

// Compact token count, Claude-Code style: 1.2k / 206k, raw below 1000.
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.max(0, Math.round(n)))
}

// The draft's markdown for one tick. Elapsed floors to clean 5s milestones (Telegram coalesces
// rapid draft updates, so a per-second counter reads as jittery — 5s steps stay clean). `output`
// is tokens generated this turn (↑), `context` the window fill. Activity lines render as bullets.
export function claudingStatus(o: {
  tick: number
  elapsedSec: number
  output: number
  context: number
  word?: string
  activity?: string[]
}): string {
  const mil = Math.floor(Math.max(0, o.elapsedSec) / 5) * 5
  const head = `${claudingFrame(o.tick)} **${o.word ?? 'Clauding'}…** · ${mil}s · ↑ ${fmtTokens(o.output)} · ${fmtTokens(o.context)} ctx`
  const body = o.activity?.length ? '\n\n' + o.activity.map(a => `• ${a}`).join('\n') : ''
  return head + body
}
