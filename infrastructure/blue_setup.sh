#!/usr/bin/env bash
# Install and start the BlueV3 Hebrew voice server on this host.
#   Model: notmax123/BlueV3-onnx v3.0.1 (MIT; decoder OpenRAIL-M).  Code: github.com/maxmelichov/BlueTTS, pinned commit,
#   in its own Python environment (it needs onnxruntime 1.27-1.29; the pipeline uses another version).
#   Serves the OpenAI-compatible example server of BlueTTS on 127.0.0.1:1920 only; the pipeline talks to it locally.
# Everything lives under $ROLLY_WORKSPACE/blue (persistent volume).  Idempotent.  Output goes to the job log.
set -uo pipefail
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
WS="${ROLLY_WORKSPACE:-/workspace}"; BL="$WS/blue"; LOGS="$WS/logs"; PUB="$WS/public"; mkdir -p "$BL" "$LOGS" "$PUB"
COMMIT="${ROLLY_BLUE_COMMIT:-5a9d9a0}"; VOICE="${ROLLY_BLUE_VOICE:-daniel}"
say() { echo "[$(date -u +%T)] $*"; }
state() { echo "{\"blue\": \"$1\", \"time\": \"$(date -u +%FT%TZ)\", \"providers\": \"${USED:-?}\"}" > "$PUB/blue.json"; }
state installing
export PATH="$HOME/.local/bin:$PATH" UV_PYTHON_INSTALL_DIR="$WS/uv-python" HF_HOME="${HF_HOME:-$WS/hf}"
command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1
command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git >/dev/null)

say "source at $COMMIT"
[ -d "$BL/src/.git" ] || git clone -q https://github.com/maxmelichov/BlueTTS "$BL/src" || { state failed; exit 1; }
(cd "$BL/src" && git fetch -q origin && git checkout -q "$COMMIT") || { say "checkout failed"; state failed; exit 1; }

PY="$BL/venv/bin/python"
if ! "$PY" -c "import blue_onnx, fastapi, uvicorn, polyg2p" 2>/dev/null; then
  say "python environment"
  rm -rf "$BL/venv"; uv venv -q --python 3.12 "$BL/venv" || { state failed; exit 1; }
  uv pip install -q --python "$PY" -e "$BL/src[hebrew]" "renikud-plus[cpu]==0.5.0" "heb-tts-normalizer==0.2.0" "hebrew-num2words==0.1.0" \
    "fastapi>=0.110" "uvicorn>=0.29" httpx || { say "dependency install failed"; state failed; exit 1; }
fi

say "model files"
"$PY" - <<PYEOF || { say "model download failed"; state failed; exit 1; }
from huggingface_hub import snapshot_download
snapshot_download("notmax123/BlueV3-onnx", local_dir="$BL/bundle",
                  allow_patterns=["onnx/*", "voices/*", "frontend/*", "frontend/**", "*.md", "MANIFEST.json"],
                  ignore_patterns=["frontend/*macosx*", "onnx/vector_estimator.int8.onnx"])
PYEOF
"$PY" -c "import polyg2p" 2>/dev/null || uv pip install -q --python "$PY" --no-index --find-links "$BL/bundle/frontend" polyg2p==0.1.0
mkdir -p "$BL/voice" && cp "$BL/bundle/voices/$VOICE.json" "$BL/voice/" || { say "voice $VOICE not in the bundle"; state failed; exit 1; }
# the other voices of the bundle too: the default stays $VOICE, the rest only answer when a request names them
# (the audition endpoint of the worker; 2026-11-26, after "adam" turned out to be read aloud as a word, not used as a voice)
cp "$BL/bundle/voices/"*.json "$BL/voice/" 2>/dev/null || true

# GPU provider.  onnxruntime-gpu 1.27-1.29 is built for CUDA 13 + cuDNN 9, this image ships CUDA 12: the matching
# libraries come as pip wheels (the [cuda,cudnn] extras) and are put on the library path of the server process.
# onnxruntime-gpu replaces the CPU wheel (both provide the same module).
SITE="$("$PY" -c "import site; print(site.getsitepackages()[0])")"
if [ "${ROLLY_BLUE_BACKEND:-gpu}" = "gpu" ] && ! ls "$SITE"/nvidia/*/lib/libcudnn.so* >/dev/null 2>&1; then
  say "installing the GPU build of ONNX Runtime with its CUDA and cuDNN libraries"
  uv pip uninstall -q --python "$PY" onnxruntime 2>/dev/null
  uv pip install -q --python "$PY" --reinstall "onnxruntime-gpu[cuda,cudnn]>=1.27,<1.30" \
    || { say "GPU build not installable; back to CPU"; uv pip install -q --python "$PY" --reinstall "onnxruntime>=1.27,<1.30"; }
fi
NVLIBS="$(ls -d "$SITE"/nvidia/*/lib 2>/dev/null | tr '\n' ':')"
PROVIDERS="CPUExecutionProvider"
"$PY" -c "import onnxruntime as o, sys; sys.exit(0 if 'CUDAExecutionProvider' in o.get_available_providers() else 1)" 2>/dev/null && [ "${ROLLY_BLUE_BACKEND:-gpu}" = "gpu" ] \
  && PROVIDERS="CUDAExecutionProvider,CPUExecutionProvider"

say "starting the server (providers requested: $PROVIDERS)"
pkill -f "examples/openai_server.py" 2>/dev/null || true; pkill -f "blue_serve.py" 2>/dev/null || true; sleep 1
# fp32: the listening samples were made with the float graph; the int8 graph is not quality-gated by its author
LD_LIBRARY_PATH="$NVLIBS${LD_LIBRARY_PATH:-}" BLUE_ONNX_PRECISION=fp32 POLYG2P_DATA="$BL/bundle/frontend/polyg2p_data" nohup "$PY" "$SELF_DIR/blue_serve.py" "$BL/src/examples/openai_server.py" --bundle "$BL/bundle" \
  --voices-dir "$BL/voice" --default-voice "$VOICE" --pcm-sample-rate 0 --host 127.0.0.1 --port 1920 --providers "$PROVIDERS" > "$LOGS/blue_server.log" 2>&1 &
for i in $(seq 1 90); do curl -fs -m 3 http://127.0.0.1:1920/health >/dev/null 2>&1 && break; sleep 2; done
curl -fs -m 3 http://127.0.0.1:1920/health >/dev/null 2>&1 || { say "server did not come up:"; tail -15 "$LOGS/blue_server.log"; state failed; exit 1; }
USED="$(grep -o "Using ONNX Runtime providers.*" "$LOGS/blue_server.log" | head -1)"; say "$USED"

REQ='{"model":"bluev3","input":"נו, מה קרה עם ששת הראיונות שעוד רצית לקבוע למשפחות?","language":"he","speed":1.2,"response_format":"pcm","stream":true}'
LAST=99
for n in 1 2 3 4; do
  LAST="$(curl -fsS -m 60 http://127.0.0.1:1920/v1/audio/speech -H "Content-Type: application/json" -d "$REQ" -o "$BL/warm.pcm" -w "%{time_total}")" || LAST=99
  say "request $n: $LAST s for one sentence of about 3.8 s"
done
grep -i "Failed to create\|error" "$LOGS/blue_server.log" | cut -c1-260 | sort -u | head -4
grep -F "[blue_serve]" "$LOGS/blue_server.log" | sort -u
nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader
tail -c 6000 "$LOGS/blue_server.log" > "$PUB/blue_server.log"
# Speed gate: a sentence is synthesised as a whole, so this time is the wait before its first sound.
# Slower than the limit is unusable in conversation (measured on this host's CPU: 3-7 s): leave the pipeline on Piper.
LIMIT="${ROLLY_BLUE_MAX_SENTENCE_S:-0.45}"
if ! awk -v t="$LAST" -v l="$LIMIT" 'BEGIN { exit !(t <= l) }'; then
  say "too slow for conversation ($LAST s > $LIMIT s): not used"; state too_slow; exit 1
fi
say "BlueV3 is serving on 127.0.0.1:1920"; state serving
