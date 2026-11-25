#!/usr/bin/env bash
# Follow-up job for a running pod.  pod_autorun.sh re-runs this file whenever its content changes on the
# deployment branch (the pod has no shell access), without restarting vLLM.  Output: $WS/logs/job.log.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
# job 10: Hebrew voice = BlueV3 (built-in voice "daniel", speed 1.2), chosen by the product owner from listening samples.
# Jobs 8-9 found the cause of the 3-9 s per sentence: the Hebrew text front end ran on the host's CPU (2.5 s alone).
# blue_serve.py now puts it on the GPU.  The worker is switched to BlueV3 only if blue_setup.sh's speed gate passes;
# otherwise Hebrew stays on Piper.
# job 11 (2026-11-25): restart the worker for the per-turn question guard and the Hebrew pronunciation fix (זאפי);
# vLLM and the BlueV3 server keep running, blue_setup.sh is idempotent.
pkill -f "zonos3-server" 2>/dev/null || true
if bash infrastructure/blue_setup.sh; then
  ROLLY_TTS_HE_ENGINE=blue bash infrastructure/start_worker.sh
else
  echo "BlueV3 not in use; Hebrew stays on Piper"
  ROLLY_TTS_HE_ENGINE=renikud_piper bash infrastructure/start_worker.sh
fi
