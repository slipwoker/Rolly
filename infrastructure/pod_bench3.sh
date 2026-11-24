#!/usr/bin/env bash
# Third GPU pass: commercial components called from the pod (needs OPENAI_API_KEY in the pod environment).
#   1) OpenAI Realtime speech-to-speech baseline (first live use of the bridge: a one-scenario smoke test first)
#   2) hybrid pipeline: STT on GPU + OpenAI gpt-6-luna + TTS on CPU
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
case "$OPENAI_API_KEY" in *RUNPOD_SECRET*) echo "the RunPod secret was not substituted (does a secret named OPENAI_API_KEY exist?)"; exit 1;; esac
until curl -fs http://127.0.0.1:8000/healthz | grep -q '"ready":true'; do sleep 3; done

RT="OpenAI Realtime API called from a RunPod pod in Sweden (server-side WebSocket bridge); client on the same host"
run "A realtime smoke test (one scenario)" "$PY" -m benchmarks.run_scenarios --provider openai-realtime --url "$URL" --hardware "$RT; smoke" --only s02 --tag gpu-oai-smoke --turn-timeout 30 --opener-timeout 30
if "$PY" - <<'PYEOF'
import glob, json, sys
f = sorted(glob.glob("benchmarks/results/scenarios_openai-realtime_*.json"))[-1]
d = json.load(open(f)); r = d["results"][0]
print("smoke:", "opener" in r, [t.get("latency_ms") for t in r["turns"]], r.get("error"), (r.get("errors") or [])[:3])
sys.exit(0 if any(t.get("latency_ms") for t in r["turns"]) else 1)
PYEOF
then
  run "B realtime baseline gpt-realtime-2.1, all scenarios" "$PY" -m benchmarks.run_scenarios --provider openai-realtime --url "$URL" --hardware "$RT; gpt-realtime-2.1" --tag gpu-oai-rt --turn-timeout 30 --opener-timeout 30
  run "C realtime baseline gpt-realtime-2.1-mini, all scenarios" "$PY" -m benchmarks.run_scenarios --provider openai-realtime-mini --url "$URL" --hardware "$RT; gpt-realtime-2.1-mini" --tag gpu-oai-rt-mini --turn-timeout 30 --opener-timeout 30
else
  echo "realtime smoke test produced no reply - skipping the full realtime runs (see the smoke result file for the error text)"
fi
HWH="GPU pod: $GPU; STT Whisper large-v3-turbo float16 on GPU; LLM OpenAI gpt-6-luna over HTTPS (reasoning off); TTS Piper/ReNikud on CPU; client on the same host"
run "D hybrid scenarios" "$PY" -m benchmarks.run_scenarios --provider hybrid-apillm --url "$URL" --hardware "$HWH" --tag gpu-hybrid --turn-timeout 40 --opener-timeout 40
run "E hybrid concurrency ramp" "$PY" -m benchmarks.concurrency --provider hybrid-apillm --url "$URL" --hardware "$HWH" --levels ${LEVELS:-1 5 10 20 35} --turns 5 --admin-token "$ROLLY_ADMIN_TOKEN" --timeout 45 --tag gpu-hybrid-conc --cooldown 8
echo; echo "PASS3 DONE"
