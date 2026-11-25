#!/usr/bin/env bash
# Follow-up job for a running pod.  pod_autorun.sh re-runs this file whenever its content changes on the
# deployment branch (the pod has no shell access), without restarting vLLM.  Output: $WS/logs/job.log.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
# job 5: back to the Piper voice for Hebrew.  In live conversation the ZONOS3-Mini voice cut the last word of
# sentences, ran sentences together and changed pace between them (listener feedback, confirmed by measurement).
# The voice server keeps running for tuning; the pipeline does not use it until ROLLY_TTS_HE_ENGINE=zonos again.
bash infrastructure/zonos_setup.sh
ROLLY_TTS_HE_ENGINE=renikud_piper bash infrastructure/start_worker.sh
