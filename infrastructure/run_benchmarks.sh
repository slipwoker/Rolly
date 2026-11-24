#!/usr/bin/env bash
# Runs the whole benchmark suite against a running server and regenerates the cost model.
# Usage: infrastructure/run_benchmarks.sh <provider-id> "<hardware description>" [ws-url] [admin-token]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
PROVIDER="${1:?provider id, e.g. modular-selfhosted}"; HW="${2:?hardware description, e.g. 'RunPod L40S 48GB'}"
URL="${3:-ws://127.0.0.1:8000/ws}"; ADMIN="${4:-${ROLLY_ADMIN_TOKEN:-}}"
PY="${PYTHON:-$ROOT/.venv/bin/python}"; export PYTHONPATH="$ROOT" HF_HOME="${HF_HOME:-$ROOT/models/hf}"
"$PY" -m benchmarks.run_scenarios --provider "$PROVIDER" --url "$URL" --hardware "$HW" --repeat "${REPEAT:-3}" --tag "bench-$PROVIDER"
"$PY" -m benchmarks.concurrency --provider "$PROVIDER" --url "$URL" --hardware "$HW" --levels ${LEVELS:-1 5 10 20 50} --admin-token "$ADMIN" --stop-on-fail
"$PY" -m benchmarks.long_session --provider "$PROVIDER" --url "$URL" --hardware "$HW" --minutes "${MINUTES:-30}"
"$PY" -m finops.cost_model
echo "results in benchmarks/results/, cost model in reports/"
