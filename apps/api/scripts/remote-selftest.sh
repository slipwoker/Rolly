#!/usr/bin/env bash
# Run a server-side self-test on the deployed rolly-api (scripted phone next to the server -> real GPU pod) and save the
# result. Needs the admin token: Authorization header, or injected by the Claude environment's proxy.
#   apps/api/scripts/remote-selftest.sh relay he
#   apps/api/scripts/remote-selftest.sh memory he
set -euo pipefail
API=${ROLLY_API:-https://rolly-api.onrender.com}
SCENARIO=${1:-relay}
LANG_=${2:-he}
AUTH=()
[ -n "${ROLLY_ADMIN_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer ${ROLLY_ADMIN_TOKEN}")
OUT_DIR=$(cd "$(dirname "$0")/../../.." && pwd)/benchmarks/results
id=$(curl -sf -m 30 -X POST "$API/v1/admin/selftest" "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d "{\"scenario\":\"$SCENARIO\",\"lang\":\"$LANG_\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "job $id"
for _ in $(seq 1 90); do
  r=$(curl -sf -m 30 "$API/v1/admin/selftest/$id" "${AUTH[@]}")
  st=$(echo "$r" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
  [ "$st" != "running" ] && break
  sleep 5
done
f="$OUT_DIR/phase1_selftest_${SCENARIO}_${LANG_}_$(date -u +%Y%m%dT%H%M%S).json"
echo "$r" | python3 -m json.tool --no-ensure-ascii > "$f"
echo "status: $st -> $f"
