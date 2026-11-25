
import { WAKE_PORT } from "./config"

// ── Images: OCI → ext4 zvol ─────────────────────────────────────────────────

/** PID 1 is tini; this is its child. Plain sh + the static busybox: the image may have nothing else. */
export const GUEST_INIT = String.raw`#!/.spunto/busybox sh
# Spunto Firecracker guest init (RFC 0039). tini is PID 1, this script its only child.
# Reads its env from MMDS, runs the platform's bootstrap with it, and watches MMDS for a new
# generation: the host writes one at every boot and every load of a RAM snapshot. A builder (MMDS
# has a "build") runs that script instead, prints it on the console, and powers off.
B=/.spunto/busybox
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
log() { echo "[spunto-init] $*" > /dev/console; }

$B mount -o remount,rw / 2>/dev/null
mnt() {
  $B mountpoint -q "$3" 2>/dev/null && return 0
  $B mkdir -p "$3"
  if [ -n "$4" ]; then $B mount -t "$1" -o "$4" "$2" "$3"; else $B mount -t "$1" "$2" "$3"; fi
}
mnt proc proc /proc
mnt sysfs sys /sys
mnt devtmpfs dev /dev
mnt devpts devpts /dev/pts gid=5,mode=620,ptmxmode=666
mnt tmpfs shm /dev/shm mode=1777
mnt tmpfs run /run mode=755
mnt cgroup2 cgroup2 /sys/fs/cgroup
# Ctrl-Alt-Del as SIGINT to PID 1 (tini, which hands it to us), not the kernel's immediate reboot.
echo 0 > /proc/sys/kernel/ctrl-alt-del
[ -e /dev/fd ] || $B ln -s /proc/self/fd /dev/fd
# And its three neighbours, which devtmpfs has not either: without them "tee /dev/stderr" tries to create a
# file there, refused to a non-root user (a GitHub Actions step on Spunto CI, 2026-11-25).
[ -e /dev/stdin ] || $B ln -s /proc/self/fd/0 /dev/stdin
[ -e /dev/stdout ] || $B ln -s /proc/self/fd/1 /dev/stdout
[ -e /dev/stderr ] || $B ln -s /proc/self/fd/2 /dev/stderr
mnt ext4 /dev/vdb /workspace
$B ip link set lo up
$B ip route add 169.254.169.254 dev eth0 2>/dev/null
$B rm -f /etc/resolv.conf
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > /etc/resolv.conf
# Images built by Docker often have no /etc/hosts (Docker mounts its own): localhost, at least.
[ -f /etc/hosts ] || { $B rm -f /etc/hosts; printf '127.0.0.1 localhost\n::1 localhost ip6-localhost ip6-loopback\n' > /etc/hosts; }
# Docker in the box: iptables-nft where the image picked legacy (the docker-in-docker feature does,
# when the kernel it was installed on had the filter table — a check that says nothing of raw).
if command -v update-alternatives >/dev/null 2>&1; then
  for t in iptables ip6tables; do
    [ -x /usr/sbin/$t-nft ] && update-alternatives --query $t 2>/dev/null | $B grep -q '^Value: .*-legacy$' &&
      update-alternatives --set $t /usr/sbin/$t-nft >/dev/null 2>&1 && log "$t: legacy -> nft"
  done
fi
$B mkdir -p /run/spunto && $B chmod 700 /run/spunto

# Each filesystem fills its disk: a box's system disk is grown at its creation (the image's was made
# at 10 GB), a disk can be grown under a running box (§ 4.12). The kernel's own online resize,
# EXT4_IOC_RESIZE_FS, through perl (essential in Debian and Ubuntu) or python3. Not resize2fs first:
# in a guest it took a mounted disk for a free one ("Device or resource busy", seen on base:ubuntu),
# and an older one refuses what the host's mkfs enabled. A filesystem at its disk's size stays so.
grow_fs() {
  for m in /:vda /workspace:vdb; do
    mp=$(echo "$m" | $B cut -d: -f1); d=$(echo "$m" | $B cut -d: -f2)
    $B mountpoint -q "$mp" 2>/dev/null && [ -e /sys/class/block/$d/size ] || continue
    bs=$($B stat -f -c %S "$mp") && n=$(( $(cat /sys/class/block/$d/size) * 512 / bs )) || continue
    perl -e 'open(my $f, "<", $ARGV[0]) or die; ioctl($f, 0x40086610, pack("Q", $ARGV[1])) or die' "$mp" "$n" 2>/dev/null ||
      python3 -c 'import fcntl,os,struct,sys;fcntl.ioctl(os.open(sys.argv[1],os.O_RDONLY),0x40086610,struct.pack("Q",int(sys.argv[2])))' "$mp" "$n" 2>/dev/null ||
      resize2fs /dev/$d >/dev/null 2>&1 || log "$mp: could not grow its filesystem to its disk (no perl, python3 or working resize2fs)"
  done
}
grow_fs &

# MMDS v2 over raw HTTP (busybox nc): a session token (kept: a new VMM — a load — refuses it, and
# a new one is taken), then the value.
body() { $B tr -d '\r' | $B sed '1,/^$/d'; }
TOK=
get() {
  printf 'GET /spunto/%s HTTP/1.0\r\nX-metadata-token: %s\r\n\r\n' "$1" "$TOK" | $B timeout 2 $B nc 169.254.169.254 80 > /run/spunto/mmds.http || return 1
  $B head -1 /run/spunto/mmds.http | $B grep -q ' 200 '
}
mmds() {
  if [ -z "$TOK" ] || ! get "$1"; then
    TOK=$(printf 'PUT /latest/api/token HTTP/1.0\r\nX-metadata-token-ttl-seconds: 21600\r\n\r\n' | $B timeout 2 $B nc 169.254.169.254 80 | body)
    [ -n "$TOK" ] && get "$1" || return 1
  fi
  body < /run/spunto/mmds.http
}

GEN=
FAILED=
PIDF=/run/spunto/bootstrap.pid
AGENTPID=/run/spunto/agent.pid
AGENTSIG=/run/spunto/agent.signals
RESUMED=/run/spunto/resumed-at
running() { [ -s $PIDF ] && kill -0 "$(cat $PIDF)" 2>/dev/null; }
# A generation's env and bootstrap, into *.new — all or nothing: a read that fails or comes back
# empty replaces nothing, and the loop tries again. Never a bootstrap without its token.
fetch() {
  $B rm -f /run/spunto/env.new /run/spunto/bootstrap.new
  b=$(mmds bootstrap) && [ -n "$b" ] || return 1
  e=$(mmds env) && [ -n "$e" ] || return 1
  printf '%s' "$b" | $B base64 -d > /run/spunto/bootstrap.new 2>/dev/null && [ -s /run/spunto/bootstrap.new ] || return 1
  ( umask 077; printf '%s' "$e" | $B base64 -d > /run/spunto/env.new 2>/dev/null ) || return 1
  $B grep -q '^SPUNTO_SANDBOX_TOKEN=..' /run/spunto/env.new || return 1
}
# Clock and name: nice to have, never a reason to hold the bootstrap back.
settle() {
  now=$(mmds now) && $B date -s "@$now" >/dev/null 2>&1
  if h=$(mmds hostname) && [ -n "$h" ]; then
    $B hostname "$h" && echo "$h" > /etc/hostname
    $B sed -i '/# spunto$/d' /etc/hosts; echo "127.0.1.1 $h # spunto" >> /etc/hosts
  fi
}
start_bootstrap() {
  $B mv /run/spunto/env.new /run/spunto/env
  $B mv /run/spunto/bootstrap.new /run/spunto/bootstrap
  # Its own session: a new identity stops the whole tree (kill -<pgid>), not the runner it detached.
  # The agent writes its pid where we told it, and the signals it understands: they go to it only.
  ( set -a; . /run/spunto/env; SPUNTO_AGENT_PIDFILE=$AGENTPID; SPUNTO_AGENT_SIGNALS_FILE=$AGENTSIG; SPUNTO_AGENT_RESUMED_FILE=$RESUMED; SPUNTO_AGENT_ENV_FILE=/run/spunto/env; set +a; cd /
    exec $B setsid sh -c 'echo $$ > /run/spunto/bootstrap.pid; exec sh -c "$(cat /run/spunto/bootstrap)"'
  ) >> /var/log/spunto-bootstrap.log 2>&1 < /dev/null &
  sleep 0.2
  log "bootstrap started (generation $GEN)"
}
stop_bootstrap() {
  running || return 0
  p=$(cat $PIDF)
  kill -TERM -"$p" 2>/dev/null
  for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 -"$p" 2>/dev/null || break; sleep 0.1; done
  kill -KILL -"$p" 2>/dev/null
  rm -f $PIDF $AGENTPID $AGENTSIG
}
# The agent, by the pid it wrote — still alive, and still the agent (not a reused pid). USR2 ($1)
# when the host says the platform let its connection go (a start after a stop) and the agent knows
# USR2: it dials at once. Otherwise USR1: it probes its connection first.
signal_agent() {
  p=$(cat $AGENTPID 2>/dev/null) && [ -n "$p" ] && $B grep -q agent.mjs /proc/"$p"/cmdline 2>/dev/null || return 1
  s=USR1
  [ "$1" = USR2 ] && $B grep -qw USR2 $AGENTSIG 2>/dev/null && s=USR2
  kill -$s "$p" && echo $s
}

# Ctrl-Alt-Del from the host (SendCtrlAltDel) reaches tini as SIGINT, then us: the disk is about to
# outlive this RAM (a rebuild keeping /workspace, an archive), so what the page cache holds goes first.
shutdown() {
  log "shutting down"
  stop_bootstrap
  sync
  $B umount /workspace 2>/dev/null
  $B mount -o remount,ro / 2>/dev/null
  sync
  $B reboot -f
}
trap shutdown INT TERM

# A builder: the recipe as root, its output on the console (the host's build log), then off. The
# host reads the exit status from the last marker; a builder that dies without one has failed.
run_build() {
  GEN=$g
  settle
  printf '%s' "$1" | $B base64 -d > /run/spunto/build.sh || { echo "::spunto-fc:build:exit:125" > /dev/console; shutdown; }
  sh=/bin/bash; [ -x $sh ] || sh=/bin/sh
  echo "::spunto-fc:build:start" > /dev/console
  ( cd /; export HOME=/root; exec $sh /run/spunto/build.sh ) > /dev/console 2>&1 < /dev/null
  echo "::spunto-fc:build:exit:$?" > /dev/console
  shutdown
}

# MMDS is read every second — and at once when the host knocks on port ${WAKE_PORT}, which it does right
# after it resumes a loaded RAM (the new generation is there by then). Waiting on a listening nc
# rather than sleeping: no wake-up in between, and the knock is seen in milliseconds. The guest's
# clock is no help: it resumes where it was frozen (tsc), not at the host's time.
wait_knock() {
  $B timeout 1 $B nc -l -p ${WAKE_PORT} < /dev/null > /dev/null 2>&1
  # Not a knock nor the second gone by (143): the port is taken — a plain sleep, not a busy loop.
  r=$?; [ $r -eq 0 ] || [ $r -eq 143 ] || sleep 1
}
# A disk grown under the box (grow, an operator's ctl grow, a load whose RAM knew it smaller):
# its size changes in /sys, read here every pass without a fork; grow_fs follows.
SIZES=
while :; do
  wait_knock
  read va < /sys/class/block/vda/size 2>/dev/null; read vb < /sys/class/block/vdb/size 2>/dev/null
  if [ "$va:$vb" != "$SIZES" ]; then
    [ -n "$SIZES" ] && grow_fs &
    SIZES="$va:$vb"
  fi
  g=$(mmds generation) || g=
  # A fork (§ 4.10): another box's RAM, this box's env. An agent that can take a new identity is
  # handed it and every process stays; an older one gets the old way below (the bootstrap starts
  # over, its whole tree killed).
  if [ -n "$g" ] && [ "$g" != "$GEN" ] && running && [ "$(mmds resume)" = reidentify ] && $B grep -qw REIDENTIFY $AGENTSIG 2>/dev/null && fetch; then
    GEN=$g
    $B mv /run/spunto/env.new /run/spunto/env
    $B rm -f /run/spunto/bootstrap.new
    read up _ < /proc/uptime && echo "$up" > $RESUMED
    now=$(mmds now) && $B date -s "@$now" >/dev/null 2>&1
    settle
    s=$(signal_agent USR2) && log "forked (generation $GEN): the agent takes its new identity ($s), its processes stay"
    grow_fs &
    continue
  fi
  # Our own RAM loaded back: same env by construction (the host says so) — the agent first, at once.
  if [ -n "$g" ] && [ "$g" != "$GEN" ] && running && [ "$(mmds resume)" = reconnect ]; then
    GEN=$g
    # When, on the clock the agent reads too (/proc/uptime: frozen with the box): a socket it dialed
    # after this was made since the resume, and is kept.
    read up _ < /proc/uptime && echo "$up" > $RESUMED
    # The clock first (one read, ~4 ms): the agent's new TLS handshake checks certificates against
    # it, and it resumes where it was frozen. How far behind it was goes in the log.
    lag=?
    if now=$(mmds now) && [ -n "$now" ]; then
      lag=$((now - $($B date +%s))); $B date -s "@$now" >/dev/null 2>&1
    fi
    s=$(signal_agent USR2) && log "resumed (generation $GEN): agent told ($s), clock was $lag s behind"
    settle
    grow_fs &
    continue
  fi
  if [ -n "$g" ] && [ "$g" != "$GEN" ] && b=$(mmds build) && [ -n "$b" ]; then
    run_build "$b"
  elif [ -n "$g" ] && [ "$g" != "$GEN" ] && ! fetch; then
    # GEN stays where it was: the next pass reads this generation again.
    [ "$FAILED" = "$g" ] || log "could not read generation $g from MMDS: keeping what runs, retrying"
    FAILED=$g
  elif [ -n "$g" ] && [ "$g" != "$GEN" ]; then
    GEN=$g
    if ! running || ! $B cmp -s /run/spunto/env /run/spunto/env.new; then
      settle
      # The first boot, or a new identity (a clone of a template): the bootstrap starts over.
      running && log "new identity: restarting the bootstrap"
      stop_bootstrap
      start_bootstrap
    else
      # Same box, RAM loaded back (a host that does not say "reconnect"): the agent checks its connection.
      $B rm -f /run/spunto/env.new /run/spunto/bootstrap.new
      s=$(signal_agent USR1) && log "resumed (generation $GEN): agent told ($s)"
      settle
    fi
  elif [ -n "$GEN" ] && [ -s /run/spunto/env ] && ! running; then
    log "bootstrap exited, restarting"
    $B cp /run/spunto/env /run/spunto/env.new && $B cp /run/spunto/bootstrap /run/spunto/bootstrap.new && start_bootstrap
  fi
done
`

/**
 * The unpacker's init: PID 1 of a throwaway microVM that puts an image on a fresh disk. An image is
 * an archive from anywhere — absolute symlinks, `etc -> /`, device files — and the old way, `tar -x`
 * as root on the host into a mounted zvol, trusted it with the host (writing `etc/resolv.conf`
 * through an image's `etc -> /` was the host's own). Here the worst it reaches is this VM. The host
 * never mounts the disk again: what a guest wrote is not a filesystem the host's kernel should parse.
 */
export const UNPACK_INIT = String.raw`#!/bin/busybox sh
B=/bin/busybox
$B mount -t proc proc /proc; $B mount -t sysfs sys /sys; $B mount -t tmpfs tmp /tmp
$B mountpoint -q /dev || $B mount -t devtmpfs dev /dev
say() { echo "$*" > /dev/console; }
fail() { say "::spunto-fc:unpack:error:$*"; $B sync; $B reboot -f; }
$B ip link set lo up
$B mount -t ext4 /dev/vdb /mnt || fail "cannot mount the new disk"
say "::spunto-fc:unpack:start"
set -o pipefail
export HOME=/tmp SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
/bin/crane export --platform linux/amd64 "$1" - | /bin/tar -x --numeric-owner --xattrs --xattrs-include='*' -C /mnt || fail "crane export | tar -x exited with $?"
# Ours: tini, busybox and the init in /.spunto, a mount point for /workspace, a resolver.
$B rm -rf /mnt/.spunto && $B mkdir -p /mnt/.spunto /mnt/workspace /mnt/etc || fail "cannot make /.spunto"
$B cp /payload/tini /payload/busybox /payload/init /mnt/.spunto/ && $B chmod 755 /mnt/.spunto/tini /mnt/.spunto/busybox /mnt/.spunto/init || fail "cannot install the init"
echo "$1" > /mnt/.spunto/image
$B rm -f /mnt/etc/resolv.conf; echo 'nameserver 1.1.1.1' > /mnt/etc/resolv.conf
$B sync; $B umount /mnt || fail "cannot unmount the disk"
say "::spunto-fc:unpack:done"
$B reboot -f
`
