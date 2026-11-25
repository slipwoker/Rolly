#!/usr/bin/env bash
# Follow-up job for a running pod.  pod_autorun.sh re-runs this file whenever its content changes on the
# deployment branch (the pod has no shell access), without restarting vLLM.  Output: $WS/logs/job.log.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
# job 8: diagnose why BlueV3 takes about 4 s per sentence on this host (job 7: speed gate failed, Hebrew stays on Piper).
WS="${ROLLY_WORKSPACE:-/workspace}"; BL="$WS/blue"
pkill -f "examples/openai_server.py" 2>/dev/null || true
SITE="$("$BL/venv/bin/python" -c "import site; print(site.getsitepackages()[0])")"
NVLIBS="$(ls -d "$SITE"/nvidia/*/lib 2>/dev/null | tr '\n' ':')"
echo "nvidia wheel library dirs: $(ls -d "$SITE"/nvidia/*/lib 2>/dev/null | wc -l)"; nproc; uptime
LD_LIBRARY_PATH="$NVLIBS${LD_LIBRARY_PATH:-}" "$BL/venv/bin/python" infrastructure/blue_diag.py "$BL" 2>&1 | grep -v "consider to run pre-processing" | cut -c1-400
