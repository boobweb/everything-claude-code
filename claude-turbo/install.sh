#!/usr/bin/env bash
# Turbo for Claude Code — macOS / Linux installer wrapper.
#   ./install.sh                 install or update
#   ./install.sh --uninstall
#   ./install.sh --with-playwright   (also installs the headless browser for /turbo:smoke)
#   ./install.sh --no-permissions    (do not touch ~/.claude/settings.json)
set -euo pipefail
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but was not found on PATH. Install the LTS from https://nodejs.org (or your package manager) and re-run."
  exit 1
fi
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/install.js" "$@"
