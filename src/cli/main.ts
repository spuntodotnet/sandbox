/**
 * sbx — Spunto Sandbox's command line: microVMs on this machine, through spunto-sandboxd.
 * `sbx help` lists the commands; every one is a call of the SDK (src/client).
 */

import { createReadStream, createWriteStream, readFileSync, statSync } from "node:fs"
import net from "node:net"
import { SandboxApiError, SandboxClient, Sandbox, snapshots, type SandboxInfo } from "../client"

const VERSION = "0.1.0"

const HELP = `sbx — Firecracker microVMs on this machine (Spunto Sandbox ${VERSION})

Sandboxes
  sbx run <image> [opts] [-- cmd…]   make a sandbox and wait until it runs (then run cmd in it)
      --name <n>  --size small|default|large|xlarge  -e KEY=VALUE  --from <snapshot>  --rm
  sbx ls                             list sandboxes
  sbx inspect <sandbox>              everything about one (JSON)
  sbx exec [-it] <sandbox> -- cmd…   run a command (-it: a terminal)   -e K=V  -w <dir>  -u <user>
  sbx shell <sandbox>                an interactive shell (bash, else sh)
  sbx pause <sandbox>                stop it, KEEPING its memory: nothing runs, nothing is lost
  sbx resume <sandbox>               back where it was, every process — milliseconds
  sbx stop <sandbox>                 stop it, its memory dropped (a clean shutdown); start boots it
  sbx start <sandbox>                run it again
  sbx fork <sandbox> [--name <n>]    a copy of a running sandbox: same memory, same processes
  sbx rm <sandbox>…                  destroy (disks and memory)

Snapshots and builds
  sbx snapshot <sandbox> [--name <n>] [--disks-only]   keep it as it is now; sbx run --from <it>
  sbx snapshots                      list them;  sbx snapshots rm <snapshot>
  sbx build <image> <script.sh>      bake a recipe into a disk; sbx run --from <build>

Files, ports, logs
  sbx cp <src> <dst>                 a file in or out: sbx cp ./a.txt box:/workspace/a.txt
  sbx port-forward <sandbox> [local:]port     e.g. 8080:3000, then http://localhost:8080
  sbx logs <sandbox> [-n 200]        its serial console (kernel, init, bootstrap)
  sbx usage <sandbox>                CPU, memory, network and disk, as the host measures them

This machine
  sbx host                           kernel, pool, memory, what runs
  sbx sizes                          what a sandbox can be made at
  sbx version

  --json for machine-readable output.  SBX_HOST (unix:///run/spunto-sandbox.sock, or http://host:7070)
  and SBX_TOKEN to reach another daemon.  Docs: https://sandbox.spunto.net`

type Args = { _: string[]; flags: Record<string, string | boolean>; multi: Record<string, string[]>; rest: string[] }

function parse(argv: string[]): Args {
  const out: Args = { _: [], flags: {}, multi: {}, rest: [] }
  const takesValue = new Set(["name", "size", "from", "e", "env", "w", "workdir", "u", "user", "n", "host", "token", "lines"])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--") {
      out.rest = argv.slice(i + 1)
      break
    }
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split(/=(.*)/s)
      if (v !== undefined) put(out, k!, v)
      else if (takesValue.has(k!)) put(out, k!, argv[++i] ?? "")
      else out.flags[k!] = true
    } else if (/^-[a-zA-Z]+$/.test(a)) {
      const letters = a.slice(1)
      if (letters.length === 1 && takesValue.has(letters)) put(out, letters, argv[++i] ?? "")
      else for (const l of letters) out.flags[l] = true
    } else out._.push(a)
  }
  return out
}
function put(a: Args, k: string, v: string) {
  a.flags[k] = v
  ;(a.multi[k] ??= []).push(v)
}

function envOf(a: Args): Record<string, string> | undefined {
  const pairs = [...(a.multi.e ?? []), ...(a.multi.env ?? [])]
  if (!pairs.length) return undefined
  const env: Record<string, string> = {}
  for (const p of pairs) {
    const i = p.indexOf("=")
    if (i < 1) {
      // `-e KEY`: its value here.
      if (process.env[p] === undefined) die(`-e ${p}: not set here (use KEY=VALUE)`)
      env[p] = process.env[p]!
    } else env[p.slice(0, i)] = p.slice(i + 1)
  }
  return env
}

function die(msg: string, code = 1): never {
  process.stderr.write(`sbx: ${msg}\n`)
  process.exit(code)
}

const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s)
const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s)
const ms = (n?: number) => (n === undefined ? "" : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`)

function table(rows: string[][]) {
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)))
  for (const [j, r] of rows.entries()) {
    const line = r.map((c, i) => c.padEnd(w[i]!)).join("  ").trimEnd()
    console.log(j === 0 ? dim(line) : line)
  }
}

function stateOf(s: SandboxInfo) {
  if (s.transition) return s.transition
  if (s.state === "stopped" && s.ram === "saved") return "paused"
  return s.state
}

function age(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000
  return s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`
}

async function interactive(box: Sandbox, cmd: string[], opts: { env?: Record<string, string>; cwd?: string; user?: string }) {
  const tty = process.stdin.isTTY ? { rows: process.stdout.rows || 24, cols: process.stdout.columns || 80 } : undefined
  const p = await box.spawn(cmd, { ...opts, ...(tty ? { tty } : {}) })
  p.on("stdout", (b) => process.stdout.write(b))
  p.on("stderr", (b) => process.stderr.write(b))
  if (tty) {
    process.stdin.setRawMode(true)
    process.stdout.on("resize", () => p.resize(process.stdout.rows, process.stdout.columns))
  }
  process.stdin.on("data", (b: Buffer) => p.write(b))
  process.stdin.on("end", () => p.end())
  process.stdin.resume()
  try {
    const exit = await p.wait()
    return exit.code
  } finally {
    if (tty) process.stdin.setRawMode(false)
    process.stdin.pause()
  }
}

async function streamed(box: Sandbox, cmd: string[], opts: { env?: Record<string, string>; cwd?: string; user?: string }) {
  const p = await box.spawn(cmd, opts)
  p.on("stdout", (b) => process.stdout.write(b))
  p.on("stderr", (b) => process.stderr.write(b))
  if (!process.stdin.isTTY) {
    process.stdin.on("data", (b: Buffer) => p.write(b))
    process.stdin.on("end", () => p.end())
  } else p.end()
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => p.kill(sig))
  return (await p.wait()).code
}

function splitTarget(s: string): { box?: string; path: string } {
  const m = /^([a-z0-9][a-z0-9-]*):(\/.*)$/.exec(s)
  return m ? { box: m[1]!, path: m[2]! } : { path: s }
}

async function main() {
  const a = parse(process.argv.slice(2))
  const json = a.flags.json === true
  const client = new SandboxClient({ host: (a.flags.host as string) || undefined, token: (a.flags.token as string) || undefined })
  const get = (id?: string) => (id ? Sandbox.get(id, { client }) : die("which sandbox? (sbx ls)"))
  const [cmd, ...args] = a._
  const print = (v: unknown, human: () => void) => (json ? console.log(JSON.stringify(v, null, 2)) : human())

  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
      if (a.flags.version) return console.log(VERSION)
      return console.log(HELP)
    case "version":
      return console.log(VERSION)

    case "run":
    case "create": {
      const image = args[0]
      const from = a.flags.from as string | undefined
      if (!image && !from) die("sbx run <image>  (or --from <snapshot>)")
      const t0 = performance.now()
      if (!json && process.stderr.isTTY) process.stderr.write(dim(`making a sandbox of ${image ?? from}…\n`))
      const box = await Sandbox.create({ client, image, from, name: a.flags.name as string | undefined, size: a.flags.size as string | undefined, env: envOf(a) })
      const took = Math.round(performance.now() - t0)
      if (!a.rest.length) return print(box.info, () => console.log(`${bold(box.name)} running ${dim(`(${box.info.size}, ${ms(took)})`)}\n  sbx shell ${box.name}`))
      if (!json) process.stderr.write(dim(`${box.name} running (${ms(took)})\n`))
      const code = a.flags.it || a.flags.i || a.flags.t ? await interactive(box, a.rest, {}) : await streamed(box, a.rest, {})
      if (a.flags.rm) await box.destroy()
      process.exit(code)
    }

    case "ls":
    case "ps":
    case "list": {
      const boxes = await Sandbox.list({ client })
      return print(
        boxes.map((b) => b.info),
        () => {
          if (!boxes.length) return console.log(dim("no sandbox yet — sbx run ubuntu:24.04"))
          table([["NAME", "ID", "STATE", "SIZE", "IMAGE", "AGE"], ...boxes.map((b) => [b.name, b.id, stateOf(b.info), b.info.size, b.info.image, age(b.info.createdAt)])])
        },
      )
    }

    case "inspect":
      return console.log(JSON.stringify((await get(args[0])).info, null, 2))

    case "exec": {
      const box = await get(args[0])
      const command = a.rest.length ? a.rest : args.slice(1)
      if (!command.length) die("sbx exec <sandbox> -- <command…>")
      const opts = { env: envOf(a), cwd: (a.flags.w ?? a.flags.workdir) as string | undefined, user: (a.flags.u ?? a.flags.user) as string | undefined }
      const code = a.flags.it || (a.flags.i && a.flags.t) || a.flags.t ? await interactive(box, command, opts) : await streamed(box, command, opts)
      process.exit(code)
    }

    case "shell":
    case "sh": {
      const box = await get(args[0])
      const shell = "if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi"
      process.exit(await interactive(box, ["/bin/sh", "-c", shell], { user: (a.flags.u ?? a.flags.user) as string | undefined }))
    }

    case "pause":
    case "resume":
    case "start":
    case "stop": {
      if (!args.length) die(`sbx ${cmd} <sandbox>`)
      for (const id of args) {
        const box = await get(id)
        await box[cmd]()
        print(box.info, () => console.log(`${bold(box.name)} ${stateOf(box.info)} ${dim(`in ${ms(box.info.tookMs)}${cmd === "pause" ? " — memory kept" : ""}${cmd === "resume" && box.info.ram !== "none" ? "" : ""}`)}`))
      }
      return
    }

    case "fork": {
      const box = await get(args[0])
      const t0 = performance.now()
      const copy = await box.fork({ name: a.flags.name as string | undefined })
      return print(copy.info, () => console.log(`${bold(copy.name)} running, a copy of ${box.name} ${dim(`(${box.name} paused ${ms(copy.info.pauseMs)}, copy ready in ${ms(Math.round(performance.now() - t0))})`)}`))
    }

    case "rm":
    case "destroy": {
      if (!args.length) die("sbx rm <sandbox>…")
      for (const id of args) {
        await (await get(id)).destroy()
        if (!json) console.log(`${id} removed`)
      }
      return
    }

    case "snapshot": {
      const box = await get(args[0])
      const s = await box.snapshot({ name: a.flags.name as string | undefined, memory: !a.flags["disks-only"] })
      return print(s, () => console.log(`${bold(s.name ?? s.id)} ${dim(`(${s.kind}, ${s.state})`)}\n  sbx run --from ${s.name ?? s.id}`))
    }

    case "snapshots": {
      if (args[0] === "rm") {
        for (const id of args.slice(1)) {
          await snapshots.delete(id, client)
          console.log(`${id} removed`)
        }
        return
      }
      const list = await snapshots.list(client)
      return print(list, () => {
        if (!list.length) return console.log(dim("no snapshot yet — sbx snapshot <sandbox>"))
        table([["NAME", "ID", "KIND", "STATE", "OF", "IMAGE", "AGE"], ...list.map((s) => [s.name ?? "", s.id, s.kind, s.state, s.sandboxId, s.image, age(s.createdAt)])])
      })
    }

    case "build": {
      const [image, file] = args
      if (!image || !file) die("sbx build <image> <script.sh>")
      const b = await client.call<{ id: string }>("POST", "/v1/builds", { image, script: readFileSync(file, "utf8"), size: a.flags.size })
      let cursor = 0
      for (;;) {
        const st = await client.call<{ state: string; log: string; cursor: number; error?: string }>("GET", `/v1/builds/${b.id}?cursor=${cursor}`)
        if (st.log && !json) process.stdout.write(st.log)
        cursor = st.cursor
        if (st.state === "ready") return print(b, () => console.log(`\n${bold(b.id)} ready\n  sbx run --from ${b.id}`))
        if (st.state === "failed") die(`build ${b.id} failed: ${st.error}`)
        await new Promise((r) => setTimeout(r, 1000))
      }
    }

    case "cp": {
      const [src, dst] = args.map((s) => splitTarget(s ?? ""))
      if (!src || !dst || (!src.box && !dst.box) || (src.box && dst.box)) die("sbx cp <local> <sandbox>:/path   or   sbx cp <sandbox>:/path <local>")
      if (dst.box) {
        const box = await get(dst.box)
        const mode = (statSync(src.path).mode & 0o777).toString(8)
        const r = await box.files.write(dst.path, createReadStream(src.path), { mode })
        if (!json) console.log(`${r.bytes} bytes → ${dst.box}:${dst.path}`)
      } else {
        const box = await get(src.box)
        const data = await box.files.read(src.path)
        if (dst.path === "-") process.stdout.write(data)
        else await new Promise<void>((res, rej) => createWriteStream(dst.path).on("error", rej).end(data, res))
        if (!json && dst.path !== "-") console.log(`${data.length} bytes → ${dst.path}`)
      }
      return
    }

    case "port-forward":
    case "forward": {
      const box = await get(args[0])
      const spec = args[1] ?? die("sbx port-forward <sandbox> [local:]port")
      const [local, remote] = spec.includes(":") ? spec.split(":").map(Number) : [Number(spec), Number(spec)]
      const srv = net.createServer(async (sock) => {
        try {
          const up = await box.connect(remote!)
          sock.pipe(up).pipe(sock)
          up.on("error", () => sock.destroy())
          sock.on("error", () => up.destroy())
        } catch (err) {
          process.stderr.write(`sbx: ${err instanceof Error ? err.message : err}\n`)
          sock.destroy()
        }
      })
      srv.listen(local, "127.0.0.1", () => console.log(`localhost:${local} → ${box.name}:${remote}  ${dim("(Ctrl-C to stop)")}`))
      return await new Promise(() => {})
    }

    case "logs": {
      const box = await get(args[0])
      return process.stdout.write(await box.logs(Number(a.flags.n ?? a.flags.lines ?? 200)))
    }

    case "usage":
      return console.log(JSON.stringify(await (await get(args[0])).usage(), null, 2))

    case "host":
    case "info": {
      const h = await client.call<Record<string, any>>("GET", "/v1/host")
      return print(h, () => {
        console.log(`${bold("spunto-sandboxd")} ${h.version} ${dim(`agent ${h.agent ?? "none"}`)}`)
        console.log(`kernel     ${h.kernel}`)
        console.log(`sandboxes  ${h.running ?? 0} running of ${h.sandboxes ?? 0}`)
        if (h.vmsSliceRamMb !== undefined) console.log(`memory     ${(h.vmsSliceRamMb / 1024).toFixed(1)} GB held by the boxes`)
        if (h.poolFreeGb !== undefined) console.log(`pool       ${h.poolFreeGb} GB free${h.memoryFilesGb ? `, ${h.memoryFilesGb} GB of saved memory` : ""}`)
        if (h.network) console.log(`network    ${h.network.perBoxMbit} Mbit/s per box, ${h.network.totalMbit} shared, SMTP ${h.network.smtp}`)
      })
    }

    case "sizes": {
      const sizes = await client.call<{ id: string; label: string }[]>("GET", "/v1/sizes")
      return print(sizes, () => sizes.forEach((s) => console.log(`${s.id.padEnd(8)} ${dim(s.label)}`)))
    }

    default:
      die(`unknown command ${cmd} — sbx help`)
  }
}

main().catch((err) => {
  if (err instanceof SandboxApiError) die(err.message, err.status === 404 ? 3 : 1)
  die(err instanceof Error ? err.message : String(err))
})
