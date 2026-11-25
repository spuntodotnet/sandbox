# Spunto Sandbox

**Firecracker microVMs on your own Linux machine.** An OCI image in, a microVM in seconds. A pause
keeps the memory, a resume brings every process back where it was, a fork copies a running VM.

```sh
curl -fsSL https://sandbox.spunto.net/install.sh | sudo sh

sbx run ubuntu:24.04 --name hello        # a microVM, from any Docker image
sbx exec hello -- uname -a
sbx pause hello                          # RAM written, nothing runs, nothing is lost
sbx resume hello                         # same processes, back in milliseconds
sbx fork hello --name hello-2            # a second VM, same memory, same processes
```

```ts
import { Sandbox } from "@spunto/sandbox"

const box = await Sandbox.create({ image: "node:24" })
const { stdout } = await box.exec("node -v")
await box.pause()             // RAM kept, nothing running
await box.resume()            // same processes, back in milliseconds
const copy = await box.fork() // a second box, same memory
```

It is the engine that runs [Spunto Cloud](https://spunto.net) in production. It was written there
first; this repository is that code, with a daemon, a CLI and an SDK around it so that it runs on
your machine without the rest of Spunto.

## What a box is

- **A microVM**, not a container: its own kernel (ours, built reproducibly, Docker works inside),
  its own disks, its own network namespace. Each VMM runs under Firecracker's **jailer** — a chroot,
  a uid of its own, no capability.
- **Made from any OCI image**, pulled and unpacked inside a throwaway microVM (an image is an archive
  from anywhere: the host never untars it).
- **Two disks**: `/` (a copy-on-write clone of the image) and `/workspace` (kept across rebuilds). ZFS
  underneath: a clone costs nothing, a box only takes what it writes.
- **Out to the internet only**: no box reaches the host, another box, a private network or a cloud's
  metadata server; outgoing SMTP is closed. Nothing comes in: the host reaches the box from its
  namespace, and `sbx port-forward` / `box.connect(port)` are how you reach a port.
- **Bounded**: CPU (a quota and an equal weight per box), network (a ceiling per box, equal shares
  when the uplink is full), memory (a box only starts if the machine has room for it — never one
  the OOM killer would take a minute later).

## Measured

On a GCP `n2-standard-8` with nested virtualization (so slower than bare metal), `small` boxes:

| | |
|---|---|
| `sbx run ubuntu:24.04`, first time (pull + unpack + boot) | 7.6 s |
| `sbx run ubuntu:24.04`, image already there | 2.5 s |
| `sbx pause` (RAM written) / `sbx resume` (agent answering) | 0.8 s / 0.34 s |
| `sbx fork` of a running box: source paused / copy running | 63 ms / 1.2 s |
| A box from a memory snapshot (daemon side) | 0.36 s |

On Spunto Cloud's bare-metal machines, a resume is 55 to 77 ms on the daemon's side. The design
notes, and every number with how it was measured: [docs](https://sandbox.spunto.net/docs/design).

## Requirements

- Linux **x86_64** with **KVM** (`/dev/kvm`: bare metal, or a cloud VM with nested virtualization)
- **systemd**, cgroup v2
- **ZFS**: a pool of yours, or `--create-pool 100G` for one in a file (to try it)
- root, for the daemon (the VMMs themselves run unprivileged, each jailed)

Not macOS, not ARM — not yet.

## In this repository

| | |
|---|---|
| `src/engine/` | the engine: ZFS, the jailer, networks, the guest's init, snapshots, forks, builds |
| `src/daemon/` | `spunto-sandboxd`: the engine behind a REST API on a unix socket ([openapi.yaml](openapi.yaml)) |
| `src/client/` | `@spunto/sandbox`, the TypeScript SDK |
| `src/cli/` | `sbx` |
| `guest/` | `sbx-agent`, the static Go binary in every box (exec, terminals, files, ports) — [protocol](guest/protocol.md) |
| `kernel/` | the guest kernel's config and its reproducible build |
| `docs/` | the documentation site (fumadocs) |
| `install.sh` | the installer |

```sh
npm ci && npm test          # unit tests: the engine against a fake host, the agent for real
npm run build               # dist/: sandboxd.mjs, sbx.mjs, sbx-agent (needs Go), client.mjs, engine.mjs
scripts/up.sh && scripts/try.sh   # a throwaway GCP machine with KVM and ZFS, this tree installed on it
```

## License

[Apache-2.0](LICENSE). Built on [Firecracker](https://github.com/firecracker-microvm/firecracker).
