#!/usr/bin/env bash
# A fresh Spunto worker (postCreateCommand of the Spunto project « Spunto Sandbox »): the repository's and the docs
# site's dependencies, Go for the guest agent (`npm run build`, the agent's tests), and process-compose (which runs
# the docs site: scripts/start.sh). Safe to run again.
#   bash scripts/init.sh
set -euo pipefail
cd "$(dirname "$0")/.."
echo "▸ Spunto Sandbox: installing ($(pwd))"
npm ci --no-audit --no-fund
npm --prefix docs ci --no-audit --no-fund

# Go, the version guest/go.mod asks for, in ~/.local/go (the image has none)
GO=$(awk '/^go /{print $2; exit}' guest/go.mod)
[ "${GO//[^.]}" = . ] && GO=$GO.0                 # `go 1.24` in go.mod, go1.24.0 on go.dev
if ! command -v go >/dev/null 2>&1 && [ ! -x "$HOME/.local/go/bin/go" ]; then
  echo "▸ Go $GO"
  mkdir -p "$HOME/.local"
  curl -fsSL --retry 5 "https://go.dev/dl/go$GO.linux-amd64.tar.gz" | tar -xz -C "$HOME/.local"
fi
grep -qs '.local/go/bin' "$HOME/.bashrc" || echo 'export PATH="$HOME/.local/go/bin:$PATH"' >> "$HOME/.bashrc"
grep -qs '.local/go/bin' "$HOME/.zshrc" 2>/dev/null || [ ! -f "$HOME/.zshrc" ] || echo 'export PATH="$HOME/.local/go/bin:$PATH"' >> "$HOME/.zshrc"

scripts/pc version >/dev/null                # installs process-compose if missing
echo "▸ Spunto Sandbox installed. Start: bash scripts/start.sh"
