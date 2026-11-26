// The docs site as sandbox.spunto.net serves it (docs/nginx.conf), for a worker's :3000: the static export in
// .serve/current/out, `$uri`, `$uri.html`, `$uri/index.html`, then 404.html; /install.sh and /healthz. Read on each
// request, so scripts/start.sh swaps .serve/current without restarting this.
import { createServer } from "node:http"
import { readFile, stat } from "node:fs/promises"
import { extname, join, normalize } from "node:path"

const ROOT = new URL("..", import.meta.url).pathname
const PORT = Number(process.env.PORT ?? 3000)
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2",
  ".sh": "text/x-shellscript", ".xml": "application/xml",
}

async function file(path) {
  try { return (await stat(path)).isFile() ? path : null } catch { return null }
}

createServer(async (req, res) => {
  let url
  try { url = decodeURIComponent(new URL(req.url, "http://x").pathname) }
  catch { res.writeHead(400).end("bad request\n"); return } // a malformed %: an answer, not a crash
  if (url === "/healthz") return res.end("ok\n")
  const out = join(ROOT, ".serve/current/out")
  const rel = normalize(url).replace(/^(\.\.[/\\])+/, "")
  const found = url === "/install.sh" ? join(ROOT, "install.sh")
    : (await file(join(out, rel))) ?? (await file(join(out, rel + ".html"))) ?? (await file(join(out, rel, "index.html")))
  const path = found ?? (await file(join(out, "404.html")))
  if (!path) { res.writeHead(404).end("not built yet: bash scripts/start.sh\n"); return }
  res.writeHead(found ? 200 : 404, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" })
  res.end(await readFile(path))
}).listen(PORT, "0.0.0.0", () => console.log(`site on :${PORT}`))
