/**
 * A connection to a box's guest agent: a TCP connection to 172.16.0.2:47771 opened **from the box's
 * network namespace** — the only place that address is reached from. Node cannot enter a namespace
 * itself, so a static busybox `nc` does it (`nsenter --net`), its stdin and stdout the connection.
 */

import { spawn } from "node:child_process"
import { Duplex } from "node:stream"
import { BIN, netnsOf } from "../engine"
import { request, type Exit, type Hello } from "../protocol"
import { AGENT_ADDR, AGENT_PORT } from "./config"
import { tokenOf } from "./store"

const NETNS_DIR = process.env.SPUNTO_FC_NETNS_DIR ?? "/run/netns"

/** A raw byte stream to the agent of `handle`. Closing it ends the `nc`. */
export function dialAgent(handle: string): Duplex {
  const netns = netnsOf(handle)
  if (!netns) throw Object.assign(new Error(`no such sandbox ${handle}`), { code: "not_found" })
  const child = spawn("nsenter", [`--net=${NETNS_DIR}/${netns}`, BIN("busybox"), "nc", AGENT_ADDR, String(AGENT_PORT)], { stdio: ["pipe", "pipe", "pipe"] })
  let stderr = ""
  child.stderr.on("data", (c: Buffer) => (stderr = (stderr + c.toString()).slice(-500)))
  const stream = new Duplex({
    read() {
      child.stdout.resume()
    },
    write(chunk, _enc, cb) {
      if (!child.stdin.writable) return cb(new Error("the connection to the sandbox is closed"))
      child.stdin.write(chunk, cb)
    },
    final(cb) {
      cb()
    },
    destroy(err, cb) {
      child.kill()
      cb(err)
    },
  })
  child.stdout.on("data", (c: Buffer) => {
    if (!stream.push(c)) child.stdout.pause()
  })
  child.stdout.on("end", () => stream.push(null))
  child.on("error", (err) => stream.destroy(err))
  child.on("close", (code) => {
    if (code && !stream.destroyed) stream.destroy(new Error(`could not reach the sandbox's agent${stderr.trim() ? `: ${stderr.trim()}` : ` (nc exited with ${code})`}`))
    else stream.destroy()
  })
  child.stdin.on("error", () => {})
  return stream
}

/** One request to a box's agent, its token filled in: the exit frame, or the agent's error. */
export async function agentRequest(handle: string, sandboxId: string, hello: Hello, on: Parameters<typeof request>[2] = {}, stream = dialAgent(handle)): Promise<Exit> {
  try {
    return await request(stream, { ...hello, token: tokenOf(sandboxId) } as Hello, on)
  } finally {
    stream.destroy()
  }
}

/** Wait until a box's agent answers (`info`), up to `timeoutMs`: a box just booted starts it within a second or two. */
export async function waitAgent(handle: string, sandboxId: string, timeoutMs = 60_000): Promise<Exit> {
  const end = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < end) {
    try {
      return await agentRequest(handle, sandboxId, { op: "info" })
    } catch (err) {
      last = err
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  throw Object.assign(new Error(`the sandbox's agent did not answer within ${Math.round(timeoutMs / 1000)} s (${last instanceof Error ? last.message : last}) — sbx logs <sandbox> shows its console`), { code: "upstream" })
}
