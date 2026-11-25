#!/usr/bin/env bash
# Follow-up job for a running pod.  pod_autorun.sh re-runs this file whenever its content changes on the
# deployment branch (the pod has no shell access), without restarting vLLM.  Output: $WS/logs/job.log.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
# job 9: BlueV3 took 6-9 s per sentence on GPU and on CPU alike (job 8).  The host shows 128 CPUs but the container's
# quota is about 13: a component that sizes its thread pool by the visible CPUs is throttled.  Measure with the
# process pinned to 8 CPUs, unpinned for comparison, and time the Hebrew text front end on its own.
WS="${ROLLY_WORKSPACE:-/workspace}"; BL="$WS/blue"
pkill -f "examples/openai_server.py" 2>/dev/null || true
SITE="$("$BL/venv/bin/python" -c "import site; print(site.getsitepackages()[0])")"
NVLIBS="$(ls -d "$SITE"/nvidia/*/lib 2>/dev/null | tr '\n' ':')"
command -v taskset >/dev/null || (apt-get update -qq && apt-get install -y -qq util-linux >/dev/null)
echo "--- pinned to CPUs 0-7"
LD_LIBRARY_PATH="$NVLIBS${LD_LIBRARY_PATH:-}" taskset -c 0-7 "$BL/venv/bin/python" infrastructure/blue_diag.py "$BL" 2>&1 | grep -v "consider to run pre-processing\|Loaded RenikudPlus\|Using ONNX" | cut -c1-400
