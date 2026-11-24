/**
 * The daemon's operations, on top of the engine: sandboxes by id or name, a create that waits until
 * the box answers, a fork that is one call, snapshots that can be started from, exec and files
 * through the guest agent.
 */

import { execFile } from "node:child_process"
import { engine, SandboxError, sizeOf, type Description } from "../engine"
import { frame, T, type Exit, type Hello } from "../protocol"
import { agentRequest, dialAgent, waitAgent } from "./agent"
import { CREATE_TIMEOUT_MS, DEFAULT_SIZE } from "./config"
import { BOOTSTRAP } from "./guest"
import { db, newId, persist, tokenOf, type SandboxRecord, type SnapshotRecord } from "./store"

export const handleOf = (id: string) => `sbx-${id}`
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/

export type SandboxView = SandboxRecord & Description & { handle: string }
export type SnapshotView = SnapshotRecord & { state: "pending" | "ready" | "error"; detail?: string }

export function find(idOrName: string): SandboxRecord {
  const s = db().sandboxes
  const r = s[idOrName] ?? Object.values(s).find((x) => x.name === idOrName)
  if (!r) throw new SandboxError(`no sandbox ${idOrName}`, "not_found")
  return r
}

export async function view(r: SandboxRecord): Promise<SandboxView> {
  const d = await engine.describe({ handle: handleOf(r.id) })
  return { ...r, env: redact(r.env), handle: handleOf(r.id), ...d }
}

/** Env values are the caller's secrets: names only, in every answer. */
const redact = (env: Record<string, string>) => Object.fromEntries(Object.keys(env).map((k) => [k, "…"]))

export async function list(): Promise<SandboxView[]> {
  return Promise.all(Object.values(db().sandboxes).map(view))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Until the box runs and its agent answers — or it fails, saying why. */
export async function waitRunning(r: SandboxRecord, timeoutMs = CREATE_TIMEOUT_MS): Promise<SandboxView> {
  const end = Date.now() + timeoutMs
  const handle = handleOf(r.id)
  for (;;) {
    const d = await engine.describe({ handle })
    if (d.state === "error") throw new SandboxError(`${r.name}: ${d.detail ?? "failed"}`)
    if (d.state === "missing") throw new SandboxError(`${r.name} is gone`, "not_found")
    if (d.state === "running") break
    if (Date.now() > end) throw new SandboxError(`${r.name} is still ${d.state} (${d.detail ?? ""}) after ${Math.round(timeoutMs / 1000)} s`)
    await sleep(d.state === "creating" ? 250 : 100)
  }
  await waitAgent(handle, r.id, Math.max(5_000, end - Date.now()))
  return view(r)
}

/** Until a stop or a pause is done (its RAM written): `describe` has no `transition` any more. */
export async function waitSettled(r: SandboxRecord, timeoutMs = 10 * 60_000): Promise<SandboxView> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = await view(r)
    if (!v.transition || Date.now() > end) return v
    await sleep(100)
  }
}

export type CreateRequest = {
  image?: string
  name?: string
  size?: string
  env?: Record<string, string>
  labels?: Record<string, string>
  /** A snapshot's id (or name), or a build's id. */
  from?: string
  /** Answer once it runs and its agent answers (the default), or at once. */
  wait?: boolean
}

function checkName(name: string) {
  if (!NAME.test(name)) throw new SandboxError(`a name is lowercase letters, digits and dashes (${name})`, "invalid")
  if (Object.values(db().sandboxes).some((s) => s.name === name)) throw new SandboxError(`a sandbox is already named ${name}`, "invalid")
}

function checkEnv(env: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new SandboxError(`not an environment variable name: ${k}`, "invalid")
    if (typeof v !== "string") throw new SandboxError(`${k}: a value is a string`, "invalid")
    if (k === "SPUNTO_SANDBOX_TOKEN" || k.startsWith("SPUNTO_AGENT_")) throw new SandboxError(`${k} is the agent's`, "invalid")
  }
  return env
}

/** The engine's ref of a snapshot or build — waited for while its memory is still being written. */
async function sourceOf(from: string): Promise<{ ref: string; image?: string; size?: string; env?: Record<string, string> }> {
  const snaps = db().snapshots
  const snap = snaps[from] ?? Object.values(snaps).find((s) => s.name === from)
  if (snap) {
    const end = Date.now() + 10 * 60_000
    for (;;) {
      const st = await engine.templateStatus({ ref: snap.ref })
      if (st.state === "ready") break
      if (st.state === "error") throw new SandboxError(`snapshot ${from}: ${st.detail}`)
      if (Date.now() > end) throw new SandboxError(`snapshot ${from} is still being written`)
      await sleep(200)
    }
    return { ref: snap.ref, image: snap.image, size: snap.size, env: snap.env }
  }
  const build = db().builds[from]
  if (build) return { ref: build.ref, image: build.image, size: build.size }
  throw new SandboxError(`no snapshot or build ${from}`, "not_found")
}

export async function create(req: CreateRequest): Promise<SandboxView> {
  const source = req.from ? await sourceOf(req.from) : undefined
  const image = req.image ?? source?.image
  if (!image) throw new SandboxError("an image, please (ubuntu:24.04, node:24, ghcr.io/…)", "invalid")
  const id = newId()
  const name = req.name ?? id
  checkName(name)
  const env = { ...(source?.env ?? {}), ...checkEnv(req.env) }
  const size = sizeOf(req.size ?? source?.size ?? DEFAULT_SIZE).id
  if (req.size && req.size !== size) throw new SandboxError(`no size ${req.size} (small, default, large, xlarge)`, "invalid")
  const r: SandboxRecord = { id, name, image, size, env, ...(req.labels ? { labels: req.labels } : {}), ...(req.from ? { from: req.from } : {}), createdAt: new Date().toISOString() }
  db().sandboxes[id] = r
  persist()
  try {
    await engine.create({ sandboxId: id, name, image, size, env: { ...env, SPUNTO_SANDBOX_TOKEN: tokenOf(id), SPUNTO_SANDBOX_ID: id }, bootstrap: BOOTSTRAP, labels: { "sbx.name": name, ...req.labels }, from: source?.ref })
  } catch (err) {
    delete db().sandboxes[id]
    persist()
    throw err
  }
  return req.wait === false ? view(r) : waitRunning(r)
}

/**
 * A copy of a running sandbox, processes and memory included: the source paused for as short as
 * the engine can (only what it dirtied since its last snapshot is written), then one create from it.
 */
export async function fork(idOrName: string, req: { name?: string; wait?: boolean } = {}): Promise<SandboxView & { pauseMs?: number }> {
  const src = find(idOrName)
  if (req.name) checkName(req.name)
  const f = await engine.fork({ handle: handleOf(src.id) })
  const id = newId()
  const name = req.name ?? id
  const r: SandboxRecord = { id, name, image: src.image, size: src.size, env: src.env, ...(src.labels ? { labels: src.labels } : {}), from: `fork:${src.id}`, createdAt: new Date().toISOString() }
  db().sandboxes[id] = r
  persist()
  try {
    await engine.create({ sandboxId: id, name, image: src.image, size: src.size, env: { ...src.env, SPUNTO_SANDBOX_TOKEN: tokenOf(id), SPUNTO_SANDBOX_ID: id }, bootstrap: BOOTSTRAP, labels: { "sbx.name": name, ...src.labels }, from: f.ref })
  } catch (err) {
    delete db().sandboxes[id]
    persist()
    await engine.deleteTemplate({ ref: f.ref }).catch(() => {})
    throw err
  }
  const v = req.wait === false ? await view(r) : await waitRunning(r)
  return { ...v, pauseMs: f.pauseMs }
}

export async function snapshot(idOrName: string, req: { name?: string; memory?: boolean } = {}): Promise<SnapshotView> {
  const src = find(idOrName)
  if (req.name && Object.values(db().snapshots).some((s) => s.name === req.name)) throw new SandboxError(`a snapshot is already named ${req.name}`, "invalid")
  const memory = req.memory !== false
  // A model (`fork({ model })`): kept for many copies, each taking its own identity in place.
  const made = memory ? await engine.fork({ handle: handleOf(src.id), model: true }) : await engine.snapshotDisks({ handle: handleOf(src.id) })
  const s: SnapshotRecord = { id: newId("snap-"), ref: made.ref, sandboxId: src.id, ...(req.name ? { name: req.name } : {}), image: src.image, size: src.size, env: src.env, kind: memory ? "memory" : "disks", createdAt: new Date().toISOString() }
  db().snapshots[s.id] = s
  persist()
  return snapshotView(s)
}

export async function snapshotView(s: SnapshotRecord): Promise<SnapshotView> {
  const st = await engine.templateStatus({ ref: s.ref })
  return { ...s, env: redact(s.env), state: st.state, ...(st.detail ? { detail: st.detail } : {}) }
}

export function findSnapshot(idOrName: string): SnapshotRecord {
  const s = db().snapshots
  const r = s[idOrName] ?? Object.values(s).find((x) => x.name === idOrName)
  if (!r) throw new SandboxError(`no snapshot ${idOrName}`, "not_found")
  return r
}

export async function deleteSnapshot(idOrName: string) {
  const s = findSnapshot(idOrName)
  await engine.deleteTemplate({ ref: s.ref })
  delete db().snapshots[s.id]
  persist()
}

export async function destroy(idOrName: string) {
  const r = find(idOrName)
  await engine.destroy({ handle: handleOf(r.id) })
  delete db().sandboxes[r.id]
  persist()
}

/** exec, buffered: what a script or an SDK call wants. Output capped at `max` bytes each (the rest dropped, and said). */
export async function exec(
  idOrName: string,
  req: { cmd: string | string[]; env?: Record<string, string>; cwd?: string; user?: string; stdin?: string; timeoutMs?: number; detach?: boolean },
  max = 16 * 1024 * 1024,
): Promise<{ exitCode: number; signal?: string; stdout: string; stderr: string; truncated?: boolean; pid?: number; log?: string; durationMs: number }> {
  const r = find(idOrName)
  const cmd = typeof req.cmd === "string" ? ["/bin/sh", "-c", req.cmd] : req.cmd
  if (!Array.isArray(cmd) || !cmd.length || cmd.some((c) => typeof c !== "string")) throw new SandboxError("cmd: a string (run by /bin/sh -c) or an array of strings", "invalid")
  const out: Buffer[] = []
  const err: Buffer[] = []
  let size = 0
  let truncated = false
  const keep = (into: Buffer[]) => (b: Buffer) => {
    if (size + b.length > max) return void (truncated = true)
    size += b.length
    into.push(b)
  }
  const t0 = Date.now()
  const hello: Hello = { op: "exec", cmd, ...(req.env ? { env: checkEnv(req.env) } : {}), ...(req.cwd ? { cwd: req.cwd } : {}), ...(req.user ? { user: req.user } : {}), ...(req.detach ? { detach: true } : {}) }
  const stream = dialAgent(handleOf(r.id))
  let timer: NodeJS.Timeout | undefined
  const running = agentRequest(handleOf(r.id), r.id, hello, {
    ready: () => {
      if (req.stdin !== undefined) stream.write(frame(T.data, Buffer.from(req.stdin)))
      stream.write(frame(T.close))
    },
    stdout: keep(out),
    stderr: keep(err),
  }, stream)
  if (req.timeoutMs) timer = setTimeout(() => stream.write(frame(T.signal, { signal: "SIGKILL" })), req.timeoutMs)
  let exit: Exit
  try {
    exit = await running
  } finally {
    clearTimeout(timer)
  }
  return {
    exitCode: exit.code,
    ...(exit.signal ? { signal: exit.signal } : {}),
    stdout: Buffer.concat(out).toString("utf8"),
    stderr: Buffer.concat(err).toString("utf8"),
    ...(truncated ? { truncated } : {}),
    ...(exit.pid ? { pid: exit.pid } : {}),
    ...(exit.log ? { log: exit.log as string } : {}),
    durationMs: Date.now() - t0,
  }
}

/** The box's serial console, from the journal: the kernel, the init, what the bootstrap said. */
export function logs(idOrName: string, lines = 200): Promise<string> {
  const r = find(idOrName)
  return new Promise((resolve, reject) =>
    execFile("journalctl", ["-u", `spunto-fc-${handleOf(r.id)}`, "-n", String(Math.min(Math.max(1, lines), 10_000)), "--no-pager", "-o", "cat"], { maxBuffer: 16 * 1024 * 1024 }, (e, out, stderr) =>
      e ? reject(new SandboxError(`journalctl: ${stderr || e.message}`)) : resolve(out),
    ),
  )
}
