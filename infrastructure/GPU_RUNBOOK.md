# GPU benchmark runbook

Status: **executed on 2026-11-24** on one RunPod L40S, but through the unattended path below rather than the manual steps in
sections 1–3, which remain as originally written and were not run by hand.

## 0. Unattended path (what was actually used)

No shell access is needed. Create a pod whose start command clones this repository and runs `infrastructure/pod_autorun.sh`;
that script runs `pod_setup.sh` (uv, Python 3.12, models, vLLM, the application) and then a benchmark script, and publishes
logs and result files on a read-only HTTP port.

- Image `nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04`, GPU with 48 GB, container disk 60 GB, volume 80 GB at `/workspace`,
  ports `8000/http,8001/http,22/tcp`.
- Start command: see the header of `infrastructure/pod_autorun.sh`.
- Environment: `ROLLY_WORKSPACE=/workspace`; `ROLLY_BENCH_SCRIPT=infrastructure/pod_bench2.sh` (or another pass) to choose the
  experiment; `OPENAI_API_KEY` (as a RunPod Secret or pod variable, never in the repository) to enable the hybrid provider and the
  OpenAI Realtime baseline.
- Watch `https://<pod-id>-8001.proxy.runpod.net/status.json`, `setup.log`, `bench.out`, `results/index.txt`.
- The repository must be readable by the pod (public, or add a token).
- Changing a pod variable through the API restarts the container; everything heavy is cached on the volume, so a restart takes
  about three minutes.
- Lessons from the run: the slim CUDA image needs `build-essential` for vLLM (handled in `pod_setup.sh`); read progress from the
  result files rather than from filtered console output; terminate the pod when done.

## 1. Rent the machine (about 20 minutes, about $1.09/h — price unverified)

1. Create an account at runpod.io and add $50 credit.
2. Deploy a pod: GPU **L40S 48 GB**, Secure Cloud, an EU region, a PyTorch / CUDA 12 template, container disk 60 GB,
   volume 80 GB, expose **TCP ports 8000 and 22**.
3. Note the pod's public IP and the mapped external port for 8000 (use the direct TCP mapping, not the HTTP proxy:
   the proxy is unauthenticated and cuts connections after 100 s).

Any other provider with a 48 GB GPU and SSH works the same way. On a 24 GB GPU set
`ROLLY_VLLM_MODEL=google/gemma-4-12B-it-qat-w4a16-ct` (research fallback, unmeasured).

## 2. Start the stack on the pod

```bash
git clone https://github.com/slipwoker/Rolly.git && cd Rolly
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/pip uninstall -y onnxruntime && .venv/bin/pip install onnxruntime-gpu
infrastructure/download_models.sh --no-llm
```

```bash
pip install vllm && nohup vllm serve google/gemma-4-26B-A4B-it --served-model-name local --port 8081 \
  --max-model-len 16384 --gpu-memory-utilization 0.70 --enable-prefix-caching > vllm.log 2>&1 &
```

```bash
export ROLLY_ACCESS_TOKEN=$(openssl rand -hex 16) ROLLY_ADMIN_TOKEN=$(openssl rand -hex 16)
export ROLLY_STT_DEVICE=cuda ROLLY_STT_COMPUTE=float16 ROLLY_STT_WORKERS=4
export ROLLY_TTS_PROVIDER=cuda ROLLY_TTS_INSTANCES=4 ROLLY_LLM_BASE_URL=http://127.0.0.1:8081/v1 ROLLY_LLM_MODEL=local
export ROLLY_WARM_PROVIDERS=modular-selfhosted ROLLY_HOST=0.0.0.0
nohup infrastructure/run_dev.sh 8000 > server.log 2>&1 &
```

(`docker compose -f infrastructure/docker-compose.gpu.yml up --build` does the same with containers.)

Gemma weights may need a Hugging Face token with the licence accepted: `export HF_TOKEN=…` before starting vLLM.

## 3. Run the benchmarks (about 2 hours unattended)

On the pod itself (removes network latency from the numbers):

```bash
REPEAT=3 LEVELS="1 5 10 20 50" MINUTES=30 infrastructure/run_benchmarks.sh modular-selfhosted "RunPod L40S 48GB, gemma-4-26B-A4B FP8, vLLM" \
  "ws://127.0.0.1:8000/ws?token=$ROLLY_ACCESS_TOKEN" "$ROLLY_ADMIN_TOKEN"
```

Then, from a laptop, repeat the scenario run against the public address to include real network latency, and open
`http://<ip>:<port>/?token=…` in Chrome for a manual conversation (HTTPS is required for the microphone unless you
tunnel to localhost: `ssh -L 8000:localhost:8000 root@<ip> -p <ssh-port>` then use `http://localhost:8000`).

## 4. Feed the results into the cost model

`benchmarks/results/concurrency_*.json` contains `max_sustainable_concurrency`. Measure each stage in isolation where
possible (STT workers, LLM, TTS instances) and run:

```bash
python -m finops.cost_model --capacity-override '{"base": {"stt": <n>, "llm": <n>, "tts": <n>}}'
```

## 5. Experiments worth the GPU hours (in priority order)

1. Latency budget on one session: STT, LLM time-to-first-token, first TTS chunk; endpointing at 544 / 400 / 300 ms and eager on/off.
2. Concurrency ramp 1 → 50 with the combined pipeline; record GPU memory and utilisation (`/api/resources`).
3. LLM alternatives on the same card: Gemma-4 26B-A4B FP8 vs a 12B model vs AWQ quantisation; prefix caching on/off.
4. STT: `num_workers` 1/2/4/8, batched decoding, float16 vs int8_float16.
5. Hebrew TTS bake-off: piper-he-noa vs BlueV3 vs ZONOS3-Mini (needs approval B4), time-to-first-audio and listening test.
6. `benchmarks/llm_quality.py` against the GPU LLM for Hebrew context retention and hallucination.
7. Cold start: time from container start to first response (model load), for autoscaling.

## 6. Stop the pod

Copy `benchmarks/results/` and `reports/` off the machine (or commit them), then **terminate** the pod — a stopped pod
still bills for its volume.

## 7. Pod as a GPU backend for the hosted app

Set `ROLLY_POD_MODE=worker` and `ROLLY_GPU_API_KEY=<long random token>` on the pod and expose ports `8000/http` and `8081/http`.
`pod_setup.sh` then starts vLLM on port 8081 and `backend.gpu_worker` on port 8000, both requiring the token. The worker runs
the benchmarked `modular-selfhosted` pipeline for each conversation behind `WS /v1/session` (the app relays audio to it) and
also offers `/v1/audio/transcriptions`, `/v1/audio/speech` and `/healthz`. First start takes about 12 minutes (27 GB model
download); a restart on the same volume takes a few minutes.
Point the app at it with `ROLLY_GPU_WORKER_URL=https://<pod>-8000.proxy.runpod.net/v1`,
`ROLLY_GPU_HEALTH_URL=https://<pod>-8000.proxy.runpod.net/healthz` and the same `ROLLY_GPU_API_KEY`.
Progress is published on port 8001 (`status.json`, `setup.log`, `worker.tail.log`).

## 8. Night shutdown of the GPU pod (set up 2026-11-25)

Two scheduled Claude Code tasks in the owner's account, Israel time, each run in a fresh session and report by push notification:

| Task | When | What it does |
|---|---|---|
| "Rolly GPU: stop for the night" | every day 21:04 | waits up to 30 minutes if a conversation is active, then `podStop` (never terminate); reports the balance |
| "Rolly GPU: start for the day" | every day 06:13 | `podResume`, retries if the host has no free GPU, waits until the pod and the Hebrew voice server are serving; reports |

- A stopped pod keeps its id, its address and its `/workspace` volume, so the app needs no change; storage is still billed.
- While the pod is off the self-hosted agent shows as unavailable in the app; the two OpenAI-based agents keep working.
- Risk: a stopped pod is tied to its host. If that host has no free GPU in the morning the pod cannot start; the task then
  reports it and does not create another pod.
- The tasks use the RunPod key saved on the Claude Code environment. They can be paused or deleted in the Claude app
  (scheduled tasks) or by asking in a session.
- First real run: the evening of 2026-11-25. Not exercised before that.
