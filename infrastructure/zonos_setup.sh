#!/usr/bin/env bash
# Build and start the ZONOS3-Mini voice server (Zyphra, Apache-2.0 weights, MIT code) on this host.
#   C++/ggml server from https://github.com/Zyphra/ZONOS3-Mini, pinned commit, built with CUDA when the toolkit
#   can be installed, otherwise for CPU.  Listens on 127.0.0.1:1919 only; the pipeline talks to it locally.
# Everything lives under $ROLLY_WORKSPACE/zonos (persistent volume), so a restart only starts the server.
# Idempotent.  Output: $ROLLY_WORKSPACE/logs/zonos.log (published by pod_autorun.sh).
set -uo pipefail
SELF="$(readlink -f "$0")"
WS="${ROLLY_WORKSPACE:-/workspace}"; Z="$WS/zonos"; LOGS="$WS/logs"; PUB="$WS/public"; mkdir -p "$Z" "$LOGS" "$PUB"
COMMIT="${ROLLY_ZONOS_COMMIT:-a50e141}"
say() { echo "[$(date -u +%T)] $*"; }
state() { echo "{\"zonos\": \"$1\", \"time\": \"$(date -u +%FT%TZ)\", \"backend\": \"${BACKEND:-?}\"}" > "$PUB/zonos.json"; }
BACKEND="?"; state building

# a CPU instance from an earlier attempt is too slow for conversation: stop it, the pipeline falls back to Piper
pkill -f "zonos3-server" 2>/dev/null || true
say "tools"
export DEBIAN_FRONTEND=noninteractive
command -v cmake >/dev/null && command -v git >/dev/null && command -v pkg-config >/dev/null || \
  (apt-get update -qq && apt-get install -y -qq cmake git pkg-config build-essential curl ca-certificates >/dev/null)
export CARGO_HOME="$Z/cargo" RUSTUP_HOME="$Z/rustup" PATH="$Z/cargo/bin:$PATH"
command -v cargo >/dev/null || (curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable >/dev/null 2>&1)
cargo --version || { say "no Rust toolchain"; state failed; exit 1; }

say "source at $COMMIT"
if [ ! -d "$Z/src/.git" ]; then git clone -q https://github.com/Zyphra/ZONOS3-Mini "$Z/src" || { state failed; exit 1; }; fi
cd "$Z/src" && git fetch -q origin && git checkout -q "$COMMIT" && git submodule update -q --init --depth 1 servers/ggml/ggml third_party/zyphra-textnorm \
  || { say "checkout failed"; state failed; exit 1; }
cd "$Z/src/servers/ggml"

# CUDA build needs the compiler part of the toolkit, which the runtime image does not ship
if [ "${ROLLY_ZONOS_BACKEND:-gpu}" != "cpu" ] && ! command -v nvcc >/dev/null && [ ! -x /usr/local/cuda/bin/nvcc ]; then
  V="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1)"; say "installing the CUDA compiler packages (driver $V)"
  # the nvidia/cuda images export CUDA_VERSION (e.g. 12.4.1); the apt packages are named by major-minor
  CV="$(echo "${CUDA_VERSION:-$(ls -d /usr/local/cuda-*.* 2>/dev/null | head -1 | sed 's/.*cuda-//')}" | cut -d. -f1,2 | tr . -)"; CV="${CV:-12-4}"
  say "CUDA packages for version $CV"
  (apt-get update -qq && apt-get install -y -qq "cuda-nvcc-$CV" "cuda-cudart-dev-$CV" "libcublas-dev-$CV" "cuda-driver-dev-$CV" "cuda-cccl-$CV" >/dev/null) \
    || say "CUDA compiler packages not available"
fi
export PATH="/usr/local/cuda/bin:$PATH" CUDA_HOME="${CUDA_HOME:-/usr/local/cuda}"
# The project's CMake file compiles for sm_90 (H100) only; any other GPU then fails at run time with
# "no kernel image is available".  Build for the GPU that is actually here (L40S = compute capability 8.9 -> 89).
ARCH="${ROLLY_ZONOS_CUDA_ARCH:-$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d '. ')}"
BUILD="build-cuda-$ARCH"
if [ "${ROLLY_ZONOS_BACKEND:-gpu}" != "cpu" ] && command -v nvcc >/dev/null && [ -n "$ARCH" ]; then
  if [ ! -x "$BUILD/zonos3-server" ]; then
    say "building with CUDA for architecture $ARCH (about 15 minutes)"
    cmake -B "$BUILD" -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="$ARCH" -DCMAKE_BUILD_TYPE=Release > "$LOGS/zonos_build.log" 2>&1 \
      && cmake --build "$BUILD" -j"$(nproc)" --target zonos3-server zonos3-cli >> "$LOGS/zonos_build.log" 2>&1 \
      || { say "CUDA build failed:"; grep -i "error" "$LOGS/zonos_build.log" | head -8; tail -8 "$LOGS/zonos_build.log"; rm -rf "$BUILD"; }
  fi
fi
if [ -x "$BUILD/zonos3-server" ] && [ "${ROLLY_ZONOS_BACKEND:-gpu}" != "cpu" ]; then BIN="$PWD/$BUILD/zonos3-server"; BACKEND=gpu; FLAG="--gpu"
elif [ "${ROLLY_ZONOS_BACKEND:-gpu}" = "cpu" ]; then
  # CPU was measured on this host with a 23 s voice reference: first audio after about 1.3 s and gaps in playback.
  # Too slow for conversation, so it is used only when asked for explicitly.
  if [ ! -x build/zonos3-server ]; then
    say "building for CPU (several minutes)"
    cmake -B build -DCMAKE_BUILD_TYPE=Release > "$LOGS/zonos_build.log" 2>&1 && cmake --build build -j"$(nproc)" --target zonos3-server zonos3-cli >> "$LOGS/zonos_build.log" 2>&1 \
      || { say "CPU build failed:"; tail -15 "$LOGS/zonos_build.log"; state failed; exit 1; }
  fi
  BIN="$PWD/build/zonos3-server"; BACKEND=cpu; FLAG="--cpu"
else
  say "no GPU build of the voice server: the pipeline keeps using the Piper voice"; BACKEND=none; state failed; exit 1
fi

say "model files"
mkdir -p "$Z/gguf"
for f in backbone-ptq.gguf zac-keep2.gguf; do
  [ -s "$Z/gguf/$f" ] || curl -fsSL -o "$Z/gguf/$f" "https://huggingface.co/Zyphra/ZONOS3-Mini/resolve/main/gguf/$f" || { say "download of $f failed"; state failed; exit 1; }
done

say "starting the server ($BACKEND)"
# ggml's "programmatic dependent launch" probe aborts on GPUs older than Hopper ("no kernel image is available",
# seen on an L40S); the feature only exists on Hopper and newer, so it is switched off.
export GGML_CUDA_PDL=0
pkill -f "zonos3-server" 2>/dev/null || true; sleep 1
mkdir -p "$Z/novoices"
nohup "$BIN" "$Z/gguf/backbone-ptq.gguf" $FLAG --host 127.0.0.1 --port 1919 --batch "${ROLLY_ZONOS_BATCH:-8}" --tts-default-voices-dir "$Z/novoices" > "$LOGS/zonos_server.log" 2>&1 &
for i in $(seq 1 90); do curl -fs -m 3 http://127.0.0.1:1919/v2/capabilities >/dev/null 2>&1 && break; sleep 2; done
if ! curl -fs -m 3 http://127.0.0.1:1919/v2/capabilities >/dev/null 2>&1; then
  say "server did not come up:"; tail -15 "$LOGS/zonos_server.log"
  state failed; exit 1
fi

# speed check with a default (non-cloned) voice: time to first audio and total time for one Hebrew sentence
T0=$(date +%s.%N)
curl -fsS -m 60 http://127.0.0.1:1919/v2/generate -d '{"text":"בוקר טוב, מה קורה? חשבתי על מה שדיברנו אתמול.","language":"he","stream":true,"silence_prefill_frames":0}' \
  -o "$Z/warm.pcm" -w "warm-up: first byte %{time_starttransfer} s, total %{time_total} s, %{size_download} bytes of float32 PCM at 44.1 kHz\n" || say "warm-up request failed"
curl -fsS -m 60 http://127.0.0.1:1919/v2/generate -d '{"text":"בוקר טוב, מה קורה? חשבתי על מה שדיברנו אתמול.","language":"he","stream":true,"silence_prefill_frames":0}' \
  -o "$Z/warm.pcm" -w "second:  first byte %{time_starttransfer} s, total %{time_total} s, %{size_download} bytes\n" || true
nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader
say "ZONOS3-Mini is serving on 127.0.0.1:1919 ($BACKEND)"; state serving
