import { readFileSync } from "node:fs"

import { SandboxError } from "./types"
import { GUEST_IP, GW_IP, GW_MAC, IFB_DOWN, IFB_UP, NET_FIRST, NET_LIMITS, SYSFS_NET, positiveEnv } from "./config"
import { ok, run, sh } from "./host-commands"
import { reg } from "./registry"

// ── Network ─────────────────────────────────────────────────────────────────

/** Box n's /30: the host side is .1, the namespace side .2. */
export function netOf(n: number) {
  const base = (10 << 24) | (89 << 16) | (n * 4)
  const ip = (x: number) => [x >>> 24, (x >>> 16) & 255, (x >>> 8) & 255, x & 255].join(".")
  return { host: ip(base + 1), ns: ip(base + 2), hostIf: `fcv${n}`, netns: `fc${n}` }
}

/** Networks of boxes being destroyed (out of the registry already, not torn down yet), and of unpackers. */
export const releasing = new Set<number>()

export function freeNet(): number {
  const builds = Object.values(reg().builds).filter((b) => b.state === "running")
  const used = new Set([...Object.values(reg().vms).map((v) => v.net), ...builds.map((b) => b.net), ...releasing])
  for (let n = NET_FIRST; n < 16384; n++) if (!used.has(n)) return n
  throw new SandboxError("no network left on this machine")
}

export let uplink: string | null = null
export async function uplinkDev(): Promise<string> {
  if (process.env.SPUNTO_FC_UPLINK) return process.env.SPUNTO_FC_UPLINK
  uplink ??= /\bdev (\S+)/.exec(await run("ip", ["-4", "route", "show", "default"]))?.[1] ?? null
  if (!uplink) throw new SandboxError("no default route on this machine")
  return uplink
}

/** Insert an iptables rule unless it is there (`-C`). */
export async function rule(table: string, chain: string, spec: string[], position = 1) {
  if (await ok(run("iptables", ["-t", table, "-C", chain, ...spec]))) return
  await run("iptables", ["-t", table, "-I", chain, String(position), ...spec])
}

/**
 * What a box never reaches, even through the uplink: private networks (the provider's LAN, a VPN
 * route, another tenant), CGNAT, and link-local — 169.254.169.254 is a cloud's metadata server:
 * on a Google Cloud VM lent to the fleet, its service account's credentials.
 */
export const BLOCKED_DESTINATIONS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16"]

/** The IPv4 addresses of `ip -4 -o addr show dev <uplink>`. Pure. */
export function uplinkAddresses(ipAddr: string): string[] {
  return [...ipAddr.matchAll(/\binet (\d+\.\d+\.\d+\.\d+)\//g)].map((m) => m[1]!)
}

/**
 * Host-wide, once per daemon start: NAT out of the uplink for 10.89.0.0/16, and the forward rules.
 * Docker's FORWARD policy is DROP and its DOCKER-USER chain runs first: the rules go there.
 * The host's own addresses are INPUT, dropped below; Docker's published ports are DNAT'd to its
 * bridges, so they hit the private ranges (or the final drop) — except those reached on the
 * uplink's own addresses, which the internet reaches too: on a machine that also hosts the platform
 * (test-2, its Traefik on 80/443), a box dials the API there.
 */
export async function ensureHostNetwork() {
  const out = await uplinkDev()
  await run("sysctl", ["-qw", "net.ipv4.ip_forward=1"])
  await rule("nat", "POSTROUTING", ["-s", "10.89.0.0/16", "-o", out, "-j", "MASQUERADE"])
  const chain = (await ok(run("iptables", ["-S", "DOCKER-USER"]))) ? "DOCKER-USER" : "FORWARD"
  // Each one inserted at the top, so the last written runs first: the private ranges, then accept
  // out, accept replies, and drop everything else from a box.
  await rule("filter", chain, ["-i", "fcv+", "-j", "DROP"])
  await rule("filter", chain, ["-o", "fcv+", "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT"])
  // Nothing comes in, whatever the chain's policy: Docker's DROP said so on its machines, but a host
  // without Docker (Canada since 2026-10-25) forwards with ufw's ACCEPT — a VPN peer or a neighbour
  // routing 10.89/16 through the host would reach a box. Not a reply, then dropped; written so as
  // not to depend on its place, since a machine that has the rules above only gets this one, on top.
  await rule("filter", chain, ["-o", "fcv+", "-m", "conntrack", "!", "--ctstate", "RELATED,ESTABLISHED", "-j", "DROP"])
  await rule("filter", chain, ["-i", "fcv+", "-o", out, "-j", "ACCEPT"])
  // Out of a namespace, only its own /30's address (the guest's is SNATed to it): the same as
  // `guardSpoof`, host-wide, for a namespace from before it.
  await rule("filter", chain, ["-i", "fcv+", "!", "-s", "10.89.0.0/16", "-j", "DROP"])
  for (const net of BLOCKED_DESTINATIONS) await rule("filter", chain, ["-i", "fcv+", "-d", net, "-j", "DROP"])
  // Above the private ranges: a port Docker publishes on the uplink's address, as the internet sees it.
  for (const ip of uplinkAddresses(await run("ip", ["-4", "-o", "addr", "show", "dev", out])))
    await rule("filter", chain, ["-i", "fcv+", "-m", "conntrack", "--ctstate", "DNAT", "--ctorigdst", ip, "-j", "ACCEPT"])
  // Nothing on the host is a box's business (the API is reached on the internet, like anywhere).
  await rule("filter", "INPUT", ["-i", "fcv+", "-j", "DROP"])
  // A kernel without ifb or HTB (a BYOC owner's machine) runs its boxes unshaped, and says so.
  await ensureShapingHost().catch((err) => console.error(`[firecracker] network limits off: ${err instanceof Error ? err.message : err}`))
}

/**
 * Nothing from the guest reaches its namespace — except the replies to what the host opens there
 * (the knock after a resume, § 4.4). Checked at every spawn: a namespace made before this rule has
 * it from its next start.
 */
export const REPLIES_FROM_GUEST = ["INPUT", "-i", "tap0", "-m", "conntrack", "--ctstate", "ESTABLISHED", "-j", "ACCEPT"]

/**
 * The tap, owned by the VMM's uid (`owner`): a VMM without a capability may only open a tap that is
 * its own. A box's VMM is never running while this runs (a spawn).
 */
export const tapScript = (owner?: number) => `
      ip tuntap add tap0 mode tap${owner === undefined ? "" : ` user ${owner} group ${owner}`}
      ip link set tap0 address ${GW_MAC}
      ip addr add ${GW_IP}/30 dev tap0
      ip link set tap0 up`

/** The uid a tap belongs to, from `ip -d link show` (`tun type tap … user 2000000300 …`) — undefined: nobody's. Pure. */
export function tapOwnerOf(ipLink: string) {
  const m = /\btun type tap\b.*?\buser (\d+)/.exec(ipLink)
  return m ? Number(m[1]) : undefined
}

/**
 * The box's namespace, tap and veth — idempotent: a reboot of the host loses them. A tap made for
 * another uid (root's, before the jailer; a network number another box had) is made again for this
 * one: the rules on `tap0` are by name, they stay.
 */
export async function ensureNet(vm: { net: number; sandboxId?: string }, owner?: number) {
  await makeNet(vm, owner)
  await guardNet(vm.net, vm.sandboxId)
}

export async function makeNet(vm: { net: number }, owner?: number) {
  const n = netOf(vm.net)
  const tap = await run("ip", ["netns", "exec", n.netns, "ip", "-d", "link", "show", "tap0"]).catch(() => null)
  if (tap !== null) {
    if (!(await ok(run("ip", ["netns", "exec", n.netns, "iptables", "-C", ...REPLIES_FROM_GUEST])))) {
      await run("ip", ["netns", "exec", n.netns, "iptables", "-I", ...REPLIES_FROM_GUEST.slice(0, 1), "1", ...REPLIES_FROM_GUEST.slice(1)])
    }
    if (owner !== undefined && tapOwnerOf(tap) !== owner) await sh(`ip netns exec ${n.netns} sh -ec '
      ip link del tap0${tapScript(owner)}
    '`)
    return
  }
  await sh(`
    ip netns del ${n.netns} 2>/dev/null || true
    ip link del ${n.hostIf} 2>/dev/null || true
    ip netns add ${n.netns}
    ip link add ${n.hostIf} type veth peer name veth0 netns ${n.netns}
    ip addr add ${n.host}/30 dev ${n.hostIf}
    ip link set ${n.hostIf} up
    ip netns exec ${n.netns} sh -ec '
      ip link set lo up
      ip addr add ${n.ns}/30 dev veth0
      ip link set veth0 up
      ip route add default via ${n.host}${tapScript(owner)}
      sysctl -qw net.ipv4.ip_forward=1
      iptables -t nat -A POSTROUTING -o veth0 -s ${GUEST_IP} -j SNAT --to-source ${n.ns}
      iptables -A ${REPLIES_FROM_GUEST.join(" ")}
      iptables -A INPUT -i tap0 -j DROP
    '
  `)
}

export async function removeNet(vm: { net: number }) {
  const n = netOf(vm.net)
  await sh(`ip netns del ${n.netns} 2>/dev/null || true; ip link del ${n.hostIf} 2>/dev/null || true`)
  await unshape(vm.net)
}

// ── Network: a fair share of the uplink, and no SMTP (RFC 0039 § 22) ─────────
//
// Every box's traffic goes through two IFB devices of the machine's: what it sends (its veth's
// ingress, redirected) through `<prefix>u`, what it receives (its veth's egress) through `<prefix>d`.
// On each, one HTB: a parent at what the machine gives its boxes (`SPUNTO_FC_NET_TOTAL_MBIT`), and a
// class per box, all alike — a tiny guaranteed rate, the same quantum, the ceiling per box
// (`SPUNTO_FC_NET_MBIT`). Under the ceiling, a box is alone; when the parent is full, HTB lends what
// is left round-robin among the boxes that want it: equal parts per box, however many flows each has.
// The uplink's own qdisc (the host's traffic, the platform's on test-2) is never touched.

/** A box's class on both IFBs; 1:1 is the parent, 1:ffff what no box was found for. */
export const netClassOf = (net: number) => `1:${(net + 16).toString(16)}`

/**
 * The shaping, as `tc` arguments (pure): the per-box ceiling, and what the machine gives all of
 * them — `SPUNTO_FC_NET_TOTAL_MBIT`, else 95 % of the uplink's link speed (`/sys/class/net/<uplink>/speed`,
 * which a cloud VM often does not know: 1000 then). The total must be under what the machine really
 * has for the fair share to be ours: above it, the uplink's own queue (fq_codel: fair per flow, not
 * per box) is where packets wait.
 */
export function netShaping(linkMbit?: number) {
  const ceil = positiveEnv("SPUNTO_FC_NET_MBIT", 200)
  const total = positiveEnv("SPUNTO_FC_NET_TOTAL_MBIT", linkMbit && linkMbit > 0 ? Math.floor(linkMbit * 0.95) : 1000)
  // 5 ms at the rate, 32 KB at least: HTB's default burst (a tick's worth) undershoots at these rates.
  const burst = (mbit: number) => `${Math.max(32, Math.ceil((mbit * 1e6) / 8 / 200 / 1024))}k`
  // Above the largest packet: a veth carries GSO packets of up to 64 KiB (68 130 bytes seen on
  // Canada), and HTB's round-robin sends one packet per turn when its quantum is smaller — the box
  // with the bigger packets (one fast flow, against eight slower ones) then took 204 Mbit/s to its
  // neighbour's 139, both backlogged. At 128 KiB, it is bytes that are shared (RFC 0039 § 22).
  const htb = (rate: number, ceil: number) => ["htb", "rate", `${rate}mbit`, "ceil", `${ceil}mbit`, "burst", burst(ceil), "cburst", burst(ceil), "quantum", "131072"]
  return {
    ceil: Math.min(ceil, total),
    total,
    parent: ["parent", "1:", "classid", "1:1", ...htb(total, total)],
    box: (classid: string) => ["parent", "1:1", "classid", classid, ...htb(1, Math.min(ceil, total))],
  }
}

export let shaping: ReturnType<typeof netShaping> | null = null
/** Once per daemon start: the two IFBs, their HTB and the parent class (changed in place if the total moved). */
export async function ensureShapingHost() {
  shaping = null
  if (!NET_LIMITS) return
  let link: number | undefined
  try {
    link = Number(readFileSync(`${SYSFS_NET}/${await uplinkDev()}/speed`, "utf8").trim())
  } catch {}
  const s = netShaping(link)
  for (const dev of [IFB_UP, IFB_DOWN]) {
    if (!(await ok(run("ip", ["link", "show", dev])))) await run("ip", ["link", "add", dev, "type", "ifb"])
    await run("ip", ["link", "set", dev, "up"])
    if (!/\bhtb 1: root\b/.test(await run("tc", ["qdisc", "show", "dev", dev, "root"]).catch(() => ""))) {
      await run("tc", ["qdisc", "replace", "dev", dev, "root", "handle", "1:", "htb", "default", "ffff"])
    }
    await run("tc", ["class", "replace", "dev", dev, ...s.parent])
    await run("tc", ["class", "replace", "dev", dev, ...s.box("1:ffff")])
  }
  shaping = s
  console.log(`[firecracker] network: ${s.ceil} Mbit/s per box each way, ${s.total} Mbit/s shared equally between the boxes when full (${IFB_UP}, ${IFB_DOWN})`)
}

/**
 * A box's class on both IFBs, its leaf queue, and its veth redirected through them — idempotent
 * (`replace`), at every spawn and on every box's veth at the daemon's start: a box running from
 * before is shaped without a restart. The redirect marks each packet with the box's class
 * (`skbedit priority`), which HTB reads directly: no filter on the IFBs.
 */
export async function shape(net: number) {
  if (!NET_LIMITS || !shaping) return
  const { hostIf } = netOf(net)
  const classid = netClassOf(net)
  for (const dev of [IFB_UP, IFB_DOWN]) {
    await run("tc", ["class", "replace", "dev", dev, ...shaping.box(classid)])
    await run("tc", ["qdisc", "replace", "dev", dev, "parent", classid, "fq_codel"])
  }
  if (!/\bclsact\b/.test(await run("tc", ["qdisc", "show", "dev", hostIf, "clsact"]).catch(() => ""))) {
    await run("tc", ["qdisc", "add", "dev", hostIf, "clsact"])
  }
  for (const [hook, dev] of [["ingress", IFB_UP], ["egress", IFB_DOWN]] as const) {
    // `tc filter replace` of a matchall answers "File exists": one that is right stays, another goes first.
    if (redirectsTo(await run("tc", ["filter", "show", "dev", hostIf, hook]).catch(() => ""), classid, dev)) continue
    await run("tc", ["filter", "del", "dev", hostIf, hook, "pref", "1"]).catch(() => {})
    await run("tc", ["filter", "add", "dev", hostIf, hook, "pref", "1", "handle", "1", "matchall", "action", "skbedit", "priority", classid, "pipe", "action", "mirred", "egress", "redirect", "dev", dev])
  }
}

/** `tc filter show` has the box's redirect: its class, to that IFB. Pure. */
export function redirectsTo(show: string, classid: string, dev: string) {
  return new RegExp(`skbedit\\s+priority ${classid}\\b`).test(show) && show.includes(`Redirect to device ${dev})`)
}

/** A network given back: its classes go (the veth, gone, took its filters). */
export async function unshape(net: number) {
  if (!NET_LIMITS) return
  for (const dev of [IFB_UP, IFB_DOWN]) await run("tc", ["class", "del", "dev", dev, "classid", netClassOf(net)]).catch(() => {})
}

/**
 * Outgoing SMTP (port 25) is refused to every box: the first abuse of a compute paid by card,
 * stolen or not, and what gets a machine's address on blocklists — every neighbour's mail with it.
 * 465 and 587 stay open: they are submission, to an account at a mail provider, which
 * authenticates and rate-limits the sender (Google Cloud closes 25 only, the same way). Open again:
 * a whole machine (`SPUNTO_FC_SMTP=open`, a BYOC owner's choice for their own machine), or
 * sandbox by sandbox (`SPUNTO_FC_SMTP_ALLOW=<sandboxId>,…`), both applied at the daemon's next start.
 */
export function smtpOpen(sandboxId?: string) {
  if (process.env.SPUNTO_FC_SMTP === "open") return true
  const allow = (process.env.SPUNTO_FC_SMTP_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  return !!sandboxId && allow.includes(sandboxId)
}
/** In the box's namespace (gone with it: a network number given to another box takes nothing along). */
export const SMTP_RULE = ["FORWARD", "-i", "tap0", "-p", "tcp", "--dport", "25", "-j", "REJECT", "--reject-with", "tcp-reset"]
export async function guardSmtp(net: number, sandboxId?: string) {
  const { netns } = netOf(net)
  const has = await ok(run("ip", ["netns", "exec", netns, "iptables", "-C", ...SMTP_RULE]))
  if (smtpOpen(sandboxId)) {
    if (has) await run("ip", ["netns", "exec", netns, "iptables", "-D", ...SMTP_RULE])
  } else if (!has) await run("ip", ["netns", "exec", netns, "iptables", "-I", SMTP_RULE[0]!, "1", ...SMTP_RULE.slice(1)])
}

/**
 * Only the guest's own address leaves its namespace: nothing SNATs another source, and a box's root
 * forging one (a reflection off a resolver, in a victim's name) would leave the uplink with it —
 * the provider's network drops that on Google Cloud, not on every bare-metal machine.
 */
export const SPOOF_RULE = ["FORWARD", "-i", "tap0", "!", "-s", GUEST_IP, "-j", "DROP"]
export async function guardSpoof(net: number) {
  const { netns } = netOf(net)
  if (!(await ok(run("ip", ["netns", "exec", netns, "iptables", "-C", ...SPOOF_RULE])))) {
    await run("ip", ["netns", "exec", netns, "iptables", "-I", SPOOF_RULE[0]!, "1", ...SPOOF_RULE.slice(1)])
  }
}

/** What every box's network gets, at every spawn and at the daemon's start: its own source, its share, and no SMTP. */
export async function guardNet(net: number, sandboxId?: string) {
  await guardSpoof(net)
  await guardSmtp(net, sandboxId)
  await shape(net)
}
