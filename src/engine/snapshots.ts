import { kernelId } from "./host"
import { existsSync, renameSync, rmSync, statSync, truncateSync } from "node:fs"
import { join } from "node:path"
import type { RamKind } from "./types"
import { SandboxError } from "./types"

import { BIN, STATE, sizeOf } from "./config"
import { engine } from "./engine"
import { ensureHost } from "./host"
import { ms, run } from "./host-commands"
import { waitInactive } from "./images"
import { uidOf, withVmmPaths } from "./jail"
import { allocatedOf, commitMem, destroyMem, inMem, memClone, memDir, memEnsure, memFresh, memNameOf, noRoomFor, ramBytesOf } from "./memory"
import { Snapshot, Template, Vm, reg, save, serial, vmOf } from "./registry"
import { fc, loadSnapshot, stopVmm, unitActive } from "./vmm"
import { destroyDataset, dev, ds, scratchOf } from "./zfs"

/**
 * Freeze a running box for a copy of it, the shortest pause possible:
 *  0. before the pause, its base made ready (`prepareBase`): nothing long happens once it is paused;
 *  1. pause; write its RAM into a new file of its memory dataset — a **Diff** (only the pages it
 *     dirtied since its last snapshot) when there is a base to merge it into, a Full otherwise —
 *     without an fsync (`sync_snapshot_files: false`: the pause does not wait for the disk);
 *     snapshot both disks; resume. The source runs again as soon as that is done — `pauseMs`;
 *  2. `finish`, under the source's lock still (a stop waits for it): merge the Diff into the
 *     source's base — a snapshot resets the dirty log, so its next Diff starts from here and its
 *     base must hold these pages too — then `zfs snapshot` it and clone that for the copy, with
 *     this instant's device state. After a Full, the file becomes the base: its next fork or stop
 *     is a Diff.
 *
 * The source's memory file may back its RAM (a warm start: `MAP_PRIVATE`): the Diff only touches
 * pages the guest wrote, which it holds privately already — it never sees the merge.
 */
export async function freeze(vm: Vm, ref: string) {
  const kind = await prepareBase(vm)
  // Refused before the pause, the box untouched: its RAM would go into the pool its disks are in.
  const full = await noRoomFor(await ramBytesOf(vm))
  if (full) throw new SandboxError(full, "capacity")
  forgetDirtySince(vm)
  const dir = memDir(vm.handle)
  const mem = join(dir, "mem")
  const written = join(scratchOf(vm.handle), ref)
  const vmstate = join(dir, `vmstate.${ref}`)
  rmSync(written, { force: true })
  let t0 = performance.now()
  let ramMs = 0
  let pauseMs = 0
  // Bound into its jail before the pause, unbound after the resume: nothing more in the pause.
  await withVmmPaths(vm.handle, uidOf(vm.net), [{ path: vmstate, own: true }, { path: written, own: true }], async ([vmstatePath, writtenPath]) => {
    t0 = performance.now()
    await fc(vm.handle, "PATCH", "/vm", { state: "Paused" })
    try {
      await fc(vm.handle, "PUT", "/snapshot/create", { snapshot_type: kind === "Full" ? "Full" : "Diff", snapshot_path: vmstatePath, mem_file_path: writtenPath, sync_snapshot_files: false }, 10 * 60_000)
      ramMs = ms(t0)
      // Disks and RAM of the same instant: the box is paused while both are taken — the disks after
      // the RAM, whose snapshot fsyncs the block devices (guest writes still in the host's cache).
      await run("zfs", ["snapshot", `${ds.root(vm.handle)}@${ref}`, `${ds.ws(vm.sandboxId)}@${ref}`])
    } catch (err) {
      rmSync(written, { force: true })
      throw err
    } finally {
      await fc(vm.handle, "PATCH", "/vm", { state: "Resumed" })
      pauseMs = ms(t0)
    }
  })
  const finish = async () => {
    await mergeInto(vm, kind, written).finally(() => rmSync(written, { force: true }))
    // Its own base from now on, current as of this freeze — not loadable: the box runs on. Only
    // now can its next write be a Diff again (`forgetDirtySince`).
    vm.snapshot = { vmstate: join(dir, "vmstate"), mem, own: true, loadable: false, kernel: vm.kernel, at: new Date().toISOString() }
    vm.diffable = true
    save()
    // The copy's memory: that base as of now, copy-on-write, and this instant's device state.
    await run("zfs", ["snapshot", `${ds.mem(vm.handle)}@${ref}`])
    rmSync(vmstate, { force: true })
    const copy = await memClone(`${ds.mem(vm.handle)}@${ref}`, ref)
    renameSync(join(copy, `vmstate.${ref}`), join(copy, "vmstate"))
    // On disk before the copy is called ready: after a crash, never this RAM with an older vmstate.
    await commitMem()
  }
  return { pauseMs, ramMs, kind, finish, disks: { root: `${ds.root(vm.handle)}@${ref}`, ws: `${ds.ws(vm.sandboxId)}@${ref}` } }
}

/**
 * A copy of a running box, as a template `create({ from })` takes: answered once the source runs
 * again (the pause); the memory of the copy is made after, and `create` waits for it.
 * `kind: "fork"` is for one copy; `user` and `prebuild` stay, their disks cloned for themselves.
 */
export async function freezeTemplate(handle: string, kind: NonNullable<Template["kind"]>): Promise<Template> {
  await ensureHost()
  const vm = vmOf(handle)
  if (vm.state !== "running" || !(await unitActive(handle))) throw new SandboxError(`only a running sandbox can be copied (this one is ${vm.state})`, "invalid")
  const prefix = kind === "fork" ? "frk" : kind === "user" ? "usr" : "tpl"
  const ref = `${prefix}-${handle.replace(/^sbx-/, "")}-${Date.now().toString(36)}`
  const dir = memDir(ref)
  const tpl: Template = { ref, handle, size: vm.size, kind, state: "pending", vmstate: join(dir, "vmstate"), mem: join(dir, "mem"), kernel: vm.kernel, createdAt: new Date().toISOString() }
  // Known from now: a create from it waits for it (`readyTemplateOf`), whatever this call answers.
  reg().templates[ref] = tpl
  save()
  let paused!: () => void
  const resumed = new Promise<void>((r) => (paused = r))
  void serial(handle, async () => {
    const t0 = performance.now()
    try {
      if (vm.state !== "running") throw new SandboxError(`the sandbox stopped before it could be copied (${vm.state})`, "invalid")
      const frozen = await freeze(vm, ref)
      Object.assign(tpl, { pauseMs: frozen.pauseMs, ramKind: frozen.kind, disks: kind === "fork" ? frozen.disks : undefined })
      save()
      paused()
      await frozen.finish()
      // Deleted while its memory was being made (`deleteTemplate` does not wait for the source's
      // lock): what was made goes, below, instead of staying with nothing to name it.
      if (reg().templates[ref] !== tpl) throw new SandboxError("deleted while it was being made")
      if (kind !== "fork") {
        for (const [part, snap] of [["root", frozen.disks.root], ["ws", frozen.disks.ws]] as const) {
          await run("zfs", ["clone", snap, ds.tpl(ref, part)])
          await run("zfs", ["snapshot", `${ds.tpl(ref, part)}@ready`])
        }
        // What the boxes from it clone their own base from (`prepareBase`).
        await run("zfs", ["snapshot", `${ds.mem(ref)}@ready`])
      }
      tpl.state = "ready"
      console.log(`[firecracker] ${kind} ${ref} of ${handle}: paused ${frozen.pauseMs} ms (${frozen.kind}, RAM written in ${frozen.ramMs} ms), memory ready in ${ms(t0)} ms`)
    } catch (err) {
      tpl.state = "error"
      tpl.error = err instanceof Error ? err.message : String(err)
      console.error(`[firecracker] ${kind} ${ref} failed:`, err)
      paused()
      // What it had made: the snapshots of the source's disks and memory (a clone holds them: then
      // they stay), the copy's memory, this instant's device state.
      for (const snap of [`${ds.root(handle)}@${ref}`, `${ds.ws(vm.sandboxId)}@${ref}`]) await run("zfs", ["destroy", snap]).catch(() => {})
      await destroyMem(ref).catch(() => {})
      await run("zfs", ["destroy", `${ds.mem(handle)}@${ref}`]).catch(() => {})
      rmSync(join(memDir(handle), `vmstate.${ref}`), { force: true })
    }
    save()
  })
  // Once the source runs again — or within the platform's budget, whatever a Full takes (a box
  // booted from its disk has no memory file to diff against: 7 to 16 s for 2 to 4 GB).
  await Promise.race([resumed, new Promise((r) => setTimeout(r, 7_000))])
  // Failed before answering (the box stopped meanwhile, a snapshot refused): an error, not a ref.
  if (tpl.state === "error") throw new SandboxError(`the sandbox could not be frozen: ${tpl.error}`)
  return tpl
}

/**
 * A running box's disks, as `create({ from })` boots them (RFC 0060): no RAM written, so the pause is
 * the time of a `zfs snapshot` — milliseconds, whatever the box holds in memory. The platform has
 * the guest `sync` first (its page cache); the box is paused while its block devices are flushed
 * (what Firecracker wrote is still in the host's cache of the zvols, which a `zfs snapshot` does
 * not see) and both disks snapshotted in one command: the same instant for `/` and `/workspace`.
 * Cloned into the template's own datasets at once, so the box it came from can go.
 */
export async function freezeDisks(handle: string): Promise<Template> {
  await ensureHost()
  return serial(handle, async () => {
    const vm = vmOf(handle)
    if (vm.state !== "running" || !(await unitActive(handle))) throw new SandboxError(`only a running sandbox can be snapshotted (this one is ${vm.state})`, "invalid")
    const ref = `dsk-${handle.replace(/^sbx-/, "")}-${Date.now().toString(36)}`
    const disks = { root: `${ds.root(vm.handle)}@${ref}`, ws: `${ds.ws(vm.sandboxId)}@${ref}` }
    const t0 = performance.now()
    await fc(vm.handle, "PATCH", "/vm", { state: "Paused" })
    let pauseMs: number
    try {
      await run("blockdev", ["--flushbufs", dev(ds.root(vm.handle)), dev(ds.ws(vm.sandboxId))])
      await run("zfs", ["snapshot", disks.root, disks.ws])
    } finally {
      await fc(vm.handle, "PATCH", "/vm", { state: "Resumed" })
      pauseMs = ms(t0)
    }
    try {
      for (const [part, snap] of [["root", disks.root], ["ws", disks.ws]] as const) {
        await run("zfs", ["clone", snap, ds.tpl(ref, part)])
        await run("zfs", ["snapshot", `${ds.tpl(ref, part)}@ready`])
      }
    } catch (err) {
      for (const part of ["root", "ws"] as const) await destroyDataset(ds.tpl(ref, part)).catch(() => {})
      for (const snap of [disks.root, disks.ws]) await run("zfs", ["destroy", snap]).catch(() => {})
      throw err
    }
    const tpl: Template = { ref, handle, size: vm.size, kind: "disks", state: "ready", vmstate: "", mem: "", kernel: vm.kernel, pauseMs, createdAt: new Date().toISOString() }
    reg().templates[ref] = tpl
    save()
    console.log(`[firecracker] disks ${ref} of ${handle}: paused ${pauseMs} ms`)
    return tpl
  })
}

/**
 * A fork is for one copy, made at once: one nobody made a copy of within 30 min (the platform's
 * insert or its create failed, its retries gave up) goes — its RAM file and the snapshots of its
 * source's disks would stay for good otherwise.
 */
export const FORK_TTL_MS = 30 * 60_000
export async function sweepForks() {
  for (const tpl of Object.values(reg().templates)) {
    if (tpl.kind !== "fork" || tpl.state === "pending" || Date.now() - Date.parse(tpl.createdAt) < FORK_TTL_MS) continue
    console.warn(`[firecracker] fork ${tpl.ref} never copied: deleting it`)
    await engine.deleteTemplate({ ref: tpl.ref }).catch((err) => console.warn(`[firecracker] could not delete ${tpl.ref}:`, err))
  }
}

/** A template being made (a fork's memory being copied): waited for, up to 10 min. */
export async function readyTemplateOf(ref: string): Promise<Template | undefined> {
  for (let i = 0; i < 6000; i++) {
    const tpl = reg().templates[ref]
    if (!tpl || tpl.state !== "pending" || tpl.kind !== "fork") return tpl
    await new Promise((r) => setTimeout(r, 100))
  }
  return reg().templates[ref]
}

/**
 * Bring the disk up to date with the box, when its RAM is about to be thrown away while the disk
 * stays (a rebuild keeping /workspace, an archive). Killing the VMM, or keeping only the disk of a
 * box whose RAM is saved, loses what the guest's page cache had not written yet — seen on the first
 * rebuild: a file written 2 s before was gone. A box whose RAM is saved is loaded first.
 */
export async function cleanShutdown(vm: Vm, waitMs = 15_000) {
  const t0 = performance.now()
  if (!(await unitActive(vm.handle))) {
    // Not running, and no RAM that matches the disk: there is no page cache left to write.
    if (!canLoad(vm.snapshot)) return
    try {
      await loadSnapshot(vm, vm.snapshot!)
    } catch (err) {
      // A RAM this Firecracker cannot load any more: nothing to write back, the disk is what is left.
      console.warn(`[firecracker] ${vm.handle}: its RAM did not load for a clean shutdown (${err instanceof Error ? err.message : err})`)
      await stopVmm(vm.handle)
      vm.snapshot = undefined
      return
    }
  }
  try {
    await fc(vm.handle, "PATCH", "/vm", { state: "Resumed" }).catch(() => {})
    await fc(vm.handle, "PUT", "/actions", { action_type: "SendCtrlAltDel" })
    await waitInactive(vm.handle, waitMs, 100)
  } catch (err) {
    console.warn(`[firecracker] ${vm.handle}: no clean shutdown (${err instanceof Error ? err.message : err})`)
  }
  await stopVmm(vm.handle)
  vm.snapshot = undefined
  vm.timings = { ...vm.timings, shutdownMs: ms(t0) }
}

/** Where a box's memory files were before the datasets (`memDir`): read, copied in, never written. */
export const vmDir = (handle: string) => join(STATE, "vms", handle)

/** Room in the pool for a copy of `file` (what it holds, at worst), with the margin new boxes keep. */
export const roomFor = async (file: string) => !(await noRoomFor(allocatedOf(file)))

export let migrating: Promise<void> | null = null
/**
 * Memory files from before the datasets — templates' (`templates/<ref>/`), then boxes' own bases
 * (`vms/<handle>/`), stopped or running — copied in once, after a start of the daemon, one at a
 * time in the background: the copy of old is paid here rather than by the next fork or stop (which
 * would make it themselves, `prepareBase`). They stay loadable meanwhile, and after: a box whose
 * RAM is saved keeps it. A box's file is copied without its lock (nothing writes such a file any
 * more), then switched under it, unless its base changed meanwhile. A file the pool has no room for
 * stays where it is. `SPUNTO_FC_MEM_MIGRATE=0` leaves them all.
 */
/** Templates' moves in flight, by ref: the migration and a box's stop share one. */
export const templateMoves = new Map<string, Promise<void>>()
/**
 * A template's memory from before the datasets moved into `mem/<ref>` with its `@ready`, once:
 * every box loaded from it is pointed at the new file, then the old one goes — after, never under
 * a box that was about to copy it. A file the pool has no room for stays where it is.
 */
export function moveTemplateIn(tpl: Template): Promise<void> {
  let move = templateMoves.get(tpl.ref)
  if (move) return move
  move = (async () => {
    if (tpl.kind === "fork" || tpl.state !== "ready" || inMem(tpl.mem) || !existsSync(tpl.mem)) return
    if (!(await roomFor(tpl.mem))) return void console.warn(`[firecracker] no room in the pool to move the memory of ${tpl.ref}: it stays on the host's disk`)
    const old = tpl.mem
    const t0 = performance.now()
    try {
      await copyIn(tpl.ref, old)
      await run("zfs", ["snapshot", `${ds.mem(tpl.ref)}@ready`])
    } catch (err) {
      console.warn(`[firecracker] could not move the memory of ${tpl.ref}:`, err)
      return void (await destroyMem(tpl.ref).catch(() => {}))
    }
    // Deleted meanwhile: its copy goes too.
    if (reg().templates[tpl.ref] !== tpl) return void (await destroyMem(tpl.ref).catch(() => {}))
    tpl.mem = join(memDir(tpl.ref), "mem")
    tpl.vmstate = join(memDir(tpl.ref), "vmstate")
    // Boxes loaded from it: their next write clones the dataset (boxes running from the old file keep its inode).
    for (const vm of Object.values(reg().vms)) if (vm.base === old) vm.base = tpl.mem
    save()
    rmSync(join(old, ".."), { recursive: true, force: true })
    console.log(`[firecracker] memory of ${tpl.ref} moved into ${ds.mem(tpl.ref)} in ${ms(t0)} ms`)
  })().finally(() => templateMoves.delete(tpl.ref))
  templateMoves.set(tpl.ref, move)
  return move
}

export function migrateLegacyMemory(): Promise<void> {
  migrating ??= (async () => {
    for (const tpl of Object.values(reg().templates)) await moveTemplateIn(tpl)
    for (const vm of Object.values(reg().vms)) {
      const snap = vm.snapshot
      if (!snap?.own || inMem(snap.mem) || !existsSync(snap.mem) || !["running", "stopped"].includes(vm.state)) continue
      if (!(await roomFor(snap.mem))) {
        console.warn(`[firecracker] no room in the pool to move the memory of ${vm.handle}: it stays on the host's disk`)
        continue
      }
      const t0 = performance.now()
      const moving = `${vm.handle}-moving`
      try {
        await copyIn(moving, snap.mem)
      } catch (err) {
        console.warn(`[firecracker] could not move the memory of ${vm.handle}:`, err)
        await destroyMem(moving).catch(() => {})
        continue
      }
      await serial(vm.handle, async () => {
        // A stop or a freeze made it a new base meanwhile (in its dataset), or it is gone.
        if (vm.snapshot !== snap || reg().vms[vm.handle] !== vm) return void (await destroyMem(moving).catch(() => {}))
        await destroyMem(vm.handle, { wait: true })
        await run("zfs", ["rename", ds.mem(moving), ds.mem(vm.handle)])
        adoptLegacyBase(vm, memDir(vm.handle))
        console.log(`[firecracker] memory of ${vm.handle} moved into ${ds.mem(vm.handle)} in ${ms(t0)} ms`)
      }).catch((err) => console.warn(`[firecracker] could not move the memory of ${vm.handle}:`, err))
    }
  })().catch((err) => console.warn("[firecracker] moving memory files into the pool stopped:", err))
  return migrating
}

/** A saved RAM a start may load: written by a `saveRam` that went through, never loaded since. */
export const canLoad = (snap?: Snapshot) => !!snap && snap.loadable === true && existsSync(snap.mem) && existsSync(snap.vmstate)

/** A RAM taken under another kernel: loading it would keep that kernel running (§ 4.1). */
export const sameKernel = (snap: { kernel?: string }) => !!snap.kernel && snap.kernel === kernelId

/**
 * How a box's RAM is written — only what it dirtied, whenever there is something to go over:
 *  - `Diff`: over its own memory file (it was loaded from it, or frozen since), merged into it;
 *  - `Boot`: booted from its disk, never written since — a Diff of a booted VM holds all of its
 *    memory and loads as is (Firecracker's snapshot docs): what the guest never touched is a hole;
 *  - `Template`: loaded from a template's file (a member's model, a prebuild), never written
 *    since: a Diff over a copy of that file;
 *  - `Full` otherwise (a box from a daemon that did not track these): every page, zeros included —
 *    16 GB written in 201 s for an xlarge on Canada (§ 15), against a few hundred MB.
 */

export function ramKindOf(vm: Pick<Vm, "handle" | "diffable" | "snapshot" | "sinceBoot" | "base">): RamKind {
  // Its base in its memory dataset — or still where it was before them, moved in by `prepareBase`.
  const own = [join(memDir(vm.handle), "mem"), join(vmDir(vm.handle), "mem")]
  if (vm.diffable && vm.snapshot?.own && own.includes(vm.snapshot.mem) && existsSync(vm.snapshot.mem)) return "Diff"
  if (vm.sinceBoot) return "Boot"
  if (vm.base && existsSync(vm.base)) return "Template"
  return "Full"
}

/**
 * Before a snapshot: Firecracker starts its dirty log over at every `snapshot/create`, so from then
 * on "dirty since the boot" and "dirty since the template" are false, and "dirty since its own
 * file" holds only once that file has this snapshot's pages (the end of `freeze`'s `finish`, or a
 * stop that went through). Forgotten **before** the call: whatever fails after it (a `zfs snapshot`,
 * a clone, a merge, a full pool), the next write is a Full — never a Diff over a base that misses
 * pages, which would load back as zeros.
 */
export function forgetDirtySince(vm: Vm) {
  vm.sinceBoot = false
  vm.base = undefined
  vm.diffable = false
  save()
}

/**
 * Before the pause, so that nothing long happens once the box is paused: the memory dataset the
 * snapshot goes into, and the base its Diff will be merged into —
 *  - `Template`: a clone of the template's `@ready` (instantaneous; until 2026-10-11, a `cp` of
 *    the template's whole file after the pause). Once cloned, the template can go: a clone keeps
 *    its blocks. One whose memory is still a file from before the datasets is copied in, once;
 *  - `Diff` over a base from before the datasets (`vms/<handle>/mem`): copied in, once;
 *  - otherwise, the dataset as it is (a Full or a Boot writes a file of its own).
 * Anything failing here makes it a Full, written into the box's dataset: never a Diff over a base
 * that is not all there.
 */
export async function prepareBase(vm: Vm): Promise<RamKind> {
  let kind = ramKindOf(vm)
  try {
    // A model whose memory is still a file from before the datasets: moved in once (`moveTemplateIn`,
    // the same move as the migration's, never two at once), then cloned like any other.
    const old = kind === "Template" && !inMem(vm.base) ? Object.values(reg().templates).find((t) => t.mem === vm.base) : undefined
    if (old) await moveTemplateIn(old)
    if (kind === "Template" && inMem(vm.base)) await memClone(`${ds.mem(memNameOf(vm.base!))}@ready`, vm.handle)
    else if (kind === "Template") await copyIn(vm.handle, vm.base!)
    else if (kind === "Diff" && !inMem(vm.snapshot!.mem)) await adoptLegacyBase(vm, await copyIn(vm.handle, vm.snapshot!.mem))
    else await memEnsure(vm.handle)
  } catch (err) {
    if (kind === "Full" || kind === "Boot") throw err
    console.warn(`[firecracker] ${vm.handle}: no base for a ${kind} (${err instanceof Error ? err.message : err}) — a Full instead`)
    kind = "Full"
    await memEnsure(vm.handle)
  }
  return kind
}

/**
 * A memory file from before the datasets copied into a fresh dataset `name` (`mem`, and its
 * `vmstate` when it has one next to it): the slow copy of old, made once per file — sparse, and
 * lz4 drops its blocks of zeros.
 */
export async function copyIn(name: string, file: string) {
  const full = await noRoomFor(allocatedOf(file))
  if (full) throw new SandboxError(full, "capacity")
  const dir = await memFresh(name)
  await run("cp", ["--sparse=always", file, join(dir, "mem")], { timeoutMs: 30 * 60_000 })
  const vmstate = join(file, "..", "vmstate")
  if (existsSync(vmstate)) await run("cp", [vmstate, join(dir, "vmstate")])
  return dir
}

/** A box's base copied into its dataset (`copyIn`): it is the one from now on, the old file goes. */
export function adoptLegacyBase(vm: Vm, dir: string) {
  const old = vm.snapshot!
  vm.snapshot = { ...old, mem: join(dir, "mem"), vmstate: join(dir, "vmstate") }
  save()
  // A box running from that file (a warm start) keeps its inode until it stops.
  rmSync(vmDir(vm.handle), { recursive: true, force: true })
}

/** A memory file as long as the box's RAM: a Diff may stop at the last page it wrote. */
export function fullLength(file: string, vm: Pick<Vm, "size">) {
  const bytes = sizeOf(vm.size).memMib * 1024 ** 2
  if (statSync(file).size < bytes) truncateSync(file, bytes)
}

/**
 * After the pause: what the snapshot wrote (in SCRATCH) becomes the box's base, in its dataset — a
 * Diff (`Diff`, `Template`) merged into it by `snapshot-editor` (only the pages it holds: the base
 * is a clone, the rest of it shared), a Full or a Boot copied in sparse, then renamed over it. A
 * base the box's RAM maps (`MAP_PRIVATE`, a warm start) keeps what the guest sees: a Diff only holds
 * pages the guest has privately, a rename leaves the mapped inode as it was. The caller deletes
 * `written`.
 */
export async function mergeInto(vm: Vm, kind: RamKind, written: string) {
  const mem = join(memDir(vm.handle), "mem")
  // Checked again with what was really written (the check before the pause was an upper bound,
  // other boxes may have written since).
  const full = await noRoomFor(allocatedOf(written))
  if (full) throw new SandboxError(full, "capacity")
  if (kind === "Diff" || kind === "Template") {
    await run(BIN("snapshot-editor"), ["edit-memory", "rebase", "--memory-path", mem, "--diff-path", written], { timeoutMs: 30 * 60_000 })
  } else {
    if (kind === "Boot") fullLength(written, vm)
    rmSync(`${mem}.new`, { force: true })
    await run("cp", ["--sparse=always", written, `${mem}.new`], { timeoutMs: 30 * 60_000 })
    renameSync(`${mem}.new`, mem)
  }
}

/**
 * Pause, write RAM and device state, then let the process go: only the pages the box dirtied when
 * there is a base to merge them into, or nothing before them (`ramKindOf`); a Full otherwise.
 */
export async function saveRam(vm: Vm) {
  const t0 = performance.now()
  const kind = await prepareBase(vm)
  // Before anything is paused or forgotten: a box the pool cannot take the RAM of is shut down
  // cleanly by the caller instead — its disk whole, its processes lost.
  const full = await noRoomFor(await ramBytesOf(vm))
  if (full) throw new NoRoom(full)
  forgetDirtySince(vm)
  const dir = memDir(vm.handle)
  const mem = join(dir, "mem")
  const vmstate = join(dir, "vmstate")
  const written = join(scratchOf(vm.handle), "stop")
  for (const f of [written, `${vmstate}.new`]) rmSync(f, { force: true })
  let tp = performance.now()
  let tPause = 0
  let ramMs = 0
  await withVmmPaths(vm.handle, uidOf(vm.net), [{ path: `${vmstate}.new`, own: true }, { path: written, own: true }], async ([vmstatePath, writtenPath]) => {
    tp = performance.now()
    await fc(vm.handle, "PATCH", "/vm", { state: "Paused" })
    tPause = ms(tp)
    await fc(vm.handle, "PUT", "/snapshot/create", { snapshot_type: kind === "Full" ? "Full" : "Diff", snapshot_path: vmstatePath, mem_file_path: writtenPath, sync_snapshot_files: false }, 10 * 60_000).catch((err) => {
      rmSync(written, { force: true })
      throw err
    })
    ramMs = ms(tp)
  })
  // The VMM stays, paused, until its RAM is in the pool: if that fails, the caller can still shut
  // the box down cleanly (`finishStop`) rather than lose what its page cache held for the disk.
  await mergeInto(vm, kind, written).finally(() => rmSync(written, { force: true }))
  renameSync(`${vmstate}.new`, vmstate)
  // On disk before it is called loadable.
  await commitMem()
  await stopVmm(vm.handle)
  vm.snapshot = { vmstate, mem, own: true, loadable: true, kernel: vm.kernel, at: new Date().toISOString() }
  vm.timings = { ...vm.timings, pauseMs: tPause, stopRamMs: ramMs, [`stop${kind}Ms`]: ms(t0) }
  console.log(`[firecracker] ${vm.handle}: ${kind} snapshot in ${ms(t0)} ms (RAM written in ${ramMs} ms)`)
}

/** A stop that cannot keep the RAM: no room for it in the pool. */
export class NoRoom extends SandboxError {
  constructor(why: string) {
    super(why, "capacity")
  }
}

/** The slow half of a stop or a pause: a clean shutdown, or the RAM written if the VMM is still there. */
export async function finishStop(vm: Vm) {
  // A destroy queued meanwhile has taken over the box.
  if (vm.state !== "stopping") return
  if (vm.stopKind === "stop") {
    // RAM dropped on purpose: what the guest's page cache holds reaches the disk first. A paused
    // box is loaded once more for that (`cleanShutdown`).
    await cleanShutdown(vm)
    vm.stoppedWhy = undefined
    vm.stopKind = undefined
    if (vm.state === "stopping") vm.state = "stopped"
    save()
    return
  }
  try {
    // A VMM already gone (OOM, crash): nothing to save, and its last RAM no longer matches the disk.
    if (await unitActive(vm.handle)) await saveRam(vm)
  } catch (err) {
    // The RAM is not kept (no room for it, a failed write or merge): a clean shutdown, so that the
    // disk has what the guest's page cache held — powered off, never a box whose disk lost writes.
    console.error(`[firecracker] pause ${vm.handle}: its RAM is not kept, shutting it down cleanly:`, err)
    vm.stoppedWhy = `its memory could not be saved (${err instanceof Error ? err.message : err}): it was shut down cleanly, a start boots it`
    await cleanShutdown(vm)
  }
  vm.stopKind = undefined
  if (vm.state === "stopping") vm.state = "stopped"
  save()
}

/** The legacy memory migration may run again (a test's restart). */
export function resetMigration() {
  migrating = null
}
