/**
 * The daemon's settings, from its environment (`/etc/spunto-sandbox/sandboxd.env` under systemd).
 * The engine's own (`SPUNTO_FC_*`: paths, dataset, sizes, limits) are read by the engine.
 */

export const DAEMON_VERSION = "0.1.0"

/** Where the API listens: a unix socket, root's and its group's (`SBX_SOCKET_GROUP`). */
export const SOCKET = process.env.SBX_SOCKET ?? "/run/spunto-sandbox.sock"
/** The group that may use the socket without sudo (made by install.sh). Unset or missing: root only. */
export const SOCKET_GROUP = process.env.SBX_SOCKET_GROUP ?? "spunto-sandbox"
/** Also on TCP (`0.0.0.0:7070`): every request then needs `Authorization: Bearer $SBX_API_TOKEN`. */
export const LISTEN = process.env.SBX_LISTEN ?? ""
export const API_TOKEN = process.env.SBX_API_TOKEN ?? ""
/** The daemon's own state: its sandboxes and snapshots by id, the secret their tokens derive from. */
export const STATE_DIR = process.env.SBX_STATE_DIR ?? "/var/lib/spunto-sandbox"
/** Where the guest agent is, for a daemon run from the source tree (a bundle carries its own). */
export const AGENT_FILE = process.env.SBX_AGENT_FILE ?? ""
/** How long a create waits for its box (an image pulled for the first time takes a while). */
export const CREATE_TIMEOUT_MS = Number(process.env.SBX_CREATE_TIMEOUT_MS ?? 15 * 60_000)
/** The size of a box nobody chose one for. */
export const DEFAULT_SIZE = process.env.SBX_DEFAULT_SIZE ?? "small"
/** The address and port the guest agent listens on inside every box. */
export const AGENT_ADDR = "172.16.0.2"
export const AGENT_PORT = 47771
