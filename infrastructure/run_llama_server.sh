#!/usr/bin/env bash
# Starts a local OpenAI-compatible LLM server (llama.cpp) for CPU-only development.
# On a GPU host use infrastructure/docker-compose.gpu.yml (vLLM) instead.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODEL="${ROLLY_GGUF:-$(ls "$ROOT"/models/hf/hub/models--unsloth--Qwen3-4B-Instruct-2507-GGUF/snapshots/*/*.gguf | head -1)}"
PORT="${ROLLY_LLM_PORT:-8081}"
export LD_LIBRARY_PATH="$ROOT/models/llama.cpp:${LD_LIBRARY_PATH:-}"
exec "$ROOT/models/llama.cpp/llama-server" -m "$MODEL" --host 127.0.0.1 --port "$PORT" \
  -c "${ROLLY_LLM_CTX:-8192}" -np "${ROLLY_LLM_PARALLEL:-1}" -t "${ROLLY_LLM_THREADS:-4}" --jinja --no-webui
