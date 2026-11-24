#!/usr/bin/env bash
# Downloads every model used by the self-hosted pipeline into ./models (about 7 GB with the CPU LLM).
# Usage: infrastructure/download_models.sh [--no-llm]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="${PYTHON:-$ROOT/.venv/bin/python}"
mkdir -p "$ROOT/models/hebrew-tts" && cd "$ROOT/models"
export HF_HOME="$ROOT/models/hf"

# Silero VAD (MIT)
[ -s silero_vad.onnx ] || curl -fsSL -o silero_vad.onnx https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx

# English TTS voices packaged for sherpa-onnx (Kokoro: Apache-2.0; Piper lessac: see MODEL_CARD)
for f in kokoro-multi-lang-v1_0 vits-piper-en_US-lessac-medium; do
  [ -d "$f" ] || { curl -fsSL -o "$f.tar.bz2" "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/$f.tar.bz2"; tar -xjf "$f.tar.bz2"; rm "$f.tar.bz2"; }
done

# Hebrew TTS: voice (CC BY 4.0) + grapheme-to-phoneme model (CC BY 4.0)
[ -s hebrew-tts/he_IL-noa-medium.onnx ] || curl -fsSL -o hebrew-tts/he_IL-noa-medium.onnx https://huggingface.co/thewh1teagle/piper-he-noa/resolve/main/he_IL-noa-medium.onnx
[ -s hebrew-tts/he_IL-noa-medium.onnx.json ] || curl -fsSL -o hebrew-tts/he_IL-noa-medium.onnx.json https://huggingface.co/thewh1teagle/piper-he-noa/resolve/main/he_IL-noa-medium.onnx.json
[ -s hebrew-tts/renikud.onnx ] || curl -fsSL -o hebrew-tts/renikud.onnx https://huggingface.co/renikud/renikud/resolve/main/model.onnx

# Speech-to-text (Apache-2.0 / MIT) and, unless --no-llm, a small CPU LLM for development (Apache-2.0)
"$PY" - "$@" <<'PY'
import sys
from huggingface_hub import hf_hub_download, snapshot_download
for rid in ("ivrit-ai/whisper-large-v3-turbo-ct2", "deepdml/faster-whisper-large-v3-turbo-ct2", "Systran/faster-whisper-small"):
    print("fetching", rid); snapshot_download(rid)
if "--no-llm" not in sys.argv:
    print("fetching CPU development LLM"); hf_hub_download("unsloth/Qwen3-4B-Instruct-2507-GGUF", "Qwen3-4B-Instruct-2507-Q4_K_M.gguf")
PY
echo "models ready in $ROOT/models"
