import { spawn as spawnChild, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { downloadInto, humanBytes } from "./artifact"
import { SandboxError, type BuildInput, type ExportStatus } from "./types"
import { DRIVE_ROOT, DRIVE_WS, GUEST_KERNEL, GUEST_MAC, MAX_BUILD_LOG, STATE, rootSizeFor, sizeOf } from "./config"
import { ms, ok, run } from "./host-commands"
import { ConsoleTail, ensureImage, waitInactive } from "./images"
import { kernelPathOf } from "./jail"
import { releasing, removeNet } from "./network"
import { Build, save } from "./registry"
import { addBalloon, fc, kernelArgs, spawn, stopVmm } from "./vmm"
import { assertPoolRoom, destroyDataset, dev, ds, growTo, waitDev } from "./zfs"

// ── Builds: the recipe in a builder microVM (RFC 0037) ──────────────────────
//
// A recipe is the project's code run as root: it gets a sandbox's isolation, never the host. The
// builder is a box like the others — a clone of the image, its own netns, `vms.slice` — whose init
// finds a `build` in MMDS, runs it with its output on the serial console (a file of the host's), and
// powers off. Its root disk, snapshotted, is the build. Nothing in it but the recipe's work: no
// token, no env, nothing personal (the script carries none).

export const buildRefOf = (buildId: string) => `bld-${buildId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40)}`
export const buildDir = (ref: string) => join(STATE, "builds", ref)
export const builderOf = (ref: string) => `build-${ref}`
export const fcStep = (edge: "start" | "end", id: string) => `::spunto:step:${edge}:fc:${id}`
/** Builds deleted (`deleteBuild`): their runner stops at its next step, cleans up, writes nothing back. */
export const deleted = new WeakSet<Build>()
/** The runner of each build in flight, by ref: a delete leaves the clean-up to it, a new build of that ref waits for it. */
export const buildRuns = new Map<string, Promise<void>>()
export class Cancelled extends Error {}

export function note(b: Build, where: "pre" | "post", line: string) {
  b[where] += `${line}\n`
  if (!deleted.has(b)) save()
}

export const BUILD_START = "::spunto-fc:build:start"
export const BUILD_EXIT = "::spunto-fc:build:exit:"

/**
 * The recipe's part of a build log, read from the builder's console as it grows: what is between
 * the start and exit markers. The text kept stops at MAX_BUILD_LOG (one line says so), the search
 * for the exit marker does not — a talkative recipe that exits 0 is a build that worked. Read from
 * the start again after a restart of the daemon, it comes out the same: the platform's cursor holds.
 */
export class BuildLog {
  private readonly tail: ConsoleTail
  private started = false
  private truncated = false
  log = ""
  exit?: number
  constructor(file: string, private readonly max = MAX_BUILD_LOG) {
    this.tail = new ConsoleTail(file)
  }

  /** `complete`: the builder is gone, its last unfinished line is all there will be. */
  read(complete: boolean): this {
    for (const line of this.tail.read(complete)) {
      if (this.exit !== undefined) break
      if (!this.started) {
        this.started = line === BUILD_START
        continue
      }
      if (line.startsWith(BUILD_EXIT)) {
        this.exit = Number(line.slice(BUILD_EXIT.length))
        continue
      }
      if (this.truncated) continue
      if (this.log.length + line.length + 1 > this.max) {
        this.truncated = true
        this.log += `[firecracker] the rest of the recipe's log is not kept (over ${Math.round(this.max / 1024 ** 2)} MB)\n`
        continue
      }
      this.log += `${line}\n`
    }
    return this
  }
}

/** Kept while a build runs or its log is being read; dropped once it has all been handed over. */
export const buildLogs = new Map<string, BuildLog>()
export function readBuildLog(ref: string, complete: boolean) {
  let l = buildLogs.get(ref)
  if (!l) buildLogs.set(ref, (l = new BuildLog(join(buildDir(ref), "console.log"))))
  return l.read(complete)
}

/** A child's exit, its stderr's tail in the error: `zfs send`/`zfs receive` of a build (RFC 0041). */
export function exited(child: ChildProcess, what: string): Promise<void> {
  let err = ""
  child.stderr?.on("data", (c: Buffer) => (err = (err + c.toString()).slice(-2000)))
  return new Promise((resolve, reject) => {
    child.on("error", reject)
    child.on("close", (code) => (code === 0 ? resolve() : reject(new SandboxError(`${what} exited with ${code}: ${err.trim()}`))))
  })
}

/** Exports to the org's bucket in flight or done (RFC 0041 § 4.3), by build ref. Lost with a restart: the platform asks again. */
export const exportsByRef = new Map<string, ExportStatus>()

/**
 * A build from the bucket (RFC 0041 § 4.3): what another machine sent with `zfs send`, received as
 * this build's disk — `@ready` comes with the stream. A full stream, so this machine needs neither
 * the image nor anything else of the other's.
 */
export async function fetchBuild(b: Build, artifact: NonNullable<BuildInput["artifact"]>) {
  await assertPoolRoom()
  await destroyDataset(ds.build(b.ref))
  const child = spawnChild("zfs", ["receive", "-u", ds.build(b.ref)], { stdio: ["pipe", "ignore", "pipe"] })
  const done = exited(child, "zfs receive")
  const size = artifact.bytes ? ` of ${humanBytes(artifact.bytes)}` : ""
  let shown = 0
  try {
    await downloadInto(artifact.target, child.stdin!, (n) => {
      b.phase = `fetching the build from the bucket — ${humanBytes(n)}${size}`
      // A line every 256 MB: the log tells the download, without a line per chunk.
      if (n - shown >= 256 * 1024 ** 2) {
        shown = n
        note(b, "pre", `[firecracker] ${humanBytes(n)}${size} fetched`)
      }
    })
  } catch (err) {
    child.kill()
    await done.catch(() => {})
    throw err
  }
  await done
  if (!(await ok(run("zfs", ["list", "-H", "-t", "snapshot", `${ds.build(b.ref)}@ready`])))) throw new SandboxError("the stream had no @ready snapshot")
  b.bytes = Number((await run("zfs", ["get", "-Hp", "-o", "value", "used", ds.build(b.ref)])).trim()) || undefined
}

export async function runBuild(b: Build, input: BuildInput | null) {
  const t0 = performance.now()
  const handle = builderOf(b.ref)
  const size = sizeOf(b.size)
  // Its network number stays taken until the very end of the clean-up below, whatever the state
  // says: `freeNet` would otherwise hand it to a new box while this one's netns is being removed.
  releasing.add(b.net)
  // Between two long steps: a build deleted meanwhile stops here, its clean-up in the catch.
  const check = () => {
    if (deleted.has(b)) throw new Cancelled()
  }
  try {
    // Built already, by another machine: fetched rather than cooked (RFC 0041 § 4.3). A fetch that
    // fails costs the recipe's minutes, never the build.
    if (input?.artifact?.format === "firecracker-zfs") {
      note(b, "pre", fcStep("start", "fetch"))
      try {
        await fetchBuild(b, input.artifact)
        check()
        note(b, "pre", `[firecracker] ${ds.build(b.ref)}@ready fetched from the bucket — no recipe to run`)
        note(b, "pre", fcStep("end", "fetch"))
        b.state = "ready"
        b.phase = "ready"
        return
      } catch (err) {
        if (err instanceof Cancelled) throw err
        await destroyDataset(ds.build(b.ref)).catch(() => {})
        note(b, "pre", `[firecracker] could not fetch the build from the bucket (${err instanceof Error ? err.message : String(err)}) — building from the recipe instead`)
        note(b, "pre", fcStep("end", "fetch"))
      }
    }
    if (input) {
      b.phase = "preparing the base image"
      note(b, "pre", fcStep("start", "image"))
      const imageId = await ensureImage(input.image, (p) => {
        b.phase = p
        if (!deleted.has(b)) save()
      })
      check()
      note(b, "pre", `[firecracker] ${input.image}: disk ${imageId}`)
      note(b, "pre", fcStep("end", "image"))
      b.phase = "starting a builder microVM"
      note(b, "pre", fcStep("start", "builder"))
      await stopVmm(handle)
      await destroyDataset(ds.build(b.ref))
      await destroyDataset(ds.buildWs(b.ref))
      await run("zfs", ["clone", `${ds.image(imageId)}@ready`, ds.build(b.ref)])
      // A recipe needs room too: the builder's system disk is a box's (its init grows the filesystem).
      await growTo(ds.build(b.ref), rootSizeFor(b.size))
      // A scratch /workspace, as a box would have: thrown away with the builder.
      await run("zfs", ["create", "-s", "-V", "4G", "-o", "volblocksize=16k", ds.buildWs(b.ref)])
      await waitDev(ds.buildWs(b.ref))
      await run("mkfs.ext4", ["-q", "-F", "-m", "0", "-L", "workspace", dev(ds.buildWs(b.ref))], { timeoutMs: 120_000 })
      await waitDev(ds.build(b.ref))
      mkdirSync(buildDir(b.ref), { recursive: true, mode: 0o700 })
      rmSync(join(buildDir(b.ref), "console.log"), { force: true })
      buildLogs.delete(b.ref)
      check()
      await spawn({
        handle,
        net: b.net,
        memMib: size.memMib,
        vcpus: size.vcpus,
        root: dev(ds.build(b.ref)),
        ws: dev(ds.buildWs(b.ref)),
        description: `Spunto build ${b.buildId}`,
        console: join(buildDir(b.ref), "console.log"),
      })
      await fc(handle, "PUT", "/boot-source", { kernel_image_path: kernelPathOf(), boot_args: kernelArgs() })
      await fc(handle, "PUT", "/drives/root", { drive_id: "root", path_on_host: DRIVE_ROOT, is_root_device: true, is_read_only: false })
      await fc(handle, "PUT", "/drives/ws", { drive_id: "ws", path_on_host: DRIVE_WS, is_root_device: false, is_read_only: false })
      await fc(handle, "PUT", "/machine-config", { vcpu_count: size.vcpus, mem_size_mib: size.memMib })
      await fc(handle, "PUT", "/network-interfaces/eth0", { iface_id: "eth0", host_dev_name: "tap0", guest_mac: GUEST_MAC })
      // A recipe's apt and compilers come and go: what they free goes back to the machine.
      await addBalloon(handle)
      await fc(handle, "PUT", "/mmds/config", { version: "V2", network_interfaces: ["eth0"] })
      await fc(handle, "PUT", "/mmds", {
        spunto: {
          generation: randomBytes(6).toString("hex"),
          now: String(Math.floor(Date.now() / 1000)),
          hostname: "spunto-build",
          build: Buffer.from(input.script).toString("base64"),
        },
      })
      await fc(handle, "PUT", "/actions", { action_type: "InstanceStart" })
      note(b, "pre", `[firecracker] builder microVM: ${size.vcpus} vCPU, ${size.memMib} MiB, kernel ${GUEST_KERNEL.version}`)
      note(b, "pre", fcStep("end", "builder"))
      b.phase = "running the recipe"
      save()
    }
    // A delete stops the builder: this wait ends at once.
    if (!(await waitInactive(handle, 2 * 60 * 60_000, 1000))) {
      await stopVmm(handle)
      throw new SandboxError("the recipe ran for more than 2 h")
    }
    check()
    const { exit } = readBuildLog(b.ref, true)
    if (exit === undefined) {
      const why = existsSync(join(buildDir(b.ref), "console.log")) ? "the builder stopped before the end of the recipe" : "interrupted by a restart of the node daemon"
      throw new SandboxError(`${why} (see its log)`)
    }
    if (exit !== 0) throw new SandboxError(`the recipe exited with status ${exit} (see its log)`)
    b.phase = "saving the disk"
    note(b, "post", fcStep("start", "disk"))
    await destroyDataset(ds.buildWs(b.ref))
    check()
    await run("zfs", ["snapshot", `${ds.build(b.ref)}@ready`])
    b.bytes = Number((await run("zfs", ["get", "-Hp", "-o", "value", "used", ds.build(b.ref)])).trim()) || undefined
    note(b, "post", `[firecracker] ${ds.build(b.ref)}@ready — ${Math.round((b.bytes ?? 0) / 1024 ** 2)} MB written by the recipe over the image`)
    note(b, "post", fcStep("end", "disk"))
    check()
    b.state = "ready"
    b.phase = "ready"
  } catch (err) {
    const gone = deleted.has(b)
    if (!gone) {
      b.state = "failed"
      b.phase = "failed"
      b.error = err instanceof Error ? err.message : String(err)
      note(b, "post", `[firecracker] build failed: ${b.error}`)
      console.error(`[firecracker] build ${b.ref} failed:`, err)
    }
    // Failed or deleted: what this runner made goes, whenever in the build it was made.
    await stopVmm(handle)
    await destroyDataset(ds.buildWs(b.ref)).catch(() => {})
    await destroyDataset(ds.build(b.ref)).catch(() => {})
    if (gone) {
      rmSync(buildDir(b.ref), { recursive: true, force: true })
      buildLogs.delete(b.ref)
    }
  } finally {
    await removeNet({ net: b.net }).catch(() => {})
    releasing.delete(b.net)
    if (!deleted.has(b)) {
      b.timings = { ...b.timings, buildMs: ms(t0) }
      save()
      console.log(`[firecracker] build ${b.ref} ${b.state} in ${ms(t0)} ms`)
    }
  }
}

/** Run a build's runner — after the previous runner of that ref, if a deleted one is still cleaning up. */
export function startBuild(b: Build, input: BuildInput | null) {
  const prev = buildRuns.get(b.ref) ?? Promise.resolve()
  const run = prev.then(() => runBuild(b, input))
  buildRuns.set(b.ref, run)
  void run.finally(() => buildRuns.get(b.ref) === run && buildRuns.delete(b.ref))
}
