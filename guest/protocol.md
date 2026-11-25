# The guest agent's protocol

`sbx-agent` listens on **172.16.0.2:47771** inside every box — the guest's own address, the same in
every box, reached only from the box's network namespace on the host (the daemon opens connections
there with `nsenter --net=/run/netns/fc<n> busybox nc 172.16.0.2 47771`). A client of the daemon
speaks the same frames over `POST /v1/sandboxes/{id}/attach` (`Upgrade: sbx-agent/1`); the daemon
fills in the token and pipes the bytes.

## Frames

```
type (1 byte, ASCII) · length (uint32, big endian) · payload (at most 4 MiB)
```

One request per connection. The client's first frame is the **hello**.

| Type | Way | Payload |
|---|---|---|
| `h` hello | → | JSON: `token`, `op`, and the operation's fields (below) |
| `0` data | → | bytes: a process's stdin, a file's content, a tunnel's bytes |
| `c` close | → | none: the end of stdin (`^D` on a terminal), of a file, of a tunnel's way out |
| `r` resize | → | JSON `{ "rows", "cols" }` |
| `k` signal | → | JSON `{ "signal": "SIGINT" }` — to the process group |
| `o` ready | ← | JSON: the operation started (`pid`, a file's `size` and `mode`) |
| `1` stdout | ← | bytes: stdout, a terminal's output, a file's content, a tunnel's bytes |
| `2` stderr | ← | bytes |
| `x` exit | ← | JSON `{ "code", "signal"? , … }`: the end |
| `e` error | ← | JSON `{ "message" }`: the end, refused or failed |

## Operations

| `op` | Fields | |
|---|---|---|
| `exec` | `cmd` (argv), `env`, `cwd` (`/workspace` by default), `user`, `tty` (`{rows, cols}`), `detach` | Pipes, or a pseudo-terminal with `tty`. Without one, the process gets a process group of its own: a signal reaches its children, and it outlives an agent restarted by a new identity. `detach`: a session of its own, its output in `/var/log/sbx/<pid>.log`, answered at once with `{code: 0, pid, log}`. A connection gone before the process: `SIGHUP` to its group. |
| `read` | `path` | `o` with `size` and `mode`, the content in `1` frames, then `x` |
| `write` | `path`, `mode` (octal string) | `o`, then the content in `0` frames and a `c`; written to a temporary name and renamed: never half a file |
| `connect` | `port`, `host` (`127.0.0.1`) | a TCP connection from inside the box: `0` frames out, `1` frames back, `c` half-closes |
| `info` | | `x` with `version`, `hostname`, `uptime`, `pid` |

## Identity

The token is the box's `SPUNTO_SANDBOX_TOKEN`, from the env the guest's init read from MMDS; the
agent never hands it to the processes it starts. After a **fork**, the copy's init puts the copy's
env in place and signals the agent (`USR2`): it reads the token again, and every process stays. It
writes `USR1 USR2 REIDENTIFY` to `$SPUNTO_AGENT_SIGNALS_FILE`, which tells the init it can.

## How it gets into a box

Not in the image: the daemon puts it in MMDS (`/sandbox/agent`, gzip, base64; `/sandbox/version`,
`/sandbox/sha256`) at every cold boot, and the box's bootstrap (`src/daemon/guest.ts`) writes it to
`/var/lib/spunto-sandbox/agent-<version>`, checks its sha256 and runs it. A box resumed from its RAM
has it running already; one booted from a snapshot taken under an older daemon finds a copy on its disk.
