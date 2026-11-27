#!/usr/bin/env bash
# Follow-up job for a running pod.  pod_autorun.sh re-runs this file whenever its content changes on the
# deployment branch (the pod has no shell access), without restarting vLLM.  Output: $WS/logs/job.log.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
# a one-off measurement (marker file present): run it and leave the voice worker alone, so no call is cut (run 4: dir2 variant)
if [ -f infrastructure/style_eval.run ]; then bash infrastructure/style_eval_job.sh; exit 0; fi
# job 10: Hebrew voice = BlueV3 (built-in voice "daniel", speed 1.2), chosen by the product owner from listening samples.
# Jobs 8-9 found the cause of the 3-9 s per sentence: the Hebrew text front end ran on the host's CPU (2.5 s alone).
# blue_serve.py now puts it on the GPU.  The worker is switched to BlueV3 only if blue_setup.sh's speed gate passes;
# otherwise Hebrew stays on Piper.
# job 11 (2026-11-25): restart the worker for the per-turn question guard and the Hebrew pronunciation fix (זאפי);
# vLLM and the BlueV3 server keep running, blue_setup.sh is idempotent.
# job 12 (2026-11-26): restart the worker for the note channel ({"type":"note"} on /v1/session: pacing and memory
# hints from rolly-api for the model's next turns).  Same restart as job 11: only the worker.
# job 13 (2026-11-26): restart the worker for the voice routing fix (Hebrew letters never go to the English voice) and
# the pronunciation of Spanish / Italian / German phrases in the Hebrew voice.  Same restart: only the worker.
# job 14 (2026-11-26): restart the worker for online lookups (the lookup marker is kept out of speech and reported as
# session.lookup_requested) and for skipping pieces with nothing to say ("—" woke the backup voice).  Only the worker.
# job 15 (2026-11-26): the voices the owner chose from 77 listening samples: BlueV3 `ariel` at speed 1.0 in Hebrew and
# `jonathan` at 1.0 in English (before: daniel at 1.2, and Piper for English).  Restarts the voice server (blue_setup.sh,
# which now installs both voices) and the worker.
# job 16 (2026-11-26): the voice speaks a whole piece in one synthesis and keeps short sentences together (blue_stream=0,
# tts_merge_chars=70), chosen in two blind listenings (P1-D37).  Only the worker restarts (same steps as job 15).
# The engine name in the session summary now ends in ":whole" when this is on.
# Back to the per-sentence synthesis of before: ROLLY_BLUE_STREAM=1 ROLLY_TTS_MERGE_CHARS=0.
# job 17 (2026-11-26): restart the worker for the lookup fix (a request is reported as soon as the marker is written, so a
# reply cut off right after "checking" no longer loses it) and for waiting plan topics skipping turns where the user asked
# a question (P1-D38).  Only the worker restarts.
# job 18 (2026-11-26): restart the worker for the name מאור given to BlueV3 as phonemes (it said "Me-or"). Only the worker restarts.
# job 19 (2026-11-26): names (P1-D39): the voice server (restarted by blue_setup.sh, as in job 15) serves its Hebrew front end on
# 127.0.0.1:1921; the worker pins a name that the front end reads differently by position, and takes the user's correction.
# Without the probe (ROLLY_NAME_PROBE=0 for blue_serve.py) everything is as before.
# job 20 (2026-11-27): smart end of turn in mode shadow (P1-D40): verdicts on what the user said so far are only measured
# (pod metrics turn_end_*), nothing changes. Only the worker restarts. ROLLY_TURN_END=on applies them.
# job 21 (2026-11-27): CUDA diagnosis at the start of the job (see below), then the usual restart of the voice server and the worker.
# Back to the old voices: ROLLY_BLUE_VOICE=daniel ROLLY_BLUE_SPEED=1.2 ROLLY_TTS_EN_ENGINE=sherpa.
# job 21 (2026-11-27): the worker and the voice server found no usable CUDA ("CUDA failure 999: unknown error", cudaSetDevice) while
# vLLM still holds the GPU: diagnose (output in job.log, published on :8001) and try the usual fix (the unified-memory device node).
echo "--- cuda diag $(date -u +%FT%TZ)"
nvidia-smi --query-gpu=name,driver_version,memory.used,memory.total,compute_mode,persistence_mode --format=csv 2>&1 | head -3
ls -l /dev/nvidia* 2>&1 | head -12
cat /proc/driver/nvidia/version 2>&1 | head -2
env | grep -E '^(NVIDIA|CUDA)[A-Z_]*=' | sed 's/=.*/=<set>/' | head
python3 - <<'PYEOF' 2>&1 | head -5
import ctypes
try:
    lib = ctypes.CDLL("libcuda.so.1"); print("cuInit ->", lib.cuInit(0))
    n = ctypes.c_int(); print("cuDeviceGetCount ->", lib.cuDeviceGetCount(ctypes.byref(n)), n.value)
except Exception as e:
    print("libcuda:", e)
PYEOF
ps -eo pid,etimes,rss,cmd | grep -E 'vllm|blue_serve|uvicorn' | grep -v grep | cut -c1-160 | head -6
if [ ! -e /dev/nvidia-uvm ] && command -v nvidia-modprobe >/dev/null 2>&1; then echo "creating /dev/nvidia-uvm"; nvidia-modprobe -u -c=0 2>&1 | head -3; fi
echo "--- end cuda diag"
pkill -f "zonos3-server" 2>/dev/null || true
if bash infrastructure/blue_setup.sh; then
  ROLLY_TTS_HE_ENGINE=blue bash infrastructure/start_worker.sh
else
  echo "BlueV3 not in use; Hebrew stays on Piper"
  ROLLY_TTS_HE_ENGINE=renikud_piper bash infrastructure/start_worker.sh
fi
