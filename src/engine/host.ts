import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { SandboxError } from "./types"
import { builderOf, startBuild } from "./builds"
import { BIN, DATASET, DRIVE_ROOT, DRIVE_WS, GUEST_KERNEL, JAIL_BASE, KVM, OPT, PINNED_KERNEL, RUN, STATE, SYSFS_NET, UDEV_RULES, sizeOf } from "./config"
import { ms, ok, run,  } from "./host-commands"
import { cpuLimits, ensureJailer, jailIdOf, unjail } from "./jail"
import { removeVm } from "./lifecycle"
import { ensureMemRoot, ensureScratch, sweepMem } from "./memory"
import { ensureHostNetwork, guardNet, netOf } from "./network"
import { reg, save, serial } from "./registry"
import { finishStop, migrateLegacyMemory, sweepForks } from "./snapshots"
import { EXITED, LAUNCH, settleDeadVms, settleIfDead, unitActive, unitOf } from "./vmm"
import { exists } from "./zfs"

/** What new boxes boot: the pinned kernel, or — when it could not be fetched — the one the machine had. */
export let KERNEL = PINNED_KERNEL
/** The sha256 (16 hex) of the kernel new boxes boot — set at host setup. */
export let kernelId = ""

// ── Host setup ──────────────────────────────────────────────────────────────

export const sha256Of = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex")

/**
 * The guest kernel at KERNEL, checked: fetched from ghcr.io when missing or not the pinned one (a
 * blob is addressed by its sha256 — what comes back is checked against it all the same), then
 * `kernels/default` points at it. A new version is a new daemon: the next restart fetches it, and
 * boxes pick it up at their next boot (§ 4.1).
 */
export async function ensureKernel() {
  if (process.env.SPUNTO_FC_KERNEL) {
    if (!existsSync(KERNEL)) throw new SandboxError(`no kernel at ${KERNEL}`)
    kernelId = sha256Of(KERNEL).slice(0, 16)
  } else {
    try {
      await fetchKernel()
      KERNEL = PINNED_KERNEL
      kernelId = GUEST_KERNEL.sha256.slice(0, 16)
    } catch (err) {
      // Not a reason to stop serving the boxes this machine has: the kernel it had, until the next start.
      const fallback = `${OPT}/kernels/default`
      if (!existsSync(fallback)) throw err
      console.error(`[firecracker] ${err instanceof Error ? err.message : err} — booting new boxes on ${readlinkSync(fallback)} until the next start`)
      KERNEL = fallback
      kernelId = sha256Of(fallback).slice(0, 16)
    }
  }
  // Read by jailed VMMs under uids of their own, through a bind (`makeJail`): a bind keeps the
  // file's mode, and the kernels fetched before the jailer were 600. Nothing secret in it.
  await run("chmod", ["644", KERNEL])
}

export async function fetchKernel() {
  const KERNEL = PINNED_KERNEL
  if (!existsSync(KERNEL) || sha256Of(KERNEL) !== GUEST_KERNEL.sha256) {
    const t0 = performance.now()
    const { repository, sha256 } = GUEST_KERNEL
    const auth = (await (await fetch(`https://ghcr.io/token?scope=repository:${repository}:pull`, { signal: AbortSignal.timeout(30_000) })).json()) as { token?: string }
    const res = await fetch(`https://ghcr.io/v2/${repository}/blobs/sha256:${sha256}`, { headers: auth.token ? { Authorization: `Bearer ${auth.token}` } : {}, signal: AbortSignal.timeout(5 * 60_000) })
    if (!res.ok) throw new SandboxError(`guest kernel ${GUEST_KERNEL.version}: ghcr.io answered ${res.status}`)
    const body = Buffer.from(await res.arrayBuffer())
    const got = createHash("sha256").update(body).digest("hex")
    if (got !== sha256) throw new SandboxError(`guest kernel ${GUEST_KERNEL.version}: sha256 ${got}, expected ${sha256} — not installed`)
    mkdirSync(join(KERNEL, ".."), { recursive: true })
    writeFileSync(`${KERNEL}.new`, body, { mode: 0o644 })
    renameSync(`${KERNEL}.new`, KERNEL)
    console.log(`[firecracker] guest kernel ${GUEST_KERNEL.version} installed (${Math.round(body.length / 1024 ** 2)} MB, sha256 checked) in ${ms(t0)} ms`)
  }
  await run("ln", ["-sfn", `${GUEST_KERNEL.version}/vmlinux`, `${OPT}/kernels/default`])
}

/**
 * At the daemon's start: the CPU limits on every VMM running (`systemctl set-property --runtime`,
 * at once and without a restart — those started before them included), every box's network limits
 * (its share of the uplink, no SMTP: `guardNet`), and the jails of VMMs that are gone (one the OOM
 * killer took, a machine rebooted) removed.
 */
export async function settleRunningVmms() {
  const vcpusOf = new Map<string, number>()
  for (const vm of Object.values(reg().vms)) vcpusOf.set(unitOf(vm.handle), sizeOf(vm.size).vcpus)
  for (const b of Object.values(reg().builds)) vcpusOf.set(unitOf(builderOf(b.ref)), sizeOf(b.size).vcpus)
  for (const [unit, vcpus] of vcpusOf) {
    const limits = cpuLimits(vcpus)
    if (!limits.length || !(await ok(run("systemctl", ["is-active", "--quiet", unit])))) continue
    await run("systemctl", ["set-property", "--runtime", unit, ...limits]).catch((err) => console.warn(`[firecracker] ${unit}: CPU limits not set (${err instanceof Error ? err.message : err})`))
  }
  // Their network too (§ 22): its share of the uplink, port 25 — a box from before has them now.
  const nets: [number, string | undefined][] = [
    ...Object.values(reg().vms).map((vm) => [vm.net, vm.sandboxId] as [number, string]),
    ...Object.values(reg().builds).filter((b) => b.state === "running").map((b) => [b.net, undefined] as [number, undefined]),
  ]
  for (const [net, sandboxId] of nets) {
    if (!existsSync(`${SYSFS_NET}/${netOf(net).hostIf}`)) continue
    await guardNet(net, sandboxId).catch((err) => console.warn(`[firecracker] ${netOf(net).hostIf}: network limits not set (${err instanceof Error ? err.message : err})`))
  }
  const jails = join(JAIL_BASE, "firecracker")
  if (!existsSync(jails)) return
  const handles = [...Object.keys(reg().vms), ...Object.values(reg().builds).map((b) => builderOf(b.ref))]
  for (const id of readdirSync(jails)) {
    const handle = handles.find((h) => jailIdOf(h) === id) ?? id
    if (await unitActive(handle)) continue
    await unjail(handle).catch((err) => console.warn(`[firecracker] jail ${id} stays (${err instanceof Error ? err.message : err})`))
  }
}

/**
 * A box's disks hold what its guest wrote: a label the host's fstab names (`cloudimg-rootfs`), an
 * LVM physical volume, an md superblock. udev's blkid of them is what LVM's and mdadm's rules
 * activate and assemble on: none, for the zvols under DATASET — ZFS's own rule (`/dev/zvol/…`, what
 * the engine uses) is not one of persistent-storage's. Before 60, which honours the flag.
 */
export const ZVOL_RULE = (dataset: string) =>
  `# spunto-fc: no blkid, LVM or md on the boxes' disks (what their guests wrote)\n` +
  `SUBSYSTEM=="block", KERNEL=="zd*", ACTION!="remove", PROGRAM=="zvol_id $devnode", RESULT=="${dataset}/*", ENV{UDEV_DISABLE_PERSISTENT_STORAGE_RULES_FLAG}="1"\n`

export async function ensureZvolRule() {
  const file = join(UDEV_RULES, "59-spunto-fc-zvol.rules")
  const rule = ZVOL_RULE(DATASET)
  if (existsSync(file) && readFileSync(file, "utf8") === rule) return
  mkdirSync(UDEV_RULES, { recursive: true })
  writeFileSync(`${file}.new`, rule, { mode: 0o644 })
  renameSync(`${file}.new`, file)
  await run("udevadm", ["control", "--reload"])
}

export let hostReady: Promise<void> | null = null
/** Directories, the launch script, the kernel, the datasets and the network rules — idempotent, at first use. */
export function ensureHost(): Promise<void> {
  hostReady ??= (async () => {
    for (const d of [STATE, RUN, `${STATE}/vms`, `${STATE}/templates`, `${STATE}/builds`, `${STATE}/drive`]) mkdirSync(d, { recursive: true, mode: 0o700 })
    for (const f of [DRIVE_ROOT, DRIVE_WS]) if (!existsSync(f)) writeFileSync(f, "")
    writeFileSync(`${STATE}/launch.sh`, LAUNCH, { mode: 0o755 })
    writeFileSync(`${STATE}/exited.sh`, EXITED, { mode: 0o755 })
    for (const b of ["firecracker", "snapshot-editor", "crane", "tini", "busybox"]) {
      if (!existsSync(BIN(b))) throw new SandboxError(`${BIN(b)} is missing — see docs/sandboxes.md § Mode natif`)
    }
    await ensureKernel()
    if (!existsSync(KVM)) throw new SandboxError(`${KVM} is missing: this machine cannot run microVMs`)
    for (const d of [DATASET, `${DATASET}/images`, `${DATASET}/vms`, `${DATASET}/ws`, `${DATASET}/templates`, `${DATASET}/builds`]) {
      // volmode=dev: no partition of a guest's on the host (inherited by every zvol below). A machine
      // from before has it with `zfs set volmode=dev <dataset>` — at a quiet time: ZFS makes the
      // device of every zvol not open again.
      if (!(await exists(d))) await run("zfs", ["create", "-p", "-o", "compression=lz4", ...(d === DATASET ? ["-o", "volmode=dev"] : []), d])
    }
    await ensureZvolRule().catch((err) => console.error(`[firecracker] udev rule for the boxes' disks not set: ${err instanceof Error ? err.message : err}`))
    await ensureMemRoot()
    await ensureScratch()
    await ensureHostNetwork()
    await ensureJailer().catch((err) => console.error(`[firecracker] ${err instanceof Error ? err.message : err}`))
    await settleRunningVmms()
    // What the previous daemon left halfway: its background work died with it.
    for (const vm of Object.values(reg().vms)) {
      if (vm.state === "destroying") void removeVm(vm, vm.keepVolumes === true).catch((err) => console.error(`[firecracker] destroy ${vm.handle}:`, err))
      // The RAM may be half written: finishStop writes it again if the VMM is still there (paused).
      else if (vm.state === "stopping") void serial(vm.handle, () => finishStop(vm))
      else if (vm.state === "creating") {
        vm.state = "error"
        vm.error = `interrupted at "${vm.step ?? "creating"}" by a restart of the node daemon — rebuild or destroy it`
        save()
      }
      // "running" with no VMM: the machine rebooted under it (Canada, 2026-10-11 15:51), or the VMM
      // died while no daemon was there to see it. Stopped — its next start boots the disk (its RAM
      // was consumed when loaded). One the OOM killer took too: `describe` says so, from `died`.
      else if (vm.state === "running") await settleIfDead(vm, "its microVM was not running when the node daemon started (the machine restarted?)")
    }
    // A box that dies while nobody asks about it is settled within 10 min, not at the next describe.
    setInterval(() => void settleDeadVms().then(sweepForks).then(sweepMem).catch(() => {}), 10 * 60_000).unref()
    if (process.env.SPUNTO_FC_MEM_MIGRATE !== "0") void migrateLegacyMemory()
    // A builder outlives the daemon (its own unit): its end is read from its console.
    for (const b of Object.values(reg().builds)) if (b.state === "running") startBuild(b, null)
  })().catch((err) => {
    hostReady = null
    throw err
  })
  return hostReady
}

/** As after a restart of the daemon: the host is set up again at the next operation (a test's restart). */
export function resetHost() {
  hostReady = null
}
