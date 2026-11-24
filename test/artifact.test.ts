import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "node:http"
import { Readable, Writable } from "node:stream"
import zlib from "node:zlib"
import { compressAndUpload, downloadInto, upload } from "../src/engine/artifact"

/** A bucket that keeps what it is sent: S3 parts by number, a GCS resumable session by range. */
function fakeBucket() {
  const parts = new Map<number, Buffer>()
  let session: Buffer = Buffer.alloc(0)
  let stored: Buffer = Buffer.alloc(0)
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)
    const url = new URL(req.url!, "http://x")
    if (req.method === "PUT" && url.pathname === "/part") {
      const n = Number(url.searchParams.get("n"))
      if (url.searchParams.get("fail") === String(n) && !parts.has(-n)) {
        parts.set(-n, Buffer.alloc(0)) // fails once, then works: a part is retried
        return res.writeHead(503).end("busy")
      }
      parts.set(n, body)
      return res.writeHead(200, { etag: `"etag-${n}"` }).end()
    }
    if (req.method === "PUT" && url.pathname === "/session") {
      const range = req.headers["content-range"] as string
      const m = /bytes (\d+)-(\d+)\/(\*|\d+)/.exec(range)
      if (m) session = Buffer.concat([session.subarray(0, Number(m[1])), body])
      if (range.endsWith("/*")) return res.writeHead(308, { range: `bytes=0-${session.length - 1}` }).end()
      stored = session
      return res.writeHead(200).end()
    }
    if (req.method === "GET" && url.pathname === "/object") return res.writeHead(200).end(stored)
    res.writeHead(404).end()
  })
  return {
    server,
    assembled: () => Buffer.concat([...parts.entries()].filter(([n]) => n > 0).sort(([a], [b]) => a - b).map(([, b]) => b)),
    store: (b: Buffer) => (stored = b),
    stored: () => stored,
  }
}

const bytes = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7919) % 251))
async function* chunks(b: Buffer, size: number) {
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size)
}

describe("build artifacts (RFC 0041 § 4)", () => {
  const bucket = fakeBucket()
  let base = ""
  beforeAll(async () => {
    await new Promise<void>((r) => bucket.server.listen(0, r))
    base = `http://127.0.0.1:${(bucket.server.address() as { port: number }).port}`
  })
  afterAll(() => bucket.server.close())

  it("uploads in S3 parts of the target's size, retrying a part, and reports the ETags", async () => {
    const data = bytes(2500)
    const parts = [1, 2, 3, 4].map((n) => `${base}/part?n=${n}&fail=2`)
    const seen: number[] = []
    const up = await upload(chunks(data, 333), { kind: "multipart", uploadId: "u", partSize: 1000, parts }, (n) => seen.push(n))
    expect(up).toEqual({ bytes: 2500, parts: [1, 2, 3].map((n) => ({ partNumber: n, etag: `"etag-${n}"` })) })
    expect(bucket.assembled().equals(data)).toBe(true)
    expect(seen).toEqual([1000, 2000, 2500])
  })

  it("refuses a build larger than the parts it was given", async () => {
    await expect(upload(chunks(bytes(2500), 500), { kind: "multipart", uploadId: "u", partSize: 1000, parts: [`${base}/part?n=1`] })).rejects.toThrow(/larger than one upload allows/)
  })

  it("compresses, uploads to a resumable session, and reads it back the same", async () => {
    const data = Buffer.concat([bytes(40_000), Buffer.alloc(200_000)]) // zeros, as a sparse disk has
    const up = await compressAndUpload(Readable.from(chunks(data, 4096)), { kind: "resumable", url: `${base}/session` })
    expect(up.bytes).toBe(bucket.stored().length)
    expect(up.bytes).toBeLessThan(data.length / 2)
    const out: Buffer[] = []
    const sink = new Writable({ write: (c, _e, cb) => (out.push(c), cb()) })
    const read = await downloadInto({ url: `${base}/object` }, sink)
    expect(read).toBe(up.bytes)
    expect(Buffer.concat(out).equals(data)).toBe(true)
  })

  it("says why a download was refused", async () => {
    await expect(downloadInto({ url: `${base}/nothing` }, new Writable({ write: (_c, _e, cb) => cb() }))).rejects.toThrow(/HTTP 404/)
  })

  it("fails a download that is not zstd rather than load garbage", async () => {
    bucket.store(Buffer.from("not a zstd stream"))
    await expect(downloadInto({ url: `${base}/object` }, new Writable({ write: (_c, _e, cb) => cb() }))).rejects.toThrow()
    bucket.store(zlib.zstdCompressSync(Buffer.from("ok")))
  })
})
