// Duration parsing/formatting helpers. Pure and importable; used by the scheduler and by
// the usage-reset and session-list rendering in daemon.ts.

// "12h" "1h30m" "90s" "2d" "1w" → ms (sum of every unit chunk), or null if nothing parsed.
export function parseDuration(s: string): number | null {
  const unit: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }
  let total = 0, matched = false
  for (const m of s.toLowerCase().matchAll(/(\d+)\s*([smhdw])/g)) { matched = true; total += parseInt(m[1], 10) * unit[m[2]] }
  return matched && total > 0 ? total : null
}

// Split a leading duration off a string: the contiguous run of duration units at the start, and
// the remaining text. "2h" → { ms, rest: '' }; "2h ping the server" → { ms, rest: 'ping the
// server' }; "do X" → { ms: null, rest: 'do X' }. Powers the one-shot `/schedule <time> <msg>`.
export function splitLeadingDuration(s: string): { ms: number | null; rest: string } {
  const m = s.match(/^((?:\d+\s*[smhdw]\s*)+)(.*)$/is)
  if (!m) return { ms: null, rest: s.trim() }
  return { ms: parseDuration(m[1]), rest: m[2].trim() }
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

// ---- Recurring schedules (ROADMAP #11) ----

export type Recurrence =
  | { kind: 'daily' | 'weekdays' | 'weekly'; hh: number; mm: number; dow?: number; tz: string }
  | { kind: 'cron'; expr: string; tz: string }

// What a UTC instant reads as on the wall clock of `tz`.
function wallParts(tz: string, utcMs: number): { y: number; m: number; d: number; hh: number; mm: number; ss: number; dow: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hour12: false,
  })
  const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map(x => [x.type, x.value]))
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour % 24, mm: +p.minute, ss: +p.second, dow }
}

function tzOffsetMs(tz: string, utcMs: number): number {
  const w = wallParts(tz, utcMs)
  return Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss) - Math.floor(utcMs / 1000) * 1000
}

// Wall-clock y-m-d hh:mm in `tz` → UTC ms. Two-pass so a DST jump between the guess and the
// true offset converges; times inside a spring-forward gap land an hour late, which is fine.
function zonedToUtc(tz: string, y: number, m: number, d: number, hh: number, mm: number): number {
  let utc = Date.UTC(y, m - 1, d, hh, mm)
  for (let i = 0; i < 2; i++) utc = Date.UTC(y, m - 1, d, hh, mm) - tzOffsetMs(tz, utc)
  return utc
}

// Next fire time strictly after `after` for a recurrence, on `tz`'s wall clock.
export function nextRecurrence(r: Recurrence, after: number): number {
  if (r.kind === 'cron') return nextCron(r.expr, after, r.tz) ?? after + 864e5
  for (let i = 0; i < 10; i++) {
    const day = wallParts(r.tz, after + i * 864e5)
    const cand = zonedToUtc(r.tz, day.y, day.m, day.d, r.hh, r.mm)
    if (cand <= after) continue
    const dow = wallParts(r.tz, cand).dow
    if (r.kind === 'weekdays' && (dow === 0 || dow === 6)) continue
    if (r.kind === 'weekly' && dow !== (r.dow ?? 1)) continue
    return cand
  }
  return after + 864e5   // unreachable; safe fallback
}

// "daily 09:00" / "weekdays 09:00" / "Mon 09:00" / "cron */15 9-17 * * 1-5" — for listings.
export function recurrenceLabel(r: Recurrence): string {
  if (r.kind === 'cron') return describeCron(r.expr)
  const t = `${String(r.hh).padStart(2, '0')}:${String(r.mm).padStart(2, '0')}`
  if (r.kind === 'daily') return `daily ${t}`
  if (r.kind === 'weekdays') return `weekdays ${t}`
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][r.dow ?? 1]} ${t}`
}

// ---- Cron expressions (the /cron grammar) ----
// Standard 5 fields: minute hour day-of-month month day-of-week. Supports *, numbers, ranges
// (a-b), steps (*/n, a-b/n), lists (a,b,c), and 3-letter names for month/dow. dow 0 or 7 = Sun.
type CronFields = { mins: number[]; hours: number[]; dom: Set<number>; mon: Set<number>; dow: Set<number>; domAll: boolean; dowAll: boolean }

const MON_NAMES: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const DOW_NAMES_CRON: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

function parseCronField(field: string, min: number, max: number, names?: Record<string, number>): number[] | null {
  const out = new Set<number>()
  const resolve = (tok: string): number | null => {
    if (names && tok.toLowerCase() in names) return names[tok.toLowerCase()]
    if (!/^\d+$/.test(tok)) return null
    let n = parseInt(tok, 10)
    if (max === 6 && n === 7) n = 0   // dow: 7 = Sunday
    return n >= min && n <= max ? n : null
  }
  for (const part of field.split(',')) {
    const m = /^(\*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/(\d+))?$/.exec(part)
    if (!m) return null
    const step = m[2] ? parseInt(m[2], 10) : 1
    if (step < 1) return null
    let lo = min, hi = max
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-')
      const av = resolve(a); if (av === null) return null
      const bv = b !== undefined ? resolve(b) : (m[2] ? max : av)   // "a/n" = from a to max; bare "a" = just a
      if (bv === null) return null
      lo = av; hi = bv
      if (lo > hi) return null
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out.size ? [...out].sort((a, b) => a - b) : null
}

// Parse a 5-field expression; null = invalid.
export function parseCron(expr: string): CronFields | null {
  const f = expr.trim().split(/\s+/)
  if (f.length !== 5) return null
  const mins = parseCronField(f[0], 0, 59)
  const hours = parseCronField(f[1], 0, 23)
  const dom = parseCronField(f[2], 1, 31)
  const mon = parseCronField(f[3], 1, 12, MON_NAMES)
  const dow = parseCronField(f[4], 0, 6, DOW_NAMES_CRON)
  if (!mins || !hours || !dom || !mon || !dow) return null
  return { mins, hours, dom: new Set(dom), mon: new Set(mon), dow: new Set(dow), domAll: f[2] === '*', dowAll: f[4] === '*' }
}

// Next fire strictly after `after`, on `tz`'s wall clock; null = invalid expr or no fire within
// ~13 months (e.g. Feb 30). Walks days (cheap: one Intl read per day), then allowed hh:mm pairs.
// Standard cron day rule: dom and dow both restricted → match on EITHER.
export function nextCron(expr: string, after: number, tz: string): number | null {
  const c = parseCron(expr)
  if (!c) return null
  for (let d = 0; d < 400; d++) {
    const w = wallParts(tz, after + d * 864e5)
    if (!c.mon.has(w.m)) continue
    const dayOk = c.domAll && c.dowAll ? true
      : c.domAll ? c.dow.has(w.dow)
      : c.dowAll ? c.dom.has(w.d)
      : c.dom.has(w.d) || c.dow.has(w.dow)
    if (!dayOk) continue
    for (const hh of c.hours) for (const mm of c.mins) {
      const cand = zonedToUtc(tz, w.y, w.m, w.d, hh, mm)
      if (cand > after) return cand
    }
  }
  return null
}

// Friendly-ish label for confirmations/lists: plain-words for the common shapes, raw expr otherwise.
export function describeCron(expr: string): string {
  const f = expr.trim().split(/\s+/)
  if (f.length === 5) {
    const [mi, hh, dom, mon, dow] = f
    const everyN = /^\*\/(\d+)$/.exec(mi)
    if (everyN && hh === '*' && dom === '*' && mon === '*' && dow === '*') return `every ${everyN[1]} min`
    if (/^\d+$/.test(mi) && /^\d+$/.test(hh) && dom === '*' && mon === '*') {
      const t = `${hh.padStart(2, '0')}:${mi.padStart(2, '0')}`
      if (dow === '*') return `daily ${t}`
      if (dow === '1-5' || dow.toLowerCase() === 'mon-fri') return `weekdays ${t}`
    }
  }
  return `cron ${expr}`
}
