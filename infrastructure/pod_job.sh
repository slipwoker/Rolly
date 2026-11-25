#!/usr/bin/env bash
# Follow-up job for a running pod.  pod_autorun.sh re-runs this file whenever its content changes on the
# deployment branch (the pod has no shell access), without restarting vLLM.  Output: $WS/logs/job.log.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
# job 7: Hebrew voice = BlueV3 (built-in voice "daniel", speed 1.2), chosen by the product owner from listening samples.
# Job 6 started it on CPU because the GPU libraries did not match (3-7 s per sentence).  Until BlueV3 passes the
# speed gate in blue_setup.sh the pipeline runs on the Piper voice; the worker is switched over only if it passes.
pkill -f "zonos3-server" 2>/dev/null || true
ROLLY_TTS_HE_ENGINE=renikud_piper bash infrastructure/start_worker.sh
if bash infrastructure/blue_setup.sh; then
  ROLLY_TTS_HE_ENGINE=blue bash infrastructure/start_worker.sh
else
  echo "BlueV3 not in use; Hebrew stays on Piper"
fi
