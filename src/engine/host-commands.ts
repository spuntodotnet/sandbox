import { execFile } from "node:child_process"

import { SandboxError } from "./types"

// ── Host commands ───────────────────────────────────────────────────────────

export function run(cmd: string, args: string[], opts: { timeoutMs?: number; input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: opts.timeoutMs ?? 60_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new SandboxError(`${cmd} ${args.join(" ")}: ${(stderr || err.message).trim().slice(-2000)}`))
      else resolve(stdout)
    })
    if (opts.input !== undefined) child.stdin?.end(opts.input)
  })
}
export const sh = (script: string, timeoutMs?: number) => run("bash", ["-o", "pipefail", "-ec", script], { timeoutMs })
export const ok = (p: Promise<unknown>) => p.then(() => true, () => false)
export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export const ms = (t0: number) => Math.round(performance.now() - t0)
