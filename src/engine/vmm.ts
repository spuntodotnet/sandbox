import { kernelId } from "./host"
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync, rmSync } from "node:fs"

import http from "node:http"
import { SandboxError } from "./types"

import { BIN, DRIVE_ROOT, DRIVE_WS, FC_ARGS, GUEST_IP, GUEST_MAC, GW_IP, JAILED, JAILER_BIN, JAIL_BASE, MEM_ROOT, NETNS_DIR, RUN, SLICE, STATE, WAKE_PORT, sizeOf } from "./config"
import { ok, q, run,  } from "./host-commands"
import { cpuLimits, ensureJailer, jailIdOf, jailSockOf, kernelPathOf, makeJail, plainSockOf, sockOf, uidOf, unjail, withVmmPaths } from "./jail"
import { ensureNet, netOf } from "./network"
import { Snapshot, Vm, reg, save } from "./registry"
import { dev, ds } from "./zfs"

// ── Firecracker API (HTTP over the box's unix socket) ───────────────────────

export const unitOf = (handle: string) => `spunto-fc-${handle}`

export function fc(handle: string, method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request(
      { socketPath: sockOf(handle), method, path, timeout: timeoutMs, headers: { Accept: "application/json", ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) } },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8")
          if ((res.statusCode ?? 500) >= 300) {
            let msg = text
            try {
              msg = JSON.parse(text).fault_message ?? text
            } catch {}
            return reject(new SandboxError(`firecracker ${method} ${path}: ${msg} (HTTP ${res.statusCode})`))
          }
          try {
            resolve(text ? JSON.parse(text) : {})
          } catch {
            resolve({})
          }
        })
      },
    )
    req.on("timeout", () => req.destroy(new Error(`firecracker ${method} ${path} timed out`)))
    req.on("error", reject)
    if (payload) req.write(payload)
    req.end()
  })
}

export const unitActive = (handle: string) => ok(run("systemctl", ["is-active", "--quiet", unitOf(handle)]))

// ── Boot, load, snapshot ────────────────────────────────────────────────────

/**
 * Without the jailer only (`SPUNTO_FC_JAILER=0`, and what VMMs started before 2026-10-16 still run):
 * Firecracker as root in the box's netns, its drives bound at fixed paths in a private mount
 * namespace. The memory datasets are unmounted in it first: its copy of each would keep that dataset
 * busy for as long as the box runs, and `zfs destroy` of it — a box removed, a template deleted —
 * would fail. It reaches its memory files through the daemon's namespace (`vmmPath`).
 */
export const LAUNCH = `#!/bin/sh
# spunto-fc launch <netns> <root dev> <ws dev> <api socket>
set -e
exec ip netns exec "$1" unshare --mount --propagation private sh -ec '
  umount -R -l ${MEM_ROOT} 2>/dev/null || true
  mount --bind "$1" ${DRIVE_ROOT}
  mount --bind "$2" ${DRIVE_WS}
  exec ${BIN("firecracker")} --api-sock "$3" ${FC_ARGS.join(" ")}
' launch "$2" "$3" "$4"
`

/**
 * How a VMM's unit ended, as systemd tells its `ExecStopPost` (`$SERVICE_RESULT`: `success`,
 * `oom-kill`, `signal`, `exit-code`…): written next to its socket, read when a box the registry
 * says is running has no process any more. The unit itself is collected (`--collect`): its result
 * would be gone with it.
 */
export const EXITED = `#!/bin/sh
printf '%s %s %s\\n' "$SERVICE_RESULT" "$EXIT_CODE" "$EXIT_STATUS" > "$1"
`
export const exitFileOf = (handle: string) => `${RUN}/${handle}.exit`

/** One Firecracker process: a transient unit in the slice, its netns, its two drives. */
export type Launch = {
  handle: string
  net: number
  memMib: number
  vcpus: number
  root: string
  ws: string
  /** The root drive is opened read-only (the unpacker's, shared). */
  rootReadOnly?: boolean
  description: string
  /** The serial console to a file (a builder's log), not the journal. */
  console?: string
  /** A sandbox's (not a builder's, nor an unpacker's): what its exceptions are keyed by (`smtpOpen`). */
  sandboxId?: string
}

/**
 * The VMM's unit: the jailer (or `launch.sh` without it) in `vms.slice`, its memory and CPU bounded
 * (`cpuLimits`). The jailer chroots into `jailOf(handle)`, joins the box's netns, drops to the box's
 * uid and every capability, and execs Firecracker — the unit's main process from then on, so systemd
 * still sees how it ends (`EXITED`). No cgroup of the jailer's own: the unit is the VMM's cgroup.
 */
export async function spawn(l: Launch) {
  const uid = uidOf(l.net)
  if (JAILED) await ensureJailer()
  await ensureNet(l, JAILED ? uid : undefined)
  for (const sock of [plainSockOf(l.handle), jailSockOf(l.handle)]) rmSync(sock, { force: true })
  rmSync(exitFileOf(l.handle), { force: true })
  await run("systemctl", ["reset-failed", unitOf(l.handle)]).catch(() => {})
  if (JAILED) await makeJail(l, uid)
  const sock = JAILED ? jailSockOf(l.handle) : plainSockOf(l.handle)
  await run("systemd-run", [
    `--unit=${unitOf(l.handle)}`,
    `--slice=${SLICE}`,
    "--collect",
    "--quiet",
    `--description=${l.description}`,
    // The guest's RAM plus the VMM's own: a box that touches all of its memory still fits.
    `-p`, `MemoryMax=${l.memMib + 256}M`,
    `-p`, "MemorySwapMax=0",
    ...cpuLimits(l.vcpus).flatMap((p) => ["-p", p]),
    `-p`, `ExecStopPost=${STATE}/exited.sh ${exitFileOf(l.handle)}`,
    ...(l.console ? ["-p", `StandardOutput=append:${l.console}`, "-p", "StandardError=journal"] : []),
    ...(JAILED
      ? [
          JAILER_BIN,
          "--id", jailIdOf(l.handle),
          "--exec-file", BIN("firecracker"),
          "--uid", String(uid),
          "--gid", String(uid),
          "--chroot-base-dir", JAIL_BASE,
          "--netns", `${NETNS_DIR}/${netOf(l.net).netns}`,
          "--",
          "--api-sock", "/run/api.sock",
          ...FC_ARGS,
        ]
      : [`${STATE}/launch.sh`, netOf(l.net).netns, l.root, l.ws, sock]),
  ])
  for (let i = 0; i < 200 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 10))
  if (!existsSync(sock)) throw new SandboxError(`firecracker did not start — journalctl -u ${unitOf(l.handle)}`)
}

export async function spawnVmm(vm: Vm) {
  const size = sizeOf(vm.size)
  await spawn({ handle: vm.handle, net: vm.net, memMib: size.memMib, vcpus: size.vcpus, root: dev(ds.root(vm.handle)), ws: dev(ds.ws(vm.sandboxId)), description: `Spunto sandbox ${vm.sandboxId} (${vm.name})`, sandboxId: vm.sandboxId })
}

/**
 * What the box reads from MMDS: a new generation every boot and load, and its env. `resume:
 * "reconnect"` on a load of its own RAM: the platform dropped the agent's connection when it stopped
 * the box, so the agent dials at once instead of probing a dead socket first (§ 4.4). `resume:
 * "reidentify"` on a fork: the RAM of another box, a new env — the agent takes the new identity
 * without the processes going (§ 4.10).
 */
export function mmdsData(vm: Vm, opts: { resume?: boolean; reidentify?: boolean } = {}) {
  const env = Object.entries(vm.env)
    .map(([k, v]) => `${k}=${q(v)}`)
    .join("\n")
  return {
    spunto: {
      generation: randomBytes(6).toString("hex"),
      now: String(Math.floor(Date.now() / 1000)),
      hostname: vm.name.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63) || "sandbox",
      env: Buffer.from(`${env}\n`).toString("base64"),
      bootstrap: Buffer.from(vm.bootstrap).toString("base64"),
      ...(opts.reidentify ? { resume: "reidentify" } : opts.resume ? { resume: "reconnect" } : {}),
    },
  }
}

export function kernelArgs(opts: { init?: string; readOnly?: boolean; args?: string[] } = {}) {
  return [
    "console=ttyS0",
    "reboot=k",
    "panic=1",
    "pci=off",
    "quiet",
    "i8042.noaux",
    "i8042.nomux",
    "i8042.dumbkbd",
    "root=/dev/vda",
    opts.readOnly ? "ro" : "rw",
    `ip=${GUEST_IP}::${GW_IP}:255.255.255.252::eth0:off`,
    // Not by default any more: zeroing every freed page includes the boot, when the kernel hands
    // all of the RAM to its allocator — an xlarge touched its 16 GB in 6 s and the OOM killer took
    // it (2026-10-11, § 15). Free RAM leaves the memory file through the balloon's free page
    // reporting instead (`BALLOON`). `SPUNTO_FC_INIT_ON_FREE=1` brings it back, for a machine whose
    // boxes are few and small; `SPUNTO_FC_KERNEL_EXTRA_ARGS` adds other arguments.
    ...(process.env.SPUNTO_FC_INIT_ON_FREE === "1" ? ["init_on_free=1"] : []),
    ...(process.env.SPUNTO_FC_KERNEL_EXTRA_ARGS ?? "").split(/\s+/).filter((a) => /^[a-z0-9_.]+(=[A-Za-z0-9_.,:-]+)?$/.test(a)),
    `init=${opts.init ?? "/.spunto/tini"}`,
    "--",
    ...(opts.args ?? ["/.spunto/init"]),
  ].join(" ")
}

/**
 * A balloon that never inflates (`amount_mib: 0`), for its **free page reporting**: the guest tells
 * Firecracker which ranges it freed (2 MiB and up, ~2 s later) and Firecracker `MADV_DONTNEED`s
 * them. A box's resident RAM goes down again when it frees memory (a process gone, a
 * `drop_caches`), and those pages read as zeros in a snapshot — not stored at all in a memory dataset (lz4):
 * what `init_on_free` gave the memory files, without touching every page at boot (§ 15). On a box
 * whose RAM was loaded from a file, a reported page reads as the file's again — free all the same
 * for the guest, just not smaller on disk. Pre-boot only: a box booted before keeps going without
 * it until its next cold boot. `SPUNTO_FC_FREE_PAGE_REPORTING=0` turns it off.
 */
export const BALLOON = { amount_mib: 0, deflate_on_oom: true, stats_polling_interval_s: 0, free_page_reporting: true }
export const pageReporting = () => process.env.SPUNTO_FC_FREE_PAGE_REPORTING !== "0"
export let balloonWarned = false
export async function addBalloon(handle: string) {
  if (!pageReporting()) return
  try {
    await fc(handle, "PUT", "/balloon", BALLOON)
  } catch (err) {
    // A Firecracker without it (before 1.14): the box boots all the same, its free RAM stays resident.
    if (!balloonWarned) console.warn(`[firecracker] no free page reporting: ${err instanceof Error ? err.message : err}`)
    balloonWarned = true
  }
}

export async function coldBoot(vm: Vm) {
  const size = sizeOf(vm.size)
  await spawnVmm(vm)
  const h = vm.handle
  await fc(h, "PUT", "/boot-source", { kernel_image_path: kernelPathOf(), boot_args: kernelArgs() })
  await fc(h, "PUT", "/drives/root", { drive_id: "root", path_on_host: DRIVE_ROOT, is_root_device: true, is_read_only: false })
  await fc(h, "PUT", "/drives/ws", { drive_id: "ws", path_on_host: DRIVE_WS, is_root_device: false, is_read_only: false })
  await fc(h, "PUT", "/machine-config", { vcpu_count: size.vcpus, mem_size_mib: size.memMib, track_dirty_pages: true })
  await fc(h, "PUT", "/network-interfaces/eth0", { iface_id: "eth0", host_dev_name: "tap0", guest_mac: GUEST_MAC })
  await addBalloon(h)
  await fc(h, "PUT", "/mmds/config", { version: "V2", network_interfaces: ["eth0"] })
  await fc(h, "PUT", "/mmds", mmdsData(vm))
  await fc(h, "PUT", "/actions", { action_type: "InstanceStart" })
  // Booted from the disk: dirty pages tracked from the first one, so its first snapshot is a Diff
  // holding all of its memory (`Boot`).
  vm.diffable = false
  vm.sinceBoot = true
  vm.base = undefined
  vm.kernel = kernelId
}

export async function loadSnapshot(vm: Vm, snap: Snapshot, opts: { reidentify?: boolean } = {}) {
  await spawnVmm(vm)
  const h = vm.handle
  // Its own RAM is its VMM's to read; a model's is shared, read-only (`withVmmPaths`).
  const files = [snap.vmstate, snap.mem].map((path) => ({ path, own: snap.own }))
  await withVmmPaths(h, uidOf(vm.net), files, ([vmstate, mem]) =>
    fc(h, "PUT", "/snapshot/load", {
      snapshot_path: vmstate,
      mem_backend: { backend_type: "File", backend_path: mem },
      track_dirty_pages: true,
      resume_vm: false,
      // kvmclock jumps over the time the box was stopped, instead of resuming in the past.
      clock_realtime: true,
    }),
  )
  // Consumed before the box runs again: from here on, its disk moves past this RAM.
  if (snap.own) {
    snap.loadable = false
    save()
  }
  // Not part of a snapshot: the data store starts empty after a load.
  await fc(h, "PUT", "/mmds", mmdsData(vm, opts.reidentify ? { reidentify: true } : { resume: snap.own }))
  // Its RAM knows its disks at the size they had when it was frozen: Firecracker re-reads them
  // before the resume — so before the knock, after which the init's `grow_fs` reads the size.
  await refreshDrives(h)
  await fc(h, "PATCH", "/vm", { state: "Resumed" })
  vm.diffable = snap.own
  vm.sinceBoot = false
  // A template's file is never written again: a Diff of this box can go over a copy of it.
  vm.base = snap.own ? undefined : snap.mem
  vm.kernel = snap.kernel
  knock(vm)
}

/**
 * A running box's disks changed size (grown under it): Firecracker re-reads their size and tells
 * the guest's virtio-blk, which sees the new capacity at once — its filesystem is grown next, from
 * inside (`grow_fs` in the init, or the platform's post-fork for an older init).
 */
export async function refreshDrives(handle: string) {
  for (const [id, path] of [["root", DRIVE_ROOT], ["ws", DRIVE_WS]] as const) await fc(handle, "PATCH", `/drives/${id}`, { drive_id: id, path_on_host: path })
}

/**
 * Tell the init, now, that a new generation is in MMDS: a TCP connection to its WAKE_PORT from the
 * box's namespace. In the background, a few tries (between two of its listens, the port is closed
 * for a moment): without it, the init finds out within the second anyway.
 */
export function knock(vm: Vm) {
  void (async () => {
    for (let i = 0; i < 8; i++) {
      if (await ok(run("ip", ["netns", "exec", netOf(vm.net).netns, BIN("busybox"), "nc", "-w", "1", GUEST_IP, String(WAKE_PORT)], { input: "", timeoutMs: 3_000 }))) return
      await new Promise((r) => setTimeout(r, 50))
    }
  })()
}

export async function stopVmm(handle: string) {
  await run("systemctl", ["stop", unitOf(handle)], { timeoutMs: 30_000 }).catch(() => {})
  for (const sock of [plainSockOf(handle), jailSockOf(handle)]) rmSync(sock, { force: true })
  await unjail(handle).catch((err) => console.warn(`[firecracker] ${handle}: its jail stays (${err instanceof Error ? err.message : err})`))
  // Stopped on purpose: nothing to report about how it ended.
  rmSync(exitFileOf(handle), { force: true })
}

/**
 * Why a box's VMM is gone when nobody stopped it, from its unit's `ExecStopPost` (`EXITED`) — or
 * undefined: no record (a host reboot, an older daemon's unit), or a clean exit.
 */
export function deathOf(handle: string): { result: string; detail: string } | undefined {
  let line: string
  try {
    line = readFileSync(exitFileOf(handle), "utf8").trim()
  } catch {
    return undefined
  }
  const [result = "", code = "", status = ""] = line.split(/\s+/)
  if (!result || result === "success") return undefined
  if (result === "oom-kill") {
    return {
      result,
      detail: `killed for lack of memory (OOM): the memory this machine gives its sandboxes (${SLICE}) was full — start it again once there is room, or on another machine`,
    }
  }
  return { result, detail: `the microVM ended on its own (${result}${code ? `, ${code}${status ? ` ${status}` : ""}` : ""}) — journalctl -u ${unitOf(handle)}` }
}

/**
 * A box the registry says `running` whose VMM is gone: `stopped` in the registry, said why. Left
 * `running`, it counted in the admission (`committedMib`) for good — seen on test-2 on 2026-10-20: a
 * large the OOM killer took held 8 GiB of what the machine admits for 30 h, through two restarts of
 * the daemon, until its sandbox was deleted by hand. Killed (a record, `deathOf`): `died` keeps the
 * record, and `describe` still says `error` and why. Without one (a host reboot, a clean exit): `why`.
 * True when it was settled. Not under the box's lock: a start in progress keeps the last word.
 */
export async function settleIfDead(vm: Vm, why = `its microVM ended without being asked to (journalctl -u ${unitOf(vm.handle)})`): Promise<boolean> {
  if (vm.state !== "running") return false
  const active = await unitActive(vm.handle)
  if (vm.state !== "running" || active) return false
  const death = deathOf(vm.handle)
  vm.state = "stopped"
  vm.died = death
  vm.stoppedWhy = death ? undefined : why
  console.warn(`[firecracker] ${vm.handle}: ${death?.detail ?? why} — stopped`)
  save()
  return true
}

/** Every box the registry says `running`, checked against its VMM (`settleIfDead`). */
export async function settleDeadVms() {
  for (const vm of Object.values(reg().vms)) await settleIfDead(vm)
}
