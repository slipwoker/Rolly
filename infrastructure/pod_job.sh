#!/usr/bin/env bash
# Follow-up job for a running pod.  pod_autorun.sh re-runs this file whenever its content changes on the
# deployment branch (the pod has no shell access), without restarting vLLM.  Output: $WS/logs/job.log.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
# job 3 (job 2 built for the GPU but the server aborted on a Hopper-only probe; now switched off):
# was job 2: Hebrew voice server (ZONOS3-Mini) built for the GPU (job 1 fell back to CPU: wrong CUDA package names),
# then restart the worker so that it uses it
bash infrastructure/zonos_setup.sh
bash infrastructure/start_worker.sh
