/**
 * Moving a build between a machine and the org's bucket (RFC 0041 § 4): a stream, zstd-compressed,
 * into a target minted for ONE object — S3 multipart parts or a GCS resumable session — and back
 * from a read URL. The bytes never pass through the platform, and nothing here can list or delete.
 *
 * The upload logic is the agent's (`apps/agent/src/backup.ts`, RFC 0028), for the same two target
 * kinds: the agent is a separate package, and a backup and a build are the only two writers.
 */

import http from "node:http"
import https from "node:https"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import zlib from "node:zlib"
import type { ReadTarget, WriteTarget } from "./types"

/** GCS wants chunks in multiples of 256 KiB; 32 MiB like an S3 part. */
const RESUMABLE_CHUNK = 32 * 1024 * 1024

export type Uploaded = { bytes: number; parts?: { partNumber: number; etag: string }[] }

/** Buffers chunks until `size` bytes are there — the unit of a part or a session chunk. */
class Pending {
  private chunks: Buffer[] = []
  length = 0
  push(c: Buffer) {
    this.chunks.push(c)
    this.length += c.length
  }
  unshift(c: Buffer) {
    if (!c.length) return
    this.chunks.unshift(c)
    this.length += c.length
  }
  take(n: number): Buffer {
    const all = Buffer.concat(this.chunks)
    const out = all.subarray(0, n)
    const rest = all.subarray(n)
    this.chunks = rest.length ? [rest] : []
    this.length = rest.length
    return out
  }
}

async function retried<T>(what: string, fn: () => Promise<T>): Promise<T> {
  let last: unknown
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fn()
    } catch (err) {
      last = err
      if ((err as { permanent?: boolean }).permanent) break
      await new Promise((r) => setTimeout(r, attempt * 1000))
    }
  }
  throw new Error(`${what}: ${last instanceof Error ? last.message : String(last)}`)
}

const refused = (what: string, res: Response, body: string) =>
  Object.assign(new Error(`${what} refused: HTTP ${res.status} ${body.slice(0, 300)}`), { permanent: res.status < 500 })

/** Upload a stream into a write target. `onBytes`: the bytes sent so far, as they go. */
export async function upload(source: AsyncIterable<Buffer>, target: WriteTarget, onBytes: (n: number) => void = () => {}): Promise<Uploaded> {
  const buf = new Pending()
  let sent = 0
  if (target.kind === "multipart") {
    const parts: { partNumber: number; etag: string }[] = []
    const put = async (body: Buffer) => {
      const partNumber = parts.length + 1
      const url = target.parts[partNumber - 1]
      if (!url) throw new Error(`the build is larger than one upload allows (${target.parts.length} parts × ${Math.round(target.partSize / 1024 ** 2)} MiB)`)
      // A part is idempotent (same number, same bytes): a transient failure is retried.
      const etag = await retried(`part ${partNumber}`, async () => {
        const res = await fetch(url, { method: "PUT", body: new Uint8Array(body) })
        if (!res.ok) throw refused(`part ${partNumber}`, res, await res.text().catch(() => ""))
        const tag = res.headers.get("etag")
        if (!tag) throw new Error("no ETag in the part response")
        return tag
      })
      parts.push({ partNumber, etag })
      sent += body.length
      onBytes(sent)
    }
    for await (const chunk of source) {
      buf.push(chunk)
      while (buf.length >= target.partSize) await put(buf.take(target.partSize))
    }
    if (buf.length || !parts.length) await put(buf.take(buf.length))
    return { bytes: sent, parts }
  }
  if (target.kind === "resumable") {
    // `Content-Range: bytes a-b/*` answered 308, the last request carries the total. Google may keep
    // fewer bytes than sent — the 308's `Range` says how many — so the rest goes back in front.
    const put = (body: Buffer, total: number | null) =>
      fetch(target.url, {
        method: "PUT",
        headers: { "Content-Range": body.length === 0 ? `bytes */${total}` : `bytes ${sent}-${sent + body.length - 1}/${total ?? "*"}` },
        body: new Uint8Array(body),
      })
    for await (const chunk of source) {
      buf.push(chunk)
      while (buf.length >= RESUMABLE_CHUNK) {
        const body = buf.take(RESUMABLE_CHUNK)
        const res = await put(body, null)
        if (res.status !== 308) throw refused("upload chunk", res, await res.text().catch(() => ""))
        const kept = /bytes=0-(\d+)/.exec(res.headers.get("range") ?? "")
        const accepted = Math.max(0, (kept ? Number(kept[1]) + 1 : 0) - sent)
        sent += accepted
        buf.unshift(body.subarray(accepted))
        onBytes(sent)
      }
    }
    const body = buf.take(buf.length)
    const res = await put(body, sent + body.length)
    if (res.status !== 200 && res.status !== 201) throw refused("upload completion", res, await res.text().catch(() => ""))
    sent += body.length
    onBytes(sent)
    return { bytes: sent }
  }
  throw new Error(`unknown upload target "${(target as { kind?: string }).kind}"`)
}

/** Compress `source` with zstd and upload it — what an export is, whatever produced the bytes. */
export async function compressAndUpload(source: Readable, target: WriteTarget, onBytes?: (n: number) => void): Promise<Uploaded> {
  const zstd = zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } })
  source.on("error", (err) => zstd.destroy(err))
  return upload(source.pipe(zstd), target, onBytes)
}

/**
 * Download an object and decompress it into `sink` (a `zfs receive`'s stdin, a `docker load`
 * request). `onBytes`: the compressed bytes read so far.
 */
export async function downloadInto(target: ReadTarget, sink: NodeJS.WritableStream, onBytes: (n: number) => void = () => {}): Promise<number> {
  // node:http, not fetch: undici asserts — and takes the whole process down — when a response it
  // paused (the sink is slower: a `docker load`, a `zfs receive`) sees its socket end. Seen on
  // 2026-10-13 fetching a 588 MB build into `docker load`.
  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const url = new URL(target.url)
    const req = (url.protocol === "https:" ? https : http).get(url, { headers: target.headers }, resolve)
    req.on("error", reject)
  })
  if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
    const chunks: Buffer[] = []
    for await (const c of res) chunks.push(c as Buffer)
    throw new Error(`download refused: HTTP ${res.statusCode} ${Buffer.concat(chunks).toString("utf8").slice(0, 300)}`)
  }
  let read = 0
  const count = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      read += chunk.length
      onBytes(read)
      cb(null, chunk)
    },
  })
  await pipeline(res, count, zlib.createZstdDecompress(), sink)
  return read
}

/** "1.4 GB", "312 MB" — for a build's log. */
export const humanBytes = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`)
