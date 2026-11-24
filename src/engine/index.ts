/**
 * Spunto Sandbox's engine: Firecracker microVMs on this machine, one per sandbox, whose RAM a pause
 * keeps and a start loads back. Run as root on the host (a systemd service): it needs /dev/kvm, ZFS,
 * network namespaces and systemd. The VMMs do not: each runs under Firecracker's jailer, in a chroot
 * and with a uid of its own. Everything lives under three roots:
 *
 *   /opt/spunto-fc       binaries (firecracker, jailer, snapshot-editor, crane, tini, busybox) and kernels
 *   /var/lib/spunto-fc   registry.json (root only: it holds each box's env, token included),
 *                        archives in transit, builds' logs; mem/ is where the memory datasets mount,
 *                        jail/ where each VMM's chroot is
 *   <pool>/spunto        ZFS: images/<id> (an OCI image unpacked into ext4, @ready), vms/<handle>-root
 *                        (a clone of it), ws/<sandboxId> (/workspace, kept across rebuilds), and
 *                        mem/<handle|ref>: RAM snapshots of boxes and templates, a filesystem each
 *
 * The box itself: the image's filesystem plus `/.spunto/` (tini as PID 1, a static busybox, and
 * `init`, guest.ts), booted with a shared kernel. Its main process is the caller's `bootstrap`, with
 * the env it reads from **MMDS** — never from the disk or the command line: two clones of one RAM
 * snapshot get one token each, and `init` notices a new generation in MMDS after every start.
 *
 * Network: every box has its own network namespace with the same inside (tap0 172.16.0.1, guest
 * 172.16.0.2 — a snapshot can be loaded anywhere), and a veth to the host on its own /30 of
 * 10.89.0.0/16. Out to the internet only: no box reaches the host, another box or a private
 * network. Nothing comes in but what the host opens into the box's namespace.
 *
 * One engine per machine: its state is the process's (the registry file, the locks), configured by
 * the environment (`SPUNTO_FC_*`, config.ts). Modules, in the order a box meets them:
 *
 *   config      paths, sizes, every SPUNTO_FC_* setting
 *   registry    registry.json, and one operation at a time per box (`serial`)
 *   admission   memory: whether a box may start now (`capacity` otherwise)
 *   zfs         datasets, zvols, the pool's room
 *   images      OCI image → ext4 zvol, unpacked inside a throwaway microVM
 *   network     a netns, a tap and a veth per box; NAT, egress rules, fair shaping, no SMTP
 *   jail        the jailer: a chroot and a uid per VMM, CPU limits
 *   vmm         Firecracker's API, boot, load, the guest's MMDS
 *   guest       the guest's init and the unpacker's (baked into every image's disk)
 *   memory      memory files: one ZFS filesystem per box or template, the scratch they are written to
 *   snapshots   pause, freeze, fork, Diff/Full, clean shutdowns
 *   lifecycle   create and destroy
 *   builds      a recipe in a builder microVM
 *   archive     a stopped box's disks out to a bucket and back
 *   usage       what each box uses, measured on the host
 *   host        host setup at first use (kernel, jailer, datasets, network rules)
 *   engine      the operations
 *
 * `§ n` in comments: a section of the design notes this engine grew from (Spunto's RFC 0039, where
 * each choice was measured on real machines) — summarized on the documentation's Design notes page.
 */

export { engine, netnsOf } from "./engine"
export { BIN, GUEST_IP, STATE, DATASET, SLICE } from "./config"
export * from "./types"
export { IFB_UP, IFB_DOWN, GUEST_KERNEL, SIZES, sizeOf, rootSizeFor, maxDiskGb, bytesOf } from "./config"
export { JAILER_RELEASE, uidOf, jailIdOf, blockDeviceOf, cpuLimits } from "./jail"
export { ensureHost, KERNEL, kernelId } from "./host"
export { firecrackerHostInfo as hostInfo, firecrackerHostInfo, boxUsage, unitCgroups, objsetStats, type BoxUsage } from "./usage"
export { netOf, uplinkAddresses, tapOwnerOf, netShaping, netClassOf, redirectsTo, smtpOpen, BLOCKED_DESTINATIONS } from "./network"
export { GUEST_INIT, UNPACK_INIT } from "./guest"
export { IMAGE_REF, ConsoleTail, repositoryOf } from "./images"
export { BALLOON, kernelArgs, deathOf, setGuestData } from "./vmm"
export { admitMibFor, memoryRoom, droppableCache, overcommitRatio, announcedFits } from "./admission"
export { scratchProblem, inMem, vmmPath } from "./memory"
export { canLoad, sameKernel, ramKindOf, migrateLegacyMemory } from "./snapshots"
export { BuildLog, buildRefOf } from "./builds"
export { compressAndUpload, downloadInto, humanBytes, upload } from "./artifact"

import { held } from "./admission"
import { buildRuns } from "./builds"
import { resetHost } from "./host"
import { imageIdOf } from "./images"
import { forgive, sweepMem } from "./memory"
import { resetRegistry, serial } from "./registry"
import { migrateLegacyMemory, resetMigration } from "./snapshots"
import { mmdsData } from "./vmm"

/** For tests only. */
export const _test = {
  mmdsData,
  held,
  sweepMem,
  migrateLegacyMemory,
  serial,
  forgive,
  imageIdOf,
  buildRuns,
  /** As after a restart of the daemon: registry read again, host set up again. */
  restart() {
    resetRegistry()
    resetHost()
    resetMigration()
  },
}
