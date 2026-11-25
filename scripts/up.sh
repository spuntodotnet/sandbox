#!/usr/bin/env bash
# A throwaway GCP machine to try Spunto Sandbox on: nested virtualization, ZFS on a disk of its own
# (pool `default`). Deleted after FC_E2E_MAX_RUN (4h): a forgotten one costs nothing.
# `FC_E2E_RENEW=1 up.sh` stops and starts it again (4 more hours, a new IP).
# Then scripts/try.sh installs this tree on it (docs: Contributing → On a real machine).
set -euo pipefail
PROJECT=${FC_E2E_PROJECT:-mythic-emissary-382620}
ZONE=${FC_E2E_ZONE:-europe-west1-b}
NAME=${FC_E2E_VM:-sbx-e2e-${WORKER_SLUG:-local}}; NAME=${NAME:0:60}
TYPE=${FC_E2E_MACHINE_TYPE:-n2-standard-8}
G="gcloud --project=$PROJECT"

if ! $G compute instances describe "$NAME" --zone="$ZONE" >/dev/null 2>&1; then
  $G compute instances create "$NAME" --zone="$ZONE" --machine-type="$TYPE" \
    --enable-nested-virtualization --min-cpu-platform="Intel Cascade Lake" \
    --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
    --boot-disk-size=50GB --boot-disk-type=pd-ssd \
    --create-disk=name="$NAME-zfs",size=${FC_E2E_POOL_GB:-100}GB,type=pd-ssd,auto-delete=yes,device-name=zfs \
    --max-run-duration=${FC_E2E_MAX_RUN:-4h} --instance-termination-action=DELETE \
    --labels=purpose=sbx-e2e \
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
