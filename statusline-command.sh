#!/usr/bin/env bash
# Claude Code status line — 3-line layout
# Receives session JSON on stdin; requires jq (degrades gracefully without it)

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

# progress_bar <used_pct_float> <bar_width>
# Prints e.g.  [████████░░░░░░░░]
progress_bar() {
  local pct="${1:-0}"
  local width="${2:-16}"
  local filled
  filled=$(printf '%.0f' "$(echo "$pct $width" | awk '{printf "%f", ($1/100)*$2}')")
  [ "$filled" -gt "$width" ] && filled=$width
  [ "$filled" -lt 0 ] && filled=0
  local empty=$(( width - filled ))
  local bar=""
  local i
  for (( i=0; i<filled; i++ )); do bar="${bar}█"; done
  for (( i=0; i<empty;  i++ )); do bar="${bar}░"; done
  printf '%s' "$bar"
}

# fmt_tokens <number>   →  "42.3k" or "1.2M" or raw if small
fmt_tokens() {
  local n="${1:-0}"
  awk -v n="$n" 'BEGIN {
    if (n >= 1000000) printf "%.1fM", n/1000000
    else if (n >= 1000) printf "%.1fk", n/1000
    else printf "%d", n
  }'
}

# fmt_duration <milliseconds>  →  "45s" / "1m23s" / "2h05m"
fmt_duration() {
  local ms="${1:-0}"
  awk -v ms="$ms" 'BEGIN {
    s = int(ms/1000)
    if (s >= 3600) printf "%dh%02dm", s/3600, (s%3600)/60
    else if (s >= 60) printf "%dm%02ds", s/60, s%60
    else printf "%ds", s
  }'
}

# fmt_reset <unix_ts>  →  "1h30m" / "55h33m" / "12m"  (time until reset)
fmt_reset() {
  local diff=$(( ${1:-0} - $(date +%s) ))
  [ "$diff" -lt 0 ] && diff=0
  local h=$(( diff / 3600 )) m=$(( (diff % 3600) / 60 ))
  if [ "$h" -gt 0 ]; then printf '%dh%02dm' "$h" "$m"; else printf '%dm' "$m"; fi
}

# bar_color <pct_int>  →  green <50 · yellow <80 · red >=80
bar_color() {
  if   [ "${1:-0}" -ge 80 ]; then printf '%s' "$RED"
  elif [ "${1:-0}" -ge 50 ]; then printf '%s' "$YELLOW"
  else                            printf '%s' "$GREEN"
  fi
}

# ---------------------------------------------------------------------------
# read + parse input
# ---------------------------------------------------------------------------
# No jq dependency: python3 reads the session JSON once and emits shell-quoted
# assignments for every field we render. One process per draw, and a clean
# degrade to a bare user@host:cwd line if python3 is missing or JSON is bad.
input=$(cat)

# Mirror the rate-limit data to a file the telegram daemon reads as its authoritative
# usage source (path tracks common.ts STATE_DIR). Best-effort; never blocks the draw.
usage_file="${TELEGRAM_STATE_DIR:-$HOME/.claude/channels/telegram}/usage.json"

parsed=$(STATUSLINE_JSON="$input" TELEGRAM_USAGE_FILE="$usage_file" python3 - 2>/dev/null <<'PY'
import os, sys, json, shlex
try:
    d = json.loads(os.environ.get("STATUSLINE_JSON") or "{}")
except Exception:
    sys.exit(1)

def g(*path, default=""):
    cur = d
    for k in path:
        if isinstance(cur, dict) and cur.get(k) is not None:
            cur = cur[k]
        else:
            return default
    return cur

owner, name = g("workspace", "repo", "owner"), g("workspace", "repo", "name")
fields = {
    "cwd":             g("cwd"),
    "model_name":      g("model", "display_name", default="unknown model"),
    "version":         g("version"),
    "session_name":    g("session_name"),
    "git_repo":        f"{owner}/{name}" if owner and name else "",
    "git_worktree":    g("workspace", "git_worktree"),
    "worktree_branch": g("worktree", "branch"),
    "agent_name":      g("agent", "name"),
    "vim_mode":        g("vim", "mode"),
    "used_pct":        g("context_window", "used_percentage"),
    "ctx_size":        g("context_window", "context_window_size", default=0),
    "total_in":        g("context_window", "total_input_tokens", default=0),
    "total_out":       g("context_window", "total_output_tokens", default=0),
    "cost_usd":        g("cost", "total_cost_usd"),
    "dur_ms":          g("cost", "total_duration_ms"),
    "api_ms":          g("cost", "total_api_duration_ms"),
    "lines_added":     g("cost", "total_lines_added", default=0),
    "lines_removed":   g("cost", "total_lines_removed", default=0),
    "output_style":    g("output_style", "name"),
    "effort_level":    g("effort", "level"),
    "thinking":        "true" if g("thinking", "enabled") is True else "",
    "rate_5h_pct":     g("rate_limits", "five_hour", "used_percentage"),
    "rate_5h_reset":   g("rate_limits", "five_hour", "resets_at"),
    "rate_7d_pct":     g("rate_limits", "seven_day", "used_percentage"),
    "rate_7d_reset":   g("rate_limits", "seven_day", "resets_at"),
    "pr_number":       g("pr", "number"),
    "pr_state":        g("pr", "review_state"),
}
# Mirror the account-wide rate limits for the telegram daemon: exact 5h/7d used% +
# reset epochs, written atomically. Account-global, so any session's draw is fine.
try:
    uf = os.environ.get("TELEGRAM_USAGE_FILE")
    if uf:
        import time, tempfile
        def _num(x):
            try: return float(x)
            except (TypeError, ValueError): return None
        def _win(period):
            pct = _num(g("rate_limits", period, "used_percentage"))
            if pct is None: return None
            ra = _num(g("rate_limits", period, "resets_at"))
            return {"pct": pct, "resets_at": int(ra) if ra is not None else None}
        snap, fh, sd = {"ts": int(time.time())}, _win("five_hour"), _win("seven_day")
        if fh: snap["five_hour"] = fh
        if sd: snap["seven_day"] = sd
        if fh or sd:
            d = os.path.dirname(uf) or "."
            fd, tmp = tempfile.mkstemp(dir=d, prefix=".usage-")
            with os.fdopen(fd, "w") as f:
                json.dump(snap, f)
            os.chmod(tmp, 0o600)
            os.replace(tmp, uf)
except Exception:
    pass

for k, v in fields.items():
    print(f"{k}={shlex.quote(str(v))}")
PY
)

if [ -z "$parsed" ]; then
  # python3 unavailable or unparseable input: bare fallback
  printf '\033[01;32m%s@%s\033[00m:\033[01;34m%s\033[00m\n' "$(whoami)" "$(hostname -s)" "$(pwd)"
  exit 0
fi
eval "$parsed"

# fall back to live pwd when the payload omits cwd
[ -n "$cwd" ] || cwd=$(pwd)

# current branch: prefer the worktree branch from the payload, else ask git
branch="$worktree_branch"
[ -n "$branch" ] || branch=$(git -C "$cwd" branch --show-current 2>/dev/null)

# ---------------------------------------------------------------------------
# colors
# ---------------------------------------------------------------------------
R=$'\033[0m'       # reset
BOLD=$'\033[1m'
GREEN=$'\033[01;32m'
BLUE=$'\033[01;34m'
YELLOW=$'\033[00;33m'
CYAN=$'\033[00;36m'
MAGENTA=$'\033[00;35m'
RED=$'\033[00;31m'
DIM=$'\033[02m'
WHITE=$'\033[00;37m'

# emit <parts...>  — print segments joined by a dim " | " separator, then newline
emit() {
  local sep=" ${DIM}|${R} " out="" p
  for p in "$@"; do
    [ -z "$out" ] && out="$p" || out="${out}${sep}${p}"
  done
  printf '%s\n' "$out"
}

# ---------------------------------------------------------------------------
# LINE 1 — identity & mode:  user@host:cwd (branch) | repo | Model | ε:effort | ✻think
# ---------------------------------------------------------------------------
ident="${GREEN}$(whoami)@$(hostname -s)${R}:${BLUE}${cwd}${R}"
[ -n "$branch" ] && ident="${ident} ${MAGENTA}(${branch})${R}"

l1=("$ident")
[ -n "$git_repo" ]     && l1+=("${DIM}${git_repo}${R}")
l1+=("${YELLOW}${model_name}${R}")
[ -n "$effort_level" ] && l1+=("${DIM}ε:${R}${CYAN}${effort_level}${R}")
[ "$thinking" = "true" ] && l1+=("${MAGENTA}✻think${R}")
[ -n "$vim_mode" ]     && l1+=("${YELLOW}⌨${vim_mode}${R}")
[ -n "$agent_name" ]   && l1+=("${CYAN}⛭${agent_name}${R}")
emit "${l1[@]}"

# ---------------------------------------------------------------------------
# LINE 2 — session usage:  ctx bar | ↑in ↓out | $cost | ⧗time | api | +/-lines | PR | session | version
# ---------------------------------------------------------------------------
l2=()
if [ -n "$used_pct" ] && [ "$ctx_size" -gt 0 ] 2>/dev/null; then
  used_int=$(printf '%.0f' "$used_pct")
  bar=$(progress_bar "$used_pct" 10)
  l2+=("${DIM}ctx${R} $(bar_color "$used_int")${bar}${R} ${used_int}%/$(( ctx_size / 1000 ))k")
fi
[ -n "$used_pct" ] && [ "$ctx_size" -gt 0 ] 2>/dev/null && \
  l2+=("${DIM}↑${R}$(fmt_tokens "$total_in") ${DIM}↓${R}$(fmt_tokens "$total_out")")
[ -n "$cost_usd" ]  && l2+=("${GREEN}\$$(printf '%.4f' "$cost_usd")${R}")
[ -n "$dur_ms" ]    && l2+=("${DIM}⧗${R}$(fmt_duration "$dur_ms")")
[ -n "$api_ms" ]    && l2+=("${DIM}api${R} $(fmt_duration "$api_ms")")
if [ "$lines_added" -gt 0 ] 2>/dev/null || [ "$lines_removed" -gt 0 ] 2>/dev/null; then
  l2+=("${GREEN}+${lines_added}${R} ${RED}-${lines_removed}${R}")
fi
if [ -n "$pr_number" ]; then
  case "$pr_state" in
    approved)          pr_color="$GREEN"  ;;
    changes_requested) pr_color="$RED"    ;;
    draft)             pr_color="$DIM"    ;;
    *)                 pr_color="$YELLOW" ;;
  esac
  l2+=("${pr_color}PR #${pr_number}${R}")
fi
[ -n "$session_name" ] && l2+=("${CYAN}${session_name}${R}")
[ -n "$version" ]      && l2+=("${DIM}v${version}${R}")
[ "${#l2[@]}" -gt 0 ] && emit "${l2[@]}"

# ---------------------------------------------------------------------------
# LINE 3 — rate-limit budget bars (Claude.ai Pro/Max only; hidden otherwise)
#   5h ███░░░░░░░░░░░ 24% ↻1h30m | 7d ████████████░░ 88% ↻55h33m
# ---------------------------------------------------------------------------
l3=()
if [ -n "$rate_5h_pct" ]; then
  pct_int=$(printf '%.0f' "$rate_5h_pct")
  bar=$(progress_bar "$rate_5h_pct" 14)
  seg="${DIM}5h${R} $(bar_color "$pct_int")${bar}${R} ${pct_int}%"
  [ -n "$rate_5h_reset" ] && seg="${seg} ${DIM}↻${R}$(fmt_reset "$rate_5h_reset")"
  l3+=("$seg")
fi
if [ -n "$rate_7d_pct" ]; then
  pct_int=$(printf '%.0f' "$rate_7d_pct")
  bar=$(progress_bar "$rate_7d_pct" 14)
  seg="${DIM}7d${R} $(bar_color "$pct_int")${bar}${R} ${pct_int}%"
  [ -n "$rate_7d_reset" ] && seg="${seg} ${DIM}↻${R}$(fmt_reset "$rate_7d_reset")"
  l3+=("$seg")
fi
[ "${#l3[@]}" -gt 0 ] && emit "${l3[@]}"

exit 0
