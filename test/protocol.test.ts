/**
 * What a box sends is the box's: a request fails on a frame it cannot read, the process reading it stays.
 */
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { request, T } from "../src/protocol"

/** A stream that answers `bytes` to whatever is written to it — later, as a socket would. */
function guest(bytes: Buffer) {
  const s = new PassThrough()
  s.once("data", () => setImmediate(() => s.push(bytes)))
  return s
}
const raw = (type: string, payload: string) => {
  const head = Buffer.alloc(5)
  head.write(type, 0, "latin1")
  head.writeUInt32BE(Buffer.byteLength(payload), 1)
  return Buffer.concat([head, Buffer.from(payload)])
}

describe("the protocol, against a hostile guest", () => {
  it("rejects a ready, an exit or an error frame that is not JSON", async () => {
    for (const t of [T.ready, T.exit, T.error]) await expect(request(guest(raw(t, "not json")), { op: "info" }, { ready: () => {} })).rejects.toThrow(SyntaxError)
  })

  it("rejects what the caller's ready refuses (a mode with a CR LF, into headers)", async () => {
    const ready = (info: { mode: string }) => {
      if (!/^[0-7]{1,6}$/.test(info.mode)) throw new Error("no mode")
    }
    await expect(request(guest(raw(T.ready, JSON.stringify({ size: 1, mode: "7\r\nX: y" }))), { op: "read", path: "/x" }, { ready })).rejects.toThrow(/no mode/)
  })

  it("rejects a frame bigger than any", async () => {
    const head = Buffer.alloc(5)
    head.write(T.stdout, 0, "latin1")
    head.writeUInt32BE(64 << 20, 1)
    await expect(request(guest(head), { op: "info" })).rejects.toThrow(/a frame of/)
  })
})
