#!/usr/bin/env bash
# One-command setup of the benchmark stack on a rented GPU pod (RunPod PyTorch/CUDA 12 template, >= 40 GB VRAM).
# Safe to re-run: every step is skipped when already done.
#
#   git clone -b claude/adoring-goodall-es5zzm https://github.com/slipwoker/Rolly.git /workspace/Rolly
#   cd /workspace/Rolly && bash infrastructure/pod_setup.sh
#
# Optional, BEFORE running (typed on the pod, never in chat):  export OPENAI_API_KEY=sk-...
#   -> also enables the hybrid provider (gpt-6-luna) and the OpenAI Realtime baseline.
#
# STATUS: written without access to a GPU; first run may need small fixes. Logs: /workspace/logs/
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
WS="${ROLLY_WORKSPACE:-/workspace}"; LOGS="$WS/logs"; mkdir -p "$LOGS"
export HF_HOME="${HF_HOME:-$WS/hf}" PIP_DISABLE_PIP_VERSION_CHECK=1
# Research pick, FP8 so that it fits next to Whisper on a 48 GB card.  Fallback: ROLLY_VLLM_MODEL=google/gemma-4-12B-it
LLM_MODEL="${ROLLY_VLLM_MODEL:-RedHatAI/gemma-4-26B-A4B-it-FP8-dynamic}"
step() { echo; echo "=== $* ==="; }

step "GPU"; nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || { echo "no GPU visible"; exit 1; }

step "system packages"
command -v bzip2 >/dev/null && command -v curl >/dev/null || (apt-get update -qq && apt-get install -y -qq bzip2 curl >/dev/null)

step "application environment"
PYBIN="$(command -v python3.12 || command -v python3.11 || command -v python3)"
[ -x .venv/bin/python ] || "$PYBIN" -m venv .venv
.venv/bin/pip install -q -U pip
.venv/bin/pip install -q -r requirements.txt || { echo "pinned requirements failed for $($PYBIN -V); installing unpinned"; \
  .venv/bin/pip install -q fastapi "uvicorn[standard]" websockets httpx numpy onnxruntime-gpu faster-whisper "sherpa-onnx<2" soundfile jiwer psutil pyyaml huggingface_hub scipy soxr; }
.venv/bin/pip uninstall -y -q onnxruntime >/dev/null 2>&1 || true
.venv/bin/pip install -q onnxruntime-gpu nvidia-cublas-cu12 "nvidia-cudnn-cu12>=9,<10"
# CTranslate2 (faster-whisper) loads cuBLAS/cuDNN from these wheels
NV_LIBS="$(.venv/bin/python -c 'import nvidia.cublas.lib, nvidia.cudnn.lib, os; print(os.path.dirname(nvidia.cublas.lib.__file__) + ":" + os.path.dirname(nvidia.cudnn.lib.__file__))' 2>/dev/null || true)"
export LD_LIBRARY_PATH="${NV_LIBS}:${LD_LIBRARY_PATH:-}"

step "speech models (about 4 GB)"
PYTHON="$ROOT/.venv/bin/python" bash infrastructure/download_models.sh --no-llm

step "vLLM (separate environment; first install takes several minutes)"
[ -x "$WS/vllm-venv/bin/vllm" ] || { "$PYBIN" -m venv "$WS/vllm-venv" && "$WS/vllm-venv/bin/pip" install -q -U pip && "$WS/vllm-venv/bin/pip" install -q vllm; }
if ! curl -fs http://127.0.0.1:8081/v1/models >/dev/null 2>&1; then
  echo "starting vLLM with $LLM_MODEL (downloads ~27 GB on first start) - log: $LOGS/vllm.log"
  nohup "$WS/vllm-venv/bin/vllm" serve "$LLM_MODEL" --served-model-name local --port 8081 --max-model-len 16384 \
    --gpu-memory-utilization "${ROLLY_VLLM_MEM:-0.70}" --enable-prefix-caching > "$LOGS/vllm.log" 2>&1 &
fi
for i in $(seq 1 240); do curl -fs http://127.0.0.1:8081/v1/models >/dev/null 2>&1 && break
  pgrep -f "vllm serve" >/dev/null || { echo "vLLM exited - see $LOGS/vllm.log (try: ROLLY_VLLM_MODEL=google/gemma-4-12B-it bash infrastructure/pod_setup.sh)"; tail -20 "$LOGS/vllm.log"; exit 1; }
  sleep 10; done
curl -fs http://127.0.0.1:8081/v1/models >/dev/null || { echo "vLLM not ready after 40 minutes - see $LOGS/vllm.log"; exit 1; }
echo "vLLM is serving $LLM_MODEL"

step "application server"
TOK="$WS/rolly_tokens.env"
[ -f "$TOK" ] || { umask 077; echo "export ROLLY_ACCESS_TOKEN=$(openssl rand -hex 12)" > "$TOK"; echo "export ROLLY_ADMIN_TOKEN=$(openssl rand -hex 12)" >> "$TOK"; }
# shellcheck disable=SC1090
. "$TOK"
pkill -f "uvicorn backend.app.main" 2>/dev/null || true; sleep 1
export ROLLY_HOST=0.0.0.0 ROLLY_DATA_DIR="$WS/rolly-data"
export ROLLY_STT_DEVICE=cuda ROLLY_STT_COMPUTE=float16 ROLLY_STT_WORKERS="${ROLLY_STT_WORKERS:-4}"
# TTS stays on CPU in this first run (the sherpa-onnx wheel is CPU-only); Piper English is ~14x real time on CPU.
export ROLLY_TTS_PROVIDER=cpu ROLLY_TTS_INSTANCES="${ROLLY_TTS_INSTANCES:-4}" ROLLY_TTS_THREADS=2
export ROLLY_TTS_EN_KIND=vits ROLLY_TTS_EN_DIR=models/vits-piper-en_US-lessac-medium ROLLY_TTS_EN_FILE=en_US-lessac-medium.onnx ROLLY_TTS_EN_SPEAKER=0
export ROLLY_LLM_BASE_URL=http://127.0.0.1:8081/v1 ROLLY_LLM_MODEL=local
WARM="modular-selfhosted"
if [ -n "${OPENAI_API_KEY:-}" ]; then
  export ROLLY_HYBRID_LLM_BASE_URL=https://api.openai.com/v1 ROLLY_HYBRID_LLM_MODEL=gpt-6-luna ROLLY_HYBRID_LLM_API_KEY="$OPENAI_API_KEY"
  export ROLLY_HYBRID_LLM_TOKEN_PARAM=max_completion_tokens ROLLY_HYBRID_LLM_REASONING=none
  WARM="modular-selfhosted,hybrid-apillm"; echo "OpenAI key found: hybrid and realtime providers enabled"
fi
export ROLLY_WARM_PROVIDERS="$WARM"
nohup infrastructure/run_dev.sh 8000 > "$LOGS/server.log" 2>&1 &
for i in $(seq 1 120); do curl -fs http://127.0.0.1:8000/healthz 2>/dev/null | grep -q '"ready":true' && break; sleep 3; done
curl -fs http://127.0.0.1:8000/healthz | grep -q '"ready":true' || { echo "server not ready - see $LOGS/server.log"; tail -30 "$LOGS/server.log"; exit 1; }

step "ready"
echo "Server is up on port 8000.  Next:   bash infrastructure/pod_bench.sh"
echo "Browser test (needs HTTPS for the microphone): open the pod's HTTP-proxy URL for port 8000 with ?token=\$ROLLY_ACCESS_TOKEN (tokens are in $TOK)"
