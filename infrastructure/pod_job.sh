#!/usr/bin/env bash
# Follow-up job for a running pod.  pod_autorun.sh re-runs this file whenever its content changes on the
# deployment branch (the pod has no shell access), without restarting vLLM.  Output: $WS/logs/job.log.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
# job 6: Hebrew voice = BlueV3 (built-in voice "daniel", speed 1.2), chosen by the product owner from listening samples.
# The ZONOS3 server is stopped (withdrawn; frees GPU memory).  If the BlueV3 server is down the pipeline uses Piper.
pkill -f "zonos3-server" 2>/dev/null || true
bash infrastructure/blue_setup.sh
ROLLY_TTS_HE_ENGINE=blue bash infrastructure/start_worker.sh
