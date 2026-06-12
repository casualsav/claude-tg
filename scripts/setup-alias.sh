#!/usr/bin/env bash
# One-time convenience: add the Telegram-bridge launchers to the user's shell rc. Mode-aware
# (default off-MCP, the recommended mode):
#   off-mcp -> a shell FUNCTION that takes an optional instance slot (default 1):
#                claude-tg [slot] [account] -> tmux set -p @tg_bridge <slot> ; [CLAUDE_CONFIG_DIR=~/.claude-<account>] claude --allow-dangerously-skip-permissions
#              The `@tg_bridge <slot>` tmux PANE option is the daemon's adopt marker (decoupled from
#              claude's args). `claude-tg` = slot 1 (the default bridge); `claude-tg 2` routes to a
#              second bridge (its own state dir/token, see /telegram:configure 2). --allow-… starts
#              in a normal mode (prompts relay to Telegram), bypass switchable on demand from /mode.
#   mcp     -> a single alias that loads the channel as a dev plugin (no pane marker needed — MCP
#              sessions register over the socket).
#
# Idempotent — re-running replaces the block in place. Run from the repo root:
#   bash scripts/setup-alias.sh [off-mcp|mcp]
set -euo pipefail

MODE="${1:-off-mcp}"
COMMENT="# pocket-claude: Telegram-bridged Claude Code launchers (${MODE})"

case "$MODE" in
  off-mcp)
    read -r -d '' DEFS <<'EOF' || true
claude-tg()   { tmux set -p @tg_bridge "${1:-1}" 2>/dev/null; if [ -n "$2" ]; then CLAUDE_CONFIG_DIR="$HOME/.claude-$2" claude --allow-dangerously-skip-permissions; else claude --allow-dangerously-skip-permissions; fi; }
EOF
    ;;
  mcp)
    read -r -d '' DEFS <<'EOF' || true
alias claude-tg='claude --dangerously-load-development-channels plugin:telegram@pocket-claude --dangerously-skip-permissions'
EOF
    ;;
  *) echo "usage: setup-alias.sh [off-mcp|mcp]  (default: off-mcp)" >&2; exit 2 ;;
esac

# Pick the rc file for the current login shell, falling back to bash.
case "${SHELL:-}" in
  *zsh) RC="${HOME}/.zshrc" ;;
  *)    RC="${HOME}/.bashrc" ;;
esac

# Drop any prior block we wrote (our comment + the claude-tg/claude-yolo defs, alias or function
# form) so re-runs / mode switches replace cleanly, then append the fresh block.
if [ -f "$RC" ]; then
  tmp=$(mktemp)
  grep -vE '^# pocket-claude: (launch|Telegram-bridged)|^claude-tg\(\)|^claude-yolo\(\)|^alias claude-tg=|^alias claude-yolo=' "$RC" > "$tmp" || true
  cat "$tmp" > "$RC"
  rm -f "$tmp"
fi

{ echo ""; echo "$COMMENT"; printf '%s\n' "$DEFS"; } >> "$RC"

echo "✓ Wrote the ${MODE} launchers to ${RC}"
echo "  Reload your shell or run:  source ${RC}"
if [ "$MODE" = off-mcp ]; then
  echo "  Launch:  claude-tg        (default bridge, slot 1)"
  echo "           claude-tg 2      (second bridge — configure it first: /telegram:configure 2 <token>)"
else
  echo "  Launch:  claude-tg"
fi
