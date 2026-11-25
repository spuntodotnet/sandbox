/**
 * @spunto/sandbox — the TypeScript SDK of Spunto Sandbox: microVMs on your own machine, from Node.
 *
 *   import { Sandbox } from "@spunto/sandbox"
 *   const box = await Sandbox.create({ image: "node:24" })
 *   const { stdout } = await box.exec("node -v")
 *   await box.pause()             // RAM kept, nothing running
 *   await box.resume()            // same processes, back in milliseconds
 *   const copy = await box.fork() // a second box, same memory
 *
 * It talks to the daemon (`spunto-sandboxd`) on its unix socket — `/run/spunto-sandbox.sock`, which
 * root and the `spunto-sandbox` group may use — or over TCP: `SBX_HOST=http://host:7070` and
 * `SBX_TOKEN`. Node 22 or later.
 */

import http, { type IncomingMessage } from "node:http"
import https from "node:https"
import { Duplex } from "node:stream"
import { frame, FrameReader, json, T, type Exit, type Hello } from "../protocol"

export type { Exit, Hello } from "../protocol"

export type ClientOptions = {
  /** `unix:///run/spunto-sandbox.sock` (the default), or `http(s)://host:port`. */
  host?: string
  /** For a TCP host: the daemon's `SBX_API_TOKEN`. */
  token?: string
}

export class SandboxApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
  }
}

export type SandboxInfo = {
  id: string
  name: string
  image: string
  size: string
  handle: string
  state: "creating" | "running" | "stopped" | "missing" | "error"
  detail?: string
  transition?: "pausing" | "stopping"
  ram?: "saved" | "none"
  /** Names only: values never leave the daemon. */
  env: Record<string, string>
  labels?: Record<string, string>
  from?: string
  createdAt: string
  timings?: Record<string, number>
  /** How long the call took, on the daemon (start, pause, stop, fork). */
  tookMs?: number
  /** A fork: how long its source was paused. */
  pauseMs?: number
}

export type SnapshotInfo = { id: string; name?: string; sandboxId: string; image: string; size: string; kind: "memory" | "disks"; state: "pending" | "ready" | "error"; detail?: string; createdAt: string }

export type CreateOptions = {
  /** Any OCI image: `ubuntu:24.04`, `node:24`, `ghcr.io/you/image@sha256:…`. Not needed with `from`. */
  image?: string
  name?: string
  /** `small` (1 vCPU, 2 GB), `default` (2, 4), `large` (4, 8), `xlarge` (8, 16). */
  size?: string
  env?: Record<string, string>
  labels?: Record<string, string>
  /** A snapshot (id or name) or a build to start from. */
  from?: string
}

export type ExecOptions = {
  env?: Record<string, string>
  /** `/workspace` by default (the box's persistent volume). */
  cwd?: string
  /** A user of the box's /etc/passwd; root by default. */
  user?: string
  /** What the command reads on its stdin. */
  stdin?: string
  /** Killed (SIGKILL) after this long. */
  timeoutMs?: number
}

export type ExecResult = { exitCode: number; signal?: string; stdout: string; stderr: string; truncated?: boolean; durationMs: number }

function defaults(): Required<Pick<ClientOptions, "host">> & ClientOptions {
  return { host: process.env.SBX_HOST || "unix:///run/spunto-sandbox.sock", token: process.env.SBX_TOKEN }
}

/** The daemon's API, as calls. One per daemon; `Sandbox` uses a default one (`SBX_HOST`, `SBX_TOKEN`). */
export class SandboxClient {
  readonly host: string
  private readonly token?: string
  constructor(opts: ClientOptions = {}) {
    const d = defaults()
    this.host = opts.host ?? d.host
    this.token = opts.token ?? d.token
  }

  private target(path: string): http.RequestOptions & { lib: typeof http | typeof https } {
    // No keep-alive on the socket: a script that is done exits at once (a connection costs nothing there).
    if (this.host.startsWith("unix://")) return { lib: http, socketPath: this.host.slice("unix://".length), path, agent: false }
    const u = new URL(this.host)
    return { lib: u.protocol === "https:" ? https : http, hostname: u.hostname, port: u.port, path: `${u.pathname.replace(/\/$/, "")}${path}` }
  }

  private headers(extra: Record<string, string> = {}) {
    return { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...extra }
  }

  /** The raw response of a call (a file being read, a log). */
  raw(method: string, path: string, body?: Buffer | string | NodeJS.ReadableStream, headers: Record<string, string> = {}): Promise<IncomingMessage> {
    const { lib, ...opts } = this.target(path)
    return new Promise((resolve, reject) => {
      const req = lib.request({ ...opts, method, headers: this.headers(headers) }, resolve)
      req.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT" || err.code === "ECONNREFUSED") reject(new SandboxApiError(`spunto-sandboxd is not running at ${this.host} (systemctl status spunto-sandboxd)`, 0, "unreachable"))
        else if (err.code === "EACCES") reject(new SandboxApiError(`not allowed to use ${this.host}: run as root, or join the spunto-sandbox group`, 0, "forbidden"))
        else reject(err)
      })
      if (body && typeof body === "object" && "pipe" in body) (body as NodeJS.ReadableStream).pipe(req)
      else req.end(body)
    })
  }

  async call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body === undefined ? undefined : JSON.stringify(body), body === undefined ? {} : { "Content-Type": "application/json" })
    const chunks: Buffer[] = []
    for await (const c of res) chunks.push(c as Buffer)
    const text = Buffer.concat(chunks).toString("utf8")
    let parsed: any
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      parsed = text
    }
    if ((res.statusCode ?? 500) >= 300) {
      const e = parsed?.error
      throw new SandboxApiError(e?.message ?? `HTTP ${res.statusCode}`, res.statusCode ?? 500, e?.code ?? "error")
    }
    return parsed as T
  }

  /**
   * A stream to a box's guest agent (an upgraded connection): its hello sent, frames both ways.
   * What `Sandbox.spawn`, `shell` and `connect` are made of.
   */
  attach(id: string, hello: Hello): Promise<Duplex> {
    const { lib, ...opts } = this.target(`/v1/sandboxes/${encodeURIComponent(id)}/attach`)
    return new Promise((resolve, reject) => {
      const req = lib.request({ ...opts, method: "POST", headers: this.headers({ Connection: "Upgrade", Upgrade: "sbx-agent/1" }) })
      req.on("upgrade", (_res, socket, head) => {
        if (head.length) socket.unshift(head)
        socket.write(frame(T.hello, hello))
        resolve(socket)
      })
      req.on("response", async (res) => {
        const chunks: Buffer[] = []
        for await (const c of res) chunks.push(c as Buffer)
        let msg = `HTTP ${res.statusCode}`
        try {
          msg = JSON.parse(Buffer.concat(chunks).toString()).error.message
        } catch {}
        reject(new SandboxApiError(msg, res.statusCode ?? 500, "attach"))
      })
      req.on("error", reject)
      req.end()
    })
  }
}

let shared: SandboxClient | null = null
const client = (c?: SandboxClient) => c ?? (shared ??= new SandboxClient())
const path = (id: string, rest = "") => `/v1/sandboxes/${encodeURIComponent(id)}${rest}`

/** A process running in a box, streamed: `stdout`/`stderr` events, `write` to its stdin, `wait()` for its exit. */
export class SandboxProcess {
  private readonly listeners = { stdout: [] as ((b: Buffer) => void)[], stderr: [] as ((b: Buffer) => void)[] }
  readonly exited: Promise<Exit>
  pid?: number
  constructor(private readonly stream: Duplex) {
    const reader = new FrameReader()
    this.exited = new Promise((resolve, reject) => {
      let done = false
      stream.on("data", (c: Buffer) => {
        for (const f of reader.push(c)) {
          if (f.type === T.ready) this.pid = json(f.payload).pid
          else if (f.type === T.stdout) this.listeners.stdout.forEach((l) => l(f.payload))
          else if (f.type === T.stderr) this.listeners.stderr.forEach((l) => l(f.payload))
          else if (f.type === T.exit) ((done = true), resolve(json(f.payload)), stream.destroy())
          else if (f.type === T.error) ((done = true), reject(new Error(json(f.payload).message)), stream.destroy())
        }
      })
      stream.on("close", () => done || reject(new Error("the connection to the sandbox closed before the process ended")))
      stream.on("error", (err) => done || ((done = true), reject(err)))
    })
    this.exited.catch(() => {})
  }
  on(event: "stdout" | "stderr", fn: (b: Buffer) => void) {
    this.listeners[event].push(fn)
    return this
  }
  write(data: string | Buffer) {
    this.stream.write(frame(T.data, Buffer.isBuffer(data) ? data : Buffer.from(data)))
  }
  /** The end of its stdin. */
  end() {
    this.stream.write(frame(T.close))
  }
  resize(rows: number, cols: number) {
    this.stream.write(frame(T.resize, { rows, cols }))
  }
  kill(signal = "SIGTERM") {
    this.stream.write(frame(T.signal, { signal }))
  }
  wait() {
    return this.exited
  }
}

/** A sandbox: a microVM on the daemon's machine. */
export class Sandbox {
  private constructor(
    public info: SandboxInfo,
    private readonly c: SandboxClient,
  ) {}

  get id() {
    return this.info.id
  }
  get name() {
    return this.info.name
  }
  get state() {
    return this.info.state
  }

  /** A new box, once it runs and its agent answers: seconds, the first pull of an image aside. */
  static async create(opts: CreateOptions & { client?: SandboxClient }): Promise<Sandbox> {
    const { client: given, ...body } = opts
    const c = client(given)
    return new Sandbox(await c.call<SandboxInfo>("POST", "/v1/sandboxes", body), c)
  }
  static async get(idOrName: string, opts: { client?: SandboxClient } = {}): Promise<Sandbox> {
    const c = client(opts.client)
    return new Sandbox(await c.call<SandboxInfo>("GET", path(idOrName)), c)
  }
  static async list(opts: { client?: SandboxClient } = {}): Promise<Sandbox[]> {
    const c = client(opts.client)
    return (await c.call<SandboxInfo[]>("GET", "/v1/sandboxes")).map((i) => new Sandbox(i, c))
  }

  /** Read its state again. */
  async refresh() {
    this.info = await this.c.call<SandboxInfo>("GET", path(this.id))
    return this
  }

  /** Run a command and wait for it: a string goes to `/bin/sh -c`, an array is run as it is. */
  async exec(cmd: string | string[], opts: ExecOptions = {}): Promise<ExecResult> {
    return this.c.call<ExecResult>("POST", path(this.id, "/exec"), { cmd, ...opts })
  }

  /** Start a command that outlives the call (a server, a watcher): its output in `log`, inside the box. */
  async background(cmd: string | string[], opts: Omit<ExecOptions, "stdin" | "timeoutMs"> = {}): Promise<{ pid: number; log: string }> {
    const r = await this.c.call<{ pid: number; log: string }>("POST", path(this.id, "/exec"), { cmd, ...opts, detach: true })
    return { pid: r.pid, log: r.log }
  }

  /** Run a command, streamed: its output as it comes, its stdin yours. `tty` for a terminal of that size. */
  async spawn(cmd: string | string[], opts: Omit<ExecOptions, "stdin" | "timeoutMs"> & { tty?: { rows: number; cols: number } } = {}): Promise<SandboxProcess> {
    const argv = typeof cmd === "string" ? ["/bin/sh", "-c", cmd] : cmd
    return new SandboxProcess(await this.c.attach(this.id, { op: "exec", cmd: argv, ...opts }))
  }

  /** A TCP connection to a port inside the box (its 127.0.0.1 by default): a duplex of its bytes. */
  async connect(port: number, host?: string): Promise<Duplex> {
    const s = await this.c.attach(this.id, { op: "connect", port, ...(host ? { host } : {}) })
    const reader = new FrameReader()
    let ready: () => void
    let failed: (e: Error) => void
    const opened = new Promise<void>((res, rej) => ((ready = res), (failed = rej)))
    const d = new Duplex({
      read() {},
      write(chunk, _e, cb) {
        s.write(frame(T.data, chunk), cb)
      },
      final(cb) {
        if (s.writableEnded || s.destroyed) return cb()
        s.write(frame(T.close), () => cb())
      },
      destroy(err, cb) {
        s.destroy()
        cb(err)
      },
    })
    s.on("data", (c: Buffer) => {
      for (const f of reader.push(c)) {
        if (f.type === T.ready) ready()
        else if (f.type === T.stdout) d.push(f.payload)
        else if (f.type === T.exit) (d.push(null), s.destroy())
        else if (f.type === T.error) {
          const e = new Error(json(f.payload).message)
          failed(e)
          d.destroy(e)
        }
      }
    })
    s.on("close", () => d.push(null))
    await opened
    return d
  }

  readonly files = {
    read: async (p: string): Promise<Buffer> => {
      const res = await this.c.raw("GET", `${path(this.id, "/files")}?path=${encodeURIComponent(p)}`)
      const chunks: Buffer[] = []
      for await (const ch of res) chunks.push(ch as Buffer)
      const body = Buffer.concat(chunks)
      if ((res.statusCode ?? 500) >= 300) throw new SandboxApiError(JSON.parse(body.toString()).error.message, res.statusCode ?? 500, "files")
      return body
    },
    write: async (p: string, data: string | Buffer | NodeJS.ReadableStream, opts: { mode?: string } = {}): Promise<{ bytes: number }> => {
      const q = `?path=${encodeURIComponent(p)}${opts.mode ? `&mode=${opts.mode}` : ""}`
      const res = await this.c.raw("PUT", `${path(this.id, "/files")}${q}`, typeof data === "string" ? Buffer.from(data) : data)
      const chunks: Buffer[] = []
      for await (const ch of res) chunks.push(ch as Buffer)
      const out = JSON.parse(Buffer.concat(chunks).toString())
      if ((res.statusCode ?? 500) >= 300) throw new SandboxApiError(out.error.message, res.statusCode ?? 500, "files")
      return { bytes: out.bytes }
    },
  }

  private async act(op: string, body?: unknown, wait = true) {
    this.info = await this.c.call<SandboxInfo>("POST", `${path(this.id, `/${op}`)}${wait ? "" : "?wait=false"}`, body ?? {})
    return this
  }
  /** Stop it keeping its memory: nothing runs, a `resume` brings every process back where it was. */
  pause(opts: { wait?: boolean } = {}) {
    return this.act("pause", undefined, opts.wait !== false)
  }
  /** Run it again: its RAM loaded after a pause, its disk booted after a stop. */
  resume() {
    return this.act("resume")
  }
  start() {
    return this.act("start")
  }
  /** Stop it, its disks kept and its memory dropped (a clean shutdown): a `start` boots it. */
  stop(opts: { wait?: boolean } = {}) {
    return this.act("stop", undefined, opts.wait !== false)
  }
  /** A second box with this one's memory and disks, as of now: same processes, its own identity. */
  async fork(opts: { name?: string } = {}): Promise<Sandbox> {
    return new Sandbox(await this.c.call<SandboxInfo>("POST", path(this.id, "/fork"), opts), this.c)
  }
  /** Keep this box as it is now, to start others from (`Sandbox.create({ from })`). `memory: false`: disks only, they boot. */
  async snapshot(opts: { name?: string; memory?: boolean } = {}): Promise<SnapshotInfo> {
    return this.c.call<SnapshotInfo>("POST", path(this.id, "/snapshots"), opts)
  }
  /** Grow its disks (never shrink), running or not. */
  async grow(opts: { rootGb?: number; workspaceGb?: number }) {
    return this.c.call("POST", path(this.id, "/grow"), opts)
  }
  /** Its serial console: the kernel, the init, the bootstrap. */
  async logs(lines = 200): Promise<string> {
    const res = await this.c.raw("GET", `${path(this.id, "/logs")}?lines=${lines}`)
    const chunks: Buffer[] = []
    for await (const ch of res) chunks.push(ch as Buffer)
    return Buffer.concat(chunks).toString()
  }
  /** What it uses, as the host measures it: CPU time, memory, network and disk counters. */
  async usage() {
    return this.c.call("GET", path(this.id, "/usage"))
  }
  async destroy() {
    await this.c.call("DELETE", path(this.id))
  }
}

export const snapshots = {
  list: (c?: SandboxClient) => client(c).call<SnapshotInfo[]>("GET", "/v1/snapshots"),
  get: (id: string, c?: SandboxClient) => client(c).call<SnapshotInfo>("GET", `/v1/snapshots/${encodeURIComponent(id)}`),
  delete: (id: string, c?: SandboxClient) => client(c).call("DELETE", `/v1/snapshots/${encodeURIComponent(id)}`),
}
