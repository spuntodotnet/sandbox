/**
 * The Firecracker backend's state machine against a fake host: `execFile` (systemd, zfs, ip,
 * iptables…) and the Firecracker API on its unix socket are mocked, the provider is the real one.
 */
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const host = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs")
  const { tmpdir } = require("node:os") as typeof import("node:os")
  const root = mkdtempSync(`${tmpdir()}/fc-state-`)
  for (const [k, v] of Object.entries({ OPT: "opt", STATE: "state", RUN: "run", KVM: "kvm", KERNEL: "opt/kernels/default", JAILER_BIN: "opt/bin/jailer", ZVOL_DIR: "zvol", MEMINFO: "meminfo", CGROUP_ROOT: "cgroup", MOUNTS: "mounts", SYSFS_NET: "sysnet", KSTAT: "kstat" })) {
    process.env[`SPUNTO_FC_${k}`] = `${root}/${v}`
  }
  process.env.SPUNTO_FC_UPLINK = "eth0"
  // Moving old memory files in is tested on its own: elsewhere a test's files stay where it put them.
  process.env.SPUNTO_FC_MEM_MIGRATE = "0"
  return {
    root,
    /**
     * Units systemd runs right now, by name. A box's VMM running has its API socket in its jail (one
     * from before the jailer: a test writes `<run>/<handle>.sock` too, which wins).
     */
    active: new (class extends Set<string> {
      override add(unit: string) {
        const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs")
        const h = unit.replace(/^spunto-fc-/, "")
        mkdirSync(`${root}/state/jail/firecracker/${h}/root/run`, { recursive: true })
        writeFileSync(`${root}/state/jail/firecracker/${h}/root/run/api.sock`, "")
        return super.add(unit)
      }
    })(),
    /** Firecracker API calls, in order. */
    api: [] as { method: string; path: string; body: any; given?: any; jail?: string | null }[],
    commands: [] as string[],
    /** Datasets `zfs list` does not find. */
    missing: new Set<string>(),
    /** Unpackers stay up (and say "done" when they go) instead of exiting at once with nothing. */
    slowUnpacker: false,
    /** What the registry says a reference points at (`crane digest`); one it does not have, it cannot say. */
    digests: new Map<string, string>(),
    /** `fallocate --dig-holes` runs until killed (a slow disk), and says so in `commands`. */
    slowDig: false,
    /** Each `fallocate --dig-holes` halves the file while this is above 0 (one fewer each time): a pass that punched something. */
    digShrinks: 0,
    /** zvol sizes in bytes (`zfs set volsize`), 10 GiB for one never set (an image's clone). */
    volsizes: new Map<string, number>(),
    /** What the pool has left, in bytes. */
    poolFree: 500 * 1024 ** 3,
    /** What each clone was cloned from, for `zfs get origin`. */
    origins: new Map<string, string>(),
    /** Commands that fail (a full disk, a broken tool), by their command line. */
    failing: null as RegExp | null,
    /** Run when the VMM is asked for a snapshot (a model deleted meanwhile…). */
    onSnapshot: null as null | (() => void),
    /** `vms.slice` as systemd shows it, in bytes. */
    slice: { max: 64 * 1024 ** 3, current: 0 },
    /** While set, `zfs destroy` of a dataset matching it waits for this to resolve. */
    destroyGate: null as null | { match: string; open: Promise<void> },
    /** Memory datasets a running box maps a file of: `zfs destroy` says busy. */
    busy: new Set<string>(),
    /** Called with each command line before it runs. */
    onCommand: null as null | ((line: string) => unknown),
    /** What `zfs get property,value` answers for `<dataset>/mem`, as zfs prints it. */
    memProps: "",
    /** Firecracker API paths that answer an error. */
    apiFailing: null as RegExp | null,
    /** Per dataset, what `zfs list -t snapshot -o clones -s createtxg` answers (one line per snapshot, oldest first). */
    snapClones: new Map<string, string>(),
    /** Per dataset, its snapshots' names (`zfs list -t snapshot -o name -d 1`), one per line. */
    snapNames: new Map<string, string>(),
    /** Bind mounts in place (symlinks here), by target. */
    mounts: new Set<string>(),
    /** `stat -L` says a zvol is a block device (230:16), not the file it is here. */
    zvolsAreDevices: false,
    /** Whose a box's tap is, as `ip -d link show tap0` says (empty: nobody's). */
    tapOwner: "",
    /** The port 25 rules in each box's namespace (`iptables -C` finds them, `-I`/`-D` change them), by netns. */
    smtpRules: new Set<string>(),
    /** IFB devices made (`ip link add … type ifb`): `ip link show` finds them. */
    ifbs: new Set<string>(),
  }
})

vi.mock("node:child_process", async (orig) => {
  const actual = await orig<typeof import("node:child_process")>()
  const { mkdirSync, writeFileSync } = await import("node:fs")
  const { dirname } = await import("node:path")
  const { existsSync, renameSync, rmSync } = await import("node:fs")
  // Memory datasets are filesystems: a directory each under STATE/mem, their snapshots copies of it.
  const MEM = "default/spunto/mem/"
  const memPath = (dataset: string) => `${process.env.SPUNTO_FC_STATE}/mem/${dataset.slice(MEM.length)}`
  const snapPath = (snap: string) => `${host.root}/mem-snapshots/${snap.replace(/\//g, "_")}`
  // A copy-on-write copy, as fast: a memory file can be 16 GiB long, all of it a hole.
  const cpSync = (from: string, to: string, _opts?: unknown) => {
    const { readdirSync, readFileSync, statSync, truncateSync, writeFileSync } = require("node:fs") as typeof import("node:fs")
    mkdirSync(to, { recursive: true })
    for (const f of readdirSync(from)) {
      const size = statSync(`${from}/${f}`).size
      writeFileSync(`${to}/${f}`, size > 1024 ** 2 ? "" : readFileSync(`${from}/${f}`))
      if (size > 1024 ** 2) truncateSync(`${to}/${f}`, size)
    }
  }
  const execFile = (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, out: string, errOut: string) => void) => {
    const line = `${cmd} ${args.join(" ")}`
    host.commands.push(line)
    host.onCommand?.(line)
    let fail = false
    const last = args[args.length - 1]!
    if (cmd === "zfs" && last.startsWith(MEM)) {
      if (args[0] === "list" && !last.includes("@")) fail = !existsSync(memPath(last))
      if (args[0] === "list" && last.includes("@")) fail = !existsSync(snapPath(last))
      if (args[0] === "create") mkdirSync(memPath(last), { recursive: true })
      if (args[0] === "clone") cpSync(snapPath(args[1]!), memPath(last), { recursive: true })
      if (args[0] === "rename") {
        renameSync(memPath(args[1]!), memPath(last))
        if (host.origins.has(args[1]!)) host.origins.set(last, host.origins.get(args[1]!)!)
      }
      if (args[0] === "destroy" && last.includes("@")) rmSync(snapPath(last), { recursive: true, force: true })
      else if (args[0] === "destroy" && host.busy.has(last)) fail = true
      else if (args[0] === "destroy") rmSync(memPath(last), { recursive: true, force: true })
    }
    if (cmd === "zfs" && args[0] === "snapshot") {
      for (const snap of args.slice(1).filter((a) => a.startsWith(MEM))) {
        mkdirSync(dirname(snapPath(snap)), { recursive: true })
        cpSync(memPath(snap.split("@")[0]!), snapPath(snap), { recursive: true })
      }
    }
    if (cmd.endsWith("/crane") && args[0] === "digest") fail = !host.digests.has(args[1]!)
    if (cmd === "systemctl" && args[0] === "is-active") fail = !host.active.has(args[2]!)
    if (cmd === "systemctl" && args[0] === "stop") host.active.delete(args[1]!)
    if (cmd === "zfs" && args[0] === "list" && host.missing.has(args[args.length - 1]!)) fail = true
    if (cmd === "ip" && args[0] === "link" && args[1] === "show" && args[2]?.startsWith("fcifb")) fail = !host.ifbs.has(args[2])
    if (cmd === "ip" && args[0] === "link" && args[1] === "add" && args.at(-1) === "ifb") host.ifbs.add(args[2]!)
    if (cmd === "ip" && args[0] === "netns" && args.includes("iptables") && line.includes("--dport 25")) {
      const ns = args[2]!
      const op = args[args.indexOf("iptables") + 1]
      if (op === "-C") fail = !host.smtpRules.has(ns)
      if (op === "-I") host.smtpRules.add(ns)
      if (op === "-D") host.smtpRules.delete(ns)
    }
    if (host.failing?.test(line)) fail = true
    // A zvol appears under /dev/zvol.
    if (cmd === "zfs" && args[0] === "clone") host.origins.set(args[2]!, args[1]!)
    if (cmd === "zfs" && (args[0] === "create" || args[0] === "clone")) {
      const zvol = `${process.env.SPUNTO_FC_ZVOL_DIR}/${args[args.length - 1]}`
      mkdirSync(dirname(zvol), { recursive: true })
      writeFileSync(zvol, "")
    }
    if (cmd === "systemd-run") {
      const unit = args.find((a) => a.startsWith("--unit="))!.slice("--unit=".length)
      // An unpacker is gone at once (the fake has no image to unpack) unless told otherwise; a box
      // runs until stopped.
      if (!unit.includes("-unpack-") || host.slowUnpacker) host.active.add(unit)
      const out = args.find((a) => a.startsWith("StandardOutput=append:"))?.slice("StandardOutput=append:".length)
      if (out && unit.includes("-unpack-") && host.slowUnpacker) writeFileSync(out, "::spunto-fc:unpack:done\n")
      // The API socket appears: in the jail the jailer made, or where launch.sh was told.
      const id = args[args.indexOf("--id") + 1]
      const sock = args.includes("--id") ? `${args[args.indexOf("--chroot-base-dir") + 1]}/firecracker/${id}/root/run/api.sock` : args[args.length - 1]!
      mkdirSync(dirname(sock), { recursive: true })
      writeFileSync(sock, "")
    }
    // A bind mount is a symlink here: what is written through it lands in the host's directory.
    if (cmd === "mount" && args[0] === "--bind") {
      const { symlinkSync } = require("node:fs") as typeof import("node:fs")
      rmSync(last, { recursive: true, force: true })
      symlinkSync(args[args.length - 2]!, last)
      host.mounts.add(last)
    }
    if (cmd === "umount") {
      const { lstatSync, unlinkSync } = require("node:fs") as typeof import("node:fs")
      if (host.mounts.delete(last) && lstatSync(last, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(last)
    }
    // What /proc/self/mounts says of them.
    if (cmd === "mount" || cmd === "umount") writeFileSync(`${host.root}/mounts`, [...host.mounts].map((m) => `/dev/md3 ${m} ext4 rw 0 0\n`).join(""))
    // Never across a mount: a symlink is removed, not followed.
    if (cmd === "rm" && args.includes("--one-file-system")) rmSync(last, { recursive: true, force: true })
    // The unpacker's root disk: made from the host's tar (any binary does here), into `<file>.new`.
    let out = ""
    if (cmd === "bash" && line.includes("command -v tar")) out = "/bin/sh\n"
    if (cmd.endsWith("/crane") && args[0] === "digest" && !fail) out = `${host.digests.get(args[1]!)}\n`
    if (cmd === "stat") out = args.slice(3).map((f) => (host.zvolsAreDevices && f.includes("/zvol/") ? "block special file e6 10\n" : "regular file 0 0\n")).join("")
    if (cmd === "ip" && args.includes("-d") && host.tapOwner) out = `4: tap0: <UP>\n    tun type tap pi off vnet_hdr on persist on user ${host.tapOwner} group ${host.tapOwner} addrgenmode eui64\n`
    if (cmd === "mkfs.ext4" && args.includes("-d")) writeFileSync(args[args.length - 2]!, "")
    // A memory file copied for a fork: the copy exists.
    if (cmd === "cp") writeFileSync(args[args.length - 1]!, "x")
    if (cmd === "zfs" && args[0] === "get" && args.includes("origin")) out = `${host.origins.get(args[args.length - 1]!) ?? "-"}\n`
    if (cmd === "zfs" && args[0] === "get" && args.includes("volsize")) out = `${host.volsizes.get(args[args.length - 1]!) ?? 10 * 1024 ** 3}\n`
    if (cmd === "zfs" && args[0] === "get" && args.includes("available")) out = `${host.poolFree}\n`
    if (cmd === "zfs" && args[0] === "get" && args.includes("property,value")) out = host.memProps
    if (cmd === "zfs" && args[0] === "get" && args.includes("mounted")) out = "yes\n"
    if (cmd === "zfs" && args[0] === "list" && args.includes("createtxg")) out = host.snapClones.get(last) ?? ""
    if (cmd === "zfs" && args[0] === "list" && args.includes("snapshot") && args.includes("name") && !args.includes("createtxg")) out = host.snapNames.get(last) ?? ""
    if (cmd === "zfs" && args[0] === "set" && args[1]!.startsWith("volsize=")) host.volsizes.set(args[2]!, Number(args[1]!.slice(8)))
    if (cmd === "systemctl" && args[0] === "show" && args[1] === "vms.slice") out = `MemoryMax=${host.slice.max}\nMemoryCurrent=${host.slice.current}\nControlGroup=/vms.slice\n`
    if (cmd === "systemctl" && args[0] === "show" && args.includes("ControlGroup") && args[1] !== "vms.slice") {
      out = args.filter((a) => a.endsWith(".service")).map((u) => `Id=${u}\n${host.active.has(u.replace(/\.service$/, "")) ? `ControlGroup=/vms.slice/${u}\n` : "ControlGroup=\n"}`).join("\n")
    }
    const busy = cmd === "zfs" && args[0] === "destroy" && host.busy.has(last)
    const answer = () => setImmediate(() => cb(fail ? new Error(`${line} failed`) : null, out, fail ? (busy ? "cannot unmount: target is busy" : "inactive") : ""))
    const child = { stdin: { end() {} }, killed: false, kill: () => {} } as { stdin: { end(): void }; killed: boolean; kill(): void }
    const gate = host.destroyGate
    if (cmd === "fallocate" && host.digShrinks > 0) {
      host.digShrinks--
      const { statSync, truncateSync } = require("node:fs") as typeof import("node:fs")
      truncateSync(args[args.length - 1]!, Math.floor(statSync(args[args.length - 1]!).size / 2))
    }
    if (cmd === "fallocate" && host.slowDig) {
      child.kill = () => {
        child.killed = true
        host.commands.push(`killed: ${line}`)
        setImmediate(() => cb(new Error("killed"), "", ""))
      }
    } else if (cmd === "zfs" && args[0] === "destroy" && gate && line.includes(gate.match)) void gate.open.then(answer)
    else answer()
    return child
  }
  return { ...actual, execFile }
})

vi.mock("node:http", async (orig) => {
  const actual = await orig<typeof import("node:http")>()
  const { writeFileSync } = await import("node:fs")
  const { basename, dirname, join } = await import("node:path")
  const request = (opts: { method: string; path: string; socketPath: string }, cb: (res: EventEmitter & { statusCode: number }) => void) => {
    const req = new EventEmitter() as EventEmitter & { write(b: string): void; end(): void }
    let body = ""
    req.write = (b) => void (body += b)
    req.end = () =>
      setImmediate(() => {
        const parsed = body ? JSON.parse(body) : undefined
        // A jailed VMM's paths are in its chroot: recorded as the host's files they are (through
        // the binds, symlinks here), alongside what it was given (`jailed`).
        const jail = opts.socketPath.endsWith("/root/run/api.sock") ? opts.socketPath.slice(0, -"/run/api.sock".length) : null
        const { realpathSync } = require("node:fs") as typeof import("node:fs")
        const onHost = (p: string) => (jail && p.startsWith("/mem/") ? join(realpathSync(dirname(`${jail}${p}`)), basename(p)) : p)
        const given = parsed && JSON.parse(JSON.stringify(parsed))
        if (parsed?.snapshot_path) parsed.snapshot_path = onHost(parsed.snapshot_path)
        if (parsed?.mem_file_path) parsed.mem_file_path = onHost(parsed.mem_file_path)
        if (parsed?.mem_backend?.backend_path) parsed.mem_backend.backend_path = onHost(parsed.mem_backend.backend_path)
        host.api.push({ method: opts.method, path: opts.path, body: parsed, given, jail })
        host.commands.push(`api ${opts.method} ${opts.path}${parsed?.state ? ` ${parsed.state}` : ""}`)
        // A snapshot writes its two files.
        if (opts.path === "/snapshot/create") {
          for (const f of [parsed.snapshot_path, parsed.mem_file_path]) writeFileSync(f, "x")
          host.onSnapshot?.()
        }
        // The guest shuts down cleanly and powers off: its VMM exits.
        const vmm = jail ? jail.split("/").at(-2)! : opts.socketPath.split("/").pop()!.replace(/\.sock$/, "")
        if (parsed?.action_type === "SendCtrlAltDel") host.active.delete(`spunto-fc-${vmm}`)
        const failed = host.apiFailing?.test(opts.path)
        const res = Object.assign(new EventEmitter(), { statusCode: failed ? 400 : 204 })
        cb(res)
        if (failed) res.emit("data", Buffer.from(JSON.stringify({ fault_message: "refused" })))
        res.emit("end")
      })
    return req
  }
  return { ...actual, default: { ...(actual as unknown as { default: object }).default, request }, request }
})

const { engine: fc, ensureHost, _test, deathOf, bytesOf, vmmPath, scratchProblem, blockDeviceOf, cpuLimits, jailIdOf, tapOwnerOf, uidOf, netShaping, netClassOf, redirectsTo, smtpOpen, unitCgroups, objsetStats, maxDiskGb } = await import("../src/engine")
const { createHash } = await import("node:crypto")
/** The test kernel is an empty file: what the host computes as its id. */
const KERNEL_ID = createHash("sha256").update("").digest("hex").slice(0, 16)

const STATE = process.env.SPUNTO_FC_STATE!
const handle = "sbx-t1"
const unit = `spunto-fc-${handle}`
const registry = () => JSON.parse(readFileSync(join(STATE, "registry.json"), "utf8"))
const loads = () => host.api.filter((c) => c.path === "/snapshot/load").length
const boots = () => host.api.filter((c) => c.path === "/boot-source").length
const until = async (fn: () => Promise<boolean> | boolean) => {
  for (let i = 0; i < 2000 && !(await fn()); i++) await new Promise((r) => setTimeout(r, 5))
}

beforeEach(() => {
  for (const d of ["opt/bin", "opt/kernels", "state/vms/sbx-t1", "run"]) mkdirSync(join(host.root, d), { recursive: true })
  for (const b of ["firecracker", "jailer", "snapshot-editor", "crane", "tini", "busybox"]) writeFileSync(join(host.root, "opt/bin", b), "")
  writeFileSync(join(host.root, "opt/kernels/default"), "")
  writeFileSync(join(host.root, "kvm"), "")
  writeFileSync(join(host.root, "meminfo"), "MemTotal:       33554432 kB\nMemAvailable:   30000000 kB\n")
  if (!existsSync(join(host.root, "mounts"))) writeFileSync(join(host.root, "mounts"), "")
  mkdirSync(join(host.root, "cgroup/vms.slice"), { recursive: true })
  writeFileSync(join(host.root, "cgroup/vms.slice/memory.stat"), "anon 0\ninactive_file 0\n")
  host.slice = { max: 64 * 1024 ** 3, current: 0 }
  _test.held.length = 0
  host.failing = null
  host.onSnapshot = null
  host.apiFailing = null
  host.poolFree = 500 * 1024 ** 3
})

describe("Firecracker backend — a saved RAM is loaded once", () => {
  it("warm start, VMM killed, then start boots from the disk — never the old RAM over a newer disk", async () => {
    const dir = join(STATE, "vms", handle)
    writeFileSync(join(dir, "vmstate"), "x")
    writeFileSync(join(dir, "mem"), "x")
    const snapshot = { vmstate: join(dir, "vmstate"), mem: join(dir, "mem"), own: true, loadable: true, kernel: KERNEL_ID, at: "t" }
    writeFileSync(
      join(STATE, "registry.json"),
      JSON.stringify({
        vms: { [handle]: { handle, sandboxId: "t1", name: "t1", size: "small", image: "i", net: 0, env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" }, bootstrap: "true", state: "stopped", snapshot, createdAt: "t" } },
        templates: {},
        images: {},
      }),
    )

    // 1. A warm start loads the RAM, and the snapshot is consumed before the box runs.
    await fc.start({ handle })
    expect(loads()).toBe(1)
    expect(boots()).toBe(0)
    expect(registry().vms[handle].snapshot.loadable).toBe(false)
    expect((await fc.describe({ handle })).state).toBe("running")

    // 2. The VMM dies (OOM, host reboot…) without a saveRam.
    host.active.delete(unit)
    expect((await fc.describe({ handle })).state).toBe("stopped")

    // 3. A stop finds no VMM to save: nothing is written, the RAM stays consumed.
    await fc.pause({ handle })
    await until(async () => registry().vms[handle].state === "stopped")
    expect(host.api.filter((c) => c.path === "/snapshot/create")).toHaveLength(0)
    expect((await fc.describe({ handle })).detail).toMatch(/powered off/)

    // 4. The next start boots from the disk.
    await fc.start({ handle })
    expect(loads()).toBe(1)
    expect(boots()).toBe(1)

    // 5. A stop that goes through makes the RAM loadable again — a Diff, the first since the boot:
    // all of its memory, as long as its RAM (§ 15).
    await fc.pause({ handle })
    await until(async () => registry().vms[handle].state === "stopped")
    expect(host.api.filter((c) => c.path === "/snapshot/create").map((c) => c.body.snapshot_type)).toEqual(["Diff"])
    expect(host.commands).toContain(`cp --sparse=always ${join(STATE, "scratch", handle, "stop")} ${join(STATE, "mem", handle, "mem.new")}`)
    expect(host.commands.some((c) => c.includes("snapshot-editor"))).toBe(false)
    expect(registry().vms[handle].snapshot.loadable).toBe(true)
    await fc.start({ handle })
    expect(loads()).toBe(2)

    // 6. Dead again: a rebuild (destroy keeping /workspace) must not load that RAM to shut it down.
    host.active.delete(unit)
    const before = host.api.length
    await fc.destroy({ handle, keepVolumes: true })
    const after = host.api.slice(before).map((c) => c.path)
    expect(after).not.toContain("/snapshot/load")
    expect(after).not.toContain("/actions")
    expect(existsSync(join(STATE, "vms", handle))).toBe(false)
    expect(existsSync(join(STATE, "mem", handle))).toBe(false)
  })
})

describe("Firecracker backend — pause keeps the RAM, stop drops it (RFC 0039 § 20)", () => {
  const running = () => {
    writeFileSync(
      join(STATE, "registry.json"),
      JSON.stringify({ vms: { [handle]: { handle, sandboxId: "t1", name: "t1", size: "small", image: "i", net: 0, env: {}, bootstrap: "true", state: "running", kernel: KERNEL_ID, createdAt: "t" } }, templates: {}, images: {} }),
    )
    _test.restart()
    host.api.length = 0
  }

  it("a stop shuts the guest down cleanly and keeps no RAM: the next start boots", async () => {
    running()
    host.active.add(unit)
    await fc.stop({ handle })
    // Answered at once, finished on its own: said while it lasts.
    expect(await fc.describe({ handle })).toMatchObject({ state: "stopped", transition: "stopping", detail: "shutting down…" })
    await until(async () => registry().vms[handle].state === "stopped")
    const done = await fc.describe({ handle })
    expect(done).toMatchObject({ state: "stopped", ram: "none" })
    expect(done.transition).toBeUndefined()
    expect(done.detail).toMatch(/powered off/)
    expect(host.api.some((c) => c.body?.action_type === "SendCtrlAltDel")).toBe(true)
    expect(host.api.filter((c) => c.path === "/snapshot/create")).toHaveLength(0)
    await fc.start({ handle })
    expect(loads()).toBe(0)
    expect(boots()).toBe(1)
  })

  it("a pause writes the RAM, says `pausing` until then, and the next start resumes it", async () => {
    running()
    host.active.add(unit)
    await fc.pause({ handle })
    // Answered before the RAM is written: said while it lasts, and nothing else meanwhile.
    expect(await fc.describe({ handle })).toMatchObject({ state: "stopped", transition: "pausing", detail: "saving memory…" })
    await expect(fc.pause({ handle })).rejects.toThrow(/already pausing/)
    await until(async () => registry().vms[handle].state === "stopped")
    expect(await fc.describe({ handle })).toMatchObject({ state: "stopped", ram: "saved" })
    await fc.start({ handle })
    expect(loads()).toBe(1)
    expect(boots()).toBe(0)
  })

  it("a stop of a paused box drops its RAM — loaded once more, so that the disk gets what the page cache held", async () => {
    running()
    host.active.add(unit)
    await fc.pause({ handle })
    await until(async () => registry().vms[handle].state === "stopped")
    expect((await fc.describe({ handle })).ram).toBe("saved")
    await fc.stop({ handle })
    await until(async () => registry().vms[handle].state === "stopped" && !registry().vms[handle].stopKind)
    expect((await fc.describe({ handle })).ram).toBe("none")
    const calls = host.api.map((c) => c.body?.action_type ?? c.path)
    expect(calls.lastIndexOf("SendCtrlAltDel")).toBeGreaterThan(calls.lastIndexOf("/snapshot/load"))
  })

  it("a pause of a box that is not running is refused", async () => {
    running()
    host.active.add(unit)
    await fc.stop({ handle })
    await until(async () => registry().vms[handle].state === "stopped")
    await expect(fc.pause({ handle })).rejects.toThrow(/cannot pause a sandbox that is stopped/)
  })
})

describe("Firecracker backend — a restart of the daemon picks up what it left halfway", () => {
  it("a create that died with it is an error; a stop whose VMM is still there writes its RAM again", async () => {
    const vm = (handle: string, state: string, step?: string) => ({ handle, sandboxId: handle, name: handle, size: "small", image: "i", net: handle === "sbx-c" ? 1 : 2, env: {}, bootstrap: "true", state, step, createdAt: "t" })
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { "sbx-c": vm("sbx-c", "creating", "pulling and unpacking the image"), "sbx-s": vm("sbx-s", "stopping") }, templates: {}, images: {} }))
    host.active.add("spunto-fc-sbx-s") // paused mid-snapshot, still there
    host.api.length = 0
    _test.restart()
    await ensureHost()
    await until(() => registry().vms["sbx-s"].state === "stopped")

    expect(registry().vms["sbx-c"]).toMatchObject({ state: "error" })
    expect(registry().vms["sbx-c"].error).toMatch(/interrupted at "pulling and unpacking the image"/)
    expect(host.api.filter((c) => c.path === "/snapshot/create")).toHaveLength(1)
    expect(registry().vms["sbx-s"].snapshot.loadable).toBe(true)
    expect(host.active.has("spunto-fc-sbx-s")).toBe(false)
  })
})

describe("Firecracker backend — a new kernel", () => {
  it("a RAM saved under another kernel is loaded once more to shut down cleanly, then the disk boots on the new one", async () => {
    const h = "sbx-k1"
    const dir = join(STATE, "vms", h)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "vmstate"), "x")
    writeFileSync(join(dir, "mem"), "x")
    const vm = { handle: h, sandboxId: "k1", name: "k1", size: "small", image: "i", net: 3, env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" }, bootstrap: "true", state: "stopped", createdAt: "t" }
    // No `kernel`: saved before kernels were tracked (the CI kernel).
    const snapshot = { vmstate: join(dir, "vmstate"), mem: join(dir, "mem"), own: true, loadable: true, at: "t" }
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { [h]: { ...vm, snapshot } }, templates: {}, images: {} }))
    _test.restart()
    host.api.length = 0

    await fc.start({ handle: h })
    const calls = host.api.map((c) => c.body?.action_type ?? c.path)
    // Loaded, told to shut down, then a boot: in that order.
    expect(calls.indexOf("/snapshot/load")).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf("SendCtrlAltDel")).toBeGreaterThan(calls.indexOf("/snapshot/load"))
    expect(calls.indexOf("/boot-source")).toBeGreaterThan(calls.indexOf("SendCtrlAltDel"))
    expect(registry().vms[h]).toMatchObject({ state: "running", kernel: KERNEL_ID })
    expect(registry().vms[h].snapshot).toBeUndefined()

    // Its next stop records the kernel, and the start after loads it as usual.
    await fc.pause({ handle: h })
    await until(() => registry().vms[h].state === "stopped")
    expect(registry().vms[h].snapshot).toMatchObject({ kernel: KERNEL_ID, loadable: true })
    host.api.length = 0
    await fc.start({ handle: h })
    expect(host.api.map((c) => c.path)).toContain("/snapshot/load")
    expect(host.api.map((c) => c.path)).not.toContain("/boot-source")
  })
})

describe("Firecracker backend — a box's labels", () => {
  it("keeps the platform's labels with the box, and shows them in the operator's list", async () => {
    const labels = { "spunto.sandboxId": "lb1", "spunto.organizationId": "org1", "spunto.url": "https://spunto.net/dashboard/org1/sandboxes/lb1" }
    await fc.create({ sandboxId: "lb1", name: "lb1", image: "img:lb", bootstrap: "true", env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" }, labels })
    expect(registry().vms["sbx-lb1"].labels).toEqual(labels)
    const listed = (await fc.list()) as { vms: { handle: string; labels?: unknown; env: unknown }[] }
    const vm = listed.vms.find((v) => v.handle === "sbx-lb1")!
    expect(vm.labels).toEqual(labels)
    expect(vm.env).toEqual(["SPUNTO_SANDBOX_TOKEN"])
  })
})

describe("Firecracker backend — what the registry says against what is on the disk", () => {
  it("an image recorded ready whose dataset is gone is unpacked again instead of a failed clone", async () => {
    const id = _test.imageIdOf("img:1")
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: {}, templates: {}, images: { [id]: { id, image: "img:1", state: "ready", createdAt: "t" } } }))
    _test.restart()
    host.missing.add(`default/spunto/images/${id}@ready`)
    host.commands.length = 0
    // The fake unpacker never prints its "done": the point is that it is started at all.
    await fc.create({ sandboxId: "o1", name: "o1", image: "img:1", bootstrap: "true", env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" } })
    await until(() => registry().vms["sbx-o1"].state !== "creating")
    expect(registry().images[id]).toBeUndefined()
    expect(host.commands.some((c) => c.startsWith("systemd-run") && c.includes(`--unit=spunto-fc-unpack-${id}`))).toBe(true)
    expect(host.commands.some((c) => c.startsWith(`zfs clone default/spunto/images/${id}@ready`))).toBe(false)
    host.missing.clear()
  })

  it("a build whose disk is gone falls back to the image, and says so in its status", async () => {
    const id = _test.imageIdOf("img:2")
    writeFileSync(
      join(STATE, "registry.json"),
      JSON.stringify({
        vms: {},
        templates: {},
        images: { [id]: { id, image: "img:2", state: "ready", createdAt: "t" } },
        builds: { "bld-b1": { ref: "bld-b1", buildId: "b1", image: "img:2", size: "small", net: 9, state: "ready", phase: "ready", pre: "", post: "", createdAt: "t" } },
      }),
    )
    _test.restart()
    host.missing.add("default/spunto/builds/bld-b1@ready")
    host.commands.length = 0
    await fc.create({ sandboxId: "o2", name: "o2", image: "img:2", from: "bld-b1", bootstrap: "true", env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" } })
    await until(() => registry().vms["sbx-o2"].state !== "creating")
    expect(registry().vms["sbx-o2"].state).toBe("running")
    expect(host.commands).toContain(`zfs clone default/spunto/images/${id}@ready default/spunto/vms/sbx-o2-root`)
    expect(await fc.buildStatus({ ref: "bld-b1" })).toMatchObject({ state: "failed", error: expect.stringMatching(/disk is gone/) })
    host.missing.clear()
  })
})

describe("Firecracker backend — a tag that moves (`:latest` pushed again)", () => {
  const A = `sha256:${"a".repeat(64)}`
  const B = `sha256:${"b".repeat(64)}`
  const box = async (sid: string, image: string) => {
    await fc.create({ sandboxId: sid, name: sid, image, bootstrap: "true", env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" } })
    // A slow unpacker says "done" once it goes: let it go.
    await until(() => {
      for (const u of host.active) if (u.includes("-unpack-")) host.active.delete(u)
      return registry().vms[`sbx-${sid}`].state !== "creating"
    })
    expect(registry().vms[`sbx-${sid}`].state).toBe("running")
  }
  const unpacked = () => host.api.filter((c) => c.path === "/boot-source" && c.jail?.includes("unpack-")).map((c) => c.body.boot_args as string)
  const cloned = (sid: string) => host.commands.find((c) => c.startsWith("zfs clone") && c.endsWith(`vms/sbx-${sid}-root`))

  it("unpacks what the tag points at now, by digest, and destroys the disk it replaces", async () => {
    // The disk of before: keyed by the reference alone, a `:latest` unpacked days ago.
    const stale = _test.imageIdOf("reg.example/team/base:latest")
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: {}, templates: {}, images: { [stale]: { id: stale, image: "reg.example/team/base:latest", state: "ready", createdAt: "t" } } }))
    _test.restart()
    host.slowUnpacker = true
    host.digests.set("reg.example/team/base:latest", A)
    host.commands.length = 0
    host.api.length = 0
    await box("t1", "reg.example/team/base:latest")
    const fresh = _test.imageIdOf(`reg.example/team/base@${A}`)
    // Pulled by digest, not by tag: what was resolved is what is unpacked.
    expect(unpacked().some((a) => a.includes(`reg.example/team/base@${A}`))).toBe(true)
    expect(cloned("t1")).toBe(`zfs clone default/spunto/images/${fresh}@ready default/spunto/vms/sbx-t1-root`)
    expect(registry().images[fresh]).toMatchObject({ image: "reg.example/team/base:latest", digest: A, state: "ready" })
    expect(host.commands).toContain(`zfs destroy -r default/spunto/images/${stale}`)
    expect(registry().images[stale]).toBeUndefined()
    host.slowUnpacker = false
  })

  it("the same digest again is the same disk: nothing unpacked", async () => {
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: {}, templates: {}, images: {} }))
    _test.restart()
    host.slowUnpacker = true
    host.digests.set("reg.example/team/same:1", A)
    await box("t2", "reg.example/team/same:1")
    host.api.length = 0
    host.commands.length = 0
    await box("t3", "reg.example/team/same:1")
    expect(unpacked()).toEqual([])
    expect(cloned("t3")).toContain(`images/${_test.imageIdOf(`reg.example/team/same@${A}`)}@ready`)
    host.slowUnpacker = false
  })

  it("a registry that cannot answer leaves the newest disk the machine has for that reference", async () => {
    const older = _test.imageIdOf(`reg.example/team/down@${A}`)
    const newer = _test.imageIdOf(`reg.example/team/down@${B}`)
    writeFileSync(
      join(STATE, "registry.json"),
      JSON.stringify({
        vms: {},
        templates: {},
        images: {
          [older]: { id: older, image: "reg.example/team/down:latest", digest: A, state: "ready", createdAt: "2026-11-01T00:00:00.000Z" },
          [newer]: { id: newer, image: "reg.example/team/down:latest", digest: B, state: "ready", createdAt: "2026-11-02T00:00:00.000Z" },
        },
      }),
    )
    _test.restart()
    host.api.length = 0
    host.commands.length = 0
    await box("t4", "reg.example/team/down:latest")
    expect(unpacked()).toEqual([])
    expect(cloned("t4")).toContain(`images/${newer}@ready`)
  })

  it("a reference with a digest already is not asked about", async () => {
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: {}, templates: {}, images: {} }))
    _test.restart()
    host.slowUnpacker = true
    host.commands.length = 0
    await box("t5", `reg.example/team/pinned@${B}`)
    expect(host.commands.some((c) => c.includes("crane digest"))).toBe(false)
    expect(cloned("t5")).toContain(`images/${_test.imageIdOf(`reg.example/team/pinned@${B}`)}@ready`)
    host.slowUnpacker = false
  })
})

describe("Firecracker backend — a build's network and a build deleted halfway", () => {
  const BUILD = { buildId: "b9", image: "img:9", script: "true", bakeKey: "k" }

  it("keeps a failed build's network number until its clean-up is over: a box created meanwhile gets another", async () => {
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: {}, templates: {}, images: {}, builds: {} }))
    _test.restart()
    let open!: () => void
    host.destroyGate = { match: "builds/bld-b9", open: new Promise<void>((r) => (open = r)) }
    host.commands.length = 0
    const { ref } = await fc.build(BUILD)
    const buildNet = registry().builds[ref].net
    // The unpacker fails at once here: the build is failed, its runner stuck in its clean-up.
    await until(() => registry().builds[ref].state === "failed")
    const since = host.commands.length
    await fc.create({ sandboxId: "n1", name: "n1", image: "img:other", bootstrap: "true", env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" } })
    expect(registry().vms["sbx-n1"].net).not.toBe(buildNet)
    open()
    host.destroyGate = null
    await until(() => !_test.buildRuns.has(ref))
    // Its own netns went, nobody else's.
    const after = host.commands.slice(since).filter((c) => c.includes("ip netns del"))
    expect(after.join("\n")).toContain(`ip netns del fc${buildNet} `)
    expect(after.some((c) => c.includes(`ip netns del fc${registry().vms["sbx-n1"].net} `))).toBe(false)
    await fc.destroy({ handle: "sbx-n1" })
  })

  it("a build deleted while its image unpacks makes nothing afterwards, and gives its network back", async () => {
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: {}, templates: {}, images: {}, builds: {} }))
    _test.restart()
    host.slowUnpacker = true
    host.commands.length = 0
    const { ref } = await fc.build({ ...BUILD, buildId: "b10", image: "img:10" })
    const net = registry().builds[ref].net
    const unpacker = () => [...host.active].find((u) => u.includes("-unpack-"))
    await until(() => !!unpacker())
    // Deleted while `ensureImage` runs: answered at once, the runner still going.
    await fc.deleteBuild({ ref })
    expect(registry().builds[ref]).toBeUndefined()
    expect(_test.buildRuns.has(ref)).toBe(true)
    // The image comes out fine; the runner must stop there.
    host.active.delete(unpacker()!)
    await until(() => !_test.buildRuns.has(ref))
    host.slowUnpacker = false
    expect(host.commands.some((c) => c.startsWith("zfs clone") && c.includes(`builds/${ref}`))).toBe(false)
    expect(host.commands.some((c) => c.startsWith("systemd-run") && c.includes(`--unit=spunto-fc-build-${ref}`))).toBe(false)
    expect(registry().builds[ref]).toBeUndefined()
    // Its number is free again: the next box may take it.
    await fc.create({ sandboxId: "n2", name: "n2", image: "img:10", bootstrap: "true", env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" } })
    expect(registry().vms["sbx-n2"].net).toBe(net)
    await fc.destroy({ handle: "sbx-n2" })
  })

  it("a build whose disk is gone is passed over at every create, not only the first", async () => {
    const id = _test.imageIdOf("img:3")
    writeFileSync(
      join(STATE, "registry.json"),
      JSON.stringify({
        vms: {},
        templates: {},
        images: { [id]: { id, image: "img:3", state: "ready", createdAt: "t" } },
        builds: { "bld-b3": { ref: "bld-b3", buildId: "b3", image: "img:3", size: "small", net: 40, state: "ready", phase: "ready", pre: "", post: "", createdAt: "t" } },
      }),
    )
    _test.restart()
    host.missing.add("default/spunto/builds/bld-b3@ready")
    for (const sid of ["r1", "r2"]) {
      await fc.create({ sandboxId: sid, name: sid, image: "img:3", from: "bld-b3", bootstrap: "true", env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" } })
      await until(() => registry().vms[`sbx-${sid}`].state !== "creating")
      expect(registry().vms[`sbx-${sid}`].state).toBe("running")
    }
    host.missing.clear()
  })
})

describe("Firecracker backend — fork: a copy of a running box, its processes included", () => {
  const box = (h: string, net: number, extra: Record<string, unknown> = {}) => ({
    handle: h,
    sandboxId: h.replace(/^sbx-/, ""),
    name: h,
    size: "small",
    image: "i",
    net,
    env: { SPUNTO_SANDBOX_TOKEN: `sbx_${h}` },
    bootstrap: "true",
    state: "running",
    createdAt: "t",
    ...extra,
  })

  it("a box booted from its disk: a Full while paused, which becomes its own base; the copy loads it as its own RAM, a new identity", async () => {
    const src = "sbx-fs1"
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { [src]: box(src, 50, { kernel: KERNEL_ID }) }, templates: {}, images: {}, builds: {} }))
    _test.restart()
    host.active.add(`spunto-fc-${src}`)
    host.api.length = 0
    host.commands.length = 0
    const { ref, ram } = (await fc.fork({ handle: src })) as { ref: string; ram?: string }
    expect(ref).toMatch(/^frk-fs1-/)
    expect(ram).toBe("Full")
    // Paused, written, resumed — in that order, the disks snapshotted while paused.
    const seq = host.api.map((c) => (c.path === "/vm" ? c.body.state : c.path === "/snapshot/create" ? c.body.snapshot_type : c.path))
    expect(seq.slice(0, 3)).toEqual(["Paused", "Full", "Resumed"])
    expect(host.commands.some((c) => c === `zfs snapshot default/spunto/vms/${src}-root@${ref} default/spunto/ws/fs1@${ref}`)).toBe(true)
    // To the host's disk, without waiting for it (not into a memory dataset: see SCRATCH).
    const create = host.api.find((c) => c.path === "/snapshot/create")!
    expect(create.body).toMatchObject({ mem_file_path: join(STATE, "scratch", src, ref), sync_snapshot_files: false })
    await until(() => registry().templates[ref]?.state === "ready")
    // The copy's memory: a snapshot of the source's base, cloned.
    expect(host.commands).toContain(`zfs clone default/spunto/mem/${src}@${ref} default/spunto/mem/${ref}`)
    // The source now has a base of its own: its next stop is a Diff.
    expect(registry().vms[src]).toMatchObject({ diffable: true, snapshot: { own: true, loadable: false } })

    host.api.length = 0
    await fc.create({ sandboxId: "fc1", name: "fc1", image: "i", from: ref, bootstrap: "true", env: { SPUNTO_SANDBOX_TOKEN: "sbx_copy" } })
    await until(() => registry().vms["sbx-fc1"].state !== "creating")
    expect(registry().vms["sbx-fc1"].state).toBe("running")
    expect(host.commands).toContain(`zfs clone default/spunto/vms/${src}-root@${ref} default/spunto/vms/sbx-fc1-root`)
    expect(host.commands).toContain(`zfs clone default/spunto/ws/fs1@${ref} default/spunto/ws/fc1`)
    // Its memory: the clone the freeze made of the source's base, renamed — never a copy.
    expect(host.commands).toContain(`zfs rename default/spunto/mem/${ref} default/spunto/mem/sbx-fc1`)
    expect(host.commands.some((c) => c.startsWith("cp ") && c.includes("sbx-fc1"))).toBe(false)
    const load = host.api.find((c) => c.path === "/snapshot/load")!
    expect(load.body.mem_backend.backend_path).toBe(join(STATE, "mem", "sbx-fc1", "mem"))
    expect(readFileSync(join(STATE, "mem", "sbx-fc1", "vmstate"), "utf8")).toBe("x")
    const mmds = host.api.filter((c) => c.path === "/mmds").at(-1)!.body.spunto
    expect(mmds.resume).toBe("reidentify")
    expect(Buffer.from(mmds.env, "base64").toString()).toContain("sbx_copy")
    // One copy, once: the fork's record is gone, its memory is the copy's own.
    expect(registry().templates[ref]).toBeUndefined()
    // Its own base, consumed by the load: its first stop is a Diff merged into it, not a Full.
    expect(registry().vms["sbx-fc1"].snapshot).toMatchObject({ mem: join(STATE, "mem", "sbx-fc1", "mem"), own: true, loadable: false })
    expect(registry().vms["sbx-fc1"].diffable).toBe(true)
    host.api.length = 0
    await fc.pause({ handle: "sbx-fc1" })
    await until(() => registry().vms["sbx-fc1"].state === "stopped")
    expect(host.api.filter((c) => c.path === "/snapshot/create").map((c) => c.body.snapshot_type)).toEqual(["Diff"])
    expect(host.commands.some((c) => c.includes(`edit-memory rebase --memory-path ${join(STATE, "mem", "sbx-fc1", "mem")}`))).toBe(true)
    await fc.start({ handle: "sbx-fc1" })

    // The copy goes: the source's @frk snapshots go with it.
    host.commands.length = 0
    await fc.destroy({ handle: "sbx-fc1" })
    await until(() => !registry().vms["sbx-fc1"])
    expect(host.commands.some((c) => c.startsWith("zfs destroy") && c.includes(`@${ref}`))).toBe(true)
  })

  it("a box with a memory file of its own: a Diff while paused, merged into its base after it runs again", async () => {
    const src = "sbx-fs2"
    const dir = join(STATE, "vms", src)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "mem"), "x")
    const snapshot = { vmstate: join(dir, "vmstate"), mem: join(dir, "mem"), own: true, loadable: false, kernel: KERNEL_ID, at: "t" }
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { [src]: box(src, 51, { kernel: KERNEL_ID, diffable: true, snapshot }) }, templates: {}, images: {}, builds: {} }))
    _test.restart()
    host.active.add(`spunto-fc-${src}`)
    host.api.length = 0
    host.commands.length = 0
    const { ref, ram } = (await fc.fork({ handle: src })) as { ref: string; ram?: string }
    expect(ram).toBe("Diff")
    await until(() => registry().templates[ref]?.state === "ready")
    const mem = join(STATE, "mem", src, "mem")
    const at = (match: (c: string) => boolean) => host.commands.findIndex(match)
    // A base from before the memory datasets: copied in once, before the pause — never during it.
    const copyIn = at((c) => c === `cp --sparse=always ${join(dir, "mem")} ${mem}`)
    const paused = at((c) => c === "api PATCH /vm Paused")
    const resumed = at((c) => c === "api PATCH /vm Resumed")
    const rebase = at((c) => c === `${join(host.root, "opt/bin/snapshot-editor")} edit-memory rebase --memory-path ${mem} --diff-path ${join(STATE, "scratch", src, ref)}`)
    const snap = at((c) => c === `zfs snapshot default/spunto/mem/${src}@${ref}`)
    const clone = at((c) => c === `zfs clone default/spunto/mem/${src}@${ref} default/spunto/mem/${ref}`)
    expect(copyIn).toBeGreaterThanOrEqual(0)
    expect(paused).toBeGreaterThan(copyIn)
    // The Diff merged once the source runs again, then the copy is the base with the Diff in it.
    expect(rebase).toBeGreaterThan(resumed)
    expect(snap).toBeGreaterThan(rebase)
    expect(clone).toBeGreaterThan(snap)
    expect(existsSync(dir)).toBe(false)
    expect(registry().vms[src].snapshot.mem).toBe(mem)
    expect(registry().templates[ref]).toMatchObject({ mem: join(STATE, "mem", ref, "mem"), vmstate: join(STATE, "mem", ref, "vmstate") })
    // Nothing but the merged base and this instant's device state in the copy's dataset.
    expect(existsSync(join(STATE, "scratch", src, ref))).toBe(false)
    expect(existsSync(join(STATE, "mem", ref, `vmstate.${ref}`))).toBe(false)
    expect(existsSync(join(STATE, "mem", src, `vmstate.${ref}`))).toBe(false)
    await fc.deleteTemplate({ ref })
    expect(registry().templates[ref]).toBeUndefined()
    expect(existsSync(join(STATE, "mem", ref))).toBe(false)
  })

  it("refuses a box that is not running", async () => {
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { "sbx-fs3": box("sbx-fs3", 52, { state: "stopped" }) }, templates: {}, images: {}, builds: {} }))
    _test.restart()
    await expect(fc.fork({ handle: "sbx-fs3" })).rejects.toThrow(/only a running sandbox can be copied/)
  })

  it("its disks only (RFC 0060): paused for the flush and the snapshot, no RAM written; a box from it boots — and the snapshot outlives its source", async () => {
    const src = "sbx-dk1"
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { [src]: box(src, 53, { kernel: KERNEL_ID }) }, templates: {}, images: {}, builds: {} }))
    _test.restart()
    host.active.add(`spunto-fc-${src}`)
    host.api.length = 0
    host.commands.length = 0
    const { ref, pauseMs } = await fc.snapshotDisks({ handle: src })
    expect(ref).toMatch(/^dsk-dk1-/)
    expect(pauseMs).toBeGreaterThanOrEqual(0)
    // Paused, flushed, both disks at one instant, resumed: no memory written.
    expect(host.api.map((c) => (c.path === "/vm" ? c.body.state : c.path))).toEqual(["Paused", "Resumed"])
    const flush = host.commands.findIndex((c) => c.startsWith("blockdev --flushbufs"))
    const snap = host.commands.indexOf(`zfs snapshot default/spunto/vms/${src}-root@${ref} default/spunto/ws/dk1@${ref}`)
    expect(flush).toBeGreaterThanOrEqual(0)
    expect(snap).toBeGreaterThan(flush)
    // Its own datasets at once: the source can go.
    expect(host.commands).toContain(`zfs clone default/spunto/vms/${src}-root@${ref} default/spunto/templates/${ref}-root`)
    expect(host.commands).toContain(`zfs clone default/spunto/ws/dk1@${ref} default/spunto/templates/${ref}-ws`)
    expect(registry().templates[ref]).toMatchObject({ kind: "disks", state: "ready" })
    expect(await fc.templateStatus({ ref })).toEqual({ state: "ready", detail: "disks only" })

    host.api.length = 0
    // A new sandbox: no /workspace of its own yet (a rebuild's would be kept).
    host.missing.add("default/spunto/ws/dc1")
    await fc.create({ sandboxId: "dc1", name: "dc1", image: "i", from: ref, bootstrap: "true", env: { SPUNTO_SANDBOX_TOKEN: "sbx_copy" } })
    await until(() => registry().vms["sbx-dc1"].state !== "creating")
    expect(registry().vms["sbx-dc1"].state).toBe("running")
    expect(host.commands).toContain(`zfs clone default/spunto/templates/${ref}-root@ready default/spunto/vms/sbx-dc1-root`)
    expect(host.commands).toContain(`zfs clone default/spunto/templates/${ref}-ws@ready default/spunto/ws/dc1`)
    // Booted: no RAM loaded, its identity from the start — the agent runs postStart for this boot.
    expect(host.api.map((c) => c.path)).toContain("/boot-source")
    expect(host.api.map((c) => c.path)).not.toContain("/snapshot/load")
    expect(registry().templates[ref]).toMatchObject({ kind: "disks", state: "ready" })

    await fc.deleteTemplate({ ref })
    expect(registry().templates[ref]).toBeUndefined()
  })

  it("its disks only: refuses a box that is not running", async () => {
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { "sbx-dk2": box("sbx-dk2", 54, { state: "stopped" }) }, templates: {}, images: {}, builds: {} }))
    _test.restart()
    await expect(fc.snapshotDisks({ handle: "sbx-dk2" })).rejects.toThrow(/only a running sandbox can be snapshotted/)
  })
})

describe("Firecracker backend — a system disk the size of the box, grown under it when asked", () => {
  const GIB = 1024 ** 3
  const box = (h: string, net: number, extra: Record<string, unknown> = {}) => ({ handle: h, sandboxId: h.slice(4), name: h, size: "xlarge", image: "img:g", net, env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" }, bootstrap: "true", state: "running", kernel: KERNEL_ID, createdAt: "t", ...extra })

  it("reads a size the way zfs does, so SPUNTO_FC_*_SIZE keeps every spelling it took", () => {
    expect(bytesOf("10G")).toBe(10 * GIB)
    expect(bytesOf("10240M")).toBe(10 * GIB)
    expect(bytesOf("40g")).toBe(40 * GIB)
    expect(bytesOf("40GB")).toBe(40 * GIB)
    expect(bytesOf("1.5T")).toBe(1536 * GIB)
    expect(bytesOf("4096")).toBe(4096)
    expect(() => bytesOf("ten gigs")).toThrow(/not a disk size/)
  })

  it("a box from a build gets a system disk for its size (60 GB for an xlarge), not the image's 10 GB", async () => {
    writeFileSync(
      join(STATE, "registry.json"),
      JSON.stringify({ vms: {}, templates: {}, images: {}, builds: { "bld-g1": { ref: "bld-g1", buildId: "g1", image: "img:g", size: "small", net: 70, state: "ready", phase: "ready", pre: "", post: "", createdAt: "t" } } }),
    )
    _test.restart()
    host.commands.length = 0
    await fc.create({ sandboxId: "g1", name: "g1", image: "img:g", size: "xlarge", from: "bld-g1", bootstrap: "true", env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" } })
    await until(() => registry().vms["sbx-g1"].state !== "creating")
    const clone = host.commands.indexOf("zfs clone default/spunto/builds/bld-g1@ready default/spunto/vms/sbx-g1-root")
    const grow = host.commands.indexOf(`zfs set volsize=${60 * 1024 ** 3} default/spunto/vms/sbx-g1-root`)
    const boot = host.commands.findIndex((c) => c.startsWith("systemd-run") && c.includes("--unit=spunto-fc-sbx-g1"))
    expect(clone).toBeGreaterThanOrEqual(0)
    expect(grow).toBeGreaterThan(clone)
    expect(boot).toBeGreaterThan(grow) // grown before the boot: the guest's init sees the whole disk
    await fc.destroy({ handle: "sbx-g1" })
  })

  it("grow: a running box is told (PATCH /drives), a stopped one is not; never a shrink; never past the limit", async () => {
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { "sbx-g2": box("sbx-g2", 71), "sbx-g3": box("sbx-g3", 72, { state: "stopped" }) }, templates: {}, images: {}, builds: {} }))
    _test.restart()
    host.active.add("spunto-fc-sbx-g2")
    host.api.length = 0
    const r = await fc.grow({ handle: "sbx-g2", rootGb: 50, workspaceGb: 30 })
    expect(r).toMatchObject({ rootGb: 50, workspaceGb: 30, changed: true, running: true, resizeInGuest: true })
    expect(host.api.filter((c) => c.method === "PATCH" && c.path.startsWith("/drives/")).map((c) => c.body.drive_id)).toEqual(["root", "ws"])

    host.api.length = 0
    const s = await fc.grow({ handle: "sbx-g3", rootGb: 50 })
    expect(s).toMatchObject({ rootGb: 50, changed: true, running: false, resizeInGuest: false })
    expect(host.api).toHaveLength(0)

    await expect(fc.grow({ handle: "sbx-g2", rootGb: 20 })).rejects.toThrow(/only grow/)
    await expect(fc.grow({ handle: "sbx-g2", rootGb: 9999 })).rejects.toThrow(/between 1 and 200/)
    // The same size again: nothing grows, but the running guest is told again — a grow a previous
    // call made may never have reached it — and the platform grows the filesystems again.
    host.api.length = 0
    expect(await fc.grow({ handle: "sbx-g2", rootGb: 50 })).toMatchObject({ changed: false, resizeInGuest: true })
    expect(host.api.filter((c) => c.path.startsWith("/drives/"))).toHaveLength(2)

    // A refusal on the second disk grows neither: everything is checked before anything grows.
    host.commands.length = 0
    await expect(fc.grow({ handle: "sbx-g2", rootGb: 80, workspaceGb: 10 })).rejects.toThrow(/only grow/)
    expect(host.commands.some((c) => c.startsWith("zfs set volsize"))).toBe(false)
    // So does a full pool.
    host.poolFree = 2 * GIB
    await expect(fc.grow({ handle: "sbx-g2", rootGb: 80 })).rejects.toThrow(/nearly full/)
    expect(host.commands.some((c) => c.startsWith("zfs set volsize"))).toBe(false)
    host.poolFree = 500 * GIB
  })

  it("no new box on a pool nearly full: a sparse disk would fail the guest's writes with I/O errors", async () => {
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: {}, templates: {}, images: {}, builds: {} }))
    _test.restart()
    host.poolFree = 2 * GIB
    await expect(fc.create({ sandboxId: "g4", name: "g4", image: "img:g", bootstrap: "true", env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" } })).rejects.toThrow(/pool is nearly full \(2\.0 GB left\)/)
    host.poolFree = 500 * GIB
  })
})

describe("Firecracker backend — a loaded RAM learns its disks' size before it runs", () => {
  it("PATCH /drives before PATCH /vm Resumed: the knock comes after, and the init's grow_fs reads the new size", async () => {
    const h = "sbx-rd1"
    const dir = join(STATE, "vms", h)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "vmstate"), "x")
    writeFileSync(join(dir, "mem"), "x")
    const snapshot = { vmstate: join(dir, "vmstate"), mem: join(dir, "mem"), own: true, loadable: true, kernel: KERNEL_ID, at: "t" }
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { [h]: { handle: h, sandboxId: "rd1", name: "rd1", size: "small", image: "i", net: 80, env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" }, bootstrap: "true", state: "stopped", snapshot, createdAt: "t" } }, templates: {}, images: {}, builds: {} }))
    _test.restart()
    host.api.length = 0
    host.commands.length = 0
    await fc.start({ handle: h })
    const seq = host.api.map((c) => (c.path === "/vm" ? `vm:${c.body.state}` : c.method === "PATCH" ? `patch:${c.path}` : c.path))
    expect(seq.indexOf("patch:/drives/root")).toBeGreaterThan(seq.indexOf("/snapshot/load"))
    expect(seq.indexOf("patch:/drives/ws")).toBeLessThan(seq.indexOf("vm:Resumed"))
    await until(() => host.commands.some((c) => c.includes("busybox nc") && c.includes("47770")))
    // The knock, after the resume.
    expect(host.commands.findIndex((c) => c.includes("47770"))).toBeGreaterThanOrEqual(0)
  })
})

describe("Firecracker backend — memory (RFC 0039 § 15)", () => {
  const GIB = 1024 ** 3
  const vm = (h: string, net: number, size = "xlarge") => ({ handle: h, sandboxId: h.slice(4), name: h, size, image: "i", net, env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" }, bootstrap: "true", state: "stopped", createdAt: "t" })

  it("boots with a balloon that reports free pages, and records how its unit ends", async () => {
    const h = "sbx-m1"
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { [h]: vm(h, 20) }, templates: {}, images: {} }))
    _test.restart()
    host.api.length = 0
    host.commands.length = 0
    await fc.start({ handle: h })
    const paths = host.api.map((c) => c.body?.action_type ?? c.path)
    expect(host.api.find((c) => c.path === "/balloon")?.body).toMatchObject({ amount_mib: 0, free_page_reporting: true })
    expect(paths.indexOf("/balloon")).toBeLessThan(paths.indexOf("InstanceStart"))
    expect(host.api.find((c) => c.path === "/boot-source")!.body.boot_args).not.toContain("init_on_free")
    const spawn = host.commands.find((c) => c.startsWith("systemd-run") && c.includes(`--unit=spunto-fc-${h}`))!
    expect(spawn).toContain(`ExecStopPost=${STATE}/exited.sh ${process.env.SPUNTO_FC_RUN}/${h}.exit`)
    expect(readFileSync(join(STATE, "exited.sh"), "utf8")).toContain("$SERVICE_RESULT")
  })

  it("a box the OOM killer took is an error that says so — and a start brings it back", async () => {
    const h = "sbx-m2"
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { [h]: vm(h, 21) }, templates: {}, images: {} }))
    _test.restart()
    await fc.start({ handle: h })
    expect((await fc.describe({ handle: h })).state).toBe("running")

    // What systemd's ExecStopPost writes when the kernel kills the VMM.
    writeFileSync(join(process.env.SPUNTO_FC_RUN!, `${h}.exit`), "oom-kill killed KILL\n")
    host.active.delete(`spunto-fc-${h}`)
    const d = await fc.describe({ handle: h })
    expect(d).toMatchObject({ state: "error", exit: "oom-kill" })
    expect(d.detail).toMatch(/lack of memory.*vms\.slice/)

    // Settled in the registry: no more `running`, so no more counted by the admission — the record
    // kept, so the error stays after a restart of the daemon (test-2, 2026-10-20: 8 GiB held for 30 h).
    expect(registry().vms[h]).toMatchObject({ state: "stopped", died: { result: "oom-kill" } })
    _test.restart()
    await ensureHost()
    expect(await fc.describe({ handle: h })).toMatchObject({ state: "error", exit: "oom-kill" })

    // Another end on its own: an error too, its result in it. A clean one: just stopped.
    writeFileSync(join(process.env.SPUNTO_FC_RUN!, `${h}.exit`), "signal killed SEGV\n")
    expect(deathOf(h)?.detail).toMatch(/ended on its own \(signal, killed SEGV\)/)
    writeFileSync(join(process.env.SPUNTO_FC_RUN!, `${h}.exit`), "success exited 0\n")
    expect(deathOf(h)).toBeUndefined()

    writeFileSync(join(process.env.SPUNTO_FC_RUN!, `${h}.exit`), "oom-kill killed KILL\n")
    await fc.start({ handle: h })
    expect(registry().vms[h].died).toBeUndefined()
    expect(existsSync(join(process.env.SPUNTO_FC_RUN!, `${h}.exit`))).toBe(false)
    expect((await fc.describe({ handle: h })).state).toBe("running")
    // A stop on purpose leaves no record behind.
    await fc.pause({ handle: h })
    await until(() => registry().vms[h].state === "stopped")
    expect(existsSync(join(process.env.SPUNTO_FC_RUN!, `${h}.exit`))).toBe(false)
  })

  it("refuses a create, a start and a build the slice has no room for — as `capacity`, nothing made", async () => {
    const h = "sbx-m3"
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { [h]: vm(h, 22) }, templates: {}, images: {} }))
    _test.restart()
    // 16 GB slice, 15 GB touched by the boxes already: 1 GB left, an xlarge needs 2.
    host.slice = { max: 16 * GIB, current: 15 * GIB }
    host.commands.length = 0
    await expect(fc.create({ sandboxId: "m4", name: "m4", image: "img:1", size: "xlarge", bootstrap: "true", env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" } })).rejects.toMatchObject({
      code: "capacity",
      message: expect.stringMatching(/not enough memory.*xlarge.*1\.0 GB free.*vms\.slice: 15\.0 of 16\.0 GB used.*2\.0 GB needed/),
    })
    expect(registry().vms["sbx-m4"]).toBeUndefined()
    await expect(fc.start({ handle: h })).rejects.toMatchObject({ code: "capacity" })
    expect(registry().vms[h].state).toBe("stopped")
    await expect(fc.build({ buildId: "m5", image: "img:1", script: "true", bakeKey: "k", size: "xlarge" })).rejects.toMatchObject({ code: "capacity" })
    expect(registry().builds?.["bld-m5"]).toBeUndefined()
    expect(host.commands.some((c) => c.startsWith("systemd-run"))).toBe(false)

    // A small one fits in what is left (1 GiB); droppable page cache counts as free.
    writeFileSync(join(host.root, "cgroup/vms.slice/memory.stat"), `anon 0\ninactive_file ${2 * GIB}\n`)
    await fc.start({ handle: h })
    expect(registry().vms[h].state).toBe("running")

    // The machine itself short (its containers): refused even with the slice empty.
    host.slice = { max: 16 * GIB, current: 0 }
    writeFileSync(join(host.root, "meminfo"), "MemAvailable:    524288 kB\n")
    await expect(fc.create({ sandboxId: "m6", name: "m6", image: "img:1", size: "large", bootstrap: "true", env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" } })).rejects.toMatchObject({ code: "capacity" })
  })
})

describe("Firecracker backend — only the pages a box wrote (RFC 0039 § 15)", () => {
  const box = (h: string, net: number, extra: Record<string, unknown> = {}) => ({
    handle: h, sandboxId: h.slice(4), name: h, size: "xlarge", image: "i", net, env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" }, bootstrap: "true", state: "running", kernel: KERNEL_ID, createdAt: "t", ...extra,
  })
  const types = () => host.api.filter((c) => c.path === "/snapshot/create").map((c) => c.body.snapshot_type)

  it("a box booted from its disk: its first fork writes a Diff — all of its memory, sparse — and its next stop a Diff over that", async () => {
    const src = "sbx-pb1"
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { [src]: box(src, 60, { sinceBoot: true }) }, templates: {}, images: {}, builds: {} }))
    _test.restart()
    host.active.add(`spunto-fc-${src}`)
    host.api.length = 0
    host.commands.length = 0
    // As long as the box's RAM before it is copied in: a Diff may stop at its last page.
    let lengthCopied = 0
    host.onCommand = (c) => {
      const from = /^cp --sparse=always (\S+\/scratch\/\S+) /.exec(c)?.[1]
      if (from) lengthCopied = statSync(from).size
    }
    const { ref, ram } = (await fc.fork({ handle: src, model: true })) as { ref: string; ram?: string }
    expect(ram).toBe("Boot")
    expect(types()).toEqual(["Diff"])
    const create = host.api.find((c) => c.path === "/snapshot/create")!
    const written = join(STATE, "scratch", src, ref)
    expect(create.body.mem_file_path).toBe(written)
    await until(() => registry().templates[ref]?.state === "ready")
    host.onCommand = null
    // Nothing to merge into: the file is the memory — the box's base, and the model's by a clone
    // of it, `@ready` for the boxes that will come from it.
    expect(host.commands.some((c) => c.includes("snapshot-editor"))).toBe(false)
    expect(host.commands).toContain(`cp --sparse=always ${written} ${join(STATE, "mem", src, "mem.new")}`)
    expect(lengthCopied).toBe(16384 * 1024 ** 2)
    expect(existsSync(written)).toBe(false)
    expect(existsSync(join(STATE, "mem", ref, "mem"))).toBe(true)
    expect(host.commands).toContain(`zfs snapshot default/spunto/mem/${ref}@ready`)
    expect(registry().vms[src]).toMatchObject({ diffable: true, sinceBoot: false, snapshot: { own: true } })

    host.api.length = 0
    await fc.pause({ handle: src })
    await until(() => registry().vms[src].state === "stopped")
    expect(types()).toEqual(["Diff"])
    expect(host.commands.some((c) => c.includes("snapshot-editor edit-memory rebase") && c.includes(`--memory-path ${join(STATE, "mem", src, "mem")}`))).toBe(true)
    // On disk before it is called loadable.
    expect(host.commands).toContain("zpool sync default")
  })

  it("a box loaded from a member's model: a stop clones the model's memory before the pause, and merges its Diff into the clone", async () => {
    const h = "sbx-pb2"
    mkdirSync(join(STATE, "mem", "usr-x"), { recursive: true })
    writeFileSync(join(STATE, "mem", "usr-x", "mem"), "model")
    mkdirSync(join(host.root, "mem-snapshots"), { recursive: true })
    const { cpSync } = await import("node:fs")
    cpSync(join(STATE, "mem", "usr-x"), join(host.root, "mem-snapshots", "default_spunto_mem_usr-x@ready"), { recursive: true })
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { [h]: box(h, 61, { diffable: false, base: join(STATE, "mem", "usr-x", "mem") }) }, templates: {}, images: {}, builds: {} }))
    _test.restart()
    host.active.add(`spunto-fc-${h}`)
    host.api.length = 0
    host.commands.length = 0
    await fc.pause({ handle: h })
    await until(() => registry().vms[h].state === "stopped")
    const mem = join(STATE, "mem", h, "mem")
    expect(types()).toEqual(["Diff"])
    const clone = host.commands.indexOf(`zfs clone default/spunto/mem/usr-x@ready default/spunto/mem/${h}`)
    const paused = host.commands.indexOf("api PATCH /vm Paused")
    const rebase = host.commands.findIndex((c) => c.includes(`snapshot-editor edit-memory rebase --memory-path ${mem} --diff-path ${join(STATE, "scratch", h, "stop")}`))
    expect(clone).toBeGreaterThanOrEqual(0)
    expect(paused).toBeGreaterThan(clone)
    expect(rebase).toBeGreaterThan(paused)
    expect(host.commands.some((c) => c.startsWith("cp "))).toBe(false)
    expect(readFileSync(mem, "utf8")).toBe("model")
    expect(registry().vms[h].base).toBeUndefined()
    expect(registry().vms[h].snapshot).toMatchObject({ mem, own: true, loadable: true })
  })

  it("a box loaded from a model whose memory is still a file from before the datasets: copied in, once, before the pause", async () => {
    const h = "sbx-pb5"
    const model = join(STATE, "templates", "usr-old", "mem")
    mkdirSync(join(STATE, "templates", "usr-old"), { recursive: true })
    writeFileSync(model, "model")
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { [h]: box(h, 64, { diffable: false, base: model }) }, templates: {}, images: {}, builds: {} }))
    _test.restart()
    host.active.add(`spunto-fc-${h}`)
    host.commands.length = 0
    host.api.length = 0
    await fc.pause({ handle: h })
    await until(() => registry().vms[h].state === "stopped")
    const mem = join(STATE, "mem", h, "mem")
    expect(types()).toEqual(["Diff"])
    expect(host.commands.indexOf(`cp --sparse=always ${model} ${mem}`)).toBeLessThan(host.commands.indexOf("api PATCH /vm Paused"))
    expect(registry().vms[h].snapshot).toMatchObject({ mem, loadable: true })
  })

  it("a model's file gone (deleted meanwhile): a Full, as before", async () => {
    const h = "sbx-pb3"
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { [h]: box(h, 62, { diffable: false, base: join(STATE, "templates", "gone", "mem") }) }, templates: {}, images: {}, builds: {} }))
    _test.restart()
    host.active.add(`spunto-fc-${h}`)
    host.api.length = 0
    await fc.pause({ handle: h })
    await until(() => registry().vms[h].state === "stopped")
    expect(types()).toEqual(["Full"])
  })

  it("a cold boot marks the box, a load of its own RAM does not", async () => {
    const h = "sbx-pb4"
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { [h]: box(h, 63, { state: "stopped" }) }, templates: {}, images: {}, builds: {} }))
    _test.restart()
    await fc.start({ handle: h })
    expect(registry().vms[h]).toMatchObject({ sinceBoot: true })
    await fc.pause({ handle: h })
    await until(() => registry().vms[h].state === "stopped")
    await fc.start({ handle: h })
    expect(host.api.filter((c) => c.path === "/snapshot/load").at(-1)!.body.mem_backend.backend_path).toBe(join(STATE, "mem", h, "mem"))
    expect(registry().vms[h]).toMatchObject({ sinceBoot: false, diffable: true })
  })
})

describe("Firecracker backend — a write that fails half-way never leaves a Diff over a wrong base (PR #448 review)", () => {
  const box = (h: string, net: number, extra: Record<string, unknown> = {}) => ({
    handle: h, sandboxId: h.slice(4), name: h, size: "small", image: "i", net, env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" }, bootstrap: "true", state: "running", kernel: KERNEL_ID, createdAt: "t", ...extra,
  })
  const types = () => host.api.filter((c) => c.path === "/snapshot/create").map((c) => c.body.snapshot_type)

  it("a freeze since the boot whose disk snapshot fails: the next stop is a Full, not a Diff missing the pages before", async () => {
    const h = "sbx-rv1"
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { [h]: box(h, 80, { sinceBoot: true }) }, templates: {}, images: {}, builds: {} }))
    _test.restart()
    host.active.add(`spunto-fc-${h}`)
    host.failing = /^zfs snapshot /
    host.api.length = 0
    await expect(fc.fork({ handle: h, model: true })).rejects.toThrow(/could not be frozen/)
    // The RAM was written (the dirty log started over), the rest failed.
    expect(types()).toEqual(["Diff"])
    expect(registry().vms[h]).toMatchObject({ sinceBoot: false, diffable: false })
    host.failing = null
    host.api.length = 0
    await fc.pause({ handle: h })
    await until(() => registry().vms[h].state === "stopped")
    expect(types()).toEqual(["Full"])
  })

  it("a freeze over its own base whose merge fails: the next write is a Full", async () => {
    const h = "sbx-rv2"
    const dir = join(STATE, "vms", h)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "mem"), "base")
    const snapshot = { vmstate: join(dir, "vmstate"), mem: join(dir, "mem"), own: true, loadable: false, kernel: KERNEL_ID, at: "t" }
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { [h]: box(h, 81, { diffable: true, snapshot }) }, templates: {}, images: {}, builds: {} }))
    _test.restart()
    host.active.add(`spunto-fc-${h}`)
    host.failing = /snapshot-editor edit-memory rebase/
    host.api.length = 0
    const { ref } = await fc.fork({ handle: h, model: true })
    await until(() => registry().templates[ref]?.state === "error")
    expect(types()).toEqual(["Diff"])
    expect(registry().vms[h].diffable).toBe(false)
    host.failing = null
    host.api.length = 0
    await fc.pause({ handle: h })
    await until(() => registry().vms[h].state === "stopped")
    expect(types()).toEqual(["Full"])
  })

  it("a model deleted while a box from it stops: its clone, made before the pause, holds the model's memory", async () => {
    const h = "sbx-rv3"
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { [h]: box(h, 82, { base: join(STATE, "mem", "usr-rv", "mem") }) }, templates: { "usr-rv": { ref: "usr-rv", handle: "sbx-gone", size: "small", kind: "user", state: "ready", vmstate: join(STATE, "mem", "usr-rv", "vmstate"), mem: join(STATE, "mem", "usr-rv", "mem"), createdAt: "t" } }, images: {}, builds: {} }))
    _test.restart()
    host.active.add(`spunto-fc-${h}`)
    await ensureHost()
    mkdirSync(join(STATE, "mem", "usr-rv"), { recursive: true })
    writeFileSync(join(STATE, "mem", "usr-rv", "mem"), "model")
    const { cpSync } = await import("node:fs")
    cpSync(join(STATE, "mem", "usr-rv"), join(host.root, "mem-snapshots", "default_spunto_mem_usr-rv@ready"), { recursive: true })
    // The sweep deletes the model while the box is paused.
    host.onSnapshot = () => void fc.deleteTemplate({ ref: "usr-rv" })
    host.api.length = 0
    await fc.pause({ handle: h })
    await until(() => registry().vms[h].state === "stopped")
    expect(types()).toEqual(["Diff"])
    expect(readFileSync(join(STATE, "mem", h, "mem"), "utf8")).toBe("model")
    expect(registry().vms[h].snapshot).toMatchObject({ loadable: true })
    await until(() => !registry().templates["usr-rv"])
    expect(existsSync(join(STATE, "mem", "usr-rv"))).toBe(false)
    // Gone before the stop: a Full.
    const h2 = "sbx-rv4"
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { [h2]: box(h2, 83, { base: join(STATE, "mem", "usr-rv", "mem") }) }, templates: {}, images: {}, builds: {} }))
    _test.restart()
    host.active.add(`spunto-fc-${h2}`)
    host.onSnapshot = null
    host.api.length = 0
    await fc.pause({ handle: h2 })
    await until(() => registry().vms[h2].state === "stopped")
    expect(types()).toEqual(["Full"])
  })
})

describe("Firecracker backend — memory files in ZFS (RFC 0039 § 17)", () => {
  const box = (h: string, net: number, extra: Record<string, unknown> = {}) => ({
    handle: h, sandboxId: h.slice(4), name: h, size: "small", image: "i", net, env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" }, bootstrap: "true", kernel: KERNEL_ID, createdAt: "t", ...extra,
  })

  it("a template a running box still maps cannot be destroyed: it waits in the graveyard, and goes at a sweep once it is free", async () => {
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: {}, templates: { "usr-g": { ref: "usr-g", handle: "sbx-x", size: "small", kind: "user", state: "ready", vmstate: join(STATE, "mem", "usr-g", "vmstate"), mem: join(STATE, "mem", "usr-g", "mem"), createdAt: "t" } }, images: {}, builds: {} }))
    _test.restart()
    await ensureHost()
    mkdirSync(join(STATE, "mem", "usr-g"), { recursive: true })
    host.busy.add("default/spunto/mem/usr-g")
    await fc.deleteTemplate({ ref: "usr-g" })
    expect(registry().templates["usr-g"]).toBeUndefined()
    expect(registry().memGraveyard).toEqual(["usr-g"])
    expect(existsSync(join(STATE, "mem", "usr-g"))).toBe(true)
    // Still mapped at the next sweep, then free.
    await _test.sweepMem()
    expect(registry().memGraveyard).toEqual(["usr-g"])
    host.busy.clear()
    await _test.sweepMem()
    expect(registry().memGraveyard).toEqual([])
    expect(existsSync(join(STATE, "mem", "usr-g"))).toBe(false)
  }, 20_000)

  it("old memory files move in at a start of the daemon: templates, then boxes — paths switched, a saved RAM still loadable", async () => {
    const tplDir = join(STATE, "templates", "usr-m")
    const boxDir = join(STATE, "vms", "sbx-m1")
    for (const d of [tplDir, boxDir]) {
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, "mem"), `mem of ${d}`)
      writeFileSync(join(d, "vmstate"), `vmstate of ${d}`)
    }
    const snapshot = { vmstate: join(boxDir, "vmstate"), mem: join(boxDir, "mem"), own: true, loadable: true, kernel: KERNEL_ID, at: "t" }
    writeFileSync(
      join(STATE, "registry.json"),
      JSON.stringify({
        vms: { "sbx-m1": box("sbx-m1", 90, { state: "stopped", snapshot }), "sbx-m2": box("sbx-m2", 91, { state: "running", base: join(tplDir, "mem") }) },
        templates: { "usr-m": { ref: "usr-m", handle: "sbx-y", size: "small", kind: "user", state: "ready", vmstate: join(tplDir, "vmstate"), mem: join(tplDir, "mem"), kernel: KERNEL_ID, createdAt: "t" } },
        images: {},
        builds: {},
      }),
    )
    _test.restart()
    await ensureHost()
    await _test.migrateLegacyMemory()
    const r = registry()
    expect(r.templates["usr-m"]).toMatchObject({ mem: join(STATE, "mem", "usr-m", "mem"), vmstate: join(STATE, "mem", "usr-m", "vmstate") })
    expect(host.commands).toContain("zfs snapshot default/spunto/mem/usr-m@ready")
    expect(r.vms["sbx-m2"].base).toBe(join(STATE, "mem", "usr-m", "mem"))
    expect(r.vms["sbx-m1"].snapshot).toMatchObject({ mem: join(STATE, "mem", "sbx-m1", "mem"), vmstate: join(STATE, "mem", "sbx-m1", "vmstate"), loadable: true })
    expect(host.commands).toContain(`cp ${join(boxDir, "vmstate")} ${join(STATE, "mem", "sbx-m1-moving", "vmstate")}`)
    expect(existsSync(tplDir)).toBe(false)
    expect(existsSync(boxDir)).toBe(false)
    // Copied aside, then renamed in under the box's lock.
    expect(host.commands).toContain("zfs rename default/spunto/mem/sbx-m1-moving default/spunto/mem/sbx-m1")
    // And the start loads it from there.
    host.api.length = 0
    await fc.start({ handle: "sbx-m1" })
    expect(host.api.find((c) => c.path === "/snapshot/load")!.body.mem_backend.backend_path).toBe(join(STATE, "mem", "sbx-m1", "mem"))
  })

  it("a file the pool has no room for stays where it is, and still loads", async () => {
    const boxDir = join(STATE, "vms", "sbx-m3")
    mkdirSync(boxDir, { recursive: true })
    writeFileSync(join(boxDir, "mem"), Buffer.alloc(64 * 1024, 1))
    writeFileSync(join(boxDir, "vmstate"), "x")
    const snapshot = { vmstate: join(boxDir, "vmstate"), mem: join(boxDir, "mem"), own: true, loadable: true, kernel: KERNEL_ID, at: "t" }
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { "sbx-m3": box("sbx-m3", 92, { state: "stopped", snapshot }) }, templates: {}, images: {}, builds: {} }))
    _test.restart()
    await ensureHost()
    host.poolFree = 1024 ** 3
    await _test.migrateLegacyMemory()
    host.poolFree = 500 * 1024 ** 3
    expect(registry().vms["sbx-m3"].snapshot.mem).toBe(join(boxDir, "mem"))
    host.api.length = 0
    await fc.start({ handle: "sbx-m3" })
    expect(host.api.find((c) => c.path === "/snapshot/load")!.body.mem_backend.backend_path).toBe(join(boxDir, "mem"))
  })

  it("a restart sets only the properties that differ: re-setting the mountpoint would remount, and fail, under a running box", async () => {
    host.memProps = `mountpoint\t${join(STATE, "mem")}\ncompression\tlz4\nrecordsize\t128K\natime\toff\nsync\tdisabled\n`
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: {}, templates: {}, images: {}, builds: {} }))
    _test.restart()
    host.commands.length = 0
    await ensureHost()
    host.memProps = ""
    expect(host.commands.filter((c) => c.startsWith("zfs set") && c.endsWith(" default/spunto/mem"))).toEqual(["zfs set recordsize=64K default/spunto/mem"])
    // And a VMM's namespace lets go of the memory datasets: they stay destroyable while it runs.
    expect(readFileSync(join(STATE, "launch.sh"), "utf8")).toContain(`umount -R -l ${join(STATE, "mem")}`)
  })

  it("a box with many copies: one promote, of the newest snapshot's clone, before it is destroyed", async () => {
    const h = "sbx-pm1"
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { [h]: box(h, 93, { state: "stopped" }) }, templates: {}, images: {}, builds: {} }))
    _test.restart()
    mkdirSync(join(STATE, "mem", h), { recursive: true })
    host.snapClones.set("default/spunto/mem/sbx-pm1", ["default/spunto/mem/sbx-c1", "-", "default/spunto/mem/sbx-c2,default/spunto/mem/sbx-c3", "default/spunto/mem/sbx-c4", "-"].join("\n"))
    host.commands.length = 0
    host.onCommand = (c) => c.startsWith("zfs promote") && host.snapClones.delete("default/spunto/mem/sbx-pm1")
    await fc.destroy({ handle: h })
    await until(() => !registry().vms[h])
    host.onCommand = null
    expect(host.commands.filter((c) => c.startsWith("zfs promote"))).toEqual(["zfs promote default/spunto/mem/sbx-c4"])
    expect(existsSync(join(STATE, "mem", h))).toBe(false)
  })

  it("a box whose snapshot has a clone with a snapshot of the same name: its own renamed, then promoted, then destroyed", async () => {
    const h = "sbx-pc1"
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { [h]: box(h, 94, { state: "stopped" }) }, templates: {}, images: {}, builds: {} }))
    _test.restart()
    const root = `default/spunto/vms/${h}-root`
    const tpl = "default/spunto/templates/usr-pc1-root"
    host.snapClones.set(root, ["-", tpl].join("\n"))
    host.snapNames.set(root, [`${root}@ready`, `${root}@usr-pc1`].join("\n"))
    host.snapNames.set(tpl, `${tpl}@ready`)
    host.commands.length = 0
    host.onCommand = (c) => c.startsWith("zfs promote") && host.snapClones.delete(root)
    await fc.destroy({ handle: h })
    await until(() => !registry().vms[h])
    host.onCommand = null
    const zfs = host.commands.filter((c) => c.startsWith("zfs rename") || c.startsWith("zfs promote"))
    expect(zfs).toEqual([`zfs rename ${root}@ready ${root}@ready-of-${h}-root`, `zfs promote ${tpl}`])
  })

  it("a copy under another kernel boots its disks: the source's RAM is not left loadable over them", async () => {
    const src = "sbx-fk1"
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { [src]: box(src, 94, { state: "running", kernel: "an-old-kernel", sinceBoot: true }) }, templates: {}, images: {}, builds: {} }))
    _test.restart()
    host.active.add(`spunto-fc-${src}`)
    const { ref } = await fc.fork({ handle: src })
    await until(() => registry().templates[ref]?.state === "ready")
    await fc.create({ sandboxId: "fk2", name: "fk2", image: "i", from: ref, bootstrap: "true", env: { SPUNTO_SANDBOX_TOKEN: "sbx_copy" } })
    await until(() => registry().vms["sbx-fk2"].state !== "creating")
    expect(registry().vms["sbx-fk2"]).toMatchObject({ state: "running", sinceBoot: true })
    expect(registry().vms["sbx-fk2"].snapshot).toBeUndefined()
  })

  it("a fork deleted while its memory is being made: what the freeze made goes too", async () => {
    const src = "sbx-fd1"
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { [src]: box(src, 95, { state: "running", sinceBoot: true }) }, templates: {}, images: {}, builds: {} }))
    _test.restart()
    host.active.add(`spunto-fc-${src}`)
    let ref = ""
    host.onSnapshot = () => {
      ref = Object.keys(registry().templates)[0]!
      void fc.deleteTemplate({ ref })
    }
    host.commands.length = 0
    await fc.fork({ handle: src }).catch(() => {})
    host.onSnapshot = null
    await until(() => host.commands.includes(`zfs destroy -r default/spunto/mem/${ref}`) && host.commands.includes(`zfs destroy default/spunto/mem/${src}@${ref}`))
    expect(existsSync(join(STATE, "mem", ref))).toBe(false)
    expect(registry().templates[ref]).toBeUndefined()
  })
})

describe("Firecracker backend — admission under load (PR #448 review)", () => {
  const GIB = 1024 ** 3

  it("six creates at once do not all pass on the same free memory", async () => {
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: {}, templates: {}, images: {}, builds: {} }))
    _test.restart()
    // 8 GB free, an xlarge needs 2: four fit, the two others are refused. (The announced sizes
    // would refuse the second: off, this is the room's own hold.)
    host.slice = { max: 8 * GIB, current: 0 }
    process.env.SPUNTO_FC_OVERCOMMIT = "0"
    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5, 6].map((i) => fc.create({ sandboxId: `ad${i}`, name: `ad${i}`, image: "img:1", size: "xlarge", bootstrap: "true", env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" } })),
    ).finally(() => delete process.env.SPUNTO_FC_OVERCOMMIT)
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(4)
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")
    expect(refused).toHaveLength(2)
    expect(refused[0]!.reason).toMatchObject({ code: "capacity", message: expect.stringMatching(/8\.0 GB held for boxes starting/) })
  })

  it("refuses a box the running ones' announced sizes leave no room for, though the slice is not full yet (§ 18)", async () => {
    // Canada on 2026-10-11: a 16 GB slice, an xlarge and a default running but light (2 GB touched).
    // A large fits in the room left now — and the setup it runs would fill it, the kernel killing one.
    const running = (h: string, net: number, size: string) => ({ handle: h, sandboxId: h.slice(4), name: h, size, image: "i", net, env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" }, bootstrap: "true", state: "running", createdAt: "t" })
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { "sbx-oc1": running("sbx-oc1", 101, "xlarge"), "sbx-oc2": running("sbx-oc2", 102, "default") }, templates: {}, images: {}, builds: {} }))
    _test.restart()
    host.active.add("spunto-fc-sbx-oc1")
    host.active.add("spunto-fc-sbx-oc2")
    host.slice = { max: 16 * GIB, current: 2 * GIB }
    const create = (id: string, size: string) => fc.create({ sandboxId: id, name: id, image: "img:1", size, bootstrap: "true", env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" } })
    // 16 + 4 + 8 = 28 GB announced > 1.5 × 16.
    await expect(create("oc3", "large")).rejects.toMatchObject({
      code: "capacity",
      message: expect.stringMatching(/announce 20\.0 GB of RAM.*28\.0 GB would be more than 1\.5× what it gives them \(vms\.slice: 16\.0 GB\)/),
    })
    expect(registry().vms["sbx-oc3"]).toBeUndefined()
    // 16 + 4 + 2 = 22 GB: in.
    await expect(create("oc4", "small")).resolves.toMatchObject({ handle: "sbx-oc4" })
    // The one just admitted counts for the next, before it is even running: 22 + 4 = 26.
    await expect(create("oc5", "default")).rejects.toMatchObject({ code: "capacity" })
    // A higher ratio lets it in; 0 turns the check off.
    process.env.SPUNTO_FC_OVERCOMMIT = "3"
    await expect(create("oc6", "large")).resolves.toMatchObject({ handle: "sbx-oc6" })
    delete process.env.SPUNTO_FC_OVERCOMMIT
  })

  it("a box the OOM killer took no longer counts: settled before the admission reads the registry (test-2, 2026-10-20)", async () => {
    // A 16 GB slice at 1.5×: 24 GB announced at most. An xlarge alive, a large the kernel killed.
    const running = (h: string, net: number, size: string) => ({ handle: h, sandboxId: h.slice(4), name: h, size, image: "i", net, env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" }, bootstrap: "true", state: "running", createdAt: "t" })
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { "sbx-gh1": running("sbx-gh1", 111, "xlarge"), "sbx-gh2": running("sbx-gh2", 112, "large") }, templates: {}, images: {}, builds: {} }))
    _test.restart()
    host.active.add("spunto-fc-sbx-gh1")
    host.active.add("spunto-fc-sbx-gh2")
    await ensureHost()
    // Killed while the daemon runs, and nobody asks about it.
    host.active.delete("spunto-fc-sbx-gh2")
    writeFileSync(join(process.env.SPUNTO_FC_RUN!, "sbx-gh2.exit"), "oom-kill killed KILL\n")
    host.slice = { max: 16 * GIB, current: 2 * GIB }
    // 16 + 8 (the dead large) + 8 = 32 GB would be refused; 16 + 8 = 24 GB: in.
    await expect(fc.create({ sandboxId: "gh3", name: "gh3", image: "img:1", size: "large", bootstrap: "true", env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" } })).resolves.toMatchObject({ handle: "sbx-gh3" })
    expect(registry().vms["sbx-gh2"]).toMatchObject({ state: "stopped", died: { result: "oom-kill" } })
    expect(await fc.describe({ handle: "sbx-gh2" })).toMatchObject({ state: "error", exit: "oom-kill" })
    // A stop asked for: it is just stopped now, no more an error.
    await fc.stop({ handle: "sbx-gh2" })
    expect(registry().vms["sbx-gh2"].died).toBeUndefined()
    expect(await fc.describe({ handle: "sbx-gh2" })).toMatchObject({ state: "stopped" })
  })

  it("a box is not its own neighbour: alone it starts whatever its size, and its start does not count it twice", async () => {
    const h = "sbx-oc7"
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { [h]: { handle: h, sandboxId: "oc7", name: h, size: "xlarge", image: "i", net: 107, env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" }, bootstrap: "true", state: "stopped", createdAt: "t" } }, templates: {}, images: {}, builds: {} }))
    _test.restart()
    // An xlarge on an 8 GB slice: more than 1.5× by itself — the operator's choice, not refused.
    host.slice = { max: 8 * GIB, current: 0 }
    await fc.start({ handle: h })
    expect(registry().vms[h].state).toBe("running")
    await fc.pause({ handle: h })
    await until(() => registry().vms[h].state === "stopped")
    _test.held.length = 0
    await fc.start({ handle: h })
    expect(registry().vms[h].state).toBe("running")
  })

  it("a start stops a leftover VMM of the same box before measuring the room", async () => {
    const h = "sbx-ad9"
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { [h]: { handle: h, sandboxId: "ad9", name: h, size: "small", image: "i", net: 90, env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" }, bootstrap: "true", state: "stopped", createdAt: "t" } }, templates: {}, images: {}, builds: {} }))
    _test.restart()
    host.commands.length = 0
    await fc.start({ handle: h })
    const stop = host.commands.indexOf(`systemctl stop spunto-fc-${h}`)
    const measure = host.commands.findIndex((c) => c.startsWith("systemctl show vms.slice"))
    expect(stop).toBeGreaterThanOrEqual(0)
    expect(measure).toBeGreaterThan(stop)
  })
})

describe("Firecracker backend — the registry after a reboot of the machine (RFC 0039 § 16)", () => {
  it("a box `running` with no VMM is stopped at the daemon's start; one the OOM killer took too, and keeps saying so", async () => {
    const vm = (h: string, net: number) => ({ handle: h, sandboxId: h.slice(4), name: h, size: "small", image: "i", net, env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" }, bootstrap: "true", state: "running", createdAt: "t" })
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { "sbx-rb1": vm("sbx-rb1", 95), "sbx-rb2": vm("sbx-rb2", 96), "sbx-rb3": vm("sbx-rb3", 97) }, templates: {}, images: {}, builds: {} }))
    host.active.add("spunto-fc-sbx-rb3") // still up: a restart of the daemon alone
    writeFileSync(join(process.env.SPUNTO_FC_RUN!, "sbx-rb2.exit"), "oom-kill killed KILL\n")
    _test.restart()
    await ensureHost()
    expect(registry().vms["sbx-rb1"]).toMatchObject({ state: "stopped", stoppedWhy: expect.stringMatching(/not running when the node daemon started/) })
    expect((await fc.describe({ handle: "sbx-rb1" })).detail).toMatch(/^powered off: its microVM was not running/)
    expect(registry().vms["sbx-rb2"]).toMatchObject({ state: "stopped", died: { result: "oom-kill" } })
    expect((await fc.describe({ handle: "sbx-rb2" }))).toMatchObject({ state: "error", exit: "oom-kill" })
    expect(registry().vms["sbx-rb3"].state).toBe("running")
    // A start clears what was seen.
    await fc.start({ handle: "sbx-rb1" })
    expect(registry().vms["sbx-rb1"].stoppedWhy).toBeUndefined()
  })
})

describe("Firecracker backend — a box from before system disks went by size (RFC 0039 § 16)", () => {
  it("has its system disk grown to its size's at its next start, never shrunk", async () => {
    const h = "sbx-gs1"
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { [h]: { handle: h, sandboxId: "gs1", name: h, size: "large", image: "i", net: 98, env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" }, bootstrap: "true", state: "stopped", createdAt: "t" } }, templates: {}, images: {}, builds: {} }))
    _test.restart()
    host.volsizes.set(`default/spunto/vms/${h}-root`, 10 * 1024 ** 3)
    await fc.start({ handle: h })
    expect(host.volsizes.get(`default/spunto/vms/${h}-root`)).toBe(50 * 1024 ** 3)
    await fc.pause({ handle: h })
    await until(() => registry().vms[h].state === "stopped")
    // Grown by hand beyond it since: left as it is.
    host.volsizes.set(`default/spunto/vms/${h}-root`, 120 * 1024 ** 3)
    host.commands.length = 0
    await fc.start({ handle: h })
    expect(host.commands.some((c) => c.startsWith("zfs set volsize"))).toBe(false)
  })
})

describe("Firecracker backend — memory files in ZFS, PR #458 review", () => {
  const GIB = 1024 ** 3
  const box = (h: string, net: number, extra: Record<string, unknown> = {}) => ({
    handle: h, sandboxId: h.slice(4), name: h, size: "xlarge", image: "i", net, env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" }, bootstrap: "true", state: "running", kernel: KERNEL_ID, createdAt: "t", ...extra,
  })
  const types = () => host.api.filter((c) => c.path === "/snapshot/create").map((c) => c.body.snapshot_type)
  const fresh = async (vms: Record<string, unknown>, templates: Record<string, unknown> = {}) => {
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms, templates, images: {}, builds: {} }))
    _test.restart()
    for (const h of Object.keys(vms)) host.active.add(`spunto-fc-${h}`)
    await ensureHost()
    host.api.length = 0
    host.commands.length = 0
  }

  it("a stop the pool has no room for: nothing written into it, the box shut down cleanly, said why", async () => {
    const h = "sbx-nr1"
    await fresh({ [h]: box(h, 100, { sinceBoot: true }) })
    // An xlarge whose unit holds nothing systemd says: its whole 16 GB, with 5 kept for the disks.
    host.poolFree = 20 * GIB
    await fc.pause({ handle: h })
    await until(() => registry().vms[h].state === "stopped")
    expect(types()).toEqual([])
    expect(host.api.some((c) => c.body?.action_type === "SendCtrlAltDel")).toBe(true)
    expect(registry().vms[h].snapshot).toBeUndefined()
    expect((await fc.describe({ handle: h })).detail).toMatch(/no room in the machine's disk pool/)
  })

  it("a fork the pool has no room for is refused before the pause, the source untouched", async () => {
    const h = "sbx-nr2"
    await fresh({ [h]: box(h, 101, { sinceBoot: true }) })
    host.poolFree = 20 * GIB
    await expect(fc.fork({ handle: h })).rejects.toThrow(/no room in the machine's disk pool/)
    expect(host.api.some((c) => c.path === "/vm")).toBe(false)
    expect(registry().vms[h]).toMatchObject({ state: "running", sinceBoot: true })
  })

  it("a stop whose RAM was written but not merged (the pool filled meanwhile): the VMM was kept, the box shuts down cleanly", async () => {
    const h = "sbx-nr3"
    await fresh({ [h]: box(h, 102, { sinceBoot: true }) })
    host.onSnapshot = () => void (host.poolFree = 4.9 * GIB)
    await fc.pause({ handle: h })
    await until(() => registry().vms[h].state === "stopped")
    expect(types()).toEqual(["Diff"])
    const calls = host.commands.filter((c) => c.startsWith("api ") || c.startsWith("cp ") || c.startsWith("systemctl stop"))
    // Resumed and told to shut down, its VMM stopped after that — never killed with its page cache.
    expect(calls.findIndex((c) => c === "api PUT /actions")).toBeGreaterThan(calls.findIndex((c) => c === "api PUT /snapshot/create"))
    expect(host.commands.some((c) => c.startsWith("cp --sparse=always"))).toBe(false)
    expect(registry().vms[h].snapshot).toBeUndefined()
    expect(existsSync(join(STATE, "scratch", h, "stop"))).toBe(false)
  })

  it("an old file copied in at a first write needs room too", async () => {
    const h = "sbx-nr4"
    const dir = join(STATE, "vms", h)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "mem"), Buffer.alloc(1024 ** 2, 1))
    const snapshot = { vmstate: join(dir, "vmstate"), mem: join(dir, "mem"), own: true, loadable: false, kernel: KERNEL_ID, at: "t" }
    await fresh({ [h]: box(h, 103, { size: "small", diffable: true, snapshot }) })
    host.poolFree = 5 * GIB + 512 * 1024
    // No room for the copy: a Full instead — which has no room either: shut down cleanly.
    await fc.pause({ handle: h })
    await until(() => registry().vms[h].state === "stopped")
    expect(host.commands.some((c) => c.startsWith(`cp --sparse=always ${join(dir, "mem")}`))).toBe(false)
    expect(types()).toEqual([])
  })

  it("the scratch on a ZFS host: only a mount of its own dataset, uncompressed, will do", () => {
    const ds = "default/spunto/scratch"
    const path = "/var/lib/spunto-fc/scratch"
    expect(scratchProblem(`rpool/var /var zfs rw 0 0\n${ds} ${path} zfs rw 0 0\n`, ds, "off", path)).toBeUndefined()
    expect(scratchProblem(`rpool/var /var zfs rw 0 0\n`, ds, "off", path)).toMatch(/not a mount point/)
    expect(scratchProblem(`rpool/other ${path} zfs rw 0 0\n`, ds, "off", path)).toMatch(/mounted from rpool\/other/)
    expect(scratchProblem(`${ds} ${path} zfs rw 0 0\n`, ds, "lz4", path)).toMatch(/compression=lz4/)
  })

  it("a restart empties the scratch without removing it (it may be a mount point)", async () => {
    await fresh({})
    mkdirSync(join(STATE, "scratch", "sbx-x"), { recursive: true })
    writeFileSync(join(STATE, "scratch", "sbx-x", "stop"), "x")
    const { statSync: st } = await import("node:fs")
    const ino = st(join(STATE, "scratch")).ino
    _test.restart()
    await ensureHost()
    expect(existsSync(join(STATE, "scratch", "sbx-x", "stop"))).toBe(false)
    expect(st(join(STATE, "scratch")).ino).toBe(ino)
  })

  it("a fork's copy whose load fails is not left with the source's RAM loadable", async () => {
    const src = "sbx-fl1"
    await fresh({ [src]: box(src, 104, { size: "small", sinceBoot: true }) })
    const { ref } = await fc.fork({ handle: src })
    await until(() => registry().templates[ref]?.state === "ready")
    host.apiFailing = /^\/snapshot\/load$/
    await fc.create({ sandboxId: "fl2", name: "fl2", image: "i", from: ref, bootstrap: "true", env: { SPUNTO_SANDBOX_TOKEN: "sbx_copy" } })
    await until(() => registry().vms["sbx-fl2"].state !== "creating")
    expect(registry().vms["sbx-fl2"].state).toBe("error")
    expect(registry().vms["sbx-fl2"].snapshot).toBeUndefined()
  })

  it("a copy under another kernel: the fork's memory goes at once, nothing renamed for the copy", async () => {
    const src = "sbx-fk3"
    await fresh({ [src]: box(src, 105, { size: "small", kernel: "an-old-kernel", sinceBoot: true }) })
    const { ref } = await fc.fork({ handle: src })
    await until(() => registry().templates[ref]?.state === "ready")
    host.commands.length = 0
    await fc.create({ sandboxId: "fk4", name: "fk4", image: "i", from: ref, bootstrap: "true", env: { SPUNTO_SANDBOX_TOKEN: "sbx_copy" } })
    await until(() => registry().vms["sbx-fk4"].state !== "creating")
    expect(registry().vms["sbx-fk4"].state).toBe("running")
    expect(host.commands.some((c) => c.startsWith("zfs rename"))).toBe(false)
    expect(host.commands).toContain(`zfs destroy default/spunto/mem/${src}@${ref}`)
    expect(existsSync(join(STATE, "mem", ref))).toBe(false)
    expect(registry().templates[ref]).toBeUndefined()
  })

  it("a model still loaded by a running box is not touched — no promote, `@ready` kept — until the box is gone", async () => {
    const tpl = { ref: "usr-mp", handle: "sbx-gone", size: "small", kind: "user", state: "ready", vmstate: join(STATE, "mem", "usr-mp", "vmstate"), mem: join(STATE, "mem", "usr-mp", "mem"), kernel: KERNEL_ID, createdAt: "t" }
    await fresh({ "sbx-mp1": box("sbx-mp1", 106, { size: "small", base: join(STATE, "mem", "usr-mp", "mem") }) }, { "usr-mp": tpl })
    mkdirSync(join(STATE, "mem", "usr-mp"), { recursive: true })
    host.snapClones.set("default/spunto/mem/usr-mp", "default/spunto/mem/sbx-other\n")
    await fc.deleteTemplate({ ref: "usr-mp" })
    expect(host.commands.some((c) => c.startsWith("zfs promote") || c.startsWith("zfs destroy -r default/spunto/mem/usr-mp"))).toBe(false)
    expect(registry().memGraveyard).toEqual(["usr-mp"])
    // Still mapped at the sweep; then the box stops (its base cleared) and the sweep takes it.
    await _test.sweepMem()
    expect(existsSync(join(STATE, "mem", "usr-mp"))).toBe(true)
    host.active.delete("spunto-fc-sbx-mp1")
    host.snapClones.delete("default/spunto/mem/usr-mp")
    await _test.sweepMem()
    expect(existsSync(join(STATE, "mem", "usr-mp"))).toBe(false)
    expect(registry().memGraveyard).toEqual([])
  })

  it("the sweep does not destroy a name a box took back meanwhile", async () => {
    await fresh({})
    const r = JSON.parse(readFileSync(join(STATE, "registry.json"), "utf8"))
    r.memGraveyard = ["sbx-rb1"]
    writeFileSync(join(STATE, "registry.json"), JSON.stringify(r))
    _test.restart()
    await ensureHost()
    mkdirSync(join(STATE, "mem", "sbx-rb1"), { recursive: true })
    // The rebuilt box's operation holds its lock, and takes the name back before the sweep gets it.
    let release!: () => void
    const held = _test.serial("sbx-rb1", () => new Promise<void>((r) => (release = r)))
    const sweep = _test.sweepMem()
    await until(() => !!release)
    _test.forgive("sbx-rb1")
    release()
    await held
    await sweep
    expect(existsSync(join(STATE, "mem", "sbx-rb1"))).toBe(true)
  })

  it("a model still in an old file, loaded by two boxes: moved in once, then each box clones it", async () => {
    const model = join(STATE, "templates", "usr-two", "mem")
    mkdirSync(join(STATE, "templates", "usr-two"), { recursive: true })
    writeFileSync(model, "model")
    const tpl = { ref: "usr-two", handle: "sbx-y", size: "small", kind: "user", state: "ready", vmstate: join(STATE, "templates", "usr-two", "vmstate"), mem: model, kernel: KERNEL_ID, createdAt: "t" }
    await fresh({ "sbx-tw1": box("sbx-tw1", 107, { size: "small", base: model }), "sbx-tw2": box("sbx-tw2", 108, { size: "small", base: model }) }, { "usr-two": tpl })
    await Promise.all([fc.pause({ handle: "sbx-tw1" }), fc.pause({ handle: "sbx-tw2" })])
    await until(() => registry().vms["sbx-tw1"].state === "stopped" && registry().vms["sbx-tw2"].state === "stopped")
    expect(host.commands.filter((c) => c.startsWith(`cp --sparse=always ${model} `))).toEqual([`cp --sparse=always ${model} ${join(STATE, "mem", "usr-two", "mem")}`])
    for (const h of ["sbx-tw1", "sbx-tw2"]) expect(host.commands).toContain(`zfs clone default/spunto/mem/usr-two@ready default/spunto/mem/${h}`)
    expect(types()).toEqual(["Diff", "Diff"])
    expect(registry().templates["usr-two"].mem).toBe(join(STATE, "mem", "usr-two", "mem"))
  })
})

describe("Firecracker backend — the jailer: a chroot and a uid per VMM (RFC 0039 § 21)", () => {
  const box = (h: string, net: number, extra: Record<string, unknown> = {}) => ({
    handle: h,
    sandboxId: h.slice(4),
    name: h,
    size: "large",
    image: "i",
    net,
    env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" },
    bootstrap: "true",
    state: "stopped",
    kernel: KERNEL_ID,
    createdAt: "t",
    ...extra,
  })
  const fresh = async (vms: Record<string, unknown>, templates: Record<string, unknown> = {}) => {
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms, templates, images: {}, builds: {} }))
    _test.restart()
    for (const [h, vm] of Object.entries(vms)) if ((vm as { state: string }).state === "running") host.active.add(`spunto-fc-${h}`)
    await ensureHost()
    host.api.length = 0
    host.commands.length = 0
  }
  const jail = (h: string) => join(STATE, "jail", "firecracker", h, "root")

  it("boots under the jailer: its own uid, its netns, its CPU bounded, its drives and kernel in its chroot", async () => {
    const h = "sbx-j1"
    await fresh({ [h]: box(h, 300) })
    host.zvolsAreDevices = true
    try {
      await fc.start({ handle: h })
    } finally {
      host.zvolsAreDevices = false
    }
    const uid = uidOf(300)
    expect(uid).toBe(2_000_000_300)
    const spawn = host.commands.find((c) => c.startsWith("systemd-run") && c.includes(`--unit=spunto-fc-${h}`))!
    expect(spawn).toContain(`--slice=vms.slice`)
    expect(spawn).toContain(`-p CPUQuota=450% -p CPUWeight=100`)
    expect(spawn).toContain(
      `${join(host.root, "opt/bin/jailer")} --id ${h} --exec-file ${join(host.root, "opt/bin/firecracker")} --uid ${uid} --gid ${uid} --chroot-base-dir ${join(STATE, "jail")} --netns /run/netns/fc300 -- --api-sock /run/api.sock`,
    )
    expect(spawn).not.toContain("launch.sh")
    // Its tap is its own: a VMM without capabilities opens no other.
    expect(host.commands.some((c) => c.includes(`ip tuntap add tap0 mode tap user ${uid} group ${uid}`))).toBe(true)
    // Its drives at the paths a VMM has always had (a snapshot names them), as device nodes of its own.
    const drive = join(jail(h), STATE, "drive")
    expect(host.commands).toContain(`mknod -m 600 ${drive}/root b 230 16`)
    expect(host.commands).toContain(`chown ${uid}:${uid} ${drive}/root ${drive}/ws`)
    expect(host.commands).toContain(`mknod -m 600 ${drive}/ws b 230 16`)
    expect(host.commands).toContain(`mount --bind -o ro ${process.env.SPUNTO_FC_KERNEL} ${join(jail(h), "vmlinux")}`)
    expect(host.api.find((c) => c.path === "/boot-source")!.body.kernel_image_path).toBe("/vmlinux")
    expect(host.api.find((c) => c.path === "/drives/root")!.body.path_on_host).toBe(join(STATE, "drive", "root"))
    expect(host.api.at(-1)!.jail).toBe(jail(h))
  })

  it("its RAM goes through its jail: own directories its uid's, bound for the call and unbound after; a stop removes the jail", async () => {
    const h = "sbx-j2"
    await fresh({ [h]: box(h, 301, { state: "running", sinceBoot: true }) })
    host.active.add(`spunto-fc-${h}`)
    const uid = uidOf(301)
    await fc.pause({ handle: h })
    await until(() => registry().vms[h].state === "stopped")
    const create = host.api.find((c) => c.path === "/snapshot/create")!
    // The VMM was given paths in its chroot, which were its own directories on the host.
    expect(create.given.snapshot_path).toMatch(/^\/mem\/[0-9a-f]{8}\/vmstate\.new$/)
    expect(create.given.mem_file_path).toMatch(/^\/mem\/[0-9a-f]{8}\/stop$/)
    expect(create.body.snapshot_path).toBe(join(STATE, "mem", h, "vmstate.new"))
    expect(create.body.mem_file_path).toBe(join(STATE, "scratch", h, "stop"))
    expect(host.commands).toContain(`chown ${uid}:${uid} ${join(STATE, "mem", h)}`)
    expect(host.commands).toContain(`chown ${uid}:${uid} ${join(STATE, "scratch", h)}`)
    // Bound before the pause, unbound after the snapshot: nothing of the host stays in the jail.
    const at = (re: RegExp) => host.commands.findIndex((c) => re.test(c))
    expect(at(/^mount --bind .*\/scratch\//)).toBeLessThan(at(/^api PATCH \/vm Paused/))
    expect(at(/^umount -l .*\/mem\//)).toBeGreaterThan(at(/^api PUT \/snapshot\/create/))
    expect([...host.mounts].filter((m) => m.startsWith(`${jail(h)}/`))).toEqual([])
    // The VMM gone, its jail goes, never across a mount.
    expect(host.commands).toContain(`rm -rf --one-file-system ${join(STATE, "jail", "firecracker", h)}`)
    expect(existsSync(jail(h))).toBe(false)

    // Its own RAM, loaded: its uid's to read.
    host.commands.length = 0
    await fc.start({ handle: h })
    const load = host.api.find((c) => c.path === "/snapshot/load")!
    expect(load.given.mem_backend.backend_path).toMatch(/^\/mem\/[0-9a-f]{8}\/mem$/)
    expect(load.body.mem_backend.backend_path).toBe(join(STATE, "mem", h, "mem"))
    expect(host.commands).toContain(`chown ${uid}:${uid} ${join(STATE, "mem", h)} ${join(STATE, "mem", h, "vmstate")} ${join(STATE, "mem", h, "mem")}`)
    // What stays bound while it runs: its drives and its kernel (files here; the drives are device nodes on a real host).
    expect([...host.mounts].filter((m) => m.startsWith(`${jail(h)}/`)).sort()).toEqual([join(jail(h), STATE, "drive", "root"), join(jail(h), STATE, "drive", "ws"), join(jail(h), "vmlinux")].sort())
  })

  it("a model's memory is root's, read-only to the boxes loading it", async () => {
    const ref = "usr-jm"
    mkdirSync(join(STATE, "mem", ref), { recursive: true })
    for (const f of ["mem", "vmstate"]) writeFileSync(join(STATE, "mem", ref, f), "x")
    const tpl = { ref, handle: "sbx-gone", size: "small", kind: "user", state: "ready", vmstate: join(STATE, "mem", ref, "vmstate"), mem: join(STATE, "mem", ref, "mem"), kernel: KERNEL_ID, createdAt: "t" }
    await fresh({}, { [ref]: tpl })
    host.missing.add("default/spunto/ws/jm1")
    await fc.create({ sandboxId: "jm1", name: "jm1", image: "i", size: "small", env: { SPUNTO_SANDBOX_TOKEN: "sbx_y" }, bootstrap: "true", from: ref })
    await until(() => registry().vms["sbx-jm1"]?.state !== "creating")
    expect(registry().vms["sbx-jm1"].state).toBe("running")
    expect(host.api.find((c) => c.path === "/snapshot/load")!.jail).toBe(jail("sbx-jm1"))
    const dir = join(STATE, "mem", ref)
    expect(host.commands).toContain(`chown 0:0 ${dir} ${dir}/vmstate ${dir}/mem`)
    expect(host.commands).toContain(`chmod 755 ${dir}`)
    expect(host.commands).toContain(`chmod 644 ${dir}/vmstate ${dir}/mem`)
    expect(host.commands.some((c) => c.startsWith("chown 2") && c.includes(dir))).toBe(false)
    host.missing.delete("default/spunto/ws/jm1")
  })

  it("a VMM from before the jailer, still running, is reached as before; its next start is jailed, its tap made again for its uid", async () => {
    const h = "sbx-j3"
    await fresh({ [h]: box(h, 302, { state: "running", sinceBoot: true }) })
    host.active.add(`spunto-fc-${h}`)
    writeFileSync(join(process.env.SPUNTO_FC_RUN!, `${h}.sock`), "")
    await fc.pause({ handle: h })
    await until(() => registry().vms[h].state === "stopped")
    const create = host.api.find((c) => c.path === "/snapshot/create")!
    expect(create.body.snapshot_path).toBe(vmmPath(join(STATE, "mem", h, "vmstate.new")))
    expect(create.jail).toBeNull()
    expect(host.commands.some((c) => c.startsWith("mount"))).toBe(false)
    expect(existsSync(join(process.env.SPUNTO_FC_RUN!, `${h}.sock`))).toBe(false)

    // Its RAM, taken outside a jail, loads in one: same drive paths, its files made its uid's.
    host.commands.length = 0
    host.tapOwner = "1234"
    try {
      await fc.start({ handle: h })
    } finally {
      host.tapOwner = ""
    }
    expect(host.commands.some((c) => c.startsWith("systemd-run") && c.includes("--uid 2000000302"))).toBe(true)
    expect(host.commands.some((c) => c.includes("ip link del tap0") && c.includes("user 2000000302"))).toBe(true)
    expect(host.api.find((c) => c.path === "/snapshot/load")!.jail).toBe(jail(h))
  })

  it("at the daemon's start: CPU limits on the VMMs running (those from before included), the jails of dead ones removed", async () => {
    const h = "sbx-j4"
    mkdirSync(jail("sbx-dead"), { recursive: true })
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { [h]: box(h, 303, { state: "running", size: "small" }) }, templates: {}, images: {}, builds: {} }))
    _test.restart()
    host.active.add(`spunto-fc-${h}`)
    host.commands.length = 0
    await ensureHost()
    expect(host.commands).toContain(`systemctl set-property --runtime spunto-fc-${h} CPUQuota=150% CPUWeight=100`)
    expect(existsSync(jail("sbx-dead"))).toBe(false)
    expect(existsSync(jail(h))).toBe(true)
  })

  it("limits, ids and device numbers", () => {
    // One share per box, whatever its size: a box of 8 busy vCPUs does not take 8 shares to its 1-vCPU neighbour's one.
    expect(cpuLimits(1)).toEqual(["CPUQuota=150%", "CPUWeight=100"])
    expect(cpuLimits(8)).toEqual(["CPUQuota=850%", "CPUWeight=100"])
    process.env.SPUNTO_FC_CPU_WEIGHT = "vcpu"
    expect(cpuLimits(8)).toEqual(["CPUQuota=850%", "CPUWeight=800"])
    delete process.env.SPUNTO_FC_CPU_WEIGHT
    process.env.SPUNTO_FC_CPU_MARGIN = "0"
    expect(cpuLimits(2)).toEqual(["CPUQuota=200%", "CPUWeight=100"])
    process.env.SPUNTO_FC_CPU_LIMITS = "0"
    expect(cpuLimits(2)).toEqual([])
    delete process.env.SPUNTO_FC_CPU_LIMITS
    delete process.env.SPUNTO_FC_CPU_MARGIN
    expect(jailIdOf("sbx-0bhm3vynjwdbjr0ipbjvl")).toBe("sbx-0bhm3vynjwdbjr0ipbjvl")
    expect(jailIdOf("sbx-a_b")).toMatch(/^sbx-a-b-[0-9a-f]{16}$/)
    expect(jailIdOf("sbx-a_b")).not.toBe(jailIdOf("sbx-a-b"))
    expect(jailIdOf(`bld-${"x".repeat(80)}`).length).toBeLessThanOrEqual(64)
    expect(blockDeviceOf("block special file e6 a0\n")).toEqual({ major: 230, minor: 160 })
    expect(blockDeviceOf("regular file 0 0")).toBeUndefined()
    expect(tapOwnerOf("    tun type tap pi off vnet_hdr on persist on user 2000001000 group 2000001000 addrgenmode eui64")).toBe(2_000_001_000)
    expect(tapOwnerOf("    tun type tap pi off vnet_hdr on persist on addrgenmode eui64")).toBeUndefined()
  })
})

describe("Firecracker backend — the network, the disks and the host's measures (RFC 0039 § 22)", () => {
  const box = (h: string, net: number, extra: Record<string, unknown> = {}) => ({
    handle: h,
    sandboxId: h.slice(4),
    name: h,
    size: "small",
    image: "i",
    net,
    env: { SPUNTO_SANDBOX_TOKEN: "sbx_x" },
    bootstrap: "true",
    state: "stopped",
    kernel: KERNEL_ID,
    createdAt: "t",
    ...extra,
  })
  const fresh = async (vms: Record<string, unknown>) => {
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms, templates: {}, images: {}, builds: {} }))
    _test.restart()
    for (const [h, vm] of Object.entries(vms)) if ((vm as { state: string }).state === "running") host.active.add(`spunto-fc-${h}`)
    await ensureHost()
    host.api.length = 0
    host.commands.length = 0
  }
  const veth = (net: number) => mkdirSync(join(host.root, "sysnet", `fcv${net}`, "statistics"), { recursive: true })

  it("the machine's two IFBs, one HTB each: the boxes' total, and a default class", async () => {
    writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: {}, templates: {}, images: {}, builds: {} }))
    mkdirSync(join(host.root, "sysnet", "eth0"), { recursive: true })
    writeFileSync(join(host.root, "sysnet", "eth0", "speed"), "1000\n")
    _test.restart()
    host.ifbs.clear()
    host.commands.length = 0
    await ensureHost()
    for (const dev of ["fcifbu", "fcifbd"]) {
      expect(host.commands).toContain(`ip link add ${dev} type ifb`)
      expect(host.commands).toContain(`tc qdisc replace dev ${dev} root handle 1: htb default ffff`)
      // 95 % of the link: the queue must be ours, not the uplink's (fair per flow, not per box).
      expect(host.commands).toContain(`tc class replace dev ${dev} parent 1: classid 1:1 htb rate 950mbit ceil 950mbit burst 580k cburst 580k quantum 131072`)
      expect(host.commands).toContain(`tc class replace dev ${dev} parent 1:1 classid 1:ffff htb rate 1mbit ceil 200mbit burst 123k cburst 123k quantum 131072`)
    }
    rmSync(join(host.root, "sysnet", "eth0"), { recursive: true, force: true })
  })

  it("a box's start shapes its veth both ways through its class, and closes port 25 in its namespace", async () => {
    const h = "sbx-n1"
    await fresh({ [h]: box(h, 400) })
    host.smtpRules.clear()
    await fc.start({ handle: h })
    const cls = netClassOf(400)
    expect(cls).toBe("1:1a0")
    for (const dev of ["fcifbu", "fcifbd"]) {
      expect(host.commands).toContain(`tc class replace dev ${dev} parent 1:1 classid ${cls} htb rate 1mbit ceil 200mbit burst 123k cburst 123k quantum 131072`)
      expect(host.commands).toContain(`tc qdisc replace dev ${dev} parent ${cls} fq_codel`)
    }
    expect(host.commands).toContain(`tc qdisc add dev fcv400 clsact`)
    expect(host.commands).toContain(`tc filter add dev fcv400 ingress pref 1 handle 1 matchall action skbedit priority ${cls} pipe action mirred egress redirect dev fcifbu`)
    expect(host.commands).toContain(`tc filter add dev fcv400 egress pref 1 handle 1 matchall action skbedit priority ${cls} pipe action mirred egress redirect dev fcifbd`)
    expect(host.commands).toContain("ip netns exec fc400 iptables -I FORWARD 1 -i tap0 -p tcp --dport 25 -j REJECT --reject-with tcp-reset")
    // A second start finds the rule: not twice.
    host.commands.length = 0
    await fc.stop({ handle: h })
    await until(() => registry().vms[h].state === "stopped")
    await fc.start({ handle: h })
    expect(host.commands.filter((c) => c.includes("--dport 25") && c.includes(" -I "))).toHaveLength(0)
    // Destroyed: its classes go with its network.
    host.commands.length = 0
    await fc.destroy({ handle: h })
    await until(() => !registry().vms[h])
    expect(host.commands).toContain(`tc class del dev fcifbu classid ${cls}`)
    expect(host.commands).toContain(`tc class del dev fcifbd classid ${cls}`)
  })

  it("at the daemon's start, the boxes from before get their share and lose port 25 — running, untouched; an allowed one gets it back", async () => {
    const [a, b] = ["sbx-n2", "sbx-n3"]
    veth(401)
    veth(402)
    host.smtpRules.clear()
    host.smtpRules.add("fc402")
    process.env.SPUNTO_FC_SMTP_ALLOW = "n3, other"
    try {
      writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { [a]: box(a, 401, { state: "running" }), [b]: box(b, 402, { state: "running" }) }, templates: {}, images: {}, builds: {} }))
      _test.restart()
      host.active.add(`spunto-fc-${a}`)
      host.active.add(`spunto-fc-${b}`)
      host.commands.length = 0
      await ensureHost()
    } finally {
      delete process.env.SPUNTO_FC_SMTP_ALLOW
    }
    expect(host.commands).toContain(`tc filter add dev fcv401 ingress pref 1 handle 1 matchall action skbedit priority ${netClassOf(401)} pipe action mirred egress redirect dev fcifbu`)
    expect(host.commands).toContain(`tc filter add dev fcv402 egress pref 1 handle 1 matchall action skbedit priority ${netClassOf(402)} pipe action mirred egress redirect dev fcifbd`)
    expect(host.smtpRules.has("fc401")).toBe(true)
    expect(host.smtpRules.has("fc402")).toBe(false)
    // Nothing stopped or started.
    expect(host.commands.some((c) => c.startsWith("systemd-run") || c.startsWith("systemctl stop"))).toBe(false)
    expect(host.active.has(`spunto-fc-${a}`) && host.active.has(`spunto-fc-${b}`)).toBe(true)
  })

  it("a machine without IFB runs its boxes unshaped — port 25 still closed", async () => {
    const h = "sbx-n7"
    host.failing = /type ifb/
    try {
      writeFileSync(join(STATE, "registry.json"), JSON.stringify({ vms: { [h]: box(h, 406) }, templates: {}, images: {}, builds: {} }))
      _test.restart()
      host.ifbs.clear()
      host.smtpRules.clear()
      await ensureHost()
      host.commands.length = 0
      await fc.start({ handle: h })
    } finally {
      host.failing = null
    }
    expect(registry().vms[h].state).toBe("running")
    expect(host.commands.some((c) => c.startsWith("tc "))).toBe(false)
    expect(host.smtpRules.has("fc406")).toBe(true)
  })

  it("grow stops at the machine's ceiling, SPUNTO_FC_MAX_ROOT_GB / SPUNTO_FC_MAX_WS_GB", async () => {
    const h = "sbx-n4"
    await fresh({ [h]: box(h, 403) })
    process.env.SPUNTO_FC_MAX_ROOT_GB = "80"
    process.env.SPUNTO_FC_MAX_WS_GB = "40"
    try {
      expect(maxDiskGb()).toEqual({ root: 80, ws: 40 })
      await expect(fc.grow({ handle: h, rootGb: 81 })).rejects.toThrow(/between 1 and 80/)
      await expect(fc.grow({ handle: h, workspaceGb: 41 })).rejects.toThrow(/between 1 and 40/)
      expect(await fc.grow({ handle: h, rootGb: 80, workspaceGb: 40 })).toMatchObject({ rootGb: 80, workspaceGb: 40 })
    } finally {
      delete process.env.SPUNTO_FC_MAX_ROOT_GB
      delete process.env.SPUNTO_FC_MAX_WS_GB
    }
    expect(maxDiskGb()).toEqual({ root: 200, ws: 500 })
  })

  it("each running box's usage, from the host: its unit's cgroup, its veth, its zvols in ZFS's kstats", async () => {
    const h = "sbx-n5"
    await fresh({ [h]: box(h, 404, { state: "running" }), "sbx-n6": box("sbx-n6", 405) })
    const cg = join(host.root, "cgroup", "vms.slice", `spunto-fc-${h}.service`)
    mkdirSync(cg, { recursive: true })
    writeFileSync(join(cg, "cpu.stat"), "usage_usec 1500000\nuser_usec 1000000\n")
    writeFileSync(join(cg, "memory.current"), `${3 * 1024 ** 3}\n`)
    writeFileSync(join(cg, "memory.peak"), `${4 * 1024 ** 3}\n`)
    writeFileSync(join(cg, "memory.stat"), `anon ${2 * 1024 ** 3}\nfile ${1024 ** 3}\nshmem 0\nfile_dirty 0\nfile_writeback 0\n`)
    veth(404)
    writeFileSync(join(host.root, "sysnet", "fcv404", "statistics", "rx_bytes"), "1000\n")
    writeFileSync(join(host.root, "sysnet", "fcv404", "statistics", "tx_bytes"), "5000\n")
    mkdirSync(join(host.root, "kstat"), { recursive: true })
    const kstat = (name: string, dataset: string, r: number, w: number) =>
      writeFileSync(join(host.root, "kstat", name), `26 1 0x01 24 6784 1 2\nname type data\ndataset_name 7 ${dataset}\nwrites 4 ${w}\nnwritten 4 ${w * 4096}\nreads 4 ${r}\nnread 4 ${r * 4096}\n`)
    kstat("objset-0x1", `default/spunto/vms/${h}-root`, 10, 2)
    kstat("objset-0x2", "default/spunto/ws/n5", 5, 1)
    kstat("objset-0x3", "default/spunto/images/abc", 99, 0)
    writeFileSync(join(host.root, "kstat", "iostats"), "nothing\n")
    const u = (await fc.usage()) as { boxes: Record<string, unknown> }
    expect(Object.keys(u.boxes)).toEqual([h])
    expect(u.boxes[h]).toEqual({
      cpuUsec: 1_500_000,
      memoryBytes: 3 * 1024 ** 3,
      memoryPeakBytes: 4 * 1024 ** 3,
      ramBytes: 2 * 1024 ** 3,
      netTxBytes: 1000,
      netRxBytes: 5000,
      diskReadBytes: 15 * 4096,
      diskWrittenBytes: 3 * 4096,
      diskReads: 15,
      diskWrites: 3,
    })
  })

  it("shaping, SMTP and the parsers", () => {
    expect(netShaping()).toMatchObject({ ceil: 200, total: 1000 })
    expect(netShaping(10_000)).toMatchObject({ ceil: 200, total: 9500 })
    process.env.SPUNTO_FC_NET_MBIT = "500"
    process.env.SPUNTO_FC_NET_TOTAL_MBIT = "300"
    // A ceiling above the total is the total.
    expect(netShaping(1000)).toMatchObject({ ceil: 300, total: 300 })
    expect(netShaping(1000).box("1:20")).toEqual(["parent", "1:1", "classid", "1:20", "htb", "rate", "1mbit", "ceil", "300mbit", "burst", "184k", "cburst", "184k", "quantum", "131072"])
    delete process.env.SPUNTO_FC_NET_MBIT
    delete process.env.SPUNTO_FC_NET_TOTAL_MBIT
    const show = "filter protocol all pref 1 matchall chain 0 handle 0x1 \n  not_in_hw\n\taction order 1: skbedit  priority 1:3f8 pipe\n\taction order 2: mirred (Egress Redirect to device fctstu) stolen\n"
    expect(redirectsTo(show, "1:3f8", "fctstu")).toBe(true)
    expect(redirectsTo(show, "1:3f", "fctstu")).toBe(false)
    expect(redirectsTo(show, "1:3f8", "fctstd")).toBe(false)
    expect(redirectsTo("", "1:3f8", "fctstu")).toBe(false)
    expect(netClassOf(0)).toBe("1:10")
    expect(netClassOf(16383)).toBe("1:400f")
    expect(smtpOpen("abc")).toBe(false)
    process.env.SPUNTO_FC_SMTP_ALLOW = "abc,def"
    expect([smtpOpen("abc"), smtpOpen("def"), smtpOpen("ab"), smtpOpen(undefined)]).toEqual([true, true, false, false])
    delete process.env.SPUNTO_FC_SMTP_ALLOW
    process.env.SPUNTO_FC_SMTP = "open"
    expect(smtpOpen(undefined)).toBe(true)
    delete process.env.SPUNTO_FC_SMTP
    expect(unitCgroups("Id=spunto-fc-a.service\nControlGroup=/vms.slice/spunto-fc-a.service\n\nId=spunto-fc-b.service\nControlGroup=\n")).toEqual(new Map([["spunto-fc-a", "/vms.slice/spunto-fc-a.service"]]))
    expect(objsetStats("name type data\ndataset_name 7 p/x\nwrites 4 3\nnwritten 4 12\nreads 4 1\nnread 4 4\n")).toEqual({ dataset: "p/x", reads: 1, nread: 4, writes: 3, nwritten: 12 })
    expect(objsetStats("name type data\n")).toBeUndefined()
  })
})
