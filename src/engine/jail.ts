import { KERNEL } from "./host"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { SandboxError } from "./types"
import { DRIVE_ROOT, DRIVE_WS, JAILED, JAILER_BIN, JAIL_BASE, MOUNTS, RUN, STATE, UID_BASE } from "./config"
import { sha256Of } from "./host"
import { ms, q, run, sh } from "./host-commands"
import { vmmPath } from "./memory"
import { Launch } from "./vmm"

// ── The jail: a chroot and a uid per VMM ───────────────────────────────────

/**
 * Firecracker's jailer, pinned like the kernel: the binary of the release's tarball, by its sha256.
 * The daemon installs it next to `firecracker` when it is missing or not this one (`ensureJailer`).
 */
export const JAILER_RELEASE = {
  version: "v1.17.0",
  sha256: "65ef226e96f0ceda55ba643f445801ef2cc0ea667ef67cad8ac4f406c9c8434f",
}
export const uidOf = (net: number) => UID_BASE + net

/** The jailer's `--id`: letters, digits and hyphens, 64 at most — the handle itself when it is one. */
export function jailIdOf(handle: string) {
  if (/^[A-Za-z0-9-]{1,64}$/.test(handle)) return handle
  return `${handle.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 47)}-${createHash("sha256").update(handle).digest("hex").slice(0, 16)}`
}
/** The jailer's own directory for a VMM, and the chroot in it (`<base>/firecracker/<id>/root`). */
export const jailDirOf = (handle: string) => join(JAIL_BASE, "firecracker", jailIdOf(handle))
export const jailOf = (handle: string) => join(jailDirOf(handle), "root")
export const jailSockOf = (handle: string) => join(jailOf(handle), "run", "api.sock")
/** Where a VMM started before the jailer (or with `SPUNTO_FC_JAILER=0`) has its socket. */
export const plainSockOf = (handle: string) => `${RUN}/${handle}.sock`
/** A VMM's API socket: in its jail, unless one from before it is still running. */
export const sockOf = (handle: string) => (existsSync(plainSockOf(handle)) ? plainSockOf(handle) : jailSockOf(handle))
/** The VMM of `handle` runs in a jail (one started by an older daemon, still running, does not). */
export const jailedNow = (handle: string) => !existsSync(plainSockOf(handle)) && existsSync(jailSockOf(handle))
/** The kernel, as the VMM opens it: bound into its jail at a fixed path (`makeJail`). */
export const JAIL_KERNEL = "/vmlinux"
export const kernelPathOf = () => (JAILED ? JAIL_KERNEL : KERNEL)

/** A block device's numbers from `stat -L -c '%F %t %T'` (hex), as `mknod` takes them — or undefined: not one. Pure. */
export function blockDeviceOf(stat: string): { major: number; minor: number } | undefined {
  const m = /^block special file ([0-9a-f]+) ([0-9a-f]+)$/i.exec(stat.trim())
  return m ? { major: parseInt(m[1]!, 16), minor: parseInt(m[2]!, 16) } : undefined
}

/**
 * A VMM's jail before the jailer takes it: its two drives at the very paths a VMM has always been
 * given (`DRIVE_ROOT`, `DRIVE_WS`) — a RAM snapshot names its drives by path, so one taken outside a
 * jail loads in one, and the other way round — and the kernel, read-only. The jailer adds `dev/`
 * (kvm, net/tun, urandom, userfaultfd), copies the binary in, and chowns the chroot to the VMM.
 *  - a zvol is a device node of its own in there (`mknod`, the VMM's, 600): the host's `/dev/zd*`
 *    stay root's;
 *  - a file (the unpacker's read-only root, the kernel) is bound in, readable by all, never the VMM's.
 */
export async function makeJail(l: Launch, uid: number) {
  await unjail(l.handle)
  const root = jailOf(l.handle)
  mkdirSync(join(root, dirname(DRIVE_ROOT)), { recursive: true, mode: 0o755 })
  const drives = [
    { at: join(root, DRIVE_ROOT), from: l.root, readOnly: !!l.rootReadOnly },
    { at: join(root, DRIVE_WS), from: l.ws, readOnly: false },
  ]
  // Through the link (`/dev/zvol/…` → `/dev/zdN`), both in one call.
  const kinds = (await run("stat", ["-L", "-c", "%F %t %T", ...drives.map((d) => d.from)])).split("\n")
  const nodes: string[] = []
  const binds = [{ at: join(root, JAIL_KERNEL), from: KERNEL, readOnly: true }]
  for (const [i, d] of drives.entries()) {
    const block = blockDeviceOf(kinds[i] ?? "")
    if (!block) {
      binds.push(d)
      continue
    }
    await run("mknod", ["-m", "600", d.at, "b", String(block.major), String(block.minor)])
    nodes.push(d.at)
  }
  if (nodes.length) await run("chown", [`${uid}:${uid}`, ...nodes])
  for (const b of binds) {
    writeFileSync(b.at, "")
    await run("mount", ["--bind", ...(b.readOnly ? ["-o", "ro"] : []), b.from, b.at])
  }
}

/**
 * A jail gone: what is mounted in it unmounted (the deepest first, lazily — a mapping keeps its
 * file), then removed, never across a mount (`--one-file-system`: a bind that would not unmount is an
 * error, not a host directory emptied). At every stop, before every spawn, and at the daemon's start
 * for the jails of VMMs that died on their own.
 */
export async function unjail(handle: string) {
  const dir = jailDirOf(handle)
  if (!existsSync(dir)) return
  const mounts = readFileSync(MOUNTS, "utf8")
    .split("\n")
    .map((l) => l.split(" ")[1])
    .filter((m): m is string => !!m && m.startsWith(`${dir}/`))
    .sort((a, b) => b.length - a.length)
  for (const m of mounts) await run("umount", ["-l", m]).catch(() => {})
  await run("rm", ["-rf", "--one-file-system", dir])
}

/**
 * Host files as the VMM of `handle` must be given them, for the length of `fn` — a RAM snapshot's
 * memory and device state, written or loaded. In a jail the VMM sees nothing of the host: each
 * directory is bound into it (`/mem/<random>`) for the call, and unmounted after. The jailer makes its
 * root a slave of the host's, so a mount made since the VMM started reaches it, and so does its
 * unmount: no memory dataset is ever held by a jail (until 2026-10-16, each VMM had a private copy
 * of the host's mounts, and unmounted the memory datasets in it at its start).
 *  - `own`: the box's own directories (its memory dataset, its scratch) are its VMM's uid's — it
 *    writes there, and loads what it wrote;
 *  - otherwise (a model's memory, loaded by every box made from it): root's, readable, never written.
 * A VMM from before the jailer, still running, gets them through the daemon's root (`vmmPath`).
 */
export async function withVmmPaths<T>(handle: string, uid: number, files: { path: string; own: boolean }[], fn: (paths: string[]) => Promise<T>): Promise<T> {
  if (!jailedNow(handle)) return fn(files.map((f) => vmmPath(f.path)))
  const dirs = [...new Set(files.map((f) => dirname(f.path)))]
  const at = new Map<string, string>()
  try {
    for (const dir of dirs) {
      const mine = files.filter((f) => dirname(f.path) === dir)
      const present = mine.map((f) => f.path).filter((p) => existsSync(p))
      if (mine.some((f) => f.own)) await run("chown", [`${uid}:${uid}`, dir, ...present])
      else {
        await run("chown", ["0:0", dir, ...present])
        await run("chmod", ["755", dir])
        if (present.length) await run("chmod", ["644", ...present])
      }
      const name = `/mem/${randomBytes(4).toString("hex")}`
      mkdirSync(join(jailOf(handle), name), { recursive: true, mode: 0o755 })
      at.set(dir, name)
      await run("mount", ["--bind", dir, join(jailOf(handle), name)])
    }
    return await fn(files.map((f) => `${at.get(dirname(f.path))}/${basename(f.path)}`))
  } finally {
    for (const name of at.values()) {
      const target = join(jailOf(handle), name)
      await run("umount", ["-l", target]).catch(() => {})
      try {
        rmdirSync(target)
      } catch {}
    }
  }
}

/**
 * The CPU a VMM may take, as systemd properties of its unit (RFC 0039 § 21). Until 2026-10-16 only its
 * number of vCPUs bounded a box, and `vms.slice` had no `cpu` controller: every vCPU thread of every
 * box competed with every other one, so a box of 8 busy vCPUs took 8 shares of the machine to its
 * 1-vCPU neighbour's one (measured on Canada: the neighbour down to 0.35–0.55× its speed).
 *  - `CPUWeight`: **the same for every box** (`SPUNTO_FC_CPU_WEIGHT`, 100) — under contention, each
 *    box that wants CPU gets an equal part of the machine, up to its vCPUs. 100 per vCPU
 *    (`SPUNTO_FC_CPU_WEIGHT=vcpu`) would be what the threads got without it: a vCPU is one thread;
 *  - `CPUQuota` (`cpu.max`): its vCPUs plus a margin for the VMM's own threads (virtio, the API),
 *    `SPUNTO_FC_CPU_MARGIN` cores, 0.5 by default — never more than it was sold, even on an idle machine.
 * `SPUNTO_FC_CPU_LIMITS=0` leaves both unset.
 */
export function cpuLimits(vcpus: number): string[] {
  if (process.env.SPUNTO_FC_CPU_LIMITS === "0") return []
  const margin = Number(process.env.SPUNTO_FC_CPU_MARGIN ?? 0.5)
  const w = process.env.SPUNTO_FC_CPU_WEIGHT ?? "100"
  const weight = w === "vcpu" ? vcpus * 100 : Number(w) || 100
  return [`CPUQuota=${Math.round((vcpus + (Number.isFinite(margin) && margin >= 0 ? margin : 0.5)) * 100)}%`, `CPUWeight=${Math.min(10_000, Math.max(1, weight))}`]
}

export let jailerReady: Promise<void> | null = null
/**
 * The pinned jailer at `bin/jailer`: the release's tarball fetched from GitHub when it is missing or
 * another one (a machine installed before it, like test-2), its binary checked against the pin. A
 * machine that cannot get it keeps running its boxes, and refuses to start new ones until it can
 * (retried at the next spawn) — never a VMM as root in its place.
 */
export function ensureJailer(): Promise<void> {
  if (!JAILED) return Promise.resolve()
  jailerReady ??= (async () => {
    const bin = JAILER_BIN
    if (process.env.SPUNTO_FC_JAILER_BIN) {
      if (!existsSync(bin)) throw new SandboxError(`no jailer at ${bin}`)
      return
    }
    if (existsSync(bin) && sha256Of(bin) === JAILER_RELEASE.sha256) return
    const t0 = performance.now()
    const { version, sha256 } = JAILER_RELEASE
    const res = await fetch(`https://github.com/firecracker-microvm/firecracker/releases/download/${version}/firecracker-${version}-x86_64.tgz`, { signal: AbortSignal.timeout(5 * 60_000) })
    if (!res.ok) throw new SandboxError(`jailer ${version}: GitHub answered ${res.status}`)
    const tgz = join(STATE, `firecracker-${version}.tgz`)
    writeFileSync(tgz, Buffer.from(await res.arrayBuffer()), { mode: 0o600 })
    try {
      const out = `${bin}.new`
      await sh(`tar -xzOf ${q(tgz)} ${q(`release-${version}-x86_64/jailer-${version}-x86_64`)} > ${q(out)}`)
      const got = sha256Of(out)
      if (got !== sha256) {
        rmSync(out, { force: true })
        throw new SandboxError(`jailer ${version}: sha256 ${got}, expected ${sha256} — not installed`)
      }
      await run("chmod", ["755", out])
      renameSync(out, bin)
    } finally {
      rmSync(tgz, { force: true })
    }
    console.log(`[firecracker] jailer ${version} installed (sha256 checked) in ${ms(t0)} ms`)
  })().catch((err) => {
    jailerReady = null
    throw new SandboxError(`the jailer is missing and could not be installed (${err instanceof Error ? err.message : err}): no new microVM on this machine until it is — ${JAILER_BIN}, Firecracker ${JAILER_RELEASE.version}`)
  })
  return jailerReady
}
