#!/usr/bin/env bash
# Bootstrap for the off-MCP Telegram bridge. The setup wizard runs under bun, so this thin
# shell entrypoint exists only to: ensure bun is present (chicken-and-egg — can't run bun
# setup.ts without bun), fetch/refresh the repo, then hand off to the wizard.
#
#   curl -fsSL https://raw.githubusercontent.com/casualsav/pocket-claude/main/install.sh | bash
#
# Overridable: PC_DIR (clone location), PC_REPO (git URL).
set -euo pipefail

REPO_URL="${PC_REPO:-https://github.com/casualsav/pocket-claude}"
DEST="${PC_DIR:-$HOME/.pocket-claude}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }

# 1. Ensure bun (installs into ~/.bun — no root).
if ! command -v bun >/dev/null 2>&1; then
  say "Installing bun…"
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi
command -v bun >/dev/null 2>&1 || { echo "bun install failed — install it manually from https://bun.sh and re-run." >&2; exit 1; }

# 2. Ensure git (needed to fetch the repo; the wizard handles tmux/python itself).
command -v git >/dev/null 2>&1 || { echo "git is required to fetch the installer — install git and re-run." >&2; exit 1; }

# 3. Fetch or refresh the repo.
if [ -d "$DEST/.git" ]; then
  say "Updating $DEST…"
  git -C "$DEST" pull --ff-only --quiet || say "(couldn't fast-forward — using the existing checkout)"
else
  say "Cloning into $DEST…"
  git clone --depth 1 "$REPO_URL" "$DEST"
fi

# 4. Install deps and hand off to the wizard (interactive — needs a TTY).
cd "$DEST"
bun install --no-summary
say "Launching the setup wizard…"
# The wizard is interactive. When this script is piped (`curl … | bash`), our stdin is the
# script pipe, not the terminal — so reattach it to the controlling tty for the prompts.
if [ -t 0 ]; then
  exec bun setup.ts
elif [ -e /dev/tty ]; then
  exec bun setup.ts < /dev/tty
else
  echo "No interactive terminal available. Re-run with:  bash <(curl -fsSL $REPO_URL/raw/main/install.sh)" >&2
  exit 1
fi
