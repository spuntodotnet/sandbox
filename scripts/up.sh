#!/usr/bin/env bash
# Une machine GCP jetable pour la suite e2e du mode natif (RFC 0039) : virtualisation imbriquée,
# ZFS sur un disque à part (pool `default`, donc SPUNTO_FC_DATASET=default/spunto par défaut).
# Autodétruite au bout de FC_E2E_MAX_RUN (4h) : un oubli ne coûte rien. Le minuteur repart à chaque
# démarrage : `FC_E2E_RENEW=1 up.sh` l'arrête et la redémarre (4 h de plus), puis relancer connect.sh.
# → docs/testing.md § Suite firecracker
set -euo pipefail
PROJECT=${FC_E2E_PROJECT:-mythic-emissary-382620}
ZONE=${FC_E2E_ZONE:-europe-west1-b}
NAME=${FC_E2E_VM:-fc-e2e-${WORKER_SLUG:-local}}; NAME=${NAME:0:60}
TYPE=${FC_E2E_MACHINE_TYPE:-n2-standard-8}
G="gcloud --project=$PROJECT"

if ! $G compute instances describe "$NAME" --zone="$ZONE" >/dev/null 2>&1; then
  $G compute instances create "$NAME" --zone="$ZONE" --machine-type="$TYPE" \
    --enable-nested-virtualization --min-cpu-platform="Intel Cascade Lake" \
    --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
    --boot-disk-size=50GB --boot-disk-type=pd-ssd \
    --create-disk=name="$NAME-zfs",size=${FC_E2E_POOL_GB:-100}GB,type=pd-ssd,auto-delete=yes,device-name=zfs \
    --max-run-duration=${FC_E2E_MAX_RUN:-4h} --instance-termination-action=DELETE \
    --labels=purpose=fc-e2e \
    --metadata=startup-script='#!/bin/sh
command -v zfs >/dev/null || { apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -yq zfsutils-linux zstd; }
zpool list default >/dev/null 2>&1 || zpool import default 2>/dev/null || zpool create -f -o ashift=12 default /dev/disk/by-id/google-zfs
modprobe kvm_intel; chmod 666 /dev/kvm
touch /run/fc-e2e-ready'
elif [ "${FC_E2E_RENEW:-}" = 1 ]; then
  $G compute instances stop "$NAME" --zone="$ZONE" --quiet
  $G compute instances start "$NAME" --zone="$ZONE" --quiet
fi
echo "$NAME $ZONE"
