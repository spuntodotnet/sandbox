#!/usr/bin/env bash
# Install this tree (npm run build) on the machine of scripts/up.sh, and open a shell there:
#   scripts/try.sh            build, copy, install, then `ssh`
#   scripts/try.sh -- <cmd>   the same, then run <cmd> on it (as root)
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT=${FC_E2E_PROJECT:-mythic-emissary-382620}
ZONE=${FC_E2E_ZONE:-europe-west1-b}
NAME=${FC_E2E_VM:-sbx-e2e-${WORKER_SLUG:-local}}; NAME=${NAME:0:60}
IP=$(gcloud --project="$PROJECT" compute instances describe "$NAME" --zone="$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')
KEY=$HOME/.ssh/google_compute_engine
[ -f "$KEY" ] || gcloud --project="$PROJECT" compute ssh "$NAME" --zone="$ZONE" --quiet --command=true >/dev/null
SSH="ssh -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ServerAliveInterval=15 $(whoami)@$IP"
$SSH true 2>/dev/null || gcloud --project="$PROJECT" compute ssh "$NAME" --zone="$ZONE" --quiet --command=true >/dev/null
echo "› $NAME ($IP): waiting for ZFS"
until $SSH 'test -e /run/fc-e2e-ready' 2>/dev/null; do sleep 5; done
[ "${SKIP_BUILD:-}" = 1 ] || npm run build >/dev/null
tar -czf - install.sh -C dist sandboxd.mjs sbx.mjs sbx-agent | $SSH 'rm -rf /tmp/sbx && mkdir -p /tmp/sbx && tar -xzf - -C /tmp/sbx'
$SSH 'sudo sh /tmp/sbx/install.sh --from /tmp/sbx' | tail -12
if [ "${1:-}" = -- ]; then shift; $SSH "sudo $*"; else $SSH -t; fi
