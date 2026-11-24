import { mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, statSync } from "node:fs"
import { join } from "node:path"
import { SandboxError } from "./types"
import { DATASET, GIB, MEM_RECORDSIZE, MEM_ROOT, MIN_POOL_FREE, MOUNTS, POOL, SCRATCH, sizeOf } from "./config"
import { run } from "./host-commands"
import { Vm, reg, save, serial } from "./registry"
import { unitActive, unitOf } from "./vmm"
import { destroyDataset, ds, exists, poolFree } from "./zfs"

// ── Memory files: one ZFS filesystem per box or template ────────────────────

export const memDir = (name: string) => join(MEM_ROOT, name)
/**
 * A host path as a VMM **without a jail** must be given it (one started before the jailer and still
 * running, or `SPUNTO_FC_JAILER=0`; a jailed one: `withVmmPaths`). Each such process has a mount namespace of its
 * own (`LAUNCH`), a private copy of the host's mounts as they were when it started: a memory
 * dataset mounted since — a stop's, a fork's, the next one's — is not there, and a snapshot written
 * to its path would go into the empty directory under it (seen on the first try on Canada). Through
 * the daemon's `/proc/<pid>/root`, the path resolves in the daemon's namespace, whatever the VMM's
 * holds — boxes started before this daemon included.
 */
export const vmmPath = (path: string) => `/proc/${process.pid}/root${path}`
/** A path in the memory datasets — anything else is a memory file from before them (`vms/`, `templates/`). */
export const inMem = (path?: string) => !!path && path.startsWith(`${MEM_ROOT}/`)
/** The dataset name a memory path is in (`<name>` of `${MEM_ROOT}/<name>/mem`). */
export const memNameOf = (path: string) => path.slice(MEM_ROOT.length + 1).split("/")[0]!

/**
 * `<dataset>/mem`, its properties inherited by every box's and template's (see MEM_ROOT), and every
 * one of them mounted: a dataset that is not mounted would have its files written into the
 * directory under it, on the host's disk, and a saved RAM there would read as missing.
 */
export async function ensureMemRoot() {
  const root = `${DATASET}/mem`
  const props = { mountpoint: MEM_ROOT, compression: "lz4", recordsize: MEM_RECORDSIZE, atime: "off", sync: "disabled" }
  if (!(await exists(root))) {
    await run("zfs", ["create", "-p", ...Object.entries(props).flatMap(([k, v]) => ["-o", `${k}=${v}`]), root])
  } else {
    // Only what differs (a recordsize changed applies to files written from then on): setting a
    // mountpoint, even the same, remounts every dataset under it — and one a box maps is busy.
    const now = new Map((await run("zfs", ["get", "-H", "-o", "property,value", Object.keys(props).join(","), root])).split("\n").map((l) => l.split("\t") as [string, string]))
    for (const [k, v] of Object.entries(props)) if (now.get(k)?.toLowerCase() !== v.toLowerCase()) await run("zfs", ["set", `${k}=${v}`, root])
  }
  for (const line of (await run("zfs", ["list", "-H", "-o", "name,mounted", "-r", root])).split("\n")) {
    const [name, mounted] = line.split("\t")
    if (name && mounted === "no") await run("zfs", ["mount", name])
  }
}

/** `statfs` magic of ZFS. */
export const ZFS_MAGIC = 0x2fc12fc1
/**
 * SCRATCH must keep written zeros as data. On a machine whose `/var/lib` is itself ZFS (Ubuntu's
 * ZFS install), it gets a dataset of its own without compression — slower in a pause (a `zfs
 * snapshot` of the disks flushes it), never wrong.
 */
export async function ensureScratch() {
  mkdirSync(SCRATCH, { recursive: true, mode: 0o700 })
  if (statfsSync(SCRATCH).type === ZFS_MAGIC) {
    const scratch = `${DATASET}/scratch`
    if (!(await exists(scratch))) await run("zfs", ["create", "-o", `mountpoint=${SCRATCH}`, "-o", "compression=off", "-o", "sync=disabled", scratch])
    else if ((await run("zfs", ["get", "-H", "-o", "value", "mounted", scratch])).trim() === "no") await run("zfs", ["mount", scratch])
    // Mounted there, from that dataset, uncompressed — not merely a dataset that exists: otherwise
    // the Diffs would land on the compressed filesystem under it, their zero pages lost.
    const compression = (await run("zfs", ["get", "-H", "-o", "value", "compression", scratch])).trim()
    const why = scratchProblem(readFileSync(MOUNTS, "utf8"), scratch, compression)
    if (why) throw new SandboxError(`${SCRATCH}: ${why} — a Diff written there would lose its zero pages`)
  }
  // What a daemon that died mid-snapshot left: the stop or freeze it was is written again, or
  // failed. Emptied, never removed: it may be a mount point.
  for (const f of readdirSync(SCRATCH)) rmSync(join(SCRATCH, f), { recursive: true, force: true })
}

/**
 * Why SCRATCH, on a ZFS host, is not safe for a Diff: not mounted from `dataset` (the last mount on
 * that path is the one seen), or compressed. Undefined: safe.
 */
export function scratchProblem(mounts: string, dataset: string, compression: string, path = SCRATCH) {
  const on = mounts
    .split("\n")
    .map((l) => l.split(" "))
    .filter((f) => f[1] === path)
    .at(-1)
  if (!on) return `not a mount point (${dataset} is not mounted there)`
  if (on[0] !== dataset || on[2] !== "zfs") return `mounted from ${on[0]} (${on[2]}), not ${dataset}`
  if (compression !== "off") return `${dataset} has compression=${compression}`
  return undefined
}

/** A name in use again is not the graveyard's any more (whatever the sweep was to destroy under it). */
export function forgive(name: string) {
  const g = reg().memGraveyard
  if (!g?.includes(name)) return
  reg().memGraveyard = g.filter((n) => n !== name)
  save()
}

/**
 * The RAM goes into the pool the boxes' disks are in: a pool filled by it would fail every zvol's
 * writes, an I/O error in every box. Before any of it is written, the pool must keep
 * MIN_POOL_FREE after `bytes` more. Undefined: room enough; otherwise why not.
 */
export async function noRoomFor(bytes: number) {
  const free = await poolFree()
  if (!free || free - bytes >= MIN_POOL_FREE) return undefined
  return `no room in the machine's disk pool for ${(bytes / GIB).toFixed(1)} GB of memory (${(free / GIB).toFixed(1)} GB left, ${MIN_POOL_FREE / GIB} GB kept for the boxes' disks)`
}

/**
 * What a box's snapshot can write, at most: the memory its VMM holds (its unit's), every page of
 * which may be dirty — pages it never touched or gave back are zeros, which the pool does not
 * store. The box's whole RAM when systemd does not say.
 */
export async function ramBytesOf(vm: Vm) {
  const n = Number((await run("systemctl", ["show", unitOf(vm.handle), "-p", "MemoryCurrent", "--value"]).catch(() => "")).trim())
  return Number.isFinite(n) && n > 0 ? n : sizeOf(vm.size).memMib * 1024 ** 2
}

/** Allocated bytes of a file: what copying it into the pool can take, at most. */
export const allocatedOf = (file: string) => statSync(file).blocks * 512

/** A fresh, empty memory dataset for `name` (whatever had that name goes first). */
export async function memFresh(name: string) {
  await destroyMem(name, { wait: true })
  await run("zfs", ["create", ds.mem(name)])
  return memDir(name)
}

/** The memory dataset of `name`, made if missing — and mounted: never the directory under it. */
export async function memEnsure(name: string) {
  forgive(name)
  if (!(await exists(ds.mem(name)))) await run("zfs", ["create", ds.mem(name)])
  else if ((await run("zfs", ["get", "-H", "-o", "value", "mounted", ds.mem(name)])).trim() === "no") await run("zfs", ["mount", ds.mem(name)])
  return memDir(name)
}

/** `name` as a copy-on-write clone of a memory snapshot: what used to be a `cp` of up to 16 GB. */
export async function memClone(snapshot: string, name: string) {
  await destroyMem(name, { wait: true })
  await run("zfs", ["clone", snapshot, ds.mem(name)])
  return memDir(name)
}

/**
 * What a box wrote into its memory files is on disk: before a saved RAM is called loadable, so a
 * host that crashes right after does not bring back an older file under a registry that trusts it.
 * Not needed after a `zfs snapshot` or `zfs clone`: each syncs the pool's transaction group.
 */
export const commitMem = () => run("zpool", ["sync", POOL], { timeoutMs: 10 * 60_000 })

/**
 * Destroy a memory dataset. One a box still maps (a template's file, loaded by boxes that have not
 * stopped since) cannot be unmounted: it goes to the graveyard, retried by the sweep — what an
 * unlinked file did on ext4, its inode kept until the last mapping went. `wait`: the name is about
 * to be reused, a busy one is an error.
 */
export async function destroyMem(name: string, opts: { wait?: boolean } = {}) {
  const bury = () => {
    const g = (reg().memGraveyard ??= [])
    if (!g.includes(name)) g.push(name)
    save()
    console.warn(`[firecracker] ${ds.mem(name)} is still mapped by a running box: destroyed later`)
  }
  // Not even tried while a box runs from its file: `destroyDataset` would promote the boxes' clones
  // first — taking its `@ready` with them — then fail on the mapping, and the boxes still loaded
  // from it would find nothing to clone at their next stop (a Full of their whole RAM).
  if (!opts.wait && (await mappedBy(name))) return bury()
  try {
    await destroyDataset(ds.mem(name))
    forgive(name)
  } catch (err) {
    if (opts.wait || !/busy/i.test(err instanceof Error ? err.message : "")) throw err
    bury()
  }
}

/** A box whose RAM is loaded from a file of `name` (a template's), its VMM still running. */
export async function mappedBy(name: string) {
  for (const vm of Object.values(reg().vms)) {
    if (vm.base?.startsWith(`${memDir(name)}/`) && (await unitActive(vm.handle))) return vm.handle
  }
  return undefined
}

/** Snapshots in the memory datasets exist to be cloned: one left without a clone is only kept for this long. */
export const MEM_SNAPSHOT_GRACE_S = 10 * 60
/**
 * Every 10 min: the graveyard again, and memory snapshots no clone depends on any more — the
 * `@<ref>` of a source whose copy is gone, or one a promote moved — except a template's `@ready`.
 */
export async function sweepMem() {
  // Under the name's lock, and only if it is still the graveyard's: a box's handle is given again
  // by a rebuild, whose operations take that lock and take the name back (`forgive`).
  for (const name of [...(reg().memGraveyard ?? [])]) {
    await serial(name, async () => {
      if (reg().memGraveyard?.includes(name)) await destroyMem(name)
    }).catch(() => {})
  }
  const out = await run("zfs", ["list", "-H", "-p", "-t", "snapshot", "-o", "name,clones,creation", "-r", `${DATASET}/mem`]).catch(() => "")
  const now = Date.now() / 1000
  for (const line of out.split("\n")) {
    const [snap, clones, creation] = line.split("\t")
    if (!snap || (clones && clones !== "-") || now - Number(creation) < MEM_SNAPSHOT_GRACE_S) continue
    const [dataset, tag] = snap.split("@") as [string, string]
    if (tag === "ready" && reg().templates[dataset.split("/").pop()!]) continue
    await run("zfs", ["destroy", snap]).catch(() => {})
  }
}
