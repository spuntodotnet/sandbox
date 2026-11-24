/**
 * What the engine takes and gives. Structurally the shapes of Spunto's `runtime` capability
 * (RFC 0035 of the Spunto platform), which this engine was written against first: a caller of
 * either side can hand one to the other as it is.
 */

/** Why an operation was refused. `capacity`: this machine cannot take it now (memory, disk) — another one may. */
export type SandboxErrorCode = "not_found" | "invalid" | "capacity" | "upstream"

export class SandboxError extends Error {
  constructor(
    message: string,
    readonly code: SandboxErrorCode = "upstream",
  ) {
    super(message)
  }
}

/** A size a box can be made at. */
export type Size = { id: string; label: string; cpus?: number; memoryGb?: number; diskGb?: number }

export type CreateInput = {
  /** The caller's id for the box: its handle is `sbx-<sandboxId>`, its /workspace `ws/<sandboxId>`. */
  sandboxId: string
  /** A name for people (the guest's hostname is made from it). */
  name: string
  /** An OCI image reference, pulled anonymously: `ubuntu:24.04`, `ghcr.io/org/image@sha256:…`. */
  image: string
  /** One of `SIZES` (`small` when unknown). */
  size?: string
  /**
   * The box's main process: a shell script the guest's init runs (with `sh -c`) once its env is
   * read, restarted if it exits, started over when the box takes a new identity.
   */
  bootstrap: string
  /** Its environment. Must hold `SPUNTO_SANDBOX_TOKEN`: the init never starts a bootstrap without it. */
  env: Record<string, string>
  /** Kept with the box for whoever runs the machine to read (`list`), never acted on. */
  labels?: Record<string, string>
  /** A template (`snapshot`, `fork`, `snapshotDisks`) or a build (`build`) to start from. */
  from?: string
  /** A rebuild: the box this one replaces, destroyed just before with `keepVolumes`. */
  previousHandle?: string
  /** Ignored by the engine: accepted so that a caller may pass its own input as it is. */
  [extra: string]: unknown
}

export type HandleInput = { handle: string; sandboxId?: string; /** destroy: keep the /workspace volume (a rebuild). */ keepVolumes?: boolean }

/**
 * What a machine reads and writes a build as: a full `zfs send` of a microVM build, zstd-compressed.
 * `docker-image` is what a Docker backend would write — never this engine.
 */
export type BuildFormat = "firecracker-zfs" | "docker-image"

/** Reads ONE object, for a short while: a URL (presigned), never a key. */
export type ReadTarget = { url: string; headers?: Record<string, string> }

/** Writes ONE object: an S3 multipart upload (a presigned URL per part), or a GCS resumable session. */
export type WriteTarget = { kind: "multipart"; uploadId: string; partSize: number; parts: string[] } | { kind: "resumable"; url: string }

export type BuildInput = {
  /** The caller's id for this build (an idempotency key): its ref is `buildRefOf(buildId)`. */
  buildId: string
  /** The base image. */
  image: string
  /** Self-contained, run as root in a builder microVM of `image`. `::spunto:step:` markers are kept as they are. */
  script: string
  size?: string
  /** This build exists already somewhere (another machine sent it): fetched rather than cooked. */
  artifact?: { format: BuildFormat; target: ReadTarget; bytes?: number }
  [extra: string]: unknown
}

export type ExportStatus = {
  /** `none`: no export known for this ref (never asked, or the daemon restarted mid-way). */
  state: "uploading" | "done" | "failed" | "none"
  format?: BuildFormat
  bytes?: number
  /** S3: what completing the multipart upload needs. */
  parts?: { partNumber: number; etag: string }[]
  error?: string
}

/** The engine's view of a box, as `describe` gives it. */
export type BoxState = "creating" | "running" | "stopped" | "missing" | "error"

/** Where an archive goes and comes from: one presigned URL per object, never a key. */
export type Target = { url: string; headers?: Record<string, string> }
export type Targets = { root: Target; ws: Target }

export type BuildSteps = {
  before?: { id: string; label: string; kind?: "image" | "runtime"; detail?: string }[]
  after?: { id: string; label: string; kind?: "image" | "runtime"; detail?: string }[]
}

export type BuildStatus = {
  state: "running" | "ready" | "failed"
  /** What the engine is doing right now, in a few words ("starting a builder microVM"). */
  phase: string
  /** The log from the requested cursor on, and where the next call should start. */
  log: string
  cursor: number
  error?: string
}

/** What `describe` says of a box. `transition`: a stop or a pause still under way (`state` already says `stopped`). */
export type Description = {
  state: BoxState
  detail?: string
  transition?: "pausing" | "stopping"
  /** `saved`: a start resumes the box (a pause); `none`: a start boots it. */
  ram?: "saved" | "none"
  timings?: Record<string, number>
  /** How its VMM ended when it died on its own (`oom-kill`, `signal`…). */
  exit?: string
}

/** How a RAM snapshot was written: only the dirtied pages over a base (`Diff`, `Template`, `Boot`), or all of it. */
export type RamKind = "Full" | "Diff" | "Boot" | "Template"

/**
 * The engine: one per machine, run as root. Every operation is idempotent where it can be, answers
 * within a few seconds (the slow part — writing RAM, unpacking an image — goes on in the background,
 * and `describe` / `templateStatus` / `buildStatus` follow it), and throws a `SandboxError`.
 */
export type Engine = {
  /** Make a box: answers at once, `describe` says `creating` (and the step) until it runs. */
  create(input: CreateInput): Promise<{ handle: string; ignoredFrom?: string }>
  /** Run a stopped box: its RAM loaded when it was paused (processes kept), its disk booted otherwise. */
  start(input: HandleInput): Promise<void>
  /** Stop a box, its disks kept and its RAM dropped (a clean shutdown first). Answers at once. */
  stop(input: HandleInput): Promise<void>
  /** Stop a box **keeping its RAM**: the next `start` resumes it, processes and all. Answers at once. */
  pause(input: HandleInput): Promise<void>
  /** Remove a box: VMM, network, disks (`keepVolumes`: /workspace stays, for a rebuild), memory files. */
  destroy(input: HandleInput): Promise<void>
  describe(input: HandleInput): Promise<Description>
  /** Run a recipe in a builder microVM: its disk becomes what `create({ from: ref })` boots. */
  build(input: BuildInput): Promise<{ ref: string; steps?: BuildSteps }>
  buildStatus(input: { ref: string; cursor?: number }): Promise<BuildStatus>
  deleteBuild(input: { ref: string }): Promise<void>
  /** A full `zfs send` of a ready build, zstd, straight into one object of a bucket. */
  exportBuild(input: { ref: string; target: WriteTarget }): Promise<{ format: BuildFormat }>
  exportStatus(input: { ref: string }): Promise<ExportStatus>
  /** Grow a box's disks, running or not; never shrink. `resizeInGuest`: grow the filesystems from inside now. */
  grow(input: HandleInput & { rootGb?: number; workspaceGb?: number }): Promise<{ rootGb: number; workspaceGb: number; changed: boolean; running: boolean; resizeInGuest: boolean }>
  /** A template of a running box (RAM and disks), kept for many copies: `create({ from: ref })`. */
  snapshot(input: HandleInput): Promise<{ ref: string }>
  /** A copy of a running box, for one `create({ from: ref })` (or many: `model`). Answers once the source runs again. */
  fork(input: HandleInput & { model?: boolean }): Promise<{ ref: string; pauseMs?: number; ram?: RamKind }>
  /** A running box's disks without its RAM: boxes made from it boot. A pause of milliseconds. */
  snapshotDisks(input: HandleInput): Promise<{ ref: string; pauseMs?: number }>
  templateStatus(input: { ref: string }): Promise<{ state: "pending" | "ready" | "error"; detail?: string; stale?: boolean }>
  deleteTemplate(input: { ref: string }): Promise<void>
  /** The sizes a box can be made at. */
  sizes(): Promise<Size[]>
  /** A stopped box's disks, as two full `zfs send` streams, to two presigned URLs; the machine lets go of them. */
  archive(input: { handle: string; targets: Targets }): Promise<{ bytes: number; ms: number }>
  /** An archived box's disks back from two URLs: stopped, a start boots it. */
  restore(input: { handle: string; targets: Targets }): Promise<{ ms: number }>
  /** What each running box uses, as the host measures it. */
  usage(): Promise<{ at: string; boxes: Record<string, unknown> }>
  /** Everything the registry holds: boxes (env names only, never values), templates, images, builds. */
  list(): Promise<unknown>
}
