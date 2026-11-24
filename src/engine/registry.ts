import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { SandboxError } from "./types"
import { STATE } from "./config"
import type { RamKind } from "./types"

// ── Registry ────────────────────────────────────────────────────────────────

export type Snapshot = {
  vmstate: string
  mem: string
  /** The mem file is this box's own (not a template's): a Diff can be merged into it. */
  own: boolean
  /**
   * The RAM still matches the disk: true only after a `saveRam` that went through, false as soon as
   * it is loaded. Once the box has run, its disk moved on — loading that RAM again (after a crash,
   * a host reboot, a VMM the OOM killer took) would put stale page cache and ext4 state over a newer
   * disk. The file stays, as the base a Diff is merged into; it is never loaded as is again.
   */
  loadable: boolean
  /**
   * The kernel in that RAM (`kernelId`). One other than the machine's means a box that would keep
   * running an old kernel: the start shuts it down cleanly and boots the disk on the current one.
   * Absent: a RAM saved before kernels were tracked — the CI kernel, so not ours.
   */
  kernel?: string
  at: string
}

export type Vm = {
  handle: string
  sandboxId: string
  name: string
  size: string
  image: string
  imageId?: string
  /** Its /30 in 10.89.0.0/16. */
  net: number
  /** The platform's env, token included — fed to the box through MMDS at every boot and load. */
  env: Record<string, string>
  /** The platform's labels for the box (`CreateInput.labels`): shown by `ctl list`, nothing more. */
  labels?: Record<string, string>
  bootstrap: string
  /** `destroying` stays in the registry until the disks are gone: a failure is seen, and retried at the next start. */
  state: "creating" | "running" | "stopping" | "stopped" | "archived" | "destroying" | "error"
  /**
   * Of the `stopping` in progress (RFC 0039 § 20): `pause` writes the RAM (a start resumes it),
   * `stop` shuts the guest down and drops it (a start boots). Absent: a pause (before § 20).
   */
  stopKind?: "pause" | "stop"
  /** Of the destroy in progress: a rebuild keeps /workspace. */
  keepVolumes?: boolean
  step?: string
  error?: string
  /** RAM of a stopped box, loadable or not (`Snapshot.loadable`). None: the next start boots from the disk. */
  snapshot?: Snapshot
  /** Diff snapshots are possible: the running VM tracks dirty pages and was loaded from `snapshot.mem`. */
  diffable?: boolean
  /** Found stopped rather than stopped on purpose (a host reboot): what was seen. Cleared at the next start, and by an archive. */
  stoppedWhy?: string
  /**
   * Of a box found `stopped` because its VMM died on its own (the OOM killer, a crash): its unit's
   * record (`deathOf`), read before a start wipes it — `describe` keeps saying `error` and why.
   * Cleared by a start, a stop (the platform saw it and wants it just stopped) and an archive.
   */
  died?: { result: string; detail: string }
  /** Booted from its disk and not written since: a Diff holds all of its memory (`ramKindOf`). */
  sinceBoot?: boolean
  /** Loaded from a template's memory file (a model, a prebuild): what a Diff of it goes over. */
  base?: string
  /** The template (its RAM is loaded at first start) or the build (its disk is booted) it came from. */
  from?: string
  /** The kernel it booted, carried by its RAM: what its next snapshot records. */
  kernel?: string
  archive?: { at: string; root: string; ws: string; bytes: number }
  timings?: Record<string, number>
  createdAt: string
}

/**
 * A frozen box: its RAM and device state in its memory dataset (`<dataset>/mem/<ref>`, `@ready`),
 * its disks snapshotted at the same instant. Four kinds:
 *  - `prebuild` (no `kind`, the old path): reusable, its disks clones of its own
 *    (`<dataset>/templates/<ref>-{root,ws}@ready`) so the box it came from can go;
 *  - `user`: the same, for one member's sandboxes of one project (a model with their secrets);
 *  - `disks`: a `user` without RAM (`snapshotDisks`) — `vmstate` and `mem` empty, its boxes boot
 *    its disks, postStart included;
 *  - `fork`: one copy, once — its disks are the source's `@<ref>` snapshots, its memory dataset is
 *    renamed to be the copy's own, and the record goes when the copy is made.
 */
export type Template = {
  ref: string
  handle: string
  size: string
  kind?: "prebuild" | "user" | "disks" | "fork"
  state: "pending" | "ready" | "error"
  error?: string
  /** Empty for `disks`: nothing to load. */
  vmstate: string
  mem: string
  kernel?: string
  /** A fork's disks: the source's snapshots, cloned as they are. */
  disks?: { root: string; ws: string }
  /** How long the source was paused, and what its RAM was written as. */
  pauseMs?: number
  ramKind?: RamKind
  createdAt: string
}
/** `digest`: what `image` pointed at when it was unpacked — absent for the disks of before 2026-11-10, keyed by the reference alone. */
export type Image = { id: string; image: string; digest?: string; state: "ready" | "error"; error?: string; bytes?: number; createdAt: string }
/**
 * A project version's recipe, run in a builder microVM (RFC 0037 `build`): its root disk, snapshotted
 * `@ready` in `<dataset>/builds/<ref>`, is what `create({ from: ref })` clones. The log is the
 * builder's serial console (`builds/<ref>/console.log`), read again at every `buildStatus`.
 */
export type Build = {
  ref: string
  buildId: string
  image: string
  size: string
  net: number
  state: "running" | "ready" | "failed"
  phase: string
  /** The host's own lines around the recipe's (its steps), in order: before the builder, after it. */
  pre: string
  post: string
  error?: string
  bytes?: number
  timings?: Record<string, number>
  createdAt: string
}
export type Registry = {
  vms: Record<string, Vm>
  templates: Record<string, Template>
  images: Record<string, Image>
  builds: Record<string, Build>
  /** Memory datasets to destroy once nothing maps their file any more (`destroyMem`). */
  memGraveyard?: string[]
}

export let registry: Registry | null = null
export const registryFile = () => join(STATE, "registry.json")

export function reg(): Registry {
  if (registry) return registry
  try {
    registry = JSON.parse(readFileSync(registryFile(), "utf8")) as Registry
  } catch {
    registry = { vms: {}, templates: {}, images: {}, builds: {} }
  }
  registry.builds ??= {}
  return registry
}

export function save() {
  mkdirSync(STATE, { recursive: true, mode: 0o700 })
  const tmp = `${registryFile()}.tmp`
  writeFileSync(tmp, JSON.stringify(reg(), null, 2), { mode: 0o600 })
  renameSync(tmp, registryFile())
}

export function vmOf(handle: string): Vm {
  const vm = reg().vms[handle]
  if (!vm) throw new SandboxError(`no such sandbox ${handle}`, "not_found")
  return vm
}

/** One operation at a time per box (a start waits for the stop that is still saving RAM). */
export const locks = new Map<string, Promise<unknown>>()
export function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  locks.set(key, next)
  void next.finally(() => locks.get(key) === next && locks.delete(key)).catch(() => {})
  return next
}

/** Forget the registry in memory: the next `reg()` reads the file again (a test's restart). */
export function resetRegistry() {
  registry = null
}
