#!/usr/bin/env bash
# (Re)start the GPU worker (backend/gpu_worker.py) with the settings of the benchmarked pipeline.
# Used by pod_setup.sh and by pod_job.sh, so the worker can be restarted without touching vLLM.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
WS="${ROLLY_WORKSPACE:-/workspace}"; LOGS="$WS/logs"; mkdir -p "$LOGS"
export HF_HOME="${HF_HOME:-$WS/hf}"
export ROLLY_STT_DEVICE=cuda ROLLY_STT_COMPUTE=float16 ROLLY_STT_WORKERS="${ROLLY_STT_WORKERS:-4}"
export ROLLY_TTS_PROVIDER=cpu ROLLY_TTS_INSTANCES="${ROLLY_TTS_INSTANCES:-4}" ROLLY_TTS_THREADS=2
export ROLLY_TTS_EN_KIND=vits ROLLY_TTS_EN_DIR=models/vits-piper-en_US-lessac-medium ROLLY_TTS_EN_FILE=en_US-lessac-medium.onnx ROLLY_TTS_EN_SPEAKER=0
export ROLLY_LLM_BASE_URL=http://127.0.0.1:8081/v1 ROLLY_LLM_MODEL=local ROLLY_LLM_API_KEY="${ROLLY_GPU_API_KEY:-}"
# Hebrew voice: BlueV3 (infrastructure/blue_setup.sh); falls back to the Piper voice while its server is down.
# See config/providers.yaml.  ROLLY_TTS_HE_ENGINE=renikud_piper switches it off; zonos selects the withdrawn ZONOS3 voice.
export ROLLY_TTS_HE_ENGINE="${ROLLY_TTS_HE_ENGINE:-blue}" ROLLY_VOICE_DIR="$WS/voices"
export ROLLY_ZONOS_VOICE="${ROLLY_ZONOS_VOICE:-$WS/voices/he_voice.codes.npy}"
pkill -f "uvicorn backend.gpu_worker" 2>/dev/null || true; sleep 1
nohup .venv/bin/uvicorn backend.gpu_worker:app --host 0.0.0.0 --port 8000 > "$LOGS/worker.log" 2>&1 &
for i in $(seq 1 120); do curl -fs http://127.0.0.1:8000/healthz 2>/dev/null | grep -q '"ready":true' && break; sleep 3; done
curl -fs http://127.0.0.1:8000/healthz | grep -q '"ready":true' || { echo "GPU worker not ready - see $LOGS/worker.log"; tail -30 "$LOGS/worker.log"; exit 1; }
echo "GPU worker is up on port 8000"
