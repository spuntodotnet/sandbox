/**
 * The guest agent (guest/main.go), run here on 127.0.0.1 as the daemon would reach it in a box,
 * driven with the daemon's own protocol code. Needs the binary (`npm run build`, or Go): skipped without.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { frame, request, T, type Hello } from "../src/protocol"

const BIN = join(__dirname, "../dist/sbx-agent")
const have = existsSync(BIN)
let agent: ChildProcess
let port = 0
const dir = mkdtempSync(join(tmpdir(), "sbx-agent-"))
const envFile = join(dir, "env")

beforeAll(async () => {
  if (!have) return
  writeFileSync(envFile, "SPUNTO_SANDBOX_TOKEN='tok-1'\n")
  agent = spawn(BIN, ["serve", "agent.mjs"], {
    env: { PATH: process.env.PATH, SPUNTO_SANDBOX_TOKEN: "tok-1", SBX_AGENT_LISTEN: "127.0.0.1:0", SPUNTO_AGENT_ENV_FILE: envFile, SPUNTO_AGENT_PIDFILE: join(dir, "pid"), SPUNTO_AGENT_SIGNALS_FILE: join(dir, "signals"), FROM_BOX: "yes", SBX_AGENT_LOG_DIR: join(dir, "log") },
    stdio: ["ignore", "ignore", "pipe"],
  })
  port = await new Promise<number>((resolve) => {
    agent.stderr!.on("data", (c: Buffer) => {
      const m = /listening on 127\.0\.0\.1:(\d+)/.exec(c.toString())
      if (m) resolve(Number(m[1]))
    })
  })
})
afterAll(() => agent?.kill())

const dial = () => net.connect(port, "127.0.0.1")
async function run(hello: Hello, opts: { stdin?: string; token?: string } = {}) {
  const s = dial()
  let out = ""
  let err = ""
  const exit = await request(s, { ...hello, token: opts.token ?? "tok-1" } as Hello, {
    ready: () => {
      if (opts.stdin !== undefined) s.write(frame(T.data, opts.stdin))
      s.write(frame(T.close))
    },
    stdout: (b) => (out += b),
    stderr: (b) => (err += b),
  })
  s.destroy()
  return { exit, out, err }
}

describe.skipIf(!have)("the guest agent", () => {
  it("says what the init needs to signal it: its pid, and that a fork's copy may keep it", () => {
    expect(readFileSync(join(dir, "pid"), "utf8")).toBe(String(agent.pid))
    expect(readFileSync(join(dir, "signals"), "utf8")).toMatch(/\bREIDENTIFY\b/)
  })

  it("runs a command: stdout and stderr apart, its exit code, the box's env without the token", async () => {
    const r = await run({ op: "exec", cmd: ["/bin/sh", "-c", 'echo out; echo err >&2; echo "$FROM_BOX:${SPUNTO_SANDBOX_TOKEN:-none}:$X"; exit 7'], env: { X: "given" }, cwd: "/" })
    expect(r).toMatchObject({ out: "out\nyes:none:given\n", err: "err\n", exit: { code: 7 } })
  })

  it("feeds stdin and its end", async () => {
    expect((await run({ op: "exec", cmd: ["sh", "-c", "tr a-z A-Z"], cwd: "/" }, { stdin: "hello" })).out).toBe("HELLO")
  })

  it("refuses another box's token", async () => {
    await expect(run({ op: "info" }, { token: "nope" })).rejects.toThrow(/not this box's token/)
  })

  it("gives a terminal: a tty, its size", async () => {
    const r = await run({ op: "exec", cmd: ["sh", "-c", "test -t 0 && stty size"], tty: { rows: 33, cols: 101 }, cwd: "/" })
    expect(r.exit.code).toBe(0)
    expect(r.out).toContain("33 101")
  })

  it("writes then reads a file, its mode kept", async () => {
    const p = join(dir, "sub/dir/f.txt")
    const s = dial()
    const w = await request(s, { op: "write", path: p, mode: "750", token: "tok-1" }, { ready: () => (s.write(frame(T.data, "abc")), s.write(frame(T.data, "def")), s.write(frame(T.close))) })
    expect(w).toMatchObject({ code: 0, bytes: 6 })
    expect(execFileSync("stat", ["-c", "%a", p]).toString().trim()).toBe("750")
    expect((await run({ op: "read", path: p })).out).toBe("abcdef")
  })

  it("reaches a port of the box", async () => {
    const srv = net.createServer((c) => c.end("pong"))
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r))
    const r = await run({ op: "connect", port: (srv.address() as net.AddressInfo).port })
    expect(r.out).toBe("pong")
    srv.close()
  })

  it("starts a detached command that outlives the call, its output in a log", async () => {
    const r = await run({ op: "exec", cmd: ["sh", "-c", "sleep 0.2; echo bg"], detach: true, cwd: "/" })
    expect(r.exit).toMatchObject({ code: 0, pid: expect.any(Number), log: expect.stringMatching(/\/log\/\d+\.log$/) })
    // A loaded runner is slow: up to 5 s for it to write.
    for (let i = 0; i < 50 && readFileSync(r.exit.log!, "utf8") === ""; i++) await new Promise((res) => setTimeout(res, 100))
    expect(readFileSync(r.exit.log!, "utf8")).toBe("bg\n")
  })

  it("takes a fork's new token when the init signals it", async () => {
    writeFileSync(envFile, "SPUNTO_SANDBOX_TOKEN='tok-2'\n")
    process.kill(agent.pid!, "SIGUSR2")
    await new Promise((r) => setTimeout(r, 100))
    await expect(run({ op: "info" })).rejects.toThrow(/not this box's token/)
    expect((await run({ op: "info" }, { token: "tok-2" })).exit).toMatchObject({ code: 0 })
  })

  it("answers no one but the host: a process of the box itself has its token too (MMDS)", async () => {
    const other = spawn(BIN, ["serve", "agent.mjs"], {
      env: { PATH: process.env.PATH, SPUNTO_SANDBOX_TOKEN: "tok-1", SBX_AGENT_LISTEN: "127.0.0.1:0", SBX_AGENT_PEER: "127.0.0.2", SPUNTO_AGENT_ENV_FILE: envFile, SPUNTO_AGENT_PIDFILE: join(dir, "pid2"), SPUNTO_AGENT_SIGNALS_FILE: join(dir, "signals2"), SBX_AGENT_LOG_DIR: join(dir, "log2") },
      stdio: ["ignore", "ignore", "pipe"],
    })
    try {
      const p = await new Promise<number>((resolve) => other.stderr!.on("data", (c: Buffer) => { const m = /listening on 127\.0\.0\.1:(\d+)/.exec(c.toString()); if (m) resolve(Number(m[1])) }))
      await expect(request(net.connect(p, "127.0.0.1"), { op: "info", token: readFileSync(envFile, "utf8").match(/'(.*)'/)![1]! })).rejects.toThrow(/closed before the end|ECONNRESET/)
    } finally {
      other.kill()
    }
  })
})
