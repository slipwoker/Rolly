#!/usr/bin/env bash
# Fourth GPU pass: OpenAI Realtime re-test after the opener fix, with its three turn-detection modes on a scenario subset.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
WS="${ROLLY_WORKSPACE:-/workspace}"; LOGS="$WS/logs"; mkdir -p "$LOGS"
# shellcheck disable=SC1090
. "$WS/rolly_tokens.env"
export PYTHONPATH="$ROOT" HF_HOME="${HF_HOME:-$WS/hf}"
PY="$ROOT/.venv/bin/python"
URL="ws://127.0.0.1:8000/ws?token=$ROLLY_ACCESS_TOKEN"
run() { echo; echo "=== $1 ==="; shift; "$@" 2>&1 | grep -v Warning | tee -a "$LOGS/bench.log" | grep --line-buffered -E "^s[0-9]|^N=|max sustainable|saved|Error|Traceback"; }
until curl -fs http://127.0.0.1:8000/healthz | grep -q '"ready":true'; do sleep 3; done
RT="OpenAI Realtime API gpt-realtime-2.1 called from a RunPod pod in Sweden (server-side WebSocket bridge); client on the same host; opener fix applied"
SUB="s01 s02 s05 s07 s08 s12"
run "A realtime, semantic VAD eagerness auto (default)" "$PY" -m benchmarks.run_scenarios --provider openai-realtime --url "$URL" --hardware "$RT; semantic_vad auto" --only $SUB --tag gpu-oai4-auto --turn-timeout 30 --opener-timeout 30
run "B realtime, semantic VAD eagerness high" "$PY" -m benchmarks.run_scenarios --provider openai-realtime-eager --url "$URL" --hardware "$RT; semantic_vad high" --only $SUB --tag gpu-oai4-high --turn-timeout 30 --opener-timeout 30
run "C realtime, server VAD 500 ms" "$PY" -m benchmarks.run_scenarios --provider openai-realtime-servervad --url "$URL" --hardware "$RT; server_vad 500 ms" --only $SUB --tag gpu-oai4-svad --turn-timeout 30 --opener-timeout 30
echo; echo "PASS4 DONE"
