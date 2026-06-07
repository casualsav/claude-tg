#!/usr/bin/env bash
# One-time convenience: add a `claude-tg` alias for launching a Telegram-bridged
# Claude Code session. Mode-aware (default off-MCP, the recommended mode):
#   off-mcp  ->  claude --strict-mcp-config
#                (no per-request MCP tax; the daemon drives the session's tmux pane)
#   mcp      ->  claude --dangerously-load-development-channels plugin:telegram@better-claude-plugins --dangerously-skip-permissions
#
# Idempotent — re-running updates the alias in place if the mode changed. Run from the repo root:
#   bash scripts/setup-alias.sh [off-mcp|mcp]
set -euo pipefail

MODE="${1:-off-mcp}"
ALIAS_NAME="claude-tg"
case "$MODE" in
  off-mcp) ALIAS_CMD="claude --strict-mcp-config" ;;
  mcp)     ALIAS_CMD="claude --dangerously-load-development-channels plugin:telegram@better-claude-plugins --dangerously-skip-permissions" ;;
  *)       echo "usage: setup-alias.sh [off-mcp|mcp]  (default: off-mcp)" >&2; exit 2 ;;
esac
ALIAS_LINE="alias ${ALIAS_NAME}='${ALIAS_CMD}'"
COMMENT="# better-claude-telegram: launch a Telegram-bridged Claude Code session (${MODE})"

# Pick the rc file for the current login shell, falling back to bash.
case "${SHELL:-}" in
  *zsh) RC="${HOME}/.zshrc" ;;
  *)    RC="${HOME}/.bashrc" ;;
esac

if [ -f "$RC" ] && grep -qF "alias ${ALIAS_NAME}=" "$RC"; then
  if grep -qF "$ALIAS_LINE" "$RC"; then
    echo "✓ '${ALIAS_NAME}' (${MODE}) already present in ${RC} — nothing to do."
    exit 0
  fi
  # An alias is there but for the other mode — drop our old lines and re-add fresh.
  tmp=$(mktemp)
  grep -vE "alias ${ALIAS_NAME}=|^# better-claude-telegram: launch" "$RC" > "$tmp"
  { echo "$COMMENT"; echo "$ALIAS_LINE"; } >> "$tmp"
  cat "$tmp" > "$RC"
  rm -f "$tmp"
  echo "✓ Updated '${ALIAS_NAME}' alias in ${RC} to ${MODE} mode."
  echo "  Reload your shell or run:  source ${RC}"
  exit 0
fi

{
  echo ""
  echo "$COMMENT"
  echo "$ALIAS_LINE"
} >> "$RC"

echo "✓ Added '${ALIAS_NAME}' alias (${MODE}) to ${RC}"
echo "  Reload your shell or run:  source ${RC}"
echo "  Then launch with:          ${ALIAS_NAME}"
