/**
 * spunto-sandboxd: the engine, its API on a unix socket (and TCP when asked), the guest agent handed
 * to every box. Runs as root under systemd (install.sh writes the unit). Restarting it leaves every
 * box running: their VMMs are units of their own.
 */

import { execFileSync } from "node:child_process"
import { chmodSync, chownSync, rmSync } from "node:fs"
import { ensureHost, setGuestData } from "../engine"
import { DAEMON_VERSION, LISTEN, API_TOKEN, SOCKET, SOCKET_GROUP } from "./config"
import { guestData, loadAgent } from "./guest"
import { server } from "./http"

function groupId(name: string): number | undefined {
  try {
    const line = execFileSync("getent", ["group", name], { encoding: "utf8" }).trim()
    return Number(line.split(":")[2]) || undefined
  } catch {
    return undefined
  }
}

export async function main() {
  const agent = loadAgent()
  if (!agent) console.warn("[sandboxd] no guest agent found (SBX_AGENT_FILE, or guest/bin/sbx-agent): boxes will boot, but exec, files and ports will not answer")
  setGuestData((at) => guestData(at))

  rmSync(SOCKET, { force: true })
  const local = server({ tcp: false })
  await new Promise<void>((resolve, reject) => local.listen(SOCKET, resolve).once("error", reject))
  const gid = SOCKET_GROUP ? groupId(SOCKET_GROUP) : undefined
  chmodSync(SOCKET, gid ? 0o660 : 0o600)
  if (gid) chownSync(SOCKET, 0, gid)
  console.log(`[sandboxd] ${DAEMON_VERSION} (agent ${agent?.version ?? "none"}) listening on ${SOCKET}${gid ? ` (group ${SOCKET_GROUP})` : ""}`)

  if (LISTEN) {
    if (!API_TOKEN) throw new Error("SBX_LISTEN needs SBX_API_TOKEN: the API runs any command in any sandbox")
    const [host, port] = LISTEN.includes(":") ? [LISTEN.slice(0, LISTEN.lastIndexOf(":")), Number(LISTEN.slice(LISTEN.lastIndexOf(":") + 1))] : ["0.0.0.0", Number(LISTEN)]
    const tcp = server({ tcp: true })
    await new Promise<void>((resolve, reject) => tcp.listen(port, host, resolve).once("error", reject))
    console.log(`[sandboxd] also on tcp ${host}:${port} (bearer token)`)
  }

  // Now rather than at the first operation: the kernel fetched, the datasets and the network made,
  // what the previous daemon left halfway picked up again.
  ensureHost().then(
    () => console.log("[sandboxd] host ready"),
    (err) => console.error(`[sandboxd] host setup failed (retried at the next operation): ${err instanceof Error ? err.message : err}`),
  )
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => process.exit(0))
}

main().catch((err) => {
  console.error(`[sandboxd] ${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
