#!/usr/bin/env bash
# Local CPU development server.  Usage: infrastructure/run_dev.sh [port]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[ -f .env ] && set -a && . ./.env && set +a
export HF_HOME="${HF_HOME:-$ROOT/models/hf}"
export ROLLY_STT_COMPUTE="${ROLLY_STT_COMPUTE:-int8}"
export ROLLY_STT_DEVICE="${ROLLY_STT_DEVICE:-cpu}"
exec "$ROOT/.venv/bin/uvicorn" backend.app.main:app --host "${ROLLY_HOST:-127.0.0.1}" --port "${1:-8000}"
