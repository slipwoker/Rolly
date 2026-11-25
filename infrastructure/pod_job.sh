#!/usr/bin/env bash
# Follow-up job for a running pod.  pod_autorun.sh re-runs this file whenever its content changes on the
# deployment branch (the pod has no shell access), without restarting vLLM.  Output: $WS/logs/job.log.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
# job 4: Hebrew voice server (ZONOS3-Mini) built for this GPU's architecture (the project's default is H100 only),
# then restart the worker so that it uses it.  While it builds, the pipeline uses the Piper voice.
bash infrastructure/zonos_setup.sh
bash infrastructure/start_worker.sh
