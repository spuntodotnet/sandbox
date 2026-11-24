/**
 * The daemon's REST API (openapi.yaml): JSON in, JSON out, on a unix socket — and on TCP behind a
 * bearer token when asked. Streams (an interactive exec, a shell, a port) go over an upgraded
 * connection, `POST /v1/sandboxes/{id}/attach` with `Upgrade: sbx-agent/1`, which then carries the
 * guest agent's own frames: the daemon only fills in the box's token.
 */

import http, { type IncomingMessage, type ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import { timingSafeEqual } from "node:crypto"
import { once } from "node:events"
import { engine, firecrackerHostInfo, SandboxError } from "../engine"
import { frame, FrameReader, json, T, type Hello } from "../protocol"
import { agentRequest, dialAgent } from "./agent"
import { API_TOKEN, DAEMON_VERSION } from "./config"
import { loadAgent } from "./guest"
import * as svc from "./service"
import { db, newId, persist, tokenOf } from "./store"

type Ctx = { req: IncomingMessage; res: ServerResponse; url: URL; params: string[] }
type Route = [method: string, pattern: RegExp, fn: (c: Ctx) => Promise<unknown>]

const STATUS: Record<string, number> = { not_found: 404, invalid: 400, capacity: 409, upstream: 502 }

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function body<T = any>(req: IncomingMessage, max = 8 * 1024 * 1024): Promise<T> {
  const chunks: Buffer[] = []
  let n = 0
  for await (const c of req) {
    n += (c as Buffer).length
    if (n > max) throw new HttpError(413, "request body too large")
    chunks.push(c as Buffer)
  }
  if (!n) return {} as T
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T
  } catch {
    throw new HttpError(400, "the body is not JSON")
  }
}

const wantWait = (url: URL) => url.searchParams.get("wait") !== "false"

const routes: Route[] = [
  ["GET", /^\/v1\/health$/, async () => ({ ok: true, version: DAEMON_VERSION, agent: loadAgent()?.version ?? null })],
  ["GET", /^\/v1\/host$/, async () => ({ version: DAEMON_VERSION, agent: loadAgent()?.version ?? null, ...(await firecrackerHostInfo()) })],
  ["GET", /^\/v1\/sizes$/, async () => engine.sizes()],

  ["GET", /^\/v1\/sandboxes$/, async () => svc.list()],
  ["POST", /^\/v1\/sandboxes$/, async ({ req }) => svc.create(await body(req))],
  ["GET", /^\/v1\/sandboxes\/([^/]+)$/, async ({ params }) => svc.view(svc.find(params[0]!))],
  ["DELETE", /^\/v1\/sandboxes\/([^/]+)$/, async ({ params }) => (await svc.destroy(params[0]!), { ok: true })],
  [
    "POST",
    /^\/v1\/sandboxes\/([^/]+)\/(start|resume)$/,
    async ({ params, url }) => {
      const r = svc.find(params[0]!)
      const t0 = performance.now()
      await engine.start({ handle: svc.handleOf(r.id) })
      const v = wantWait(url) ? await svc.waitRunning(r, 120_000) : await svc.view(r)
      return { ...v, tookMs: Math.round(performance.now() - t0) }
    },
  ],
  ["POST", /^\/v1\/sandboxes\/([^/]+)\/stop$/, async ({ params, url }) => stopOrPause(params[0]!, "stop", wantWait(url))],
  ["POST", /^\/v1\/sandboxes\/([^/]+)\/pause$/, async ({ params, url }) => stopOrPause(params[0]!, "pause", wantWait(url))],
  [
    "POST",
    /^\/v1\/sandboxes\/([^/]+)\/fork$/,
    async ({ params, req, url }) => {
      const t0 = performance.now()
      const v = await svc.fork(params[0]!, { ...(await body(req)), wait: wantWait(url) })
      return { ...v, tookMs: Math.round(performance.now() - t0) }
    },
  ],
  ["POST", /^\/v1\/sandboxes\/([^/]+)\/snapshots$/, async ({ params, req }) => svc.snapshot(params[0]!, await body(req))],
  ["POST", /^\/v1\/sandboxes\/([^/]+)\/exec$/, async ({ params, req }) => svc.exec(params[0]!, await body(req))],
  [
    "POST",
    /^\/v1\/sandboxes\/([^/]+)\/grow$/,
    async ({ params, req }) => {
      const r = svc.find(params[0]!)
      const b = await body<{ rootGb?: number; workspaceGb?: number }>(req)
      const grown = await engine.grow({ handle: svc.handleOf(r.id), rootGb: b.rootGb, workspaceGb: b.workspaceGb })
      // The engine grew the disks; the filesystems follow from inside, now (the init does it too, at the next boot).
      if (grown.resizeInGuest) await svc.exec(r.id, { cmd: "true" }).catch(() => {})
      return grown
    },
  ],
  ["GET", /^\/v1\/sandboxes\/([^/]+)\/logs$/, async ({ params, url, res }) => text(res, await svc.logs(params[0]!, Number(url.searchParams.get("lines") ?? 200)))],
  [
    "GET",
    /^\/v1\/sandboxes\/([^/]+)\/usage$/,
    async ({ params }) => {
      const r = svc.find(params[0]!)
      const u = await engine.usage()
      return { at: u.at, ...((u.boxes[svc.handleOf(r.id)] as object) ?? {}) }
    },
  ],
  ["GET", /^\/v1\/sandboxes\/([^/]+)\/files$/, async (c) => readFile(c)],
  ["PUT", /^\/v1\/sandboxes\/([^/]+)\/files$/, async (c) => writeFile(c)],

  ["GET", /^\/v1\/snapshots$/, async () => Promise.all(Object.values(db().snapshots).map(svc.snapshotView))],
  ["GET", /^\/v1\/snapshots\/([^/]+)$/, async ({ params }) => svc.snapshotView(svc.findSnapshot(params[0]!))],
  ["DELETE", /^\/v1\/snapshots\/([^/]+)$/, async ({ params }) => (await svc.deleteSnapshot(params[0]!), { ok: true })],

  [
    "POST",
    /^\/v1\/builds$/,
    async ({ req }) => {
      const b = await body<{ image?: string; script?: string; size?: string }>(req)
      if (!b.image || !b.script) throw new SandboxError("an image and a script, please", "invalid")
      const id = newId("bld-")
      const started = await engine.build({ buildId: id, image: b.image, script: b.script, size: b.size })
      db().builds[id] = { id, ref: started.ref, image: b.image, size: b.size ?? "small", createdAt: new Date().toISOString() }
      persist()
      return { id, ref: started.ref }
    },
  ],
  ["GET", /^\/v1\/builds$/, async () => Object.values(db().builds)],
  [
    "GET",
    /^\/v1\/builds\/([^/]+)$/,
    async ({ params, url }) => {
      const b = db().builds[params[0]!]
      if (!b) throw new SandboxError(`no build ${params[0]}`, "not_found")
      return { ...b, ...(await engine.buildStatus({ ref: b.ref, cursor: Number(url.searchParams.get("cursor") ?? 0) })) }
    },
  ],
  [
    "DELETE",
    /^\/v1\/builds\/([^/]+)$/,
    async ({ params }) => {
      const b = db().builds[params[0]!]
      if (!b) throw new SandboxError(`no build ${params[0]}`, "not_found")
      await engine.deleteBuild({ ref: b.ref })
      delete db().builds[b.id]
      persist()
      return { ok: true }
    },
  ],
]

async function stopOrPause(idOrName: string, kind: "stop" | "pause", wait: boolean) {
  const r = svc.find(idOrName)
  const t0 = performance.now()
  await engine[kind]({ handle: svc.handleOf(r.id) })
  const v = wait ? await svc.waitSettled(r) : await svc.view(r)
  return { ...v, tookMs: Math.round(performance.now() - t0) }
}

function text(res: ServerResponse, s: string) {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
  res.end(s)
  return undefined
}

/** A file of the box, streamed out as it is read. */
async function readFile({ params, url, res }: Ctx) {
  const r = svc.find(params[0]!)
  const path = url.searchParams.get("path")
  if (!path) throw new SandboxError("?path=/absolute/path, please", "invalid")
  let started = false
  try {
    await agentRequest(svc.handleOf(r.id), r.id, { op: "read", path }, {
      ready: (info) => {
        started = true
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(info.size), "X-Sbx-Mode": info.mode })
      },
      stdout: (b) => res.write(b),
    })
    res.end()
  } catch (err) {
    if (started) return void res.destroy(err as Error)
    throw new SandboxError(err instanceof Error ? err.message : String(err), /no such file|not a file/i.test(String(err)) ? "not_found" : "upstream")
  }
  return undefined
}

/** A file into the box, streamed in as it arrives: written to a temporary name, renamed at the end. */
async function writeFile({ params, url, req }: Ctx) {
  const r = svc.find(params[0]!)
  const path = url.searchParams.get("path")
  if (!path) throw new SandboxError("?path=/absolute/path, please", "invalid")
  const stream = dialAgent(svc.handleOf(r.id))
  const done = agentRequest(svc.handleOf(r.id), r.id, { op: "write", path, ...(url.searchParams.get("mode") ? { mode: url.searchParams.get("mode")! } : {}) }, {
    ready: async () => {
      for await (const c of req) if (!stream.write(frame(T.data, c as Buffer))) await once(stream, "drain")
      stream.write(frame(T.close))
    },
  }, stream)
  const exit = await done
  return { ok: true, path, bytes: exit.bytes }
}

/**
 * An upgraded connection carries the agent's frames both ways: the client's hello (without a token)
 * gets the box's, then bytes are piped as they are. One exec, shell, read, write or tunnel each.
 */
function attach(req: IncomingMessage, socket: Duplex, head: Buffer, idOrName: string) {
  let r
  try {
    r = svc.find(idOrName)
  } catch {
    socket.end("HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n" + JSON.stringify({ error: { code: "not_found", message: `no sandbox ${idOrName}` } }))
    return
  }
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: sbx-agent/1\r\nConnection: Upgrade\r\n\r\n")
  const reader = new FrameReader()
  let agent: Duplex | null = null
  const onData = (chunk: Buffer) => {
    let frames
    try {
      frames = reader.push(chunk)
    } catch {
      return socket.destroy()
    }
    const hello = frames.shift()
    if (!hello) return
    socket.off("data", onData)
    if (hello.type !== T.hello) return socket.end(frame(T.error, { message: "the first frame is the hello" }))
    let h: Hello
    try {
      h = json<Hello>(hello.payload)
    } catch {
      return socket.end(frame(T.error, { message: "the hello is not JSON" }))
    }
    try {
      agent = dialAgent(svc.handleOf(r.id))
    } catch (err) {
      return socket.end(frame(T.error, { message: err instanceof Error ? err.message : String(err) }))
    }
    agent.write(frame(T.hello, { ...h, token: tokenOf(r.id) }))
    // What came after the hello, then everything else, as it is.
    for (const f of frames) agent.write(frame(f.type, f.payload))
    const rest = reader.rest()
    if (rest.length) agent.write(rest)
    socket.pipe(agent).pipe(socket)
    agent.on("error", () => socket.destroy())
    agent.on("close", () => socket.end())
    socket.on("close", () => agent?.destroy())
  }
  socket.on("data", onData)
  socket.on("error", () => agent?.destroy())
  if (head.length) onData(head)
}

function authorized(req: IncomingMessage, tcp: boolean) {
  if (!tcp) return true
  const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? ""
  const a = Buffer.from(given)
  const b = Buffer.from(API_TOKEN)
  return API_TOKEN !== "" && a.length === b.length && timingSafeEqual(a, b)
}

export function server(opts: { tcp: boolean }) {
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://sbx")
    const t0 = performance.now()
    try {
      if (!authorized(req, opts.tcp)) throw new HttpError(401, "Authorization: Bearer <SBX_API_TOKEN>, please")
      const route = routes.find(([m, p]) => m === req.method && p.test(url.pathname))
      if (!route) {
        const known = routes.some(([, p]) => p.test(url.pathname))
        throw new HttpError(known ? 405 : 404, known ? `${req.method} is not allowed here` : `no route ${url.pathname}`)
      }
      const params = route[1].exec(url.pathname)!.slice(1).map(decodeURIComponent)
      const out = await route[2]({ req, res, url, params })
      if (out !== undefined && !res.headersSent) {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(out))
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : STATUS[(err as { code?: string }).code ?? ""] ?? 500
      const code = err instanceof HttpError ? (status === 401 ? "unauthorized" : status === 404 ? "not_found" : "invalid") : ((err as { code?: string }).code ?? "internal")
      if (status >= 500) console.error(`[sandboxd] ${req.method} ${url.pathname}:`, err)
      if (!res.headersSent) {
        res.writeHead(status, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: { code, message: err instanceof Error ? err.message : String(err) } }))
      } else res.destroy()
    } finally {
      if (process.env.SBX_LOG_REQUESTS === "1") console.log(`[sandboxd] ${req.method} ${url.pathname} ${res.statusCode} ${Math.round(performance.now() - t0)} ms`)
    }
  })
  srv.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://sbx")
    const m = /^\/v1\/sandboxes\/([^/]+)\/attach$/.exec(url.pathname)
    if (!authorized(req, opts.tcp)) return socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")
    if (!m || req.method !== "POST" || !/^sbx-agent\//i.test(req.headers.upgrade ?? "")) return socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
    attach(req, socket, head, decodeURIComponent(m[1]!))
  })
  // Long creates (an image pulled for the first time), long streams.
  srv.requestTimeout = 0
  srv.headersTimeout = 60_000
  return srv
}
