import { kernelId } from "./host"
import { spawn as spawnChild } from "node:child_process"
import { rmSync, statSync } from "node:fs"
import { join } from "node:path"

import { compressAndUpload, humanBytes } from "./artifact"
import { SandboxError, type Engine, type ExportStatus } from "./types"
import { assertMemoryRoom } from "./admission"
import { archiveVm, handleOf, restoreVm } from "./archive"
import { buildDir, buildLogs, buildRefOf, buildRuns, builderOf, deleted, exited, exportsByRef, readBuildLog, startBuild } from "./builds"
import { GIB, GUEST_KERNEL, SIZES, STATE, maxDiskGb, rootSizeFor, sizeOf } from "./config"
import { ensureHost } from "./host"
import { ms, run } from "./host-commands"
import { createInBackground, removeVm } from "./lifecycle"
import { destroyMem } from "./memory"
import { freeNet, netOf } from "./network"
import { Build, Vm, reg, save, serial, vmOf } from "./registry"
import { canLoad, cleanShutdown, finishStop, freezeDisks, freezeTemplate, sameKernel } from "./snapshots"
import { boxUsage } from "./usage"
import { coldBoot, loadSnapshot, refreshDrives, settleIfDead, stopVmm, unitActive } from "./vmm"
import { assertPoolRoom, destroyDataset, ds, growTo, volsizeOf } from "./zfs"

export const engine: Engine = {

  async create(input) {
    await ensureHost()
    const handle = handleOf(input.sandboxId)
    const existing = reg().vms[handle]
    // The same create again (the platform retries one whose answer it did not get — a daemon
    // restarting, a call out of time): the box it already made.
    if (existing && existing.state !== "error" && existing.state !== "destroying" && !input.previousHandle) return { handle }
    if (existing && existing.state !== "error" && existing.state !== "destroying") throw new SandboxError(`${handle} already exists`, "invalid")
    const size = sizeOf(input.size).id
    await assertPoolRoom()
    // A copy takes the size of what it is a copy of.
    await assertMemoryRoom((input.from && reg().templates[input.from]?.size) || size, handle)
    if (existing?.state === "error") void removeVm(existing, true).catch(() => {})
    // Behind a destroy still running (a rebuild): `serial` below waits for it, disks and network.
    const vm: Vm = {
      handle,
      sandboxId: input.sandboxId,
      name: input.name,
      size,
      image: input.image,
      net: freeNet(),
      env: input.env,
      ...(input.labels ? { labels: input.labels } : {}),
      bootstrap: input.bootstrap,
      state: "creating",
      step: "queued",
      from: input.from,
      createdAt: new Date().toISOString(),
    }
    reg().vms[handle] = vm
    save()
    // Fire and forget: an image can take minutes, the platform's budget is 10 s.
    void serial(handle, () => createInBackground(vm, input))
    // A `from` this machine does not have (its build was cleaned up by hand, the machine replaced):
    // the box boots the image, and the platform hears it — its build or model is lost, not ready.
    const known = !input.from || !!reg().templates[input.from] || !!reg().builds[input.from]
    return known ? { handle } : { handle, ignoredFrom: `${input.from} is not on this machine` }
  },

  async start({ handle }) {
    await ensureHost()
    await serial(handle, async () => {
      const vm = vmOf(handle)
      if (vm.state === "running" && (await unitActive(handle))) return
      if (vm.state === "archived") throw new SandboxError("this sandbox is archived: restore it first", "invalid")
      if (vm.state === "creating") throw new SandboxError("still being created", "invalid")
      if (vm.state === "destroying") throw new SandboxError("being destroyed", "invalid")
      const t0 = performance.now()
      await stopVmm(handle) // a process left over (the daemon died mid-operation)
      // After it: a leftover VMM of this very box would count against it.
      await assertMemoryRoom(vm.size, handle)
      // A box made before system disks went by size (§ 4.12) still has 10 GB: grown to its size's
      // now (sparse, never shrunk) — its ext4 follows at the agent's hello (§ 16).
      // Not a reason to refuse the start (the box boots on the disk it has): said, and on.
      await growTo(ds.root(handle), rootSizeFor(vm.size)).then(
        (grew) => grew && console.log(`[firecracker] ${handle}: system disk grown to ${rootSizeFor(vm.size)}`),
        (err) => console.warn(`[firecracker] ${handle}: system disk not grown to ${rootSizeFor(vm.size)} (${err instanceof Error ? err.message : err}) — started on the one it has`),
      )
      let how = "booted from disk"
      if (canLoad(vm.snapshot) && !sameKernel(vm.snapshot!)) {
        // The machine has a new kernel: this RAM would keep the old one running. Loaded once more
        // to shut down cleanly (what its page cache holds reaches the disk), then a boot on the new.
        await cleanShutdown(vm, 6_000)
        how = "kernel changed: shut down, booted from disk"
      } else if (canLoad(vm.snapshot)) {
        try {
          await loadSnapshot(vm, vm.snapshot!)
          how = "RAM loaded"
        } catch (err) {
          // A RAM this Firecracker no longer loads (a new version, a damaged file): the disk boots,
          // its journal replayed — the box comes back without its processes rather than not at all.
          console.warn(`[firecracker] ${handle}: its RAM did not load (${err instanceof Error ? err.message : err})`)
          await stopVmm(handle)
          how = "RAM unloadable, booted from disk"
        }
      }
      if (how === "RAM loaded") vm.timings = { ...vm.timings, startWarmMs: ms(t0) }
      else {
        vm.snapshot = undefined
        await coldBoot(vm)
        vm.timings = { ...vm.timings, startColdMs: ms(t0) }
      }
      vm.state = "running"
      vm.error = undefined
      vm.stoppedWhy = undefined
      vm.died = undefined
      save()
      console.log(`[firecracker] ${handle} started in ${ms(t0)} ms (${how})`)
    })
  },

  // Both answer at once and finish on their own: writing the RAM, or a guest shutting down, takes
  // seconds — longer than the platform's budget. `describe` says `transition` until done.
  async stop({ handle }) {
    const vm = vmOf(handle)
    await settleIfDead(vm)
    // Killed: already down — a stop asked for says it is just stopped now, no more an error.
    if (vm.died) {
      vm.died = undefined
      return void save()
    }
    // A paused box too: its RAM is dropped (the disk brought up to date first, `cleanShutdown`).
    const paused = vm.state === "stopped" && canLoad(vm.snapshot)
    if (vm.state !== "running" && !paused) return
    vm.state = "stopping"
    vm.stopKind = "stop"
    save()
    void serial(handle, () => finishStop(vm))
  },

  async pause({ handle }) {
    const vm = vmOf(handle)
    if (vm.state === "stopping") throw new SandboxError(`already ${vm.stopKind === "stop" ? "stopping" : "pausing"}`, "invalid")
    // Its VMM gone (now, or found so since): no RAM left to keep — down already, nothing to pause.
    if ((await settleIfDead(vm)) || (vm.state === "stopped" && (vm.died || vm.stoppedWhy))) return
    if (vm.state !== "running") throw new SandboxError(`cannot pause a sandbox that is ${vm.state}`, "invalid")
    vm.state = "stopping"
    vm.stopKind = "pause"
    save()
    void serial(handle, () => finishStop(vm))
  },

  async destroy({ handle, keepVolumes }) {
    const vm = reg().vms[handle]
    if (!vm) return
    const removal = removeVm(vm, keepVolumes === true)
    // Within the platform's 10 s budget, whatever the guest takes to shut down; then on its own.
    const outcome = await Promise.race([removal.then(() => "done" as const), new Promise<"pending">((r) => setTimeout(() => r("pending"), 6_000))])
    if (outcome === "pending") removal.catch((err) => console.error(`[firecracker] destroy ${handle} failed after answering:`, err))
  },

  async describe({ handle }) {
    const vm = reg().vms[handle]
    if (!vm) return { state: "missing" }
    if (vm.state === "destroying") return vm.error ? { state: "error", detail: vm.error } : { state: "missing", detail: "being destroyed" }
    const extra = { timings: vm.timings, ram: canLoad(vm.snapshot) ? ("saved" as const) : ("none" as const) }
    if (vm.state === "creating") return { state: "creating", detail: vm.step ?? "creating", ...extra }
    if (vm.state === "error") return { state: "error", detail: vm.error, ...extra }
    if (vm.state === "stopping") {
      return vm.stopKind === "stop"
        ? { state: "stopped", transition: "stopping", detail: "shutting down…", ...extra }
        : { state: "stopped", transition: "pausing", detail: "saving memory…", ...extra }
    }
    if (vm.state === "archived") return { state: "stopped", detail: `archived ${vm.archive?.at ?? ""} — restore before starting`, ...extra }
    // running in the registry: is the process still there (a host reboot, a crash, the OOM killer)?
    await settleIfDead(vm)
    // Killed (the OOM killer, a crash): an error that says why — the platform shows it and offers
    // a start, instead of a box `starting` forever. Without a record (a reboot): just stopped.
    if (vm.state === "stopped" && vm.died) return { state: "error", detail: vm.died.detail, exit: vm.died.result, ...extra }
    if (vm.state === "stopped") {
      const detail = canLoad(vm.snapshot) ? "memory saved — a start resumes it" : vm.stoppedWhy ? `powered off: ${vm.stoppedWhy} — a start boots it` : "powered off — a start boots it"
      return { state: "stopped", detail, ...extra }
    }
    return { state: "running", detail: `firecracker · ${vm.size}`, ...extra }
  },

  // ── Builds (RFC 0037): the recipe in a builder microVM, its disk the result ──

  async build(input) {
    await ensureHost()
    const ref = buildRefOf(input.buildId)
    if (!reg().builds[ref]) {
      // A builder is a box too.
      await assertMemoryRoom(sizeOf(input.size).id, ref)
      const b: Build = {
        ref,
        buildId: input.buildId,
        image: input.image,
        // A builder takes the slice's memory like a box: small unless asked.
        size: sizeOf(input.size).id,
        net: freeNet(),
        state: "running",
        phase: "queued",
        pre: "",
        post: "",
        createdAt: new Date().toISOString(),
      }
      reg().builds[ref] = b
      save()
      startBuild(b, input)
    }
    return {
      ref,
      steps: {
        before: [
          ...(input.artifact?.format === "firecracker-zfs" ? [{ id: "fc:fetch", label: "Fetch from the bucket", kind: "image" as const }] : []),
          { id: "fc:image", label: "Base image", kind: "image", detail: `${input.image}, unpacked in a microVM` },
          { id: "fc:builder", label: "Builder microVM", kind: "runtime", detail: `kernel ${GUEST_KERNEL.version}` },
        ],
        after: [{ id: "fc:disk", label: "Save the disk", kind: "image" }],
      },
    }
  },

  async buildStatus({ ref, cursor = 0 }) {
    const b = reg().builds[ref]
    if (!b) return { state: "failed", phase: "failed", log: "", cursor, error: `no build ${ref} on this machine` }
    // The console from where the last read stopped; read from the start again only after a restart.
    const done = b.state !== "running"
    const log = `${b.pre}${readBuildLog(ref, done).log}${b.post}`
    // All of a finished build's log handed over: its text need not stay in memory.
    if (done && cursor >= log.length) buildLogs.delete(ref)
    return { state: b.state, phase: b.phase, log: log.slice(cursor), cursor: log.length, ...(b.error ? { error: b.error } : {}) }
  },

  /** A full `zfs send` of the build's disk, zstd, straight into the org's bucket (RFC 0041 § 4.3). */
  async exportBuild({ ref, target }) {
    await ensureHost()
    const b = reg().builds[ref]
    if (!b || b.state !== "ready") throw new SandboxError(`no ready build ${ref} on this machine`, "not_found")
    const running = exportsByRef.get(ref)
    if (running && running.state !== "failed") return { format: "firecracker-zfs" as const }
    const st: ExportStatus = { state: "uploading", format: "firecracker-zfs", bytes: 0 }
    exportsByRef.set(ref, st)
    void (async () => {
      // Full, not an increment on the image: the machine that reads it may never have seen the image.
      const child = spawnChild("zfs", ["send", `${ds.build(ref)}@ready`], { stdio: ["ignore", "pipe", "pipe"] })
      const done = exited(child, "zfs send")
      let up: Awaited<ReturnType<typeof compressAndUpload>>
      try {
        up = await compressAndUpload(child.stdout!, target, (n) => (st.bytes = n))
      } catch (err) {
        // The bucket refused half-way: `zfs send` would wait on a full pipe forever.
        child.kill()
        await done.catch(() => {})
        throw err
      }
      await done
      Object.assign(st, { state: "done", bytes: up.bytes, ...(up.parts ? { parts: up.parts } : {}) })
      console.log(`[firecracker] build ${ref} exported: ${humanBytes(up.bytes)}`)
    })().catch((err) => {
      Object.assign(st, { state: "failed", error: err instanceof Error ? err.message : String(err) })
      console.error(`[firecracker] export of ${ref} failed:`, err)
    })
    return { format: "firecracker-zfs" as const }
  },

  async exportStatus({ ref }) {
    return exportsByRef.get(ref) ?? { state: "none" }
  },

  async deleteBuild({ ref }) {
    exportsByRef.delete(ref)
    const b = reg().builds[ref]
    if (!b) return
    deleted.add(b)
    delete reg().builds[ref]
    save()
    // Still running: its runner sees the delete at its next step (the builder stopped here ends
    // its wait at once), and removes what it made — and its network, still reserved for it. The
    // network is never touched here: a finished build's number may be a new box's by now.
    if (buildRuns.has(ref)) return void (await stopVmm(builderOf(ref)))
    await destroyDataset(ds.buildWs(ref))
    // Boxes cloned from it keep its blocks (destroyDataset promotes one of them).
    await destroyDataset(ds.build(ref))
    rmSync(buildDir(ref), { recursive: true, force: true })
    buildLogs.delete(ref)
  },

  /**
   * Grow a box's disks, running or not (§ 4.12): the zvol (`volsize`), then — running — Firecracker
   * re-reads its size and the guest sees it at once. Its filesystem is grown from inside: the
   * platform runs that through the agent (`resizeInGuest`), or the init does at the next boot. Never
   * a shrink.
   */
  async grow({ handle, rootGb, workspaceGb }) {
    await ensureHost()
    return serial(handle, async () => {
      const vm = vmOf(handle)
      if (!["running", "stopped", "stopping"].includes(vm.state)) throw new SandboxError(`cannot grow a sandbox that is ${vm.state}`, "invalid")
      const max = maxDiskGb()
      const want: [string, number | undefined, number][] = [
        [ds.root(handle), rootGb, max.root],
        [ds.ws(vm.sandboxId), workspaceGb, max.ws],
      ]
      // Everything checked first — sizes, never a shrink, the pool — then grown: a refusal must not
      // leave one disk grown and the guest never told.
      const todo: [string, number][] = []
      for (const [dataset, gb, max] of want) {
        if (gb == null) continue
        if (!Number.isInteger(gb) || gb < 1 || gb > max) throw new SandboxError(`a disk of ${gb} GB: between 1 and ${max} GB`, "invalid")
        if ((await volsizeOf(dataset)) > gb * GIB) throw new SandboxError(`${dataset.split("/").pop()} is larger than ${gb} GB already: disks only grow`, "invalid")
        todo.push([dataset, gb])
      }
      await assertPoolRoom()
      const running = vm.state === "running" && (await unitActive(handle))
      let changed = false
      try {
        for (const [dataset, gb] of todo) changed = (await growTo(dataset, `${gb}G`)) || changed
      } finally {
        // A running guest is told, even if a later step failed — and even when nothing changed now: a
        // grow a previous call made may never have reached it (the call is safe to repeat).
        if (running) await refreshDrives(handle)
      }
      const gbOf = async (d: string) => Math.round((await volsizeOf(d)) / GIB)
      return { rootGb: await gbOf(ds.root(handle)), workspaceGb: await gbOf(ds.ws(vm.sandboxId)), changed, running, resizeInGuest: running }
    })
  },

  // ── Templates: a RAM snapshot plus a ZFS snapshot of both disks ─────────────

  async snapshot({ handle }) {
    const tpl = await freezeTemplate(handle, "prebuild")
    return { ref: tpl.ref }
  },

  /**
   * A copy of a running box (§ 4.10): `{ ref }` once the source runs again, for `create({ from })`
   * on this machine. `model: true` keeps it for many copies (a member's model, § 4.11) instead of one.
   */
  async fork({ handle, model }) {
    const tpl = await freezeTemplate(handle, model ? "user" : "fork")
    return { ref: tpl.ref, pauseMs: tpl.pauseMs, ram: tpl.ramKind }
  },

  /** A running box's disks, without its RAM (RFC 0060): boxes made from it boot, postStart included. */
  async snapshotDisks({ handle }) {
    const tpl = await freezeDisks(handle)
    return { ref: tpl.ref, pauseMs: tpl.pauseMs }
  },

  async templateStatus({ ref }) {
    const tpl = reg().templates[ref]
    if (!tpl) return { state: "error", detail: `template ${ref} not found` }
    if (tpl.state === "error") return { state: "error", detail: tpl.error }
    if (tpl.state === "pending") return { state: "pending", detail: "copying the memory" }
    // Booted, never loaded: no RAM to size, no kernel to match.
    if (tpl.kind === "disks") return { state: "ready", detail: "disks only" }
    // Made under another kernel: a copy would boot its disks rather than load its RAM — the
    // platform deletes a member's model that is stale this way (§ 4.11).
    return { state: "ready", detail: `${Math.round(statSync(tpl.mem).size / 1024 ** 2)} MB of RAM`, ...(sameKernel(tpl) ? {} : { stale: true }) }
  },

  async deleteTemplate({ ref }) {
    const tpl = reg().templates[ref]
    if (!tpl) return
    // A fork nobody made a copy of: the source's snapshots and its memory.
    if (tpl.kind === "fork") {
      for (const snap of [tpl.disks?.root, tpl.disks?.ws]) if (snap) await run("zfs", ["destroy", snap]).catch(() => {})
      await destroyMem(ref)
      await run("zfs", ["destroy", `${ds.mem(tpl.handle)}@${ref}`]).catch(() => {})
      rmSync(join(STATE, "templates", ref), { recursive: true, force: true })
      delete reg().templates[ref]
      return void save()
    }
    // Its disks are clones of `@<ref>` snapshots on the box it was taken from: those go too, unless
    // something still depends on them (boxes cloned from the template, after a promote).
    const origins: string[] = []
    for (const part of ["root", "ws"] as const) {
      const origin = (await run("zfs", ["get", "-H", "-o", "value", "origin", ds.tpl(ref, part)]).catch(() => "")).trim()
      if (origin.includes(`@${ref}`)) origins.push(origin)
      // Boxes cloned from it keep its blocks (destroyDataset promotes one of them).
      await destroyDataset(ds.tpl(ref, part))
    }
    for (const snap of origins) {
      await run("zfs", ["destroy", snap]).catch((err) => console.warn(`[firecracker] keeping ${snap}: ${err.message}`))
    }
    // Its memory: boxes cloned their base from it (promoted, they keep its blocks); boxes loaded
    // from it and still running map its file (then it waits in the graveyard, and the snapshot of
    // its source's memory goes with the sweep once nothing is cloned from it).
    await destroyMem(ref)
    await run("zfs", ["destroy", `${ds.mem(tpl.handle)}@${ref}`]).catch(() => {})
    rmSync(join(STATE, "templates", ref), { recursive: true, force: true })
    delete reg().templates[ref]
    save()
  },

  async sizes() {
    return SIZES.map(({ vcpus: _v, memMib: _m, ...s }) => s)
  },



  async archive({ handle, targets }) {
    await ensureHost()
    return serial(handle, () => archiveVm(vmOf(handle), targets))
  },

  async restore({ handle, targets }) {
    await ensureHost()
    return serial(handle, () => restoreVm(vmOf(handle), targets))
  },

  /** Operator: each running box's usage, as the host measures it (`BoxUsage`). */
  async usage() {
    return { at: new Date().toISOString(), boxes: await boxUsage() }
  },

  async list() {
    const r = reg()
    const strip = ({ env: _e, ...vm }: Vm) => ({ ...vm, env: Object.keys(_e) })
    const builds = Object.values(r.builds).map(({ pre: _p, post: _q, ...b }) => b)
    return { kernel: { ...GUEST_KERNEL, id: kernelId }, vms: Object.values(r.vms).map(strip), templates: Object.values(r.templates), images: Object.values(r.images), builds }
  },
}

/** The network namespace a box's VMM runs in (`fc<n>`): where its guest, 172.16.0.2, is reached from. */
export function netnsOf(handle: string): string | undefined {
  const vm = reg().vms[handle]
  return vm ? netOf(vm.net).netns : undefined
}
