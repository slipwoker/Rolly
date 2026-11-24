# GPU benchmark runbook

Status: **written but not executed** — no GPU was available in the POC session. Expect to adjust details
(image tags, vLLM flags, model ID availability) on first run. Budget approval is required before starting (`BLOCKERS.md` B2).

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
export ROLLY_STT_MODEL=ivrit-ai/whisper-large-v3-turbo-ct2 ROLLY_STT_DEVICE=cuda ROLLY_STT_COMPUTE=float16 ROLLY_STT_WORKERS=4
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
