import type { Target, Targets } from "./types"
import { mkdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { SandboxError } from "./types"
import { STATE } from "./config"
import { ms, q, run, sh } from "./host-commands"
import { destroyMem } from "./memory"
import { Vm, save } from "./registry"
import { cleanShutdown, vmDir } from "./snapshots"
import { destroyDataset, ds } from "./zfs"

// ── The provider ────────────────────────────────────────────────────────────

export const handleOf = (sandboxId: string) => `sbx-${sandboxId}`

export const curlHeaders = (t: Target) => Object.entries(t.headers ?? {}).map(([k, v]) => `-H ${q(`${k}: ${v}`)}`).join(" ")

export async function archiveVm(vm: Vm, targets: Targets) {
  if (vm.state !== "stopped") throw new SandboxError(`archive needs a stopped sandbox (this one is ${vm.state})`, "invalid")
  // The archive is the disk alone: it has to hold what the saved RAM had not written yet.
  await cleanShutdown(vm)
  save()
  const t0 = performance.now()
  const dir = join(STATE, "archive", vm.handle)
  mkdirSync(dir, { recursive: true })
  let bytes = 0
  for (const [part, dataset] of [["root", ds.root(vm.handle)], ["ws", ds.ws(vm.sandboxId)]] as const) {
    const file = join(dir, `${part}.zfs.zst`)
    const snap = `${dataset}@archive`
    await run("zfs", ["destroy", snap]).catch(() => {})
    await run("zfs", ["snapshot", snap])
    // A full stream, not an increment on the image: restorable on a machine that never saw it.
    await sh(`zfs send ${q(snap)} | zstd -q -T0 -3 -o ${q(file)} -f`, 60 * 60_000)
    bytes += statSync(file).size
    await sh(`curl -fsS --retry 3 -X PUT ${curlHeaders(targets[part])} --upload-file ${q(file)} ${q(targets[part].url)} -o /dev/null`, 60 * 60_000)
    rmSync(file, { force: true })
  }
  const tUpload = ms(t0)
  // Uploaded: the machine lets go of everything but the registry entry.
  await destroyDataset(ds.root(vm.handle))
  await destroyDataset(ds.ws(vm.sandboxId))
  await destroyMem(vm.handle)
  rmSync(vmDir(vm.handle), { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
  vm.snapshot = undefined
  vm.state = "archived"
  vm.stoppedWhy = undefined // why it was powered off no longer describes it: an archive, then a restore
  vm.died = undefined
  vm.archive = { at: new Date().toISOString(), root: targets.root.url.split("?")[0]!, ws: targets.ws.url.split("?")[0]!, bytes }
  vm.timings = { ...vm.timings, archiveMs: tUpload }
  save()
  return { bytes, ms: tUpload }
}

export async function restoreVm(vm: Vm, targets: Targets) {
  if (vm.state !== "archived") throw new SandboxError(`restore needs an archived sandbox (this one is ${vm.state})`, "invalid")
  const t0 = performance.now()
  for (const [part, dataset] of [["root", ds.root(vm.handle)], ["ws", ds.ws(vm.sandboxId)]] as const) {
    await destroyDataset(dataset)
    await sh(`curl -fsS --retry 3 ${curlHeaders(targets[part])} ${q(targets[part].url)} | zstd -q -d | zfs receive ${q(dataset)}`, 60 * 60_000)
    await run("zfs", ["destroy", `${dataset}@archive`]).catch(() => {})
  }
  vm.state = "stopped" // no RAM: the next start boots from the disk
  vm.timings = { ...vm.timings, restoreMs: ms(t0) }
  save()
  return { ms: ms(t0) }
}
