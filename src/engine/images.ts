import { createHash } from "node:crypto"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { SandboxError } from "./types"
import { BIN, DRIVE_ROOT, DRIVE_WS, GUEST_MAC, IMAGE_SIZE, STATE } from "./config"
import { GUEST_INIT, UNPACK_INIT } from "./guest"
import { ms, run, sh } from "./host-commands"
import { kernelPathOf } from "./jail"
import { freeNet, releasing, removeNet } from "./network"
import { reg, save } from "./registry"
import { fc, kernelArgs, spawn, stopVmm, unitActive } from "./vmm"
import { destroyDataset, dev, ds, exists, waitDev } from "./zfs"

/** An image reference as `crane` takes it — and as it goes on the unpacker's kernel command line. */
export const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,499}$/

/** The image, the init baked into it and the way it was unpacked: a change to either makes a new disk (a running box keeps its own). */
export const imageIdOf = (image: string) => createHash("sha256").update(`${image}\n${GUEST_INIT}\n${UNPACK_INIT}`).digest("hex").slice(0, 16)
export const imageJobs = new Map<string, Promise<string>>()

export let unpackerReady: Promise<string> | null = null
/**
 * The unpacker's root disk, read-only: busybox, crane, the host's own GNU tar (and the libraries
 * `ldd` says it needs), the CA bundle, and the payload to install. Made by the host from files it
 * trusts, with `mkfs.ext4 -d` — at the first image of each daemon start.
 */
export function ensureUnpacker(): Promise<string> {
  unpackerReady ??= (async () => {
    const file = `${STATE}/unpacker.ext4`
    const root = `${STATE}/unpacker.d`
    rmSync(root, { recursive: true, force: true })
    for (const d of ["bin", "etc/ssl/certs", "payload", "proc", "sys", "dev", "tmp", "mnt"]) mkdirSync(join(root, d), { recursive: true })
    const tar = (await sh("readlink -f \"$(command -v tar)\"")).trim()
    if (!tar) throw new SandboxError("GNU tar is missing on this machine")
    const copy = (from: string, to: string, mode = 0o755) => {
      mkdirSync(join(to, ".."), { recursive: true })
      writeFileSync(to, readFileSync(from), { mode })
    }
    copy(BIN("busybox"), join(root, "bin/busybox"))
    copy(BIN("crane"), join(root, "bin/crane"))
    copy(tar, join(root, "bin/tar"))
    for (const lib of (await run("ldd", [tar])).matchAll(/(\/\S+) \(0x/g)) copy(lib[1]!, join(root, lib[1]!))
    const ca = ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"].find((f) => existsSync(f))
    if (!ca) throw new SandboxError("no CA bundle on this machine (ca-certificates)")
    copy(ca, join(root, "etc/ssl/certs/ca-certificates.crt"), 0o644)
    writeFileSync(join(root, "etc/resolv.conf"), "nameserver 1.1.1.1\nnameserver 8.8.8.8\n")
    writeFileSync(join(root, "init"), UNPACK_INIT, { mode: 0o755 })
    copy(BIN("tini"), join(root, "payload/tini"))
    copy(BIN("busybox"), join(root, "payload/busybox"))
    writeFileSync(join(root, "payload/init"), GUEST_INIT, { mode: 0o755 })
    rmSync(`${file}.new`, { force: true })
    await run("mkfs.ext4", ["-q", "-F", "-d", root, "-L", "spunto-unpack", `${file}.new`, "128M"], { timeoutMs: 120_000 })
    // Read by a jailed VMM, under a uid of its own: bound read-only into its jail (`placeInJail`).
    await run("chmod", ["644", `${file}.new`])
    // A rename: an unpacker running now keeps the file it booted.
    renameSync(`${file}.new`, file)
    rmSync(root, { recursive: true, force: true })
    return file
  })().catch((err) => {
    unpackerReady = null
    throw err
  })
  return unpackerReady
}

/** Lines of a console that are the VMM's or the guest kernel's, not the guest's own output. */
export const NOISE = /^(\d{4}-\d\d-\d\dT[\d:.]+ \[[^\]]*\]|\[\s*\d+\.\d+\] |\[spunto-init\] )/

/**
 * A box's serial console, read as it grows: each `read` starts where the last one stopped (a build
 * log is never read whole twice), CR stripped (the tty's ONLCR), the VMM's and the kernel's lines
 * out. A line still being written waits for its newline, unless `flush` (the writer is gone).
 */
export class ConsoleTail {
  private offset = 0
  private partial = Buffer.alloc(0)
  constructor(readonly file: string) {}

  read(flush = false): string[] {
    let fd: number
    try {
      fd = openSync(this.file, "r")
    } catch {
      return []
    }
    const lines: string[] = []
    try {
      const buf = Buffer.alloc(1 << 20)
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, this.offset)
        if (n <= 0) break
        this.offset += n
        const chunk = Buffer.concat([this.partial, buf.subarray(0, n)])
        const nl = chunk.lastIndexOf(10)
        // A line with no end in sight (64 KiB): out as it is, rather than held in memory.
        if (nl < 0 && chunk.length < 65_536) {
          this.partial = chunk
          continue
        }
        const cut = nl < 0 ? chunk.length : nl
        this.partial = Buffer.from(chunk.subarray(nl < 0 ? chunk.length : nl + 1))
        lines.push(...chunk.subarray(0, cut).toString("utf8").split("\n"))
      }
    } finally {
      closeSync(fd)
    }
    if (flush && this.partial.length) {
      lines.push(this.partial.toString("utf8"))
      this.partial = Buffer.alloc(0)
    }
    return lines.map((l) => l.replace(/\r/g, "")).filter((l) => !NOISE.test(l))
  }
}

/** Wait for a transient unit to exit, up to `timeoutMs`. False: still running. */
export async function waitInactive(handle: string, timeoutMs: number, every = 500) {
  for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
    if (!(await unitActive(handle))) return true
    await new Promise((r) => setTimeout(r, every))
  }
  return !(await unitActive(handle))
}

/** `crane export | tar -x` onto the zvol `dataset` (a fresh ext4), inside a throwaway microVM. */
export async function unpackInVm(image: string, id: string, dataset: string) {
  if (!IMAGE_REF.test(image)) throw new SandboxError(`not an image reference: ${image}`, "invalid")
  const rootfs = await ensureUnpacker()
  const handle = `unpack-${id}`
  const log = join(STATE, "unpack", `${id}.log`)
  mkdirSync(join(STATE, "unpack"), { recursive: true })
  rmSync(log, { force: true })
  const net = freeNet()
  releasing.add(net)
  try {
    await spawn({ handle, net, memMib: 1024, vcpus: 2, root: rootfs, rootReadOnly: true, ws: dev(dataset), description: `Spunto image unpacker (${image})`, console: log })
    await fc(handle, "PUT", "/boot-source", { kernel_image_path: kernelPathOf(), boot_args: kernelArgs({ init: "/init", readOnly: true, args: [image] }) })
    await fc(handle, "PUT", "/drives/root", { drive_id: "root", path_on_host: DRIVE_ROOT, is_root_device: true, is_read_only: true })
    await fc(handle, "PUT", "/drives/ws", { drive_id: "ws", path_on_host: DRIVE_WS, is_root_device: false, is_read_only: false })
    await fc(handle, "PUT", "/machine-config", { vcpu_count: 2, mem_size_mib: 1024 })
    await fc(handle, "PUT", "/network-interfaces/eth0", { iface_id: "eth0", host_dev_name: "tap0", guest_mac: GUEST_MAC })
    await fc(handle, "PUT", "/actions", { action_type: "InstanceStart" })
    if (!(await waitInactive(handle, 15 * 60_000))) throw new SandboxError("unpacking the image took more than 15 min")
    const lines = new ConsoleTail(log).read(true)
    if (lines.includes("::spunto-fc:unpack:done")) return
    const error = lines.find((l) => l.startsWith("::spunto-fc:unpack:error:"))?.slice("::spunto-fc:unpack:error:".length)
    const tail = lines.filter((l) => l.trim() && !l.startsWith("::spunto-fc:")).slice(-15).join("\n")
    throw new SandboxError(`could not unpack ${image}: ${error ?? "the unpacker stopped without finishing"}${tail ? `\n${tail}` : ""}`)
  } finally {
    await stopVmm(handle)
    await removeNet({ net })
    releasing.delete(net)
  }
}

export const DIGEST = /^sha256:[0-9a-f]{64}$/
/** `name[:tag]` without its tag — a `:` after the last `/` (a registry's port comes before it). */
export const repositoryOf = (image: string) => {
  const colon = image.lastIndexOf(":")
  return colon > image.lastIndexOf("/") ? image.slice(0, colon) : image
}
/** A digest asked for less than a minute ago: the boxes of one burst (a build, its tasks) ask the registry once. */
export const DIGEST_TTL_MS = 60_000
export const digests = new Map<string, { at: number; digest: Promise<string | null> }>()

/**
 * What a tag points at now, from the registry (`crane digest`, on the host — anonymous, like the
 * unpacker's pull). Null when the registry cannot say: unreachable, an image it does not know.
 */
export function digestOf(image: string): Promise<string | null> {
  // Asked from the host, outside any box's firewall: never for what the unpacker would refuse, nor
  // a registry on an address no box reaches (the host's network, probed in a box's name).
  if (!IMAGE_REF.test(image) || unreachableRegistry(image)) return Promise.resolve(null)
  const cached = digests.get(image)
  if (cached && Date.now() - cached.at < DIGEST_TTL_MS) return cached.digest
  const digest = run(BIN("crane"), ["digest", image], { timeoutMs: 30_000 }).then(
    (out) => (DIGEST.test(out.trim()) ? out.trim() : null),
    (err) => {
      console.warn(`[firecracker] could not resolve ${image} to a digest: ${err instanceof Error ? err.message : String(err)}`)
      return null
    },
  )
  digests.set(image, { at: Date.now(), digest })
  // A failure is not remembered: the next box asks again.
  void digest.then((d) => d === null && digests.get(image)?.digest === digest && digests.delete(image))
  return digest
}

/** A reference whose registry is an address of a range boxes never reach (`BLOCKED_DESTINATIONS`, loopback). Pure. */
export function unreachableRegistry(image: string) {
  const host = image.split("/")[0]!
  if (!image.includes("/") || !/[.:]|^localhost$/.test(host)) return false
  const name = host.replace(/^\[|\](:\d+)?$|:\d+$/g, "").toLowerCase()
  if (name === "localhost" || name === "::1" || /^(fc|fd|fe80)/.test(name) && name.includes(":")) return true
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(name)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168)
}

/**
 * Which disk a box of `image` gets. A tag moves (`:latest` pushed again): the disk is the one of what
 * it points at **now** — keyed by `repository@digest`, unpacked from exactly that digest. Keyed by the
 * reference alone, a machine kept the first `:latest` it unpacked for good (2026-11-09: Strasbourg's
 * spunto-worker-base of 2026-11-04, without the process-compose pushed on 2026-11-08). A reference
 * with a digest already is its own key; a registry that cannot answer leaves the newest disk of the
 * reference this machine has, or the reference unpacked as it is.
 */
export async function resolveImage(image: string): Promise<{ id: string; pull: string; digest?: string }> {
  if (image.includes("@")) return { id: imageIdOf(image), pull: image }
  const digest = await digestOf(image)
  if (digest) {
    const pull = `${repositoryOf(image)}@${digest}`
    return { id: imageIdOf(pull), pull, digest }
  }
  const newest = Object.values(reg().images)
    .filter((i) => i.image === image && i.state === "ready")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  return newest ? { id: newest.id, pull: image, digest: newest.digest } : { id: imageIdOf(image), pull: image }
}

/**
 * The disks of `image` an unpack of a newer digest replaces. Destroyed by `destroyDataset`, which
 * hands an `@ready` that boxes or builds are clones of to one of them first: they keep their blocks.
 */
export async function dropSuperseded(image: string, keep: string) {
  for (const old of Object.values(reg().images)) {
    if (old.image !== image || old.id === keep || imageJobs.has(old.id)) continue
    try {
      await destroyDataset(ds.image(old.id))
      delete reg().images[old.id]
      save()
      console.log(`[firecracker] image ${old.id} (${image}${old.digest ? `@${old.digest}` : ""}) superseded: destroyed`)
    } catch (err) {
      console.warn(`[firecracker] could not destroy the superseded image ${old.id} (${image}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** The image unpacked on a zvol, snapshotted `@ready` — every box's root is a clone of it. */
export async function ensureImage(image: string, progress: (step: string) => void): Promise<string> {
  const { id, pull, digest } = await resolveImage(image)
  const known = reg().images[id]
  if (known?.state === "ready") {
    if (await exists(`${ds.image(id)}@ready`)) return id
    // Its disk went (cleaned up by hand, a pool recreated): unpacked again, not an error per box.
    console.warn(`[firecracker] image ${id} (${image}) was ready but its disk is gone: unpacking it again`)
    delete reg().images[id]
    save()
  }
  let job = imageJobs.get(id)
  if (!job) {
    job = (async () => {
      const dataset = ds.image(id)
      // An unpacker the previous daemon left running holds the zvol.
      await stopVmm(`unpack-${id}`)
      await destroyDataset(dataset)
      await run("zfs", ["create", "-p", "-s", "-V", IMAGE_SIZE, "-o", "volblocksize=16k", dataset])
      await waitDev(dataset)
      // A filesystem the host makes, empty: the image itself goes on it inside the unpacker.
      await run("mkfs.ext4", ["-q", "-F", "-L", "spunto-root", dev(dataset)], { timeoutMs: 120_000 })
      progress("pulling and unpacking the image (in a microVM)")
      const t0 = performance.now()
      await unpackInVm(pull, id, dataset)
      await run("zfs", ["snapshot", `${dataset}@ready`])
      const bytes = Number((await run("zfs", ["get", "-Hp", "-o", "value", "used", dataset])).trim())
      reg().images[id] = { id, image, ...(digest ? { digest } : {}), state: "ready", bytes, createdAt: new Date().toISOString() }
      save()
      console.log(`[firecracker] image ${pull} unpacked in ${ms(t0)} ms (${Math.round(bytes / 1024 ** 2)} MB)`)
      if (digest) await dropSuperseded(image, id)
      return id
    })().finally(() => imageJobs.delete(id))
    imageJobs.set(id, job)
  }
  return job
}
