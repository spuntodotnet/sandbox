/**
 * What the daemon keeps of its own, next to the engine's registry: the sandboxes it made (their name,
 * image, the env they were given — the engine stores theirs but never hands values back), the
 * snapshots, and the secret each box's agent token is derived from. One JSON file, root's alone.
 */

import { createHmac, randomBytes } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { STATE_DIR } from "./config"

export type SandboxRecord = {
  id: string
  name: string
  image: string
  size: string
  /** What the caller gave, without the token (derived: `tokenOf`). */
  env: Record<string, string>
  labels?: Record<string, string>
  /** A snapshot's or a build's id, or `fork:<sandbox id>`. */
  from?: string
  createdAt: string
}

export type SnapshotRecord = {
  id: string
  /** The engine's template ref. */
  ref: string
  sandboxId: string
  name?: string
  image: string
  size: string
  env: Record<string, string>
  /** `memory`: RAM and disks — a sandbox from it resumes, processes and all. `disks`: it boots. */
  kind: "memory" | "disks"
  createdAt: string
}

export type BuildRecord = { id: string; ref: string; image: string; size: string; createdAt: string }

type State = { secret: string; sandboxes: Record<string, SandboxRecord>; snapshots: Record<string, SnapshotRecord>; builds: Record<string, BuildRecord> }

let state: State | null = null
const file = () => join(STATE_DIR, "sandboxd.json")

export function db(): State {
  if (state) return state
  try {
    state = JSON.parse(readFileSync(file(), "utf8")) as State
  } catch {
    state = { secret: randomBytes(32).toString("hex"), sandboxes: {}, snapshots: {}, builds: {} }
    persist()
  }
  state.snapshots ??= {}
  state.builds ??= {}
  return state
}

export function persist() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = `${file()}.tmp`
  writeFileSync(tmp, JSON.stringify(db(), null, 2), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file())
}

/** A box's agent token: never stored, derived from the daemon's secret — a fork's copy gets its own. */
export const tokenOf = (sandboxId: string) => createHmac("sha256", db().secret).update(`agent:${sandboxId}`).digest("base64url")

/** Short ids people can type: 10 characters of [a-z0-9], starting with a letter. */
export function newId(prefix = "") {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
  const bytes = randomBytes(10)
  let id = alphabet[bytes[0]! % 26]!
  for (let i = 1; i < 10; i++) id += alphabet[bytes[i]! % alphabet.length]
  return `${prefix}${id}`
}

/** For tests: read the file again. */
export function resetStore() {
  state = null
}
