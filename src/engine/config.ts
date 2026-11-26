
import { SandboxError, type Size } from "./types"

export const OPT = process.env.SPUNTO_FC_OPT ?? "/opt/spunto-fc"
export const STATE = process.env.SPUNTO_FC_STATE ?? "/var/lib/spunto-fc"
export const RUN = process.env.SPUNTO_FC_RUN ?? "/run/spunto-fc"
/** The ZFS dataset everything goes under (created if missing). */
export const DATASET = process.env.SPUNTO_FC_DATASET ?? "default/spunto"
/** The systemd slice every VM runs in — its MemoryMax is the machine's budget for sandboxes. */
export const SLICE = process.env.SPUNTO_FC_SLICE ?? "vms.slice"
/**
 * The guest kernel: ours (kernel/ — Firecracker's CI config plus what Docker needs, raw and
 * mangle tables included), built reproducibly by CI and published on ghcr.io as a blob named by its
 * own sha256. The daemon fetches it at host setup, checks it, and boots every new box with it.
 * `SPUNTO_FC_KERNEL` points at another file instead (a test, a local build).
 */
export const GUEST_KERNEL = {
  version: "6.18.55-s2",
  /** = kernel/vmlinux.sha256 (a test checks it), the blob's digest on ghcr.io. */
  sha256: "88b4dfab5be8f97bf34c41b5083c3009a65debb6e4afdf6b8c2c96f0c7c44ecc",
  repository: "coderhammer/spunto-fc-kernel",
}
export const PINNED_KERNEL = process.env.SPUNTO_FC_KERNEL ?? `${OPT}/kernels/${GUEST_KERNEL.version}/vmlinux`
/** The filesystem an image is unpacked into: made at this size, grown in every box (`rootSizeFor`). */
export const IMAGE_SIZE = process.env.SPUNTO_FC_IMAGE_SIZE ?? "10G"
export const WS_SIZE = process.env.SPUNTO_FC_WORKSPACE_SIZE ?? "20G"
export const KVM = process.env.SPUNTO_FC_KVM ?? "/dev/kvm"
/** A positive number from the environment: `fallback` for nothing or nonsense. */
export const positiveEnv = (name: string, fallback: number) => {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}
/** A build's log, as read from its console: what the platform stores of it, at most. */
export const MAX_BUILD_LOG = 8 * 1024 * 1024

export const BIN = (name: string) => `${OPT}/bin/${name}`
/** Inside every box's namespace: the same addresses, so a snapshot loads in any namespace. */
export const GUEST_IP = "172.16.0.2"
export const GW_IP = "172.16.0.1"
export const GUEST_MAC = "06:00:ac:10:00:02"
/**
 * And the gateway's, fixed too: a clone's RAM carries the ARP cache of the box it was taken from.
 * With a random tap MAC, its packets were dropped until that entry expired — 40 s without network
 * after every clone (seen on the first try).
 */
export const GW_MAC = "06:00:ac:10:00:01"
/** Where a box's drives are, as its Firecracker process sees them: bind mounts in its own mount namespace. */
export const DRIVE_ROOT = `${STATE}/drive/root`
export const DRIVE_WS = `${STATE}/drive/ws`

export const SIZES: (Size & { vcpus: number; memMib: number })[] = [
  { id: "small", label: "Small — 1 vCPU, 2 GB", cpus: 1, memoryGb: 2, vcpus: 1, memMib: 2048 },
  { id: "default", label: "Default — 2 vCPU, 4 GB", cpus: 2, memoryGb: 4, vcpus: 2, memMib: 4096 },
  { id: "large", label: "Large — 4 vCPU, 8 GB", cpus: 4, memoryGb: 8, vcpus: 4, memMib: 8192 },
  { id: "xlarge", label: "XLarge — 8 vCPU, 16 GB", cpus: 8, memoryGb: 16, vcpus: 8, memMib: 16384 },
]

/** A size by its id — `small` for one this machine does not know (what a box asked for nothing gets). */
export const sizeOf = (id?: string) => SIZES.find((s) => s.id === id) ?? SIZES[0]!

/**
 * A box's system disk, by size. Room for features, Docker's images and build cache, `apt`, caches:
 * 10 GB filled up on an xlarge Spunto sandbox (2026-10-11: `/usr` 4.2 GB, `/var/lib` 4.2 GB, of
 * which Docker 4.8 GB). Sparse and lz4-compressed zvols: only what the guest writes is used.
 * The image's filesystem is made at `IMAGE_SIZE`; each box's clone is grown to this, and its init
 * grows the filesystem online at boot (`grow_fs`). `SPUNTO_FC_ROOT_SIZE` sets one size for all.
 *
 * Until 2026-10-11 `SPUNTO_FC_ROOT_SIZE` was the image's filesystem size (now `SPUNTO_FC_IMAGE_SIZE`):
 * a machine that set it to 10G for that gets 10 GB boxes again, hence the warning below.
 */
export const ROOT_GB: Record<string, number> = { small: 40, default: 40, large: 50, xlarge: 60 }
export const rootSizeFor = (size: string) => process.env.SPUNTO_FC_ROOT_SIZE ?? `${ROOT_GB[size] ?? 40}G`
if (process.env.SPUNTO_FC_ROOT_SIZE && !process.env.SPUNTO_FC_IMAGE_SIZE)
  console.warn(`[firecracker] SPUNTO_FC_ROOT_SIZE=${process.env.SPUNTO_FC_ROOT_SIZE} is every box's system disk now, not the image's filesystem (SPUNTO_FC_IMAGE_SIZE)`)
/**
 * What `grow` accepts, at most, per disk: a mistake — or a stranger, on a machine of the fleet —
 * should not take a machine's pool with it. The machine's ceiling (`SPUNTO_FC_MAX_ROOT_GB`,
 * `SPUNTO_FC_MAX_WS_GB`, 200 and 500 by default); a plan's is the platform's to check before it
 * calls (RFC 0043 § 4.2). A zvol takes no `refquota` (ZFS refuses it on a volume): its `volsize` is
 * the bound — the guest cannot write past its disk's end (RFC 0039 § 22).
 */
export const maxDiskGb = () => ({
  root: Math.floor(positiveEnv("SPUNTO_FC_MAX_ROOT_GB", 200)),
  ws: Math.floor(positiveEnv("SPUNTO_FC_MAX_WS_GB", 500)),
})
export const GIB = 1024 ** 3
export const UNIT: Record<string, number> = { "": 1, K: 1024, M: 1024 ** 2, G: GIB, T: 1024 * GIB, P: 1024 ** 2 * GIB }
/** A size as `zfs` reads one (`10G`, `10240M`, `1.5t`, `40GB`, bytes): what these variables always took. */
export const bytesOf = (size: string) => {
  const m = /^(\d+(?:\.\d+)?)\s*([KMGTP]?)(?:i?B)?$/i.exec(size.trim())
  if (!m) throw new SandboxError(`not a disk size: ${size}`, "invalid")
  return Math.floor(Number(m[1]) * UNIT[m[2]!.toUpperCase()]!)
}

/**
 * Memory files — a stopped box's RAM, a box's own base for its Diffs, a template's RAM — live in
 * ZFS **filesystems** (not zvols), one per box or template: `<dataset>/mem/<handle|ref>`, mounted at
 * `${STATE}/mem/<name>`, holding `mem` and `vmstate`. A copy of one is `zfs snapshot` + `zfs clone`:
 * instantaneous, copy-on-write, holes stay holes. On ext4 (until 2026-10-11) every fork, model and
 * stop of a box from a model copied a file of up to 16 GB with `cp --sparse`: 5 min for an xlarge
 * on Canada (RFC 0039 § 17).
 *  - lz4: guest memory compresses ~2× (2.0–2.2× on a real model), and an all-zero record — a page
 *    the guest freed and reported, a Full's untouched RAM — is not stored at all: no hole digging;
 *  - `recordsize` 64K: on a real model's memory on Canada, better compression and a faster Diff
 *    merge (snapshot-editor's read-modify-write) than 16K or 4K;
 *  - `sync=disabled`: nothing in here needs a ZIL; what must be on disk before it is relied on
 *    (a stop's RAM) is committed with `zpool sync` (`commitMem`), outside any pause.
 */
export const MEM_ROOT = `${STATE}/mem`
/**
 * Where a snapshot's memory is written **while the box is paused**: the host's own filesystem
 * (ext4), not a memory dataset, for two reasons —
 *  - a Diff is merged by `snapshot-editor`, which copies the file's *data* (`SEEK_DATA`) over the
 *    base. lz4 stores a record of zeros as a hole: a page the guest zeroed would be missing from the
 *    Diff, and the base would keep what was there before — memory corrupted without a word (seen on
 *    Canada: the copy of a fork died at its first instruction, a triple fault). ext4 keeps written
 *    zeros as data;
 *  - written without an fsync, it goes to the page cache at memory speed, and the `zfs snapshot`
 *    of the disks that follows in the pause has no RAM to flush with them.
 * It goes into the memory dataset after the box runs again (`mergeInto`), and is deleted — often
 * before it ever reached the disk.
 */
export const SCRATCH = `${STATE}/scratch`
export const MEM_RECORDSIZE = process.env.SPUNTO_FC_MEM_RECORDSIZE ?? "64K"
export const POOL = DATASET.split("/")[0]!
export const ZVOL = process.env.SPUNTO_FC_ZVOL_DIR ?? "/dev/zvol"
/** Where the rule that keeps the host's udev out of the boxes' disks goes (`ensureZvolRule`). */
export const UDEV_RULES = process.env.SPUNTO_FC_UDEV_RULES ?? "/etc/udev/rules.d"
/** Below this, no new box: sparse disks promise more than the pool holds, and a full pool fails the
 * guest's writes with I/O errors rather than a clean "no space left". */
export const MIN_POOL_FREE = Number(process.env.SPUNTO_FC_MIN_POOL_FREE_GB ?? 5) * GIB
export const CGROUP_ROOT = process.env.SPUNTO_FC_CGROUP_ROOT ?? "/sys/fs/cgroup"
export const MEMINFO = process.env.SPUNTO_FC_MEMINFO ?? "/proc/meminfo"
export const MOUNTS = process.env.SPUNTO_FC_MOUNTS ?? "/proc/self/mounts"
/**
 * Every VMM runs under the jailer (RFC 0039 § 21): chrooted in `jailOf(handle)`, as `uidOf(net)`
 * without a capability, in its box's netns, still a transient unit of the slice. Until 2026-10-16 it
 * ran as root, its drives bound in a private mount namespace (`LAUNCH`): `SPUNTO_FC_JAILER=0` brings
 * that back, for a comparison — never on a machine that runs someone else's boxes.
 */
export const JAILED = process.env.SPUNTO_FC_JAILER !== "0"
/** `SPUNTO_FC_JAILER_BIN` points at another jailer, used as it is (a test, a local build). */
export const JAILER_BIN = process.env.SPUNTO_FC_JAILER_BIN ?? BIN("jailer")
export const JAIL_BASE = process.env.SPUNTO_FC_JAIL_DIR ?? `${STATE}/jail`
/**
 * The uids (and gids) of the jailed VMMs: one per network number, which a box holds from its create
 * to its destroy (a builder, an unpacker, for as long as they run) — `freeNet` allocates both, and a
 * destroy gives both back. Above Incus's subordinate range (`root:1000000:1000000000` on Canada), so
 * no container's user is ever a VMM's.
 */
export const UID_BASE = Number(process.env.SPUNTO_FC_UID_BASE ?? 2_000_000_000)
/** Where `ip netns add` puts a namespace: what the jailer joins (`--netns`). */
export const NETNS_DIR = process.env.SPUNTO_FC_NETNS_DIR ?? "/run/netns"
/** Where this daemon's networks start: a second daemon on the machine (a test) takes another range. */
export const NET_FIRST = Number(process.env.SPUNTO_FC_NET_FIRST ?? 0)
export const NET_LIMITS = process.env.SPUNTO_FC_NET_LIMITS !== "0"
export const SYSFS_NET = process.env.SPUNTO_FC_SYSFS_NET ?? "/sys/class/net"
/** Two IFBs per daemon: a second daemon on the machine (a test) takes another prefix. At most 14 characters. */
export const IFB = (process.env.SPUNTO_FC_IFB ?? "fcifb").slice(0, 14)
export const IFB_UP = `${IFB}u`
export const IFB_DOWN = `${IFB}d`
/** Where the guest's init listens for the host's knock after a resume (§ 4.4). */
export const WAKE_PORT = 47770
/** Firecracker's own arguments. MMDS and the API take up to 4 MiB: a builder's recipe goes through them. */
export const FC_ARGS = ["--level", "Warning", "--mmds-size-limit", "4194304", "--http-api-max-payload-size", "4194304"]
export const KSTAT = process.env.SPUNTO_FC_KSTAT ?? `/proc/spl/kstat/zfs/${POOL}`
