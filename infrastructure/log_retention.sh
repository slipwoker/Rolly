#!/usr/bin/env bash
# Log retention on the GPU pod (decision P1-D40, docs/SECURITY.md): once a day every log in $WS/logs is copied to
# <name>.log.<UTC date> and emptied in place, and copies older than ROLLY_LOG_KEEP_DAYS (default 7) are deleted.
# The writers open their logs with ">>" (O_APPEND), so emptying a log in place is safe while they keep writing.
# Started by start_worker.sh.  `--once` does a single pass (used by the tests).
set -uo pipefail
WS="${ROLLY_WORKSPACE:-/workspace}"; LOGS="$WS/logs"; KEEP="${ROLLY_LOG_KEEP_DAYS:-7}"
prune() {
  # a copy holds at most one day of lines, so nothing in these logs is older than KEEP + 1 days
  [ -d "$LOGS" ] && find "$LOGS" -maxdepth 1 -type f -name '*.log.*' -mtime +"$((KEEP - 1))" -delete
  return 0
}
rotate() {
  [ -d "$LOGS" ] || return 0
  local stamp f; stamp="$(date -u +%Y%m%d-%H%M%S)"
  for f in "$LOGS"/*.log; do
    [ -s "$f" ] || continue
    cp -p "$f" "$f.$stamp" && : > "$f"
  done
}
if [ "${1:-}" = "--once" ]; then rotate; prune; exit 0; fi
# at start only old copies go (a restart already began fresh logs); then a rotation once a day
prune
while true; do sleep 86400; rotate; prune; done
