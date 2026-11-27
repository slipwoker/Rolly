#!/usr/bin/env bash
# One-off measurement run on the pod: how human Rolly sounds on the pod's own conversation model (vLLM on 127.0.0.1:8081),
# for two persona variants (infrastructure/style_eval/prompts).  Does not touch the voice worker.  Started by pod_job.sh
# when infrastructure/style_eval.run exists.  Output: $WS/public/style_eval/{out.txt,result.json} (synthetic conversations only).
set -uo pipefail
cd "$(dirname "$0")/.."
WS="${ROLLY_WORKSPACE:-/workspace}"; PUB="$WS/public/style_eval"; D="$WS/styleeval"; mkdir -p "$PUB" "$D"
exec > "$PUB/out.txt" 2>&1
echo "style eval started $(date -u +%FT%TZ)"
NODE="$WS/node"
if [ ! -x "$NODE/bin/node" ]; then
  rm -rf "$WS/node-v22.12.0-linux-x64" "$NODE"
  curl -fsSL https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.gz | tar -xz --no-same-owner -C "$WS" && mv "$WS/node-v22.12.0-linux-x64" "$NODE" || { echo "node install failed"; exit 1; }
fi
export PATH="$NODE/bin:$PATH"
cp -r infrastructure/style_eval/. "$D/"
cd "$D"
[ -d node_modules/tsx ] && [ -d node_modules/undici ] || { npm init -y >/dev/null 2>&1; npm install --silent tsx undici || { echo "npm install failed"; exit 1; }; }
for i in $(seq 1 120); do curl -fs -H "Authorization: Bearer ${ROLLY_GPU_API_KEY:-x}" http://127.0.0.1:8081/v1/models >/dev/null && break; sleep 5; done
ROLLY_LLM_URL=http://127.0.0.1:8081/v1 ROLLY_LLM_KEY="${ROLLY_GPU_API_KEY:-x}" node_modules/.bin/tsx style-eval.ts --variants base,dir2 --reps 3 --out "$PUB/result.json"
echo "style eval finished $(date -u +%FT%TZ) exit $?"
