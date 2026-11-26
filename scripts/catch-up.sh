#!/usr/bin/env bash
# Catches the code up on a stack ALREADY UP — a worker started from a snapshot, whose RAM kept the processes but whose
# code is behind (postSnapshotCommand of the Spunto project « Spunto Sandbox »). `next dev` reloads by itself: only a
# lockfile that moved needs an install (and a restart of the process), and the build on :3000 is redone in the
# background if it is behind.
#   bash scripts/catch-up.sh             moves the branch on (fast-forward to its upstream), then syncs
#   bash scripts/catch-up.sh --no-pull   syncs the environment with the checkout as it is
# The diff starts at the commit noted by the last start.sh / catch-up.sh, else at HEAD before the pull.
set -euo pipefail
cd "$(dirname "$0")/.."
PC=scripts/pc
SYNCED=$(git rev-parse --git-path spunto-env-synced)
export CATCH_UP_BASE="${CATCH_UP_BASE:-$(cat "$SYNCED" 2>/dev/null || git rev-parse HEAD)}"

if [ "${1:-}" != "--no-pull" ] && git rev-parse -q --verify '@{u}' >/dev/null; then
  git fetch -q
  git merge --ff-only --autostash -q '@{u}'
  exec bash scripts/catch-up.sh --no-pull    # this script may have changed with the pull
fi

changed=$( { git diff --name-only "$CATCH_UP_BASE"; git ls-files -o --exclude-standard; } 2>/dev/null || echo process-compose.yaml)
echo "▸ Spunto Sandbox: catching up from ${CATCH_UP_BASE:0:7} to $(git rev-parse --short HEAD) ($(echo "$changed" | grep -c . || true) files)"

up() { "$PC" process list >/dev/null 2>&1; }
if echo "$changed" | grep -qx 'package-lock.json'; then
  echo "  package-lock.json changed: npm ci"
  npm ci --no-audit --no-fund
fi
if echo "$changed" | grep -qx 'docs/package-lock.json'; then
  echo "  docs: dependencies changed, npm ci then next dev restarted"
  if up; then "$PC" process stop docs >/dev/null; fi
  npm --prefix docs ci --no-audit --no-fund
  if up; then "$PC" process start docs >/dev/null; fi
fi
if echo "$changed" | grep -qE '^(process-compose\.yaml|scripts/serve\.mjs)$'; then
  echo "  process-compose.yaml or serve.mjs changed: full restart"
  bash scripts/start.sh stop >/dev/null
fi
# Now: what is not running starts, everything answers, the commit is noted. The build of :3000 (a minute or so)
# goes to the background so the starting task does not wait: :3000 serves the previous build until the swap.
bash scripts/start.sh --no-build
mkdir -p .serve
setsid nohup bash scripts/start.sh > .serve/build.log 2>&1 < /dev/null &
echo "▸ :3000 rebuilt in the background if behind (log: .serve/build.log)"
