#!/usr/bin/env bash
# Unattended run on a GPU pod: setup, benchmarks, publish logs/results on a read-only HTTP port (8001).
# Used as the pod's start command so that no shell access is needed:
#
#   bash -c "mkdir -p /workspace/public; cd /workspace; (python3 -m http.server 8001 --directory /workspace/public >/dev/null 2>&1 &);
#            if [ -d Rolly/.git ]; then git -C Rolly pull -q; else git clone -q -b <branch> <repo-url> Rolly; fi > /workspace/public/clone.log 2>&1;
#            bash Rolly/infrastructure/pod_autorun.sh; sleep infinity"
#
# /workspace/public only receives setup/benchmark output and result files (synthetic data). The application's
# own log is NOT published because its access lines contain the session access token.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
WS="${ROLLY_WORKSPACE:-/workspace}"; PUB="$WS/public"; LOGS="$WS/logs"; mkdir -p "$PUB" "$LOGS"
status() { echo "{\"phase\": \"$1\", \"time\": \"$(date -u +%FT%TZ)\", \"commit\": \"$(git rev-parse --short HEAD 2>/dev/null)\"}" > "$PUB/status.json"; }
( while true; do
    for f in setup.log bench.out; do [ -f "$LOGS/$f" ] && cp "$LOGS/$f" "$PUB/$f"; done
    [ -f "$LOGS/vllm.log" ] && tail -c 20000 "$LOGS/vllm.log" > "$PUB/vllm.tail.log"
    [ -f "$LOGS/bench.log" ] && tail -c 30000 "$LOGS/bench.log" > "$PUB/bench.tail.log"
    mkdir -p "$PUB/results" && cp benchmarks/results/*.json "$PUB/results/" 2>/dev/null && ls "$PUB/results" > "$PUB/results/index.txt"
    nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader > "$PUB/gpu.txt" 2>&1
    sleep 15
  done ) &
SYNC=$!
if [ "${ROLLY_SKIP_SETUP:-0}" != "1" ]; then
  status setup
  if ! bash infrastructure/pod_setup.sh > "$LOGS/setup.log" 2>&1; then status setup_failed; sleep 20; exit 1; fi
fi
if [ "${ROLLY_SETUP_ONLY:-0}" = "1" ]; then status setup_done; sleep 20; exit 0; fi
status benchmarking
bash infrastructure/pod_bench.sh > "$LOGS/bench.out" 2>&1
cp "$WS/rolly-gpu-results.tar.gz" "$PUB/" 2>/dev/null
mkdir -p "$PUB/results" && cp benchmarks/results/*.json "$PUB/results/" 2>/dev/null; cp reports/benchmark_summary.md "$PUB/" 2>/dev/null
ls "$PUB/results" > "$PUB/results/index.txt" 2>/dev/null
sleep 20; status done
