import { KERNEL } from "./host"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { droppableCache, memoryNow } from "./admission"
import { builderOf } from "./builds"
import { CGROUP_ROOT, DATASET, GIB, GUEST_KERNEL, KSTAT, PINNED_KERNEL, SYSFS_NET, maxDiskGb } from "./config"
import { run } from "./host-commands"
import { netOf, shaping } from "./network"
import { reg } from "./registry"
import { unitOf } from "./vmm"
import { ds, poolFree } from "./zfs"

// ── What each box uses, measured on the host (RFC 0039 § 22) ────────────────
//
// Not the agent's word — it runs inside the box, and a box billed or suspected of abuse is the one
// whose word counts least. Counters, as the kernel keeps them: cumulative, from the unit's start
// (CPU), the veth's creation (network), the pool's import (disk). A reader takes differences, and a
// counter that goes down is a restart.

export type BoxUsage = {
  /** `cpu.stat` of its unit: the VMM's CPU time, vCPUs and its own threads. */
  cpuUsec?: number
  /** `memory.current` of its unit, the host's page cache of its disks included. */
  memoryBytes?: number
  /** Without the clean page cache the kernel drops before an OOM (`droppableCache`): what the box holds. */
  ramBytes?: number
  memoryPeakBytes?: number
  /** Its veth, as the box sees it: sent (the host's rx) and received. */
  netTxBytes?: number
  netRxBytes?: number
  /** Its two zvols, as ZFS counts them (`objset-*` kstats): the VMM's IO lands in ZFS's threads, outside its cgroup. */
  diskReadBytes?: number
  diskWrittenBytes?: number
  diskReads?: number
  diskWrites?: number
}

/** `systemctl show -p Id -p ControlGroup <units…>`: each unit's cgroup (none for a unit not running). Pure. */
export function unitCgroups(show: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const block of show.split(/\n\s*\n/)) {
    const id = /^Id=(.+)$/m.exec(block)?.[1]?.trim()
    const cg = /^ControlGroup=(.+)$/m.exec(block)?.[1]?.trim()
    if (id && cg) out.set(id.replace(/\.service$/, ""), cg)
  }
  return out
}

/** One `objset-*` kstat of ZFS: its dataset and IO counters. Pure. */
export function objsetStats(text: string) {
  const v = (k: string) => Number(new RegExp(`^${k}\\s+\\d+\\s+(\\d+)$`, "m").exec(text)?.[1] ?? 0)
  const dataset = /^dataset_name\s+\d+\s+(\S+)$/m.exec(text)?.[1]
  return dataset ? { dataset, reads: v("reads"), nread: v("nread"), writes: v("writes"), nwritten: v("nwritten") } : undefined
}

export const readNum = (path: string) => {
  try {
    const n = Number(readFileSync(path, "utf8").trim())
    return Number.isFinite(n) ? n : undefined
  } catch {
    return undefined
  }
}

/** Every running box's and builder's usage, by handle — one `systemctl show`, then files. */
export async function boxUsage(): Promise<Record<string, BoxUsage>> {
  const boxes: { handle: string; net: number; disks: string[] }[] = [
    ...Object.values(reg().vms).filter((vm) => vm.state === "running" || vm.state === "stopping").map((vm) => ({ handle: vm.handle, net: vm.net, disks: [ds.root(vm.handle), ds.ws(vm.sandboxId)] })),
    ...Object.values(reg().builds).filter((b) => b.state === "running").map((b) => ({ handle: builderOf(b.ref), net: b.net, disks: [ds.build(b.ref), ds.buildWs(b.ref)] })),
  ]
  if (!boxes.length) return {}
  const cgroups = unitCgroups(await run("systemctl", ["show", "-p", "Id", "-p", "ControlGroup", ...boxes.map((b) => `${unitOf(b.handle)}.service`)]).catch(() => ""))
  const disks = new Map<string, NonNullable<ReturnType<typeof objsetStats>>>()
  try {
    for (const f of readdirSync(KSTAT)) {
      if (!f.startsWith("objset-")) continue
      const s = objsetStats(readFileSync(join(KSTAT, f), "utf8"))
      if (s) disks.set(s.dataset, s)
    }
  } catch {}
  const out: Record<string, BoxUsage> = {}
  for (const b of boxes) {
    const u: BoxUsage = {}
    const cg = cgroups.get(unitOf(b.handle))
    if (cg) {
      const dir = `${CGROUP_ROOT}${cg}`
      try {
        u.cpuUsec = Number(/^usage_usec (\d+)$/m.exec(readFileSync(`${dir}/cpu.stat`, "utf8"))?.[1]) || undefined
      } catch {}
      u.memoryBytes = readNum(`${dir}/memory.current`)
      u.memoryPeakBytes = readNum(`${dir}/memory.peak`)
      try {
        if (u.memoryBytes !== undefined) u.ramBytes = Math.max(0, u.memoryBytes - droppableCache(readFileSync(`${dir}/memory.stat`, "utf8")))
      } catch {}
    }
    const { hostIf } = netOf(b.net)
    // The host's rx is what the box sent.
    u.netTxBytes = readNum(`${SYSFS_NET}/${hostIf}/statistics/rx_bytes`)
    u.netRxBytes = readNum(`${SYSFS_NET}/${hostIf}/statistics/tx_bytes`)
    const io = b.disks.map((d) => disks.get(d)).filter((s) => !!s)
    if (io.length) {
      u.diskReadBytes = io.reduce((n, s) => n + s.nread, 0)
      u.diskWrittenBytes = io.reduce((n, s) => n + s.nwritten, 0)
      u.diskReads = io.reduce((n, s) => n + s.reads, 0)
      u.diskWrites = io.reduce((n, s) => n + s.writes, 0)
    }
    out[b.handle] = Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined))
  }
  return out
}

/** What a machine reports about itself: the backend and its boxes. */
export async function firecrackerHostInfo() {
  const vms = Object.values(reg().vms)
  const m = await memoryNow()
  const sliceMemory = m.sliceCurrent || undefined
  const free = await poolFree().catch(() => 0)
  const mem = Number((await run("zfs", ["get", "-Hp", "-o", "value", "used", `${DATASET}/mem`]).catch(() => "")).trim()) || 0
  return {
    backend: "firecracker",
    poolFreeGb: free ? Math.round((free / GIB) * 10) / 10 : undefined,
    /** What the memory files of stopped boxes, bases and templates take in the pool (compressed, clones shared). */
    memoryFilesGb: mem ? Math.round((mem / GIB) * 10) / 10 : undefined,
    kernel: KERNEL === PINNED_KERNEL ? GUEST_KERNEL.version : `${GUEST_KERNEL.version} not installed, ${KERNEL}`,
    sandboxes: vms.length,
    running: vms.filter((v) => v.state === "running").length,
    vmsSliceMemoryMb: sliceMemory ? Math.round(sliceMemory / 1024 ** 2) : undefined,
    /** What the boxes really hold: the slice without the page cache the kernel drops before an OOM. */
    vmsSliceRamMb: sliceMemory ? Math.round(Math.max(0, sliceMemory - (m.droppable ?? 0)) / 1024 ** 2) : undefined,
    /** Each box's ceiling, each way, and what they share when the machine's part is full (§ 22). */
    network: shaping ? { perBoxMbit: shaping.ceil, totalMbit: shaping.total, smtp: process.env.SPUNTO_FC_SMTP === "open" ? "open" : "closed" } : undefined,
    maxDiskGb: maxDiskGb(),
    /** What each running box uses, as the host measures it (counters: `BoxUsage`). */
    usage: { at: new Date().toISOString(), boxes: await boxUsage().catch(() => ({})) },
  }
}
