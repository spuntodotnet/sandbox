import { execFileSync } from "node:child_process"
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { BALLOON, BuildLog, ConsoleTail, GUEST_INIT, GUEST_KERNEL, IMAGE_REF, UNPACK_INIT, _test, admitMibFor, buildRefOf, droppableCache, kernelArgs, memoryRoom, netOf, repositoryOf, uplinkAddresses } from "../src/engine"

describe("Firecracker backend", () => {
  it("gives every box its own /30, and never the same interface twice", () => {
    expect(netOf(0)).toEqual({ host: "10.89.0.1", ns: "10.89.0.2", hostIf: "fcv0", netns: "fc0" })
    expect(netOf(64)).toMatchObject({ host: "10.89.1.1", ns: "10.89.1.2", hostIf: "fcv64" })
    expect(netOf(16383).host).toBe("10.89.255.253")
  })

  it("reads the uplink's IPv4 addresses, whose published ports a box may reach", () => {
    const out = [
      "2: eno3    inet 51.255.95.20/24 metric 100 brd 51.255.95.255 scope global dynamic eno3\\       valid_lft 74011sec preferred_lft 74011sec",
      "2: eno3    inet 51.255.95.21/32 scope global eno3\\       valid_lft forever preferred_lft forever",
    ].join("\n")
    expect(uplinkAddresses(out)).toEqual(["51.255.95.20", "51.255.95.21"])
    expect(uplinkAddresses("")).toEqual([])
  })

  it("boots tini then the init, with the same guest address in every namespace", () => {
    const args = kernelArgs()
    expect(args).toContain("init=/.spunto/tini -- /.spunto/init")
    expect(args).toContain("ip=172.16.0.2::172.16.0.1:255.255.255.252::eth0:off")
  })

  it("does not zero freed pages unless asked: at boot that touched all of an xlarge's 16 GB", () => {
    const was = process.env.SPUNTO_FC_INIT_ON_FREE
    try {
      delete process.env.SPUNTO_FC_INIT_ON_FREE
      expect(kernelArgs()).not.toContain("init_on_free")
      process.env.SPUNTO_FC_INIT_ON_FREE = "0"
      expect(kernelArgs()).not.toContain("init_on_free")
      process.env.SPUNTO_FC_INIT_ON_FREE = "1"
      expect(kernelArgs()).toContain("init_on_free=1")
    } finally {
      if (was === undefined) delete process.env.SPUNTO_FC_INIT_ON_FREE
      else process.env.SPUNTO_FC_INIT_ON_FREE = was
    }
    // Free RAM leaves the memory files through the balloon instead, which never inflates.
    expect(BALLOON).toMatchObject({ amount_mib: 0, free_page_reporting: true })
  })

  it("admits a box on what the slice really has left, not on the RAM it announces", () => {
    const GIB = 1024 ** 3
    // An eighth of the box, 1 GiB at least.
    expect(admitMibFor(2048)).toBe(1024)
    expect(admitMibFor(16384)).toBe(2048)
    // 16 GB slice with 15.5 used, 1 GB of it droppable cache: 1.5 GB left.
    expect(memoryRoom({ sliceMax: 16 * GIB, sliceCurrent: 15.5 * GIB, droppable: GIB, hostAvailable: 20 * GIB })).toBe(1.5 * GIB)
    // The machine itself has less (its containers): that is the limit.
    expect(memoryRoom({ sliceMax: 16 * GIB, sliceCurrent: 0, hostAvailable: 3 * GIB })).toBe(3 * GIB)
    // No ceiling on the slice (`infinity`): the machine's.
    expect(memoryRoom({ sliceMax: undefined, hostAvailable: 5 * GIB })).toBe(5 * GIB)
  })

  it("counts every clean page of the cache as droppable, the active ones too", () => {
    const MIB = 1024 ** 2
    // The box on Canada (2026-10-16): 2.4 GB anon, 4.1 GB of its zvols' cache, 1.7 GB of it inactive.
    const stat = [`anon ${2436 * MIB}`, `file ${4134 * MIB}`, `shmem 0`, `file_dirty ${10 * MIB}`, `file_writeback ${4 * MIB}`, `active_file ${2466 * MIB}`, `inactive_file ${1667 * MIB}`].join("\n")
    expect(droppableCache(stat)).toBe(4120 * MIB)
    // shmem is a file by name only: never dropped without swap.
    expect(droppableCache(`file ${100 * MIB}\nshmem ${30 * MIB}\n`)).toBe(70 * MIB)
    // A kernel without `file`: its inactive cache, as before.
    expect(droppableCache(`anon 0\ninactive_file ${2 * MIB}\n`)).toBe(2 * MIB)
    expect(droppableCache("")).toBe(0)
  })

  it("ships an init that a POSIX shell parses", () => {
    const f = join(mkdtempSync(join(tmpdir(), "fc-")), "init")
    writeFileSync(f, GUEST_INIT)
    expect(() => execFileSync("sh", ["-n", f])).not.toThrow()
  })

  it("puts the env in MMDS as a sourced file, the token quoted, and a fresh generation each time", () => {
    const vm = { name: "My Box!", env: { SPUNTO_SANDBOX_TOKEN: "sbx_a'b", SPUNTO_API_URL: "https://x" }, bootstrap: "echo hi" } as never
    const a = _test.mmdsData(vm).spunto
    const b = _test.mmdsData(vm).spunto
    expect(a.generation).not.toBe(b.generation)
    expect(a.hostname).toBe("my-box-")
    expect(Buffer.from(a.env, "base64").toString()).toBe(`SPUNTO_SANDBOX_TOKEN='sbx_a'\\''b'\nSPUNTO_API_URL='https://x'\n`)
    expect(Buffer.from(a.bootstrap, "base64").toString()).toBe("echo hi")
  })

  it("names an image disk after the image and the init baked into it", () => {
    expect(_test.imageIdOf("a:1")).toMatch(/^[0-9a-f]{16}$/)
    expect(_test.imageIdOf("a:1")).not.toBe(_test.imageIdOf("a:2"))
  })

  it("takes the tag off a reference, not a registry's port", () => {
    expect(repositoryOf("ghcr.io/coderhammer/spunto-worker-base:latest")).toBe("ghcr.io/coderhammer/spunto-worker-base")
    expect(repositoryOf("localhost:5000/team/base:1.2")).toBe("localhost:5000/team/base")
    expect(repositoryOf("localhost:5000/team/base")).toBe("localhost:5000/team/base")
    expect(repositoryOf("ubuntu")).toBe("ubuntu")
  })

})

describe("Firecracker backend — builds and the unpacker", () => {
  it("reads the recipe's log between the builder's markers, without the VMM's or the kernel's lines, as it grows", () => {
    const f = join(mkdtempSync(join(tmpdir(), "fc-")), "console.log")
    writeFileSync(
      f,
      [
        "[    0.07] PCI: Fatal: No config space access function found",
        "2026-10-10T20:13:08.759883196 [anonymous-instance:fc_vcpu 0] vcpu: IO write failed",
        "[spunto-init] bootstrap started",
        "::spunto-fc:build:start",
        "::spunto:step:start:apt",
        "Get:1 http://archive.ubuntu.com noble InRelease",
        "::spunto:step:end:apt",
        "half a li",
      ].join("\r\n"),
    )
    const l = new BuildLog(f)
    // Still running: the line being written waits for its newline.
    expect(l.read(false)).toMatchObject({ log: "::spunto:step:start:apt\nGet:1 http://archive.ubuntu.com noble InRelease\n::spunto:step:end:apt\n", exit: undefined })
    appendFileSync(f, "ne\r\n::spunto-fc:build:exit:3\r\n")
    expect(l.read(true)).toMatchObject({ exit: 3, log: expect.stringMatching(/half a line\n$/) })
    // Read from the start again (a restarted daemon): the same text, so the platform's cursor holds.
    expect(new BuildLog(f).read(true).log).toBe(l.log)
    expect(new BuildLog(join(f, "..", "nothing")).read(true)).toMatchObject({ log: "", exit: undefined })
  })

  it("finds the exit status of a recipe whose log is far over what is kept — a talkative build that worked", () => {
    const f = join(mkdtempSync(join(tmpdir(), "fc-")), "console.log")
    const line = `${"x".repeat(99)}\r\n`
    writeFileSync(f, `::spunto-fc:build:start\r\n${line.repeat(100_000)}::spunto-fc:build:exit:0\r\n`) // ~10 MB
    const l = new BuildLog(f, 8 * 1024 * 1024).read(true)
    expect(l.exit).toBe(0)
    expect(l.log.length).toBeLessThanOrEqual(8 * 1024 * 1024 + 200)
    expect(l.log).toMatch(/the rest of the recipe's log is not kept \(over 8 MB\)\n$/)
  })

  it("strips CR and the noise from a console, and holds back an unfinished line", () => {
    const f = join(mkdtempSync(join(tmpdir(), "fc-")), "console.log")
    writeFileSync(f, "[    1.0] kernel\r\n[spunto-init] bootstrap started\r\nhello\r\nwor")
    const t = new ConsoleTail(f)
    expect(t.read()).toEqual(["hello"])
    appendFileSync(f, "ld\r\n")
    expect(t.read()).toEqual(["world"])
    expect(t.read(true)).toEqual([])
  })

  it("boots the unpacker read-only on its own init, the image as its argument", () => {
    const args = kernelArgs({ init: "/init", readOnly: true, args: ["mcr.microsoft.com/devcontainers/base:ubuntu"] })
    expect(args).toContain(" ro ")
    expect(args).toMatch(/init=\/init -- mcr\.microsoft\.com\/devcontainers\/base:ubuntu$/)
    const f = join(mkdtempSync(join(tmpdir(), "fc-")), "init")
    writeFileSync(f, UNPACK_INIT)
    expect(() => execFileSync("sh", ["-n", f])).not.toThrow()
  })

  it("takes only image references that cannot add to a kernel command line", () => {
    for (const ok of ["node:24", "ghcr.io/a/b@sha256:0123abcd", "mcr.microsoft.com/devcontainers/typescript-node:1-24-bookworm"]) expect(IMAGE_REF.test(ok)).toBe(true)
    for (const bad of ["a b", "x init=/bin/sh", "-x", "a\nb", ""]) expect(IMAGE_REF.test(bad)).toBe(false)
  })

  it("tells the box a load of its own RAM is a reconnect, never a clone or a boot", () => {
    const vm = { name: "b", env: { SPUNTO_SANDBOX_TOKEN: "sbx_a" }, bootstrap: "true" } as never
    expect(_test.mmdsData(vm, { resume: true }).spunto.resume).toBe("reconnect")
    expect(_test.mmdsData(vm).spunto).not.toHaveProperty("resume")
  })

  it("gives a build a ref of its own, the same for the same build id", () => {
    expect(buildRefOf("AbC_123")).toBe("bld-abc-123")
  })
})


describe("the guest kernel", () => {
  it("pins what kernel/ builds: its version and its sha256", () => {
    const dir = join(__dirname, "../kernel")
    const version = readFileSync(join(dir, "VERSION"), "utf8")
    const v = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(version)![1]
    expect(GUEST_KERNEL.version).toBe(`${v("LINUX_VERSION")}-${v("SPUNTO_REVISION")}`)
    expect(readFileSync(join(dir, "vmlinux.sha256"), "utf8").split(/\s+/)[0]).toBe(GUEST_KERNEL.sha256)
  })
})

describe("what is baked into every image's disk", () => {
  // An image's disk is keyed by the image and these two scripts (`imageIdOf`): a change to either
  // makes every machine unpack every image again at its next box (minutes each). Changing them is
  // allowed — on purpose, with this hash updated in the same commit, and said in the changelog.
  it("keeps the guest's init and the unpacker's byte for byte", () => {
    const { createHash } = require("node:crypto") as typeof import("node:crypto")
    expect(createHash("sha256").update(`${GUEST_INIT}\n${UNPACK_INIT}`).digest("hex")).toBe("ec384eb9fec57f285c8652be6ed260bd4eb5e8e4a8c86c1f281548698e7e0cfb")
  })
})

describe("what the guest reads from MMDS", () => {
  const vm = { handle: "sbx-a", name: "a", env: { SPUNTO_SANDBOX_TOKEN: "t" }, bootstrap: "true" } as never
  it("holds `spunto` alone unless the caller adds to it", async () => {
    expect(Object.keys(_test.mmdsData(vm))).toEqual(["spunto"])
  })
  it("adds the caller's data under `sandbox`, saying whether the box boots or loads its RAM", async () => {
    const { setGuestData } = await import("../src/engine")
    const seen: string[] = []
    setGuestData((at) => (seen.push(at), { agent: at === "boot" ? "blob" : "" }))
    try {
      expect(_test.mmdsData(vm).sandbox).toEqual({ agent: "blob" })
      expect(_test.mmdsData(vm, { resume: true }).sandbox).toEqual({ agent: "" })
      _test.mmdsData(vm, { reidentify: true })
      expect(seen).toEqual(["boot", "load", "load"])
    } finally {
      setGuestData(undefined)
    }
  })
})
