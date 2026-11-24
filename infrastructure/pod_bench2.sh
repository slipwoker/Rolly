#!/usr/bin/env bash
# Second GPU pass: full concurrency ramp (no early stop) and end-of-turn timing experiments.
# Run through pod_autorun.sh with ROLLY_BENCH_SCRIPT=infrastructure/pod_bench2.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
WS="${ROLLY_WORKSPACE:-/workspace}"; LOGS="$WS/logs"; mkdir -p "$LOGS"
# shellcheck disable=SC1090
. "$WS/rolly_tokens.env"
export PYTHONPATH="$ROOT" HF_HOME="${HF_HOME:-$WS/hf}"
PY="$ROOT/.venv/bin/python"
URL="ws://127.0.0.1:8000/ws?token=$ROLLY_ACCESS_TOKEN"
GPU="$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | head -1)"
LLM="$(curl -fs http://127.0.0.1:8081/v1/models | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["data"][0].get("root","?"))' 2>/dev/null || echo unknown)"
HW="GPU pod: $GPU; STT Whisper large-v3-turbo float16 on GPU (routed by language); LLM $LLM on vLLM (same GPU); TTS Piper/ReNikud on CPU; client on the same host (no network latency)"
run() { echo; echo "=== $1 ==="; shift; "$@" 2>&1 | grep --line-buffered -v Warning | tee -a "$LOGS/bench.log" | grep --line-buffered -E "^s[0-9]|^N=|max sustainable|saved|Error|Traceback"; }
until curl -fs http://127.0.0.1:8000/healthz | grep -q '"ready":true'; do sleep 3; done

# 1) concurrency ramp, Hebrew and English users mixed, 5 turns each, every level is run even if a target is missed
run "A concurrency ramp 1-50, mixed languages" "$PY" -m benchmarks.concurrency --provider modular-selfhosted --url "$URL" --hardware "$HW" \
    --levels ${LEVELS:-1 2 5 10 20 35 50} --turns 5 --admin-token "$ROLLY_ADMIN_TOKEN" --timeout 45 --tag gpu-conc2 --cooldown 8

# 2) how much of the response latency is the end-of-turn wait?  Same scenarios, different endpointing.
SUB="s01 s02 s03 s05 s08 s12"
run "B default endpointing (544 ms endpoint, 256 ms speculative start)" "$PY" -m benchmarks.run_scenarios --provider modular-selfhosted --url "$URL" \
    --hardware "$HW; endpoint 544 ms / eager 256 ms (default)" --only $SUB --tag gpu-ep544 --turn-timeout 40 --opener-timeout 40
run "C shorter endpoint (416 ms endpoint, 192 ms speculative start)" "$PY" -m benchmarks.run_scenarios --provider modular-selfhosted --url "$URL" \
    --hardware "$HW; endpoint 416 ms / eager 192 ms" --only $SUB --tag gpu-ep416 --turn-timeout 40 --opener-timeout 40 \
    --options '{"endpoint_silence_ms": 416, "eager_silence_ms": 192}'
run "D shortest endpoint (320 ms endpoint, 160 ms speculative start)" "$PY" -m benchmarks.run_scenarios --provider modular-selfhosted --url "$URL" \
    --hardware "$HW; endpoint 320 ms / eager 160 ms" --only $SUB --tag gpu-ep320 --turn-timeout 40 --opener-timeout 40 \
    --options '{"endpoint_silence_ms": 320, "eager_silence_ms": 160}'
run "E speculative start disabled (544 ms endpoint)" "$PY" -m benchmarks.run_scenarios --provider modular-selfhosted --url "$URL" \
    --hardware "$HW; endpoint 544 ms / speculative start OFF" --only $SUB --tag gpu-noeager --turn-timeout 40 --opener-timeout 40 \
    --options '{"endpoint_silence_ms": 544, "eager_silence_ms": 0}'
echo; echo "PASS2 DONE"
