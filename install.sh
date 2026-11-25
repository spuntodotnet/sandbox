#!/bin/sh
# Spunto Sandbox — Firecracker microVMs on this machine.
#
#   curl -fsSL https://sandbox.spunto.net/install.sh | sudo sh
#   curl -fsSL https://sandbox.spunto.net/install.sh | sudo sh -s -- --create-pool 100G
#
# Needs Linux x86_64 with KVM (/dev/kvm), systemd, and ZFS: a pool of yours (the first one is used,
# <pool>/spunto) or, with --create-pool <size>, a pool in a file made here (a try, not a production
# setup: a real disk is faster). Installs into /opt/spunto-fc (Firecracker, its jailer, a guest
# kernel, Node) and /opt/spunto-sandbox (the daemon, the CLI, the guest agent), runs the daemon as
# the systemd service spunto-sandboxd, and puts `sbx` on the PATH. Run again to upgrade: the
# sandboxes keep running.
#
# Options (or the same in the environment):
#   --create-pool <size>    no pool yet: make one in /var/lib/spunto-sandbox/pool.img (sparse)
#   --dataset <pool/name>   SPUNTO_FC_DATASET: where everything goes (default: <first pool>/spunto)
#   --version <v>           SBX_VERSION: a release of github.com/spuntodotnet/sandbox (latest)
#   --from <dir>            SBX_FROM: a dist/ directory of yours (npm run build) instead of a release
#   --memory <size>         SBX_MEMORY: what the sandboxes may take together (default: RAM − 2 GB)
set -eu

FC_VERSION=v1.17.0
NODE_VERSION=v24.11.1
REPO=spuntodotnet/sandbox
O=/opt/spunto-fc
APP=/opt/spunto-sandbox
ETC=/etc/spunto-sandbox

say() { printf '\033[1m›\033[0m %s\n' "$*"; }
die() { printf 'spunto-sandbox: %s\n' "$*" >&2; exit 1; }

CREATE_POOL=${SBX_CREATE_POOL:-}
DATASET=${SPUNTO_FC_DATASET:-}
VERSION=${SBX_VERSION:-latest}
FROM=${SBX_FROM:-}
MEMORY=${SBX_MEMORY:-}
while [ $# -gt 0 ]; do
  case "$1" in
    --create-pool) CREATE_POOL=$2; shift 2 ;;
    --dataset) DATASET=$2; shift 2 ;;
    --version) VERSION=$2; shift 2 ;;
    --from) FROM=$2; shift 2 ;;
    --memory) MEMORY=$2; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done

# ── What this machine must have ──────────────────────────────────────────────
[ "$(id -u)" = 0 ] || die "run as root (sudo)"
[ "$(uname -m)" = x86_64 ] || die "x86_64 only for now (this is $(uname -m))"
[ -e /dev/kvm ] || die "/dev/kvm is missing: this machine cannot run microVMs (a cloud VM needs nested virtualization)"
command -v systemctl >/dev/null 2>&1 || die "systemd is required"
[ -f /sys/fs/cgroup/cgroup.controllers ] || die "cgroup v2 is required"

need=""
for c in zfs:zfsutils-linux zstd:zstd iptables:iptables curl:curl nsenter:util-linux tar:tar mkfs.ext4:e2fsprogs; do
  command -v "${c%%:*}" >/dev/null 2>&1 || need="$need ${c#*:}"
done
[ -f /etc/ssl/certs/ca-certificates.crt ] || need="$need ca-certificates"
if [ -n "$need" ]; then
  command -v apt-get >/dev/null 2>&1 || die "missing:$need — install them, then run this again"
  say "installing$need"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
  # shellcheck disable=SC2086
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $need >/dev/null
fi
modprobe zfs 2>/dev/null || true

# ── Where the disks and the memory go: a ZFS dataset ─────────────────────────
if [ -z "$DATASET" ] && [ -f "$ETC/sandboxd.env" ]; then
  DATASET=$(sed -n 's/^SPUNTO_FC_DATASET=//p' "$ETC/sandboxd.env" | tail -1)
fi
if [ -z "$DATASET" ]; then
  POOL=$(zpool list -H -o name 2>/dev/null | head -1 || true)
  if [ -z "$POOL" ]; then
    [ -n "$CREATE_POOL" ] || die "no ZFS pool on this machine: make one (zpool create sandbox /dev/<disk>), or run with --create-pool 100G for one in a file"
    mkdir -p /var/lib/spunto-sandbox
    say "a ZFS pool in a file: /var/lib/spunto-sandbox/pool.img ($CREATE_POOL, sparse)"
    truncate -s "$CREATE_POOL" /var/lib/spunto-sandbox/pool.img
    zpool create -o ashift=12 -O compression=lz4 -O atime=off sandbox /var/lib/spunto-sandbox/pool.img
    POOL=sandbox
  fi
  DATASET="$POOL/spunto"
fi
zfs list -H -o name "${DATASET%%/*}" >/dev/null 2>&1 || die "no ZFS pool ${DATASET%%/*} (for $DATASET)"

# ── Binaries: Firecracker, its jailer and snapshot-editor, tini, busybox, crane, Node ──
say "Firecracker $FC_VERSION and friends in $O"
mkdir -p "$O/bin" "$O/kernels"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
if [ ! -x "$O/bin/firecracker" ] || ! "$O/bin/firecracker" --version 2>/dev/null | grep -q "${FC_VERSION#v}"; then
  curl -fsSL "https://github.com/firecracker-microvm/firecracker/releases/download/$FC_VERSION/firecracker-$FC_VERSION-x86_64.tgz" | tar -xz -C "$T"
  R="$T/release-$FC_VERSION-x86_64"
  install -m755 "$R/firecracker-$FC_VERSION-x86_64" "$O/bin/firecracker"
  install -m755 "$R/jailer-$FC_VERSION-x86_64" "$O/bin/jailer"
  install -m755 "$R/snapshot-editor-$FC_VERSION-x86_64" "$O/bin/snapshot-editor"
fi
[ -x "$O/bin/tini" ] || curl -fsSL -o "$O/bin/tini" https://github.com/krallin/tini/releases/download/v0.19.0/tini-static-amd64
[ -x "$O/bin/busybox" ] || curl -fsSL -o "$O/bin/busybox" https://busybox.net/downloads/binaries/1.35.0-x86_64-linux-musl/busybox
[ -x "$O/bin/crane" ] || curl -fsSL https://github.com/google/go-containerregistry/releases/download/v0.20.6/go-containerregistry_Linux_x86_64.tar.gz | tar -xz -C "$O/bin" crane
chmod 755 "$O"/bin/*
if [ ! -x "$O/node/bin/node" ] || [ "$("$O/node/bin/node" -v)" != "$NODE_VERSION" ]; then
  say "Node $NODE_VERSION (the daemon's own, in $O/node)"
  rm -rf "$O/node.new" && mkdir -p "$O/node.new"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz" | tar -xJ -C "$O/node.new" --strip-components=1
  rm -rf "$O/node" && mv "$O/node.new" "$O/node"
fi

# ── The daemon, the CLI, the guest agent ─────────────────────────────────────
mkdir -p "$APP"
if [ -n "$FROM" ]; then
  say "spunto-sandbox from $FROM"
  for f in sandboxd.mjs sbx.mjs sbx-agent; do [ -f "$FROM/$f" ] || die "$FROM/$f is missing (npm run build)"; done
  cp "$FROM/sandboxd.mjs" "$FROM/sbx.mjs" "$FROM/sbx-agent" "$T/"
else
  if [ "$VERSION" = latest ]; then URL="https://github.com/$REPO/releases/latest/download/spunto-sandbox-linux-x64.tar.gz"
  else URL="https://github.com/$REPO/releases/download/v${VERSION#v}/spunto-sandbox-linux-x64.tar.gz"; fi
  say "spunto-sandbox $VERSION"
  curl -fsSL ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} "$URL" | tar -xz -C "$T" || die "could not download $URL"
fi
install -m755 "$T/sandboxd.mjs" "$APP/sandboxd.mjs.new" && mv "$APP/sandboxd.mjs.new" "$APP/sandboxd.mjs"
install -m755 "$T/sbx.mjs" "$APP/sbx.mjs.new" && mv "$APP/sbx.mjs.new" "$APP/sbx.mjs"
install -m755 "$T/sbx-agent" "$APP/sbx-agent.new" && mv "$APP/sbx-agent.new" "$APP/sbx-agent"
cat > /usr/local/bin/sbx <<EOF
#!/bin/sh
exec $O/node/bin/node $APP/sbx.mjs "\$@"
EOF
chmod 755 /usr/local/bin/sbx

# ── Memory: every microVM runs in vms.slice, whose ceiling is what they may take together ──
if [ -z "$MEMORY" ]; then
  total=$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo)
  MEMORY="$(( total > 4096 ? total - 2048 : total / 2 ))M"
fi
if ! systemctl cat vms.slice >/dev/null 2>&1 || [ -n "${SBX_MEMORY:-}" ]; then
  printf '[Slice]\nMemoryMax=%s\nMemorySwapMax=0\n' "$MEMORY" > /etc/systemd/system/vms.slice
fi

# Hardening where an escape would land: no nested virtualization for the guests (read at module load).
V=$(grep -m1 -o -w -E 'vmx|svm' /proc/cpuinfo | head -n1 || true)
if [ -n "$V" ]; then
  M=kvm_intel; [ "$V" = svm ] && M=kvm_amd
  printf '# Spunto Sandbox: no nested virtualization on a host of microVMs.\noptions %s nested=0\n' $M > /etc/modprobe.d/spunto-kvm-nested.conf
fi

# ── Who may use it: root, and the spunto-sandbox group ───────────────────────
getent group spunto-sandbox >/dev/null 2>&1 || groupadd --system spunto-sandbox
[ -z "${SUDO_USER:-}" ] || [ "$SUDO_USER" = root ] || usermod -aG spunto-sandbox "$SUDO_USER"

# ── The service ──────────────────────────────────────────────────────────────
mkdir -p "$ETC" && chmod 700 "$ETC"
touch "$ETC/sandboxd.env" && chmod 600 "$ETC/sandboxd.env"
grep -q '^SPUNTO_FC_DATASET=' "$ETC/sandboxd.env" || printf 'SPUNTO_FC_DATASET=%s\n' "$DATASET" >> "$ETC/sandboxd.env"
cat > /etc/systemd/system/spunto-sandboxd.service <<EOF
[Unit]
Description=Spunto Sandbox (Firecracker microVMs)
Documentation=https://sandbox.spunto.net
After=network-online.target zfs.target docker.service
Wants=network-online.target
[Service]
EnvironmentFile=$ETC/sandboxd.env
ExecStart=$O/node/bin/node $APP/sandboxd.mjs
Restart=always
RestartSec=2
# Every microVM is a unit of its own (vms.slice): restarting the daemon leaves them running.
KillMode=process
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable spunto-sandboxd.service >/dev/null 2>&1
systemctl restart spunto-sandboxd.service
up() { curl -fsS --unix-socket /run/spunto-sandbox.sock http://sbx/v1/health >/dev/null 2>&1; }
for _ in $(seq 1 100); do up && break; sleep 0.2; done
up || die "the daemon did not start: journalctl -u spunto-sandboxd -n 50"

say "spunto-sandbox is running — dataset $DATASET, sandboxes may take $MEMORY"
cat <<EOF

  sbx run ubuntu:24.04 --name hello      a microVM, in seconds
  sbx exec hello -- uname -a
  sbx pause hello && sbx resume hello    its memory kept across
  sbx fork hello --name hello-2          a copy, running, same processes

  Logs: journalctl -u spunto-sandboxd -f    Settings: $ETC/sandboxd.env
EOF
[ -z "${SUDO_USER:-}" ] || [ "$SUDO_USER" = root ] || echo "  ($SUDO_USER is in the spunto-sandbox group: sbx without sudo from your next login)"
