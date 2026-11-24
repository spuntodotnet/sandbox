import { rmSync } from "node:fs"
import { join } from "node:path"
import { SandboxError, type CreateInput } from "./types"
import { STATE, WS_SIZE, rootSizeFor } from "./config"
import { ms, run } from "./host-commands"
import { ensureImage } from "./images"
import { destroyMem, inMem, memDir } from "./memory"
import { releasing, removeNet } from "./network"
import { Build, Snapshot, Template, Vm, reg, save, serial } from "./registry"
import { cleanShutdown, copyIn, readyTemplateOf, sameKernel, vmDir } from "./snapshots"
import { coldBoot, loadSnapshot, stopVmm } from "./vmm"
import { destroyDataset, dev, ds, exists, growTo, waitDev } from "./zfs"

// ── Creation ────────────────────────────────────────────────────────────────

/** A fresh /workspace, unless the sandbox already has one (a rebuild keeps it). */
export async function ensureWorkspace(ws: string) {
  if (await exists(ws)) return
  await run("zfs", ["create", "-p", "-s", "-V", WS_SIZE, "-o", "volblocksize=16k", ws])
  await waitDev(ws)
  await run("mkfs.ext4", ["-q", "-F", "-m", "0", "-L", "workspace", dev(ws)], { timeoutMs: 120_000 })
}

/**
 * What a box starts from, checked against the disk. Only one still being made is refused. One this
 * machine does not know, one that failed, or one whose datasets are gone (cleaned up by hand) is
 * passed over — every time, not only the first — and the box boots the plain image: the recipe
 * runs in place, slower, instead of a `zfs clone … dataset does not exist` and a box in error.
 */
export async function sourceOf(from: string | undefined): Promise<{ template?: Template; build?: Build }> {
  if (!from) return {}
  // A fork's memory may still be being copied: its copy waits for it. A copy that cannot be made
  // is an error — never the plain image in its place, which is not what was asked.
  if (from.startsWith("frk-")) {
    const fork = await readyTemplateOf(from)
    if (!fork) throw new SandboxError(`no fork ${from} on this machine`, "invalid")
    if (fork.state !== "ready") throw new SandboxError(`the fork ${from} could not be made: ${fork.error ?? fork.state}`)
    if (!(await exists(fork.disks!.root)) || !(await exists(fork.disks!.ws))) throw new SandboxError(`the fork ${from} lost its disks`)
    return { template: fork }
  }
  const template = reg().templates[from]
  const build = reg().builds[from]
  if (template?.state === "pending") throw new SandboxError(`template ${from} is not ready`, "invalid")
  if (build?.state === "running") throw new SandboxError(`build ${from} is not ready`, "invalid")
  if (template?.state === "ready") {
    if (await exists(`${ds.tpl(from, "root")}@ready`)) return { template }
    template.state = "error"
    template.error = "its disks are gone from this machine"
    save()
  } else if (build?.state === "ready") {
    if (await exists(`${ds.build(from)}@ready`)) return { build }
    build.state = "failed"
    build.error = "its disk is gone from this machine"
    save()
  }
  const why = template?.error ?? build?.error ?? "unknown on this machine"
  console.warn(`[firecracker] ${from}: ${why} — booting the image instead`)
  return {}
}

export async function createInBackground(vm: Vm, input: CreateInput) {
  const progress = (step: string) => {
    vm.step = step
    save()
  }
  const t0 = performance.now()
  // A destroy that came in while this was queued wins: it runs right after, on nothing.
  if (vm.state !== "creating") return
  try {
    const ws = ds.ws(vm.sandboxId)
    const { template, build } = await sourceOf(input.from)
    if (!template && !build) vm.from = undefined
    // What a failed destroy left under this handle.
    await destroyDataset(ds.root(vm.handle))

    if (template?.kind === "fork") {
      // The source's disks as they were at the freeze, and its RAM — this copy's own from now on.
      progress("cloning the source's disks")
      await destroyDataset(ws)
      await run("zfs", ["clone", template.disks!.root, ds.root(vm.handle)])
      await run("zfs", ["clone", template.disks!.ws, ws])
      await waitDev(ds.root(vm.handle))
      await waitDev(ws)
      vm.size = template.size
      await growTo(ds.root(vm.handle), rootSizeFor(vm.size))
      if (sameKernel(template)) {
        // Its memory dataset — a clone of the source's base, made by the freeze — becomes this
        // box's own: a rename. A fork from before the datasets (a restart in between) is copied in.
        let dir: string
        if (inMem(template.mem)) {
          await destroyMem(vm.handle, { wait: true })
          await run("zfs", ["rename", ds.mem(template.ref), ds.mem(vm.handle)])
          dir = memDir(vm.handle)
        } else dir = await copyIn(vm.handle, template.mem)
        delete reg().templates[template.ref]
        rmSync(join(STATE, "templates", template.ref), { recursive: true, force: true })
        const own: Snapshot = { vmstate: join(dir, "vmstate"), mem: join(dir, "mem"), own: true, loadable: true, kernel: template.kernel, at: template.createdAt }
        progress("loading the source's memory")
        // A new identity, the same processes: the init hands the agent its new token (§ 4.10).
        await loadSnapshot(vm, own, { reidentify: true })
        // Its base from now on, as for a box loaded from its own RAM: its first stop is a Diff.
        // Until 2026-10-11 it was never recorded, and that stop was a Full — 16 GB in 228 s for an
        // xlarge. Recorded only once loaded (`loadSnapshot` consumed it): a load that failed must
        // not leave the source's RAM, and its identity, loadable in this box.
        vm.snapshot = own
      } else {
        // The source ran another kernel: its disks, booted. Its RAM is of no use to this box — it
        // goes now, with the snapshot of the source's base it held, rather than at its first stop.
        await destroyMem(template.ref).catch(() => {})
        await run("zfs", ["destroy", `${ds.mem(template.handle)}@${template.ref}`]).catch(() => {})
        delete reg().templates[template.ref]
        rmSync(join(STATE, "templates", template.ref), { recursive: true, force: true })
        progress("booting (the source ran another kernel)")
        await coldBoot(vm)
      }
    } else if (template) {
      const keepWs = await exists(ws) // a rebuild from a template: the kept /workspace wins over RAM
      progress("cloning the template's disks")
      await run("zfs", ["clone", `${ds.tpl(template.ref, "root")}@ready`, ds.root(vm.handle)])
      if (!keepWs) await run("zfs", ["clone", `${ds.tpl(template.ref, "ws")}@ready`, ws])
      await waitDev(ds.root(vm.handle))
      await waitDev(ws)
      vm.size = template.size
      await growTo(ds.root(vm.handle), rootSizeFor(vm.size))
      if (keepWs || template.kind === "disks" || !sameKernel(template)) {
        // Disks only, or a template under another kernel: its disks, booted on the current one.
        progress("booting")
        await coldBoot(vm)
      } else {
        progress("loading the template's memory")
        // A member's model keeps its processes (code-server, services): the agent takes the new
        // identity in place. A prebuild has nobody's processes: its bootstrap starts over.
        await loadSnapshot(vm, { vmstate: template.vmstate, mem: template.mem, own: false, loadable: true, kernel: template.kernel, at: template.createdAt }, { reidentify: template.kind === "user" })
      }
    } else if (build) {
      // The build's disk, the recipe done on it: a boot, and the agent goes straight to the worker script.
      progress("cloning the build's disk")
      await run("zfs", ["clone", `${ds.build(build.ref)}@ready`, ds.root(vm.handle)])
      await growTo(ds.root(vm.handle), rootSizeFor(vm.size))
      await ensureWorkspace(ws)
      await waitDev(ds.root(vm.handle))
      progress("booting")
      await coldBoot(vm)
    } else {
      progress("preparing the image")
      vm.imageId = await ensureImage(input.image, progress)
      progress("creating disks")
      await run("zfs", ["clone", `${ds.image(vm.imageId)}@ready`, ds.root(vm.handle)])
      await growTo(ds.root(vm.handle), rootSizeFor(vm.size))
      await ensureWorkspace(ws)
      await waitDev(ds.root(vm.handle))
      progress("booting")
      await coldBoot(vm)
    }
    // Not over a destroy that started meanwhile: it must stay visible until the disks are gone.
    if (vm.state === "creating") vm.state = "running"
    vm.step = undefined
    vm.timings = { ...vm.timings, createMs: ms(t0) }
    save()
    console.log(`[firecracker] ${vm.handle} running in ${ms(t0)} ms${vm.from ? ` (from ${vm.from})` : ""}`)
  } catch (err) {
    if (vm.state === "creating") vm.state = "error"
    vm.error = err instanceof Error ? err.message : String(err)
    save()
    console.error(`[firecracker] create ${vm.handle} failed:`, err)
  }
}

// ── Removal ─────────────────────────────────────────────────────────────────

/** The `@frk-…` snapshots these datasets are clones of (a fork's), to drop once they are gone. */
export async function forkOrigins(datasets: string[]) {
  const out: string[] = []
  for (const d of datasets) {
    const origin = (await run("zfs", ["get", "-H", "-o", "value", "origin", d]).catch(() => "")).trim()
    if (/@frk-/.test(origin)) out.push(origin)
  }
  return out
}

/**
 * Tear a box down. It stays in the registry as `destroying` until its disks are gone — a failure
 * shows as an error rather than a box that is simply "missing" while its zvols stay behind (seen:
 * a zvol still busy right after its VMM exited). A rebuild's create takes the same handle meanwhile:
 * `serial` makes it wait, and the entry is only dropped if it is still this box's.
 */
export function removeVm(vm: Vm, keepVolumes: boolean): Promise<void> {
  const handle = vm.handle
  vm.state = "destroying"
  vm.error = undefined
  vm.keepVolumes = keepVolumes
  releasing.add(vm.net)
  save()
  return serial(handle, async () => {
    try {
      // A rebuild keeps /workspace: it must hold what the box last wrote.
      if (keepVolumes) await cleanShutdown(vm)
      await stopVmm(handle)
      await removeNet(vm)
      // A copy's disks and memory are clones of its source's `@frk-…` snapshots: those go with the last copy.
      const origins = await forkOrigins([ds.root(handle), ds.mem(handle), ...(keepVolumes ? [] : [ds.ws(vm.sandboxId)])])
      await destroyDataset(ds.root(handle))
      if (!keepVolumes) await destroyDataset(ds.ws(vm.sandboxId))
      // A template made from it has a clone of its memory: promoted, it keeps those blocks.
      await destroyMem(handle)
      for (const o of origins) await run("zfs", ["destroy", o]).catch(() => {})
      // A memory file from before the datasets.
      rmSync(vmDir(handle), { recursive: true, force: true })
      if (reg().vms[handle] === vm) delete reg().vms[handle]
    } catch (err) {
      vm.error = `destroy failed: ${err instanceof Error ? err.message : String(err)}`
      throw err
    } finally {
      releasing.delete(vm.net)
      save()
    }
  })
}
