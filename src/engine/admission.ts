import { readFileSync } from "node:fs"
import { SandboxError } from "./types"
import { CGROUP_ROOT, GIB, MEMINFO, SLICE, sizeOf } from "./config"
import { run } from "./host-commands"
import { reg } from "./registry"
import { settleDeadVms } from "./vmm"

/**
 * What a box needs free to start, in MiB: an eighth of its RAM, 1 GiB at least
 * (`SPUNTO_FC_ADMIT_MIN_MB`). Not its whole RAM: the slice promises more than it holds on purpose —
 * a box only takes what its guest touches (an xlarge booted at 0.8 GB, § 15). Enough not to start a
 * box the OOM killer takes a few seconds later, along with one of its neighbours.
 */
export const admitMibFor = (memMib: number) => Math.max(Number(process.env.SPUNTO_FC_ADMIT_MIN_MB ?? 1024), Math.ceil(memMib / 8))

/**
 * The memory boxes can still take, in bytes: what the slice's ceiling leaves (its page cache that
 * can be dropped counts as free: `droppableCache`), within what the machine has (`MemAvailable`: its
 * containers and the host take theirs outside the slice).
 */
export function memoryRoom(m: { sliceMax?: number; sliceCurrent?: number; droppable?: number; hostAvailable?: number }) {
  const host = m.hostAvailable ?? Infinity
  if (!m.sliceMax || !Number.isFinite(m.sliceMax)) return host
  return Math.min(host, m.sliceMax - (m.sliceCurrent ?? 0) + (m.droppable ?? 0))
}

/**
 * The page cache of a cgroup the kernel drops before it kills anything, from its `memory.stat`:
 * every clean file page, the active ones too. A box's disks are zvols its VMM reads and writes
 * through the host's page cache, charged to the box: one with 1.2 GB used inside held 6.6 GB on
 * Canada, 4.1 GB of it this cache (2026-10-16), which a `memory.reclaim` emptied at once, the box
 * none the worse. `inactive_file` alone counted only 1.7 GB of it. Not shmem (a file only by name),
 * nor what is dirty or under writeback. `inactive_file` from a kernel that does not say `file`.
 */
export function droppableCache(stat: string) {
  const v = (k: string) => Number(new RegExp(`^${k} (\\d+)$`, "m").exec(stat)?.[1] ?? 0)
  if (!/^file /m.test(stat)) return v("inactive_file")
  return Math.max(0, v("file") - v("shmem") - v("file_dirty") - v("file_writeback"))
}

export async function memoryNow() {
  const show = await run("systemctl", ["show", SLICE, "-p", "MemoryMax", "-p", "MemoryCurrent", "-p", "ControlGroup"]).catch(() => "")
  const prop = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(show)?.[1]?.trim() ?? ""
  const num = (v: string) => (/^\d+$/.test(v) ? Number(v) : undefined)
  const cg = prop("ControlGroup")
  let droppable: number | undefined
  try {
    if (cg) droppable = droppableCache(readFileSync(`${CGROUP_ROOT}${cg}/memory.stat`, "utf8")) || undefined
  } catch {}
  let hostAvailable: number | undefined
  try {
    hostAvailable = Number(/^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync(MEMINFO, "utf8"))?.[1]) * 1024 || undefined
  } catch {}
  // An empty slice is not loaded: no current usage, its ceiling still set.
  return { sliceMax: num(prop("MemoryMax")), sliceCurrent: num(prop("MemoryCurrent")) ?? 0, droppable, hostAvailable }
}

/**
 * How far the RAM the running boxes *announce* (their sizes, not what they touched) may exceed the
 * slice's ceiling: `SPUNTO_FC_OVERCOMMIT` (1.5 by default, 0 turns it off). The room check below
 * only sees a box at its start; a guest that grows afterwards — the Spunto project's setup filled a
 * `large` to 8.3 GB (§ 18) — is taken from the slice its neighbours were admitted on, and the
 * kernel kills one. Above this ratio, no new box: a full machine said, rather than a box killed.
 * A box alone always passes it (an `xlarge` on an 8 GB slice is the operator's choice).
 */
export const overcommitRatio = () => {
  const r = Number(process.env.SPUNTO_FC_OVERCOMMIT ?? 1.5)
  return Number.isFinite(r) && r > 0 ? r : 0
}

/** Whether a box of `needMib` fits next to `committedMib` already announced, in MiB. Pure. */
export function announcedFits(p: { sliceMax?: number; ratio: number; committedMib: number; needMib: number }): boolean {
  if (!p.ratio || !p.sliceMax || !Number.isFinite(p.sliceMax) || p.committedMib <= 0) return true
  return (p.committedMib + p.needMib) * 1024 ** 2 <= p.sliceMax * p.ratio
}

/**
 * What was admitted and not yet taken: a box admitted now has not touched its RAM yet, and the next
 * admission would see that RAM as free — six creates at once all passed on the same room. Each
 * admission holds what it asked for, until its box has booted and taken it (`ADMIT_HOLD_MS`) —
 * counted twice meanwhile, on the safe side. Its announced size too, until the box is in the
 * registry as running (`committedMib`).
 */
export const held: { bytes: number; until: number; key: string; mib: number }[] = []
export const ADMIT_HOLD_MS = Number(process.env.SPUNTO_FC_ADMIT_HOLD_MS ?? 30_000)
export const heldNow = () => {
  const now = Date.now()
  for (let i = held.length - 1; i >= 0; i--) if (held[i]!.until <= now) held.splice(i, 1)
  return held.reduce((sum, h) => sum + h.bytes, 0)
}

/** RAM announced by the boxes and builders holding some (or about to), in MiB — `self` aside. */
export function committedMib(self: string): number {
  const active = new Map<string, number>()
  for (const vm of Object.values(reg().vms)) {
    if (vm.state === "creating" || vm.state === "running" || vm.state === "stopping") active.set(vm.handle, sizeOf(vm.size).memMib)
  }
  for (const b of Object.values(reg().builds ?? {})) if (b.state === "running") active.set(b.ref, sizeOf(b.size).memMib)
  for (const h of held) if (!active.has(h.key)) active.set(h.key, h.mib)
  active.delete(self)
  let sum = 0
  for (const mib of active.values()) sum += mib
  return sum
}

/**
 * Before a box (or a builder) starts: refused while the machine cannot take it — `capacity`, so the
 * BYOC app places a new one on another machine, and the platform says why instead of a box the OOM
 * killer takes. Two checks: the room the slice really has now (`memoryRoom`), and what the running
 * boxes announce (`announcedFits`). The checks and the hold are one synchronous step after the read:
 * two admissions at once cannot both take the same room. `SPUNTO_FC_ADMIT=0` turns both off.
 * `key`: the box's handle (or the builder's ref) — itself is not its own neighbour on a start.
 */
export async function assertMemoryRoom(size: string, key: string) {
  if (process.env.SPUNTO_FC_ADMIT === "0") return
  // A box dead under the registry would count its size in `committedMib`: settled first.
  await settleDeadVms()
  const memMib = sizeOf(size).memMib
  const m = await memoryNow()
  const pending = heldNow()
  const room = memoryRoom(m) - pending
  const need = admitMibFor(memMib) * 1024 ** 2
  const gb = (b: number) => (b / GIB).toFixed(1)
  const committed = committedMib(key)
  const ratio = overcommitRatio()
  if (room >= need && announcedFits({ sliceMax: m.sliceMax, ratio, committedMib: committed, needMib: memMib })) {
    return void held.push({ bytes: need, until: Date.now() + ADMIT_HOLD_MS, key, mib: memMib })
  }
  if (room >= need) {
    throw new SandboxError(
      `not enough memory on this machine for a ${size} sandbox: the sandboxes already on it announce ${gb(committed * 1024 ** 2)} GB of RAM, ` +
        `and ${gb((committed + memMib) * 1024 ** 2)} GB would be more than ${ratio}× what it gives them (${SLICE}: ${gb(m.sliceMax!)} GB) — ` +
        `their guests can grow into it, and the kernel would kill one. Stop a sandbox, or use another machine`,
      "capacity",
    )
  }
  // Rounded down: 1.98 GB free is not "2.0 GB free" against 2.0 needed.
  const free = (Math.floor((Math.max(0, room) / GIB) * 10) / 10).toFixed(1)
  throw new SandboxError(
    `not enough memory on this machine for a ${size} sandbox: ${free} GB free for sandboxes` +
      `${m.sliceMax && Number.isFinite(m.sliceMax) ? ` (${SLICE}: ${gb(m.sliceCurrent ?? 0)} of ${gb(m.sliceMax)} GB used${pending ? `, ${gb(pending)} GB held for boxes starting` : ""})` : ""}, ${gb(need)} GB needed to start — stop a sandbox, or use another machine`,
    "capacity",
  )
}
