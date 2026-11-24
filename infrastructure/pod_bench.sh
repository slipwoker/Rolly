#!/usr/bin/env bash
# Runs the GPU benchmark suite on the pod after infrastructure/pod_setup.sh.  About 1.5-2 hours unattended.
#
#   bash infrastructure/pod_bench.sh            # everything
#   LONG=0 LEVELS="1 5 10" bash infrastructure/pod_bench.sh   # shorter
#
# Each step is independent: a failing step is reported and the script continues.
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
HW="${HW:-GPU pod: $GPU; STT Whisper large-v3-turbo float16 on GPU (routed by language); LLM $LLM on vLLM (same GPU); TTS Piper/ReNikud on CPU; client on the same host (no network latency)}"
LEVELS="${LEVELS:-1 5 10 20 50}"; REPEAT="${REPEAT:-2}"
run() { echo; echo "=== $1 ==="; shift; "$@" 2>&1 | grep -v Warning | tee -a "$LOGS/bench.log" | grep -E "^s[0-9]|^N=|max sustainable|saved|actual_minutes|turns_completed|memory probe|Error|Traceback" ; }

until curl -fs http://127.0.0.1:8000/healthz | grep -q '"ready":true'; do echo "waiting for server..."; sleep 3; done

run "1/6 scenarios, self-hosted pipeline" "$PY" -m benchmarks.run_scenarios --provider modular-selfhosted --url "$URL" --hardware "$HW" --repeat "$REPEAT" --tag gpu-selfhosted --turn-timeout 40 --opener-timeout 40
run "2/6 concurrency ramp, self-hosted pipeline" "$PY" -m benchmarks.concurrency --provider modular-selfhosted --url "$URL" --hardware "$HW" --levels $LEVELS --turns 4 --admin-token "$ROLLY_ADMIN_TOKEN" --timeout 40 --tag gpu-conc --stop-on-fail
run "3/6 LLM probes on the self-hosted model" "$PY" -m benchmarks.llm_quality --base-url http://127.0.0.1:8081/v1 --model local --label "gpu-$(echo "$LLM" | tr '/ ' '__')" --hardware "$GPU, vLLM"
if curl -fs "http://127.0.0.1:8000/api/providers?token=$ROLLY_ADMIN_TOKEN" | grep -q '"id":"hybrid-apillm","type":"modular"[^}]*"missing":\[\]' || [ -n "${OPENAI_API_KEY:-}" ]; then
  HWH="GPU pod: $GPU; STT on GPU; LLM OpenAI gpt-6-luna over HTTPS (reasoning off); TTS on CPU; client on the same host"
  run "4/6 scenarios, hybrid (commercial LLM)" "$PY" -m benchmarks.run_scenarios --provider hybrid-apillm --url "$URL" --hardware "$HWH" --repeat "$REPEAT" --tag gpu-hybrid --turn-timeout 40 --opener-timeout 40
  run "4b concurrency ramp, hybrid" "$PY" -m benchmarks.concurrency --provider hybrid-apillm --url "$URL" --hardware "$HWH" --levels $LEVELS --turns 4 --admin-token "$ROLLY_ADMIN_TOKEN" --timeout 40 --tag gpu-hybrid-conc --stop-on-fail
  run "5/6 OpenAI Realtime baseline (first live run of this bridge - may fail)" "$PY" -m benchmarks.run_scenarios --provider openai-realtime --url "$URL" --hardware "OpenAI Realtime API gpt-realtime-2.1 called from the pod ($GPU host)" --repeat 1 --tag gpu-openai-realtime --turn-timeout 40 --opener-timeout 40
else
  echo; echo "=== 4/6 and 5/6 skipped: no OPENAI_API_KEY was set when pod_setup.sh ran ==="
fi
if [ "${LONG:-1}" = "1" ]; then
  run "6/6 30-minute session, self-hosted pipeline" "$PY" -m benchmarks.long_session --provider modular-selfhosted --url "$URL" --hardware "$HW" --minutes 30 --lang en --timeout 60 --tag gpu-long
fi

"$PY" -m benchmarks.analyze > /dev/null 2>&1
tar -czf "$WS/rolly-gpu-results.tar.gz" benchmarks/results reports 2>/dev/null
echo; echo "================ SUMMARY (paste this back) ================"
"$PY" - <<'EOF'
import glob, json
def stat(s, k="median"): return "-" if not s or not s.get("n") else round(s[k])
for f in sorted(glob.glob("benchmarks/results/scenarios_*.json")):
    d = json.load(open(f)); a = d.get("aggregate", {})
    if "GPU pod" not in d.get("hardware_note", "") and "from the pod" not in d.get("hardware_note", ""): continue
    lat = a.get("response_latency_ms", {}); it = a.get("interruptions", {})
    print(f"[scenarios] {d['provider']}: turns {a.get('turns')} (no response {a.get('turns_without_response')}), latency median {stat(lat)} ms p95 {stat(lat,'p95')} ms, "
          f"checks {a.get('checks_passed')}/{a.get('checks_total')}, failed scenarios {a.get('scenarios_failed')}, underruns/turn {a.get('playout_underruns_per_turn')}, "
          f"interrupt {stat(it.get('onset_to_interrupt_ms'))} ms, stages " + ", ".join(f"{k}={stat(v)}" for k, v in sorted(a.get('stage_medians_ms', {}).items()) if k in ('stt_ms','llm_ttft_ms','llm_first_chunk_ms','tts_ttfa_ms','pipeline_ms')))
    errs = sorted({r['error'] for r in d['results'] if r.get('error')} | {e for r in d['results'] for e in (r.get('errors') or [])})
    if errs: print("   errors:", [e[:160] for e in errs][:3])
for f in sorted(glob.glob("benchmarks/results/concurrency_*.json")):
    d = json.load(open(f))
    if "GPU pod" not in d.get("hardware_note", ""): continue
    print(f"[concurrency] {d['provider']}: max sustainable {d.get('max_sustainable_concurrency')}")
    for lv in d["levels"]:
        r = lv.get("server_resources_last_60s") or {}
        print(f"   N={lv['concurrent_sessions']}: median {stat(lv['response_latency_ms'])} ms p95 {stat(lv['response_latency_ms'],'p95')} ms, failed turns {lv['turns_failed']}/{lv['turns_attempted']}, "
              f"gpu util {r.get('gpu_util_pct_mean')}% mem {r.get('gpu_mem_used_mb_max')} MB, cpu {r.get('cpu_pct_mean')}%")
for f in sorted(glob.glob("benchmarks/results/long_session_*.json")):
    d = json.load(open(f))
    if "GPU pod" not in d.get("hardware_note", ""): continue
    print(f"[long] {d['actual_minutes']} min, turns {d['turns_completed']} ok / {d['turns_failed']} failed, latency first third {stat(d['latency_first_third_ms'])} -> last third {stat(d['latency_last_third_ms'])} ms, probe {d.get('memory_probe', {}).get('pass')}")
for f in sorted(glob.glob("benchmarks/results/llm_quality_gpu-*.json")):
    d = json.load(open(f)); s = d["summary"]
    print(f"[llm] {d['label']}: retention {s['context_retention']['all']}, no-hallucination {s['no_hallucination_on_unknowns']['all']}, facts {s['general_facts']['all']}, ttft median {stat(s['ttft_ms'])} ms")
EOF
echo "==========================================================="
echo "Raw results: $WS/rolly-gpu-results.tar.gz"
echo "When finished: TERMINATE the pod in the RunPod console (a stopped pod still bills for its volume)."
