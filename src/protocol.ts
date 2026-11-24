/**
 * The guest agent's wire protocol (guest/protocol.md): one request per connection, in frames —
 *
 *   type (1 byte) · length (4 bytes, big endian) · payload
 *
 * The client's first frame is the hello (`h`, JSON). The daemon speaks it to the agent, through the
 * box's network namespace; a client of the daemon speaks it too, over an upgraded HTTP connection
 * (`/v1/sandboxes/{id}/attach`), and the daemon fills in the box's token.
 */

import type { Duplex } from "node:stream"

export const T = {
  hello: "h",
  data: "0",
  close: "c",
  resize: "r",
  signal: "k",
  ready: "o",
  stdout: "1",
  stderr: "2",
  exit: "x",
  error: "e",
} as const
export type FrameType = (typeof T)[keyof typeof T]

export const MAX_FRAME = 4 << 20

export type Hello =
  | { op: "exec"; cmd: string[]; env?: Record<string, string>; cwd?: string; user?: string; tty?: { rows: number; cols: number }; detach?: boolean; token?: string }
  | { op: "read"; path: string; token?: string }
  | { op: "write"; path: string; mode?: string; token?: string }
  | { op: "connect"; port: number; host?: string; token?: string }
  | { op: "info"; token?: string }

export type Exit = { code: number; signal?: string; pid?: number; log?: string; bytes?: number; [k: string]: unknown }

export function frame(type: FrameType, payload: Buffer | string | object = Buffer.alloc(0)): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload))
  const head = Buffer.alloc(5)
  head.write(type, 0, "latin1")
  head.writeUInt32BE(body.length, 1)
  return Buffer.concat([head, body])
}

/** Frames out of a byte stream, as they complete. */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0)
  push(chunk: Buffer): { type: FrameType; payload: Buffer }[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const out: { type: FrameType; payload: Buffer }[] = []
    for (;;) {
      if (this.buf.length < 5) break
      const len = this.buf.readUInt32BE(1)
      if (len > MAX_FRAME) throw new Error(`a frame of ${len} bytes`)
      if (this.buf.length < 5 + len) break
      out.push({ type: String.fromCharCode(this.buf[0]!) as FrameType, payload: this.buf.subarray(5, 5 + len) })
      this.buf = this.buf.subarray(5 + len)
    }
    return out
  }
  /** What is left that is not a whole frame. */
  rest(): Buffer {
    return this.buf
  }
}

export const json = <T = any>(b: Buffer): T => JSON.parse(b.toString("utf8")) as T

/**
 * A request on an open stream: the hello sent, frames handed to `on` as they come. Resolves with the
 * exit frame, rejects with an error frame or a stream that ends before either.
 */
export function request(stream: Duplex, hello: Hello, on: { ready?: (r: any) => void; stdout?: (b: Buffer) => void; stderr?: (b: Buffer) => void } = {}): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const reader = new FrameReader()
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }
    stream.on("data", (chunk: Buffer) => {
      let frames
      try {
        frames = reader.push(chunk)
      } catch (err) {
        return done(() => reject(err))
      }
      for (const f of frames) {
        if (f.type === T.ready) on.ready?.(json(f.payload))
        else if (f.type === T.stdout) on.stdout?.(f.payload)
        else if (f.type === T.stderr) on.stderr?.(f.payload)
        else if (f.type === T.exit) done(() => resolve(json(f.payload)))
        else if (f.type === T.error) done(() => reject(new Error(json<{ message: string }>(f.payload).message)))
      }
    })
    stream.on("error", (err) => done(() => reject(err)))
    stream.on("close", () => done(() => reject(new Error("the connection to the sandbox closed before the end"))))
    stream.write(frame(T.hello, hello))
  })
}
