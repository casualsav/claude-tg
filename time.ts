// Duration parsing/formatting helpers. Pure and importable; used by the scheduler and by
// the usage-reset and session-list rendering in daemon.ts.

// "12h" "1h30m" "90s" "2d" "1w" → ms (sum of every unit chunk), or null if nothing parsed.
export function parseDuration(s: string): number | null {
  const unit: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }
  let total = 0, matched = false
  for (const m of s.toLowerCase().matchAll(/(\d+)\s*([smhdw])/g)) { matched = true; total += parseInt(m[1], 10) * unit[m[2]] }
  return matched && total > 0 ? total : null
}

// "12h" / "1h 30m" / "3d 4h" — compact, largest units first; for confirmations.
export function formatDuration(ms: number): string {
  const d = Math.floor(ms / 864e5), h = Math.floor(ms % 864e5 / 36e5), m = Math.floor(ms % 36e5 / 6e4)
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '<1m'
}

// Absolute fire time in UTC, e.g. "Jun 8, 01:30 UTC" — unambiguous regardless of timezone.
export function fmtWhen(at: number): string {
  return new Date(at).toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) + ' UTC'
}
