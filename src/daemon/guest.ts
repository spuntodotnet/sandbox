/**
 * What the daemon puts in a box beside the engine's init: its bootstrap — a few lines of busybox
 * shell that start the guest agent — and the agent itself, handed through MMDS at every boot.
 *
 * Nothing of it is baked into an image's disk (the engine's unpacker writes only its own init), so
 * the boxes of a machine get a new agent at their next cold boot after an upgrade of the daemon, and
 * a box resumed from its RAM keeps running the one it had.
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"
import { AGENT_ADDR, AGENT_FILE, AGENT_PORT } from "./config"

/**
 * The box's main process, run by the guest's init (`sh -c`, with the box's env) and restarted if it
 * exits. The agent comes from MMDS (`/sandbox/agent`, gzip, base64 in lines) when this disk does not
 * have its version yet, and is kept on the disk: a box loaded from a snapshot made under an older
 * daemon still finds one. Its argument `agent.mjs` is for the init, which signals the process whose
 * command line says so (it was written for Spunto's own agent).
 */
export const BOOTSTRAP = String.raw`B=/.spunto/busybox
D=/var/lib/spunto-sandbox
$B mkdir -p $D && $B chmod 700 $D
body() { $B tr -d '\r' | $B sed '1,/^$/d'; }
tok=$(printf 'PUT /latest/api/token HTTP/1.0\r\nX-metadata-token-ttl-seconds: 300\r\n\r\n' | $B timeout 2 $B nc 169.254.169.254 80 | body)
get() {
  printf 'GET /sandbox/%s HTTP/1.0\r\nX-metadata-token: %s\r\n\r\n' "$1" "$tok" | $B timeout 30 $B nc 169.254.169.254 80 > $D/mmds.http || return 1
  $B head -1 $D/mmds.http | $B grep -q ' 200 ' || return 1
  body < $D/mmds.http
}
v=$(get version) || v=
if [ -n "$v" ] && [ ! -x $D/agent-$v ]; then
  sum=$(get sha256) || sum=
  get agent > $D/agent.b64 && $B base64 -d < $D/agent.b64 | $B gunzip > $D/agent-$v.new &&
    [ "$($B sha256sum $D/agent-$v.new | $B cut -d' ' -f1)" = "$sum" ] &&
    $B chmod 755 $D/agent-$v.new && $B mv $D/agent-$v.new $D/agent-$v ||
    echo "sbx: the agent $v from MMDS did not check out"
  $B rm -f $D/agent.b64 $D/agent-$v.new $D/mmds.http
fi
a=$D/agent-$v
[ -n "$v" ] && [ -x "$a" ] || a=$($B ls -t $D/agent-* 2>/dev/null | $B head -1)
if [ ! -x "$a" ]; then echo "sbx: no agent here (none in MMDS, none on this disk)"; exec $B sleep 5; fi
exec "$a" serve agent.mjs
`

type Agent = { version: string; sha256: string; b64: string }
let agent: Agent | null | undefined

/** The agent binary: bundled with the daemon (scripts/build.mjs), or `SBX_AGENT_FILE`, or guest/bin from the source tree. */
export function loadAgent(): Agent | null {
  if (agent !== undefined) return agent
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [AGENT_FILE, join(here, "sbx-agent"), join(here, "../../guest/bin/sbx-agent")].filter(Boolean)
  const bundled = (globalThis as { __SBX_AGENT__?: { b64: string } }).__SBX_AGENT__
  let bin: Buffer | null = null
  if (bundled) bin = Buffer.from(bundled.b64, "base64")
  else for (const c of candidates) if (existsSync(c)) bin = readFileSync(c)
  if (!bin) return (agent = null)
  const sha256 = createHash("sha256").update(bin).digest("hex")
  // In lines: busybox's sed and base64 read it line by line.
  const b64 = gzipSync(bin, { level: 9 }).toString("base64").replace(/.{1,76}/g, "$&\n")
  return (agent = { version: sha256.slice(0, 16), sha256, b64 })
}

/** What the engine adds to MMDS for a box: the agent at a boot; at a load, its version only (it runs already). */
export function guestData(at: "boot" | "load"): Record<string, string> | undefined {
  const a = loadAgent()
  if (!a) return undefined
  return at === "boot" ? { version: a.version, sha256: a.sha256, agent: a.b64 } : { version: a.version, sha256: a.sha256 }
}

export const AGENT = { addr: AGENT_ADDR, port: AGENT_PORT }
