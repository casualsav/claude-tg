#!/usr/bin/env bash
# One-time convenience: add a `claude-tg` alias that launches Claude Code with
# this custom Telegram channel loaded (it isn't on the approved allowlist, so it
# needs the development flag) and per-tool permission prompts skipped.
#
# Idempotent — safe to run more than once. Run from the repo root:
#   bash scripts/setup-alias.sh
set -euo pipefail

ALIAS_NAME="claude-tg"
ALIAS_CMD="claude --dangerously-load-development-channels plugin:telegram@better-claude-plugins --dangerously-skip-permissions"
ALIAS_LINE="alias ${ALIAS_NAME}='${ALIAS_CMD}'"

# Pick the rc file for the current login shell, falling back to bash.
case "${SHELL:-}" in
  *zsh)  RC="${HOME}/.zshrc" ;;
  *bash) RC="${HOME}/.bashrc" ;;
  *)     RC="${HOME}/.bashrc" ;;
esac

if [ -f "$RC" ] && grep -qF "alias ${ALIAS_NAME}=" "$RC"; then
  echo "✓ '${ALIAS_NAME}' alias already present in ${RC} — nothing to do."
  exit 0
fi

{
  echo ""
  echo "# better-claude-telegram: launch Claude Code with the Telegram channel"
  echo "$ALIAS_LINE"
} >> "$RC"

echo "✓ Added '${ALIAS_NAME}' alias to ${RC}"
echo "  Reload your shell or run:  source ${RC}"
echo "  Then launch with:          ${ALIAS_NAME}"
