# Spunto Sandbox

Firecracker microVMs on a Linux machine of one's own: the engine of Spunto Cloud (extracted from
`coderhammer/spunto`, `apps/runtime-apps/src/providers/firecracker.ts`, on 2026-11-24), with a daemon
(`spunto-sandboxd`), a CLI (`sbx`), a TypeScript SDK (`@spunto/sandbox`) and a guest agent (Go).
README.md says what is where.

## Rules

- **Spunto consumes `src/engine` by version** (a release tarball vendored in its `apps/runtime-apps`):
  the engine's operations, its env variables (`SPUNTO_FC_*`), its paths (`/opt/spunto-fc`,
  `/var/lib/spunto-fc`, `<pool>/spunto`), its unit names (`spunto-fc-<handle>`) and its MMDS layout
  are what running machines hold. Never rename them; add, don't change.
- **The guest's init and the unpacker's are baked into every image's disk** (`imageIdOf`): a byte
  changed makes every machine unpack every image again. A test pins their hash: update it on purpose,
  and say so in the release notes.
- What the standalone product needs from a box goes through the **bootstrap and MMDS**
  (`src/daemon/guest.ts`, `setGuestData`), never through the init.
- The engine is a process-wide singleton configured by the environment: one engine per machine.
- Comments say why, in the voice of the existing code; `§ n` refers to the design notes (Spunto's
  RFC 0039), summarized in `docs/content/docs/design.mdx`.

## Working on it

```sh
npm ci && npm test          # the engine against a fake host (vitest), the agent for real if built
npm run build               # dist/ (Go needed for guest/: https://go.dev/dl)
npm run typecheck
scripts/up.sh               # a GCP machine with KVM + ZFS (4 h, deletes itself)
scripts/try.sh -- sbx ls    # this tree built, installed on it, a command run there
```

Nothing that touches a box is proven without a real machine: run `scripts/try.sh` before saying it works.

## On a Spunto worker

The Spunto project « Spunto Sandbox » starts the docs site by itself (`scripts/init.sh`, `scripts/start.sh`, under
process-compose: `pc attach`, `pc process logs site|docs -f`):

| | |
|---|---|
| `:3000` | **the build**, as sandbox.spunto.net serves it (static export + `install.sh`, `scripts/serve.mjs`): the link to give the human who tests. Rebuilt by `scripts/start.sh` when `docs/` or `install.sh` changed, and at the end of each turn (Stop hook) |
| `:5173` | `next dev`, hot reload: to iterate |

A worker has **no KVM**: the daemon and boxes run on a throwaway GCP machine — `scripts/up.sh` then
`scripts/try.sh` (above). gcloud is signed in by `scripts/start.sh` as `sandbox-e2e`, a service account that may
only make, reach and delete machines and disks named `sbx-*` (its key: the project's secret
`GCP_SERVICE_ACCOUNT_KEY_B64`). Go is in `~/.local/go/bin` (`scripts/init.sh`).

## Releases

A tag `v<version>` (= package.json) → `.github/workflows/release.yml`: the tarball
`spunto-sandbox-linux-x64.tar.gz` (sandboxd.mjs, sbx.mjs, sbx-agent) and the npm tarball, as release
assets, and that npm tarball published as `@spunto/sandbox` (trusted publishing: no npm token, the
workflow's OIDC identity; 0.1.1 was published by hand to create the package).
