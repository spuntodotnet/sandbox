import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { SandboxError } from "./types"
import { DATASET, GIB, MIN_POOL_FREE, SCRATCH, ZVOL, bytesOf } from "./config"
import { ok, run } from "./host-commands"

// ── ZFS ─────────────────────────────────────────────────────────────────────

export const ds = {
  image: (id: string) => `${DATASET}/images/${id}`,
  root: (handle: string) => `${DATASET}/vms/${handle}-root`,
  ws: (sandboxId: string) => `${DATASET}/ws/${sandboxId}`,
  /** A template's own copy of a disk — a clone, so the box it came from can go (`destroyDataset`). */
  tpl: (ref: string, part: "root" | "ws") => `${DATASET}/templates/${ref}-${part}`,
  /** A build's root disk (a clone of its image, the recipe run on it), and the builder's scratch /workspace. */
  build: (ref: string) => `${DATASET}/builds/${ref}`,
  buildWs: (ref: string) => `${DATASET}/builds/${ref}-ws`,
  /** A box's or a template's memory files: a filesystem, mounted at `memDir(name)`. */
  mem: (name: string) => `${DATASET}/mem/${name}`,
}
/** A box's own directory in SCRATCH: bound into its jail for a snapshot, never another box's. */
export function scratchOf(handle: string) {
  const dir = join(SCRATCH, handle)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}
export const dev = (dataset: string) => `${ZVOL}/${dataset}`
export const exists = (dataset: string) => ok(run("zfs", ["list", "-H", "-o", "name", dataset]))
export const volsizeOf = async (dataset: string) => Number((await run("zfs", ["get", "-Hp", "-o", "value", "volsize", dataset])).trim()) || 0

/** What is left in the pool, in bytes. */
export const poolFree = async () => Number((await run("zfs", ["get", "-Hp", "-o", "value", "available", DATASET])).trim()) || 0
export async function assertPoolRoom() {
  const free = await poolFree()
  if (free && free < MIN_POOL_FREE) throw new SandboxError(`the machine's disk pool is nearly full (${(free / GIB).toFixed(1)} GB left): free space on it first`, "invalid")
}

/** Grow a zvol to `size` (never shrink): true when it changed. Sparse: it costs nothing yet. */
export async function growTo(dataset: string, size: string): Promise<boolean> {
  const want = bytesOf(size)
  if ((await volsizeOf(dataset)) >= want) return false
  // In bytes, up to a whole volblocksize (16k): what zfs requires, whatever spelling `size` had.
  await run("zfs", ["set", `volsize=${Math.ceil(want / 16384) * 16384}`, dataset])
  return true
}

export async function waitDev(dataset: string) {
  for (let i = 0; i < 100 && !existsSync(dev(dataset)); i++) await new Promise((r) => setTimeout(r, 50))
  if (!existsSync(dev(dataset))) throw new SandboxError(`${dev(dataset)} did not appear`)
}

/**
 * Destroy a zvol. One a template or a clone still depends on (its snapshot has clones) hands its
 * snapshots to a clone first (`zfs promote`), so a builder box goes while its template stays.
 */
export async function destroyDataset(dataset: string) {
  if (!(await exists(dataset))) return
  for (let i = 0; i < 5; i++) {
    // The clone of the newest snapshot that has any: a promote takes every snapshot up to its
    // origin, so one is enough however many copies there are (the oldest's took one per snapshot).
    const withClones = (await run("zfs", ["list", "-H", "-t", "snapshot", "-o", "clones", "-s", "createtxg", "-d", "1", dataset]))
      .split("\n")
      .map((l) => l.split(",").map((s) => s.trim()).filter((s) => s && s !== "-"))
      .filter((c) => c.length)
    if (!withClones.length) break
    const clone = withClones.at(-1)![0]!
    // A promote moves this dataset's snapshots to the clone: one of the same name there (a member's
    // snapshot taken from a box built from a build — both have `@ready`) makes zfs refuse ("conflicting
    // snapshot"), and the box stayed `destroying` for good (2026-10-12, e2e). Ours are renamed first:
    // this dataset goes, what moves keeps its blocks under a name of its own.
    const names = async (ds: string) =>
      // Unreadable: nothing known to clash — the promote says so if something does.
      (await run("zfs", ["list", "-H", "-t", "snapshot", "-o", "name", "-d", "1", ds]).catch(() => "")).split("\n").map((l) => l.trim().split("@")[1]).filter(Boolean) as string[]
    const theirs = new Set(await names(clone))
    for (const n of await names(dataset)) {
      if (theirs.has(n)) await run("zfs", ["rename", `${dataset}@${n}`, `${dataset}@${n}-of-${dataset.split("/").pop()}`])
    }
    await run("zfs", ["promote", clone])
  }
  // Right after its VMM exits, a zvol can still be held for a moment: "dataset is busy".
  for (let i = 0; ; i++) {
    try {
      return void (await run("zfs", ["destroy", "-r", dataset], { timeoutMs: 120_000 }))
    } catch (err) {
      if (i >= 20 || !/busy/i.test(err instanceof Error ? err.message : "")) throw err
      await new Promise((r) => setTimeout(r, 250))
    }
  }
}
