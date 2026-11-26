#!/usr/bin/env bash
# Starts the docs site on a Spunto worker (postStartCommand of the Spunto project « Spunto Sandbox »), under a
# process-compose daemon (process-compose.yaml):
#   :3000  the BUILD, as sandbox.spunto.net serves it (static export + install.sh) — what the human who tests opens,
#          the link to give them
#   :5173  `next dev`, hot reload — for whoever iterates
# Also signs gcloud in as the `sandbox-e2e` service account when the worker has its key (GCP_SERVICE_ACCOUNT_KEY_B64,
# a secret of the project): it may only make and drop `sbx-*` machines, which is what scripts/up.sh needs.
# Safe to run again: starts nothing twice, rebuilds :3000 only if docs/ or install.sh changed, waits until it answers.
#   bash scripts/start.sh               logs: pc attach, or pc process logs <process>
#   bash scripts/start.sh --no-build    without rebuilding :3000 (serves the last build, even behind)
#   bash scripts/start.sh restart
#   bash scripts/start.sh stop
set -euo pipefail
cd "$(dirname "$0")/.."
PC=scripts/pc
sudo -n ln -sf "$PWD/scripts/pc" /usr/local/bin/pc 2>/dev/null || true

if [ -n "${GCP_SERVICE_ACCOUNT_KEY_B64:-}" ] && command -v gcloud >/dev/null 2>&1; then
  account=$(printf '%s' "$GCP_SERVICE_ACCOUNT_KEY_B64" | base64 -d | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).client_email))')
  if [ "$(gcloud config get-value account 2>/dev/null)" != "$account" ]; then
    key=$(mktemp)
    printf '%s' "$GCP_SERVICE_ACCOUNT_KEY_B64" | base64 -d > "$key"
    gcloud auth activate-service-account --key-file="$key" --project=mythic-emissary-382620 >/dev/null 2>&1 \
      && echo "▸ gcloud: $account" || echo "⚠ gcloud: sign-in as $account failed" >&2
    shred -u "$key" 2>/dev/null || rm -f "$key"
  fi
fi

up() { "$PC" process list >/dev/null 2>&1; }
ready() {
  "$PC" process list -o json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { process.exit(JSON.parse(s).every((p) => !p.has_ready_probe || p.is_ready === "Ready") ? 0 : 1) }
      catch { process.exit(1) }
    })'
}
PORTS=(3000 5173)
busy() { for port in "${PORTS[@]}"; do (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null && return 0; done; return 1; }
# `pc down` returns before the processes are gone: wait for the ports
down() { if up; then "$PC" down >/dev/null; fi; for _ in $(seq 1 15); do busy || break; sleep 1; done; }

BUILD=1
case "${1:-start}" in
  stop) down; echo "▸ Spunto Sandbox stopped"; exit 0 ;;
  restart) down ;;
  start) ;;
  --no-build) BUILD=0 ;;
  *) echo "usage: bash scripts/start.sh [start|restart|stop|--no-build]" >&2; exit 2 ;;
esac

[ -d docs/node_modules ] && [ -d node_modules ] || bash scripts/init.sh

# The CONTENT of what git tracks in the sources (committed, modified or new and not ignored), not their dates.
fingerprint() {
  { git ls-tree -r HEAD -- "$@"; git diff HEAD -- "$@"
    git ls-files -o --exclude-standard -z -- "$@" | xargs -0r sha1sum; } | sha1sum | cut -c1-40
}
SOURCES=(docs install.sh)
stale() { [ "$(cat .serve/current/sources 2>/dev/null)" != "$(fingerprint "${SOURCES[@]}")" ]; }

mkdir -p .serve
if ! up; then
  for port in "${PORTS[@]}"; do fuser -k -TERM "$port/tcp" >/dev/null 2>&1 || true; done
  for _ in $(seq 1 15); do busy || break; sleep 1; done
  rm -f "$HOME/.process-compose/pc.sock"
  "$PC" up -D -f process-compose.yaml -L "$HOME/.process-compose/process-compose.log"
fi

# :3000. `next build` exports to docs/out, copied into the slot that is not served (.serve/<a|b>), then
# .serve/current swapped: the open page keeps working during the build, a failed build leaves the last one. One build
# at a time (lock), including the one scripts/catch-up.sh starts in the background.
if [ "$BUILD" = 1 ] && stale; then
  exec 9>.serve/lock
  flock 9
  if stale; then                             # another build may have finished while we waited
    slot=a; [ "$(readlink .serve/current 2>/dev/null)" = a ] && slot=b
    echo "▸ building the docs site (into .serve/$slot; the current build serves meanwhile)"
    sources="$(fingerprint "${SOURCES[@]}")"  # before: a change during the build leaves it stale
    (cd docs && npx next build >/dev/null)
    rm -rf ".serve/$slot" && mkdir -p ".serve/$slot" && cp -a docs/out ".serve/$slot/out"
    printf '%s\n' "$sources" > ".serve/$slot/sources"
    ln -sfn "$slot" .serve/current.tmp && mv -T .serve/current.tmp .serve/current
  fi
  flock -u 9
fi

for _ in $(seq 1 180); do ready && break; sleep 1; done
if ! ready; then
  echo "✗ Spunto Sandbox's docs did not start: pc attach, or pc process logs <process>" >&2
  "$PC" process list >&2 || true
  exit 1
fi
# the commit the environment matches: where scripts/catch-up.sh's diff starts
git rev-parse HEAD > "$(git rev-parse --git-path spunto-env-synced)" 2>/dev/null || true
url() { if [ -n "${WORKER_SLUG:-}" ]; then echo "https://$WORKER_SLUG-$1.${BASE_DOMAIN:-spunto.net}"; else echo "http://localhost:$1"; fi; }
[ -e .serve/current ] || echo "⚠ no build on :3000 yet: bash scripts/start.sh"
[ ! -e .serve/current ] || ! stale || echo "⚠ the build on :3000 is behind the code: bash scripts/start.sh"
echo "▸ Spunto Sandbox's docs — to test (the build): $(url 3000)/   ·   to iterate (dev): $(url 5173)/   (pc attach for logs)"
