#!/usr/bin/env bash
# Build the Spunto guest kernel for Firecracker (RFC 0039 § 4.1) — reproducibly: a pinned source
# tarball (sha256), a pinned compiler image (by digest), the config files of this directory, and a
# fixed build timestamp/user/host. Two builds of the same commit give the same vmlinux (CI checks
# it against SHA256SUMS before publishing).
#
#   kernel/build.sh [out dir]      → <out>/vmlinux, <out>/config, <out>/vmlinux.sha256
#
# Needs Docker. Inside the container: the same script with --inside.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=/dev/null
. "$HERE/VERSION"

if [ "${1:-}" != --inside ]; then
  OUT=$(mkdir -p "${1:-$HERE/out}" && cd "${1:-$HERE/out}" && pwd)
  exec docker run --rm -v "$HERE:/src:ro" -v "$OUT:/out" -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" -e CONFIG_ONLY "$BUILDER_IMAGE" bash /src/build.sh --inside
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends bc bison flex libelf-dev libssl-dev xz-utils curl ca-certificates cpio python3 >/dev/null

cd /tmp
curl -fsSL -o linux.tar.xz "https://cdn.kernel.org/pub/linux/kernel/v${LINUX_VERSION%%.*}.x/linux-${LINUX_VERSION}.tar.xz"
echo "${LINUX_SHA256}  linux.tar.xz" | sha256sum -c -
tar -xJf linux.tar.xz
cd "linux-${LINUX_VERSION}"

# Later files win: Firecracker's CI config, its CI fragment, then ours. olddefconfig fills the rest.
awk 1 /src/firecracker-6.18.config /src/firecracker-ci.config /src/spunto.config > .config
export KBUILD_BUILD_TIMESTAMP="$BUILD_TIMESTAMP" KBUILD_BUILD_USER=spunto KBUILD_BUILD_HOST=spunto LOCALVERSION="-$SPUNTO_REVISION"
make -s olddefconfig 2>&1 | grep -v "warning: override" || true

# Every line of spunto.config must have survived olddefconfig (a dependency missing, a symbol
# renamed by a new kernel): fail loudly rather than ship a kernel without iptables raw again.
missing=0
while IFS= read -r line; do
  case "$line" in CONFIG_*=*) ;; *) continue ;; esac
  grep -qxF "$line" .config || { echo "not in the final config: $line (got: $(grep -E "^(# )?${line%%=*}[= ]" .config || echo absent))"; missing=1; }
done < /src/spunto.config
[ "$missing" = 0 ] || exit 1
cp .config /out/config
[ "${CONFIG_ONLY:-}" = 1 ] && exit 0

make -s -j"$(nproc)" vmlinux
cp vmlinux /out/vmlinux
cp .config /out/config
(cd /out && sha256sum vmlinux > vmlinux.sha256)
chown "${HOST_UID:-0}:${HOST_GID:-0}" /out/vmlinux /out/config /out/vmlinux.sha256
cat /out/vmlinux.sha256
