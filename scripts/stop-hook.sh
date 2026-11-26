#!/usr/bin/env bash
# Claude Code's `Stop` hook (.claude/settings.json): at the end of each agent turn on a Spunto worker, the build the
# human opens (:3000) is brought up to date if it is behind the code (scripts/start.sh, which does nothing if it is
# not). When the task goes to review, the link given serves what was just done. Outside a worker (no WORKER_SLUG),
# nothing.
#
# A failure goes back to the agent (exit 2: it sees the end of the log and carries on), once: if it fails again on
# the next turn (stop_hook_active), the agent may hand back rather than loop.
set -uo pipefail
[ -n "${WORKER_SLUG:-}" ] || exit 0
input="$(cat)"
cd "$(dirname "$0")/.."
log="$(git rev-parse --git-path spunto-stop-hook.log)"
bash scripts/start.sh > "$log" 2>&1 && exit 0
if printf '%s' "$input" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  echo "⚠ the build served to the human could not be updated: $log" >&2
  exit 0
fi
{ echo "The build served to the human could not be updated (scripts/start.sh, log: $log). End of the log:"
  tail -40 "$log"; } >&2
exit 2
