#!/usr/bin/env bash
# Fifth GPU pass: hybrid on GPU, OpenAI Realtime turn-detection modes, and the realtime mini model (with run-away guards).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
WS="${ROLLY_WORKSPACE:-/workspace}"; LOGS="$WS/logs"; mkdir -p "$LOGS"
# shellcheck disable=SC1090
. "$WS/rolly_tokens.env"
export PYTHONPATH="$ROOT" HF_HOME="${HF_HOME:-$WS/hf}"
PY="$ROOT/.venv/bin/python"
URL="ws://127.0.0.1:8000/ws?token=$ROLLY_ACCESS_TOKEN"
GPU="$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | head -1)"
run() { echo; echo "=== $1 ==="; shift; "$@" 2>&1 | grep --line-buffered -v Warning | tee -a "$LOGS/bench.log" | grep --line-buffered -E "^s[0-9]|^N=|max sustainable|saved|Error|Traceback"; }
[ -n "${OPENAI_API_KEY:-}" ] || { echo "OPENAI_API_KEY is not set in the pod environment"; exit 1; }
until curl -fs http://127.0.0.1:8000/healthz | grep -q '"ready":true'; do sleep 3; done

HWH="GPU pod: $GPU; STT Whisper large-v3-turbo float16 on GPU; LLM OpenAI gpt-6-luna over HTTPS (reasoning off); TTS Piper/ReNikud on CPU; client on the same host"
run "A hybrid scenarios" "$PY" -m benchmarks.run_scenarios --provider hybrid-apillm --url "$URL" --hardware "$HWH" --tag gpu-hybrid --turn-timeout 40 --opener-timeout 40
run "B hybrid concurrency ramp" "$PY" -m benchmarks.concurrency --provider hybrid-apillm --url "$URL" --hardware "$HWH" --levels ${LEVELS:-1 5 10 20 35} --turns 5 --admin-token "$ROLLY_ADMIN_TOKEN" --timeout 45 --tag gpu-hybrid-conc --cooldown 8
RT="OpenAI Realtime API called from a RunPod pod in Sweden (server-side WebSocket bridge); client on the same host"
SUB="s01 s02 s05 s07 s08 s12"
run "C realtime gpt-realtime-2.1, semantic VAD eagerness high" "$PY" -m benchmarks.run_scenarios --provider openai-realtime-eager --url "$URL" --hardware "$RT; gpt-realtime-2.1; semantic_vad eagerness high" --only $SUB --tag gpu-oai-high --turn-timeout 30 --opener-timeout 30 --scenario-timeout 300
run "D realtime gpt-realtime-2.1, server VAD 500 ms" "$PY" -m benchmarks.run_scenarios --provider openai-realtime-servervad --url "$URL" --hardware "$RT; gpt-realtime-2.1; server_vad 500 ms" --only $SUB --tag gpu-oai-svad --turn-timeout 30 --opener-timeout 30 --scenario-timeout 300
run "E realtime gpt-realtime-2.1-mini, all scenarios" "$PY" -m benchmarks.run_scenarios --provider openai-realtime-mini --url "$URL" --hardware "$RT; gpt-realtime-2.1-mini; semantic_vad auto" --tag gpu-oai-mini --turn-timeout 30 --opener-timeout 30 --scenario-timeout 300
echo; echo "PASS5 DONE"
