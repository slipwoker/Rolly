# Rolly — voice-agent feasibility POC

A test platform for a proactive, interruptible Hebrew + English voice companion for people on the move, built to
compare voice architectures under identical conditions and to estimate what they cost at scale.

Start with [`FINAL_REPORT.md`](FINAL_REPORT.md). Open items needing a person are in [`BLOCKERS.md`](BLOCKERS.md).

## What is here

| Path | Contents |
|---|---|
| `frontend/` | Browser client: drive mode, blind evaluation, telemetry dashboard (no build step) |
| `backend/app/` | FastAPI server: voice WebSocket, REST API, session orchestration |
| `providers/` | One interface, several architectures: `modular/` (self-hosted pipeline, also used for `hybrid`), `commercial/` (OpenAI Realtime, Gemini Live), `speech_to_speech/` (no-go notes), `mock.py` (tests only) |
| `memory/` | Shared user memory, context builder, session summariser, synthetic profiles |
| `telemetry/` | Latency / interruption / usage recorder, resource sampler |
| `benchmarks/` | Synthetic client, scenario suite, WER, endpointing, LLM probes, concurrency, long session; raw results in `benchmarks/results/` |
| `finops/` | Financial model (`config/pricing.yaml` → `reports/`) |
| `infrastructure/` | Model download, dev server, Docker, GPU runbook |
| `tests/` | Automated tests, browser end-to-end test |
| `docs/` | Research reports, architecture, comparison matrix, privacy, human-evaluation protocol |

## Run it locally (CPU, no API keys)

Requirements: Linux or macOS, Python 3.12, about 8 GB of disk, [uv](https://docs.astral.sh/uv/) or pip.

```bash
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r requirements.txt
```

```bash
infrastructure/download_models.sh
```

Start an OpenAI-compatible LLM server. The repository's script expects a llama.cpp build in `models/llama.cpp/`
(download a release from github.com/ggml-org/llama.cpp); any other server works if you set `ROLLY_LLM_BASE_URL`.

```bash
infrastructure/run_llama_server.sh
```

```bash
cp .env.example .env && infrastructure/run_dev.sh
```

Open http://localhost:8000 in Chrome, pick a traveller and an agent, press **Start journey**. The agent speaks first.
On a laptop CPU a reply takes several seconds; that is expected (see `BENCHMARKS.md`). For CPU-only use set
`ROLLY_STT_MODEL_HE=small ROLLY_STT_MODEL_EN=small` and the Piper English voice (`ROLLY_TTS_EN_KIND=vits`, see `.env.example`).

Docker alternative: `docker compose up --build` (not built in the POC session — treat as a starting point).

## Pages

- `/` — drive mode. One button, then voice only. Interrupt at any time; say "that's enough for today" to end; the journey summary appears afterwards.
- `/eval.html` — blind evaluation: anonymous agent labels, randomised order, 1–5 ratings.
- `/dashboard.html` — latency per provider and recent sessions (add `?token=<admin>` to reveal provider names).

## Tests

```bash
.venv/bin/python -m pytest -q
```

```bash
node tests/browser_e2e.cjs /path/to/48khz-mono.wav mock daniel 16
```

The browser test drives real Chromium with a fake microphone fed from a WAV file (needs Playwright).

## Benchmarks

```bash
PYTHONPATH=. .venv/bin/python -m benchmarks.stt_wer --lang he --n 40 --models ivrit-ai/whisper-large-v3-turbo-ct2
```

```bash
infrastructure/run_benchmarks.sh modular-selfhosted "describe the hardware here"
```

```bash
PYTHONPATH=. .venv/bin/python -m finops.cost_model
```

Each script writes machine-readable JSON to `benchmarks/results/` and prints a summary. The `--hardware` text is stored
with the results so CPU and GPU runs are never confused.

## Hosted deployment (Render + RunPod)

The platform is deployed at **https://rolly-voice.onrender.com** (Render project *Rolly*, service `rolly-voice`, Frankfurt,
Standard plan). Pages and API calls need the access token: open `https://rolly-voice.onrender.com/?token=<ROLLY_ACCESS_TOKEN>`.
Scripts can send it as `Authorization: Bearer <token>` instead.

```
+----------------------------------------------------+
| RENDER  web service  rolly-voice  (CPU only)       |
|   web pages, sessions, memory and telemetry        |
|   (SQLite on a 1 GB disk)                          |
+----------------------------------------------------+
     |  ^                           |
     |  |  one WebSocket per        | HTTPS + API key
     v  |  conversation (relay)     v
+---------------------------+  +---------------------+
| RUNPOD  GPU pod (L40S)    |  | OPENAI API          |
|  the complete self-hosted |  |  realtime voice,    |
|  pipeline: turn detection,|  |  transcription,     |
|  Whisper, Gemma on vLLM,  |  |  language model     |
|  voices                   |  +---------------------+
+---------------------------+
```

| Provider in the app | Runs where | Available when |
|---|---|---|
| `selfhosted-gpu` | Whole pipeline on the GPU pod (`backend/gpu_worker.py`, `/v1/session`); Render relays audio (`providers/remote.py`) | the pod is running and healthy (probed every 15 s) |
| `openai-realtime` | OpenAI, bridged by the Render app | `OPENAI_API_KEY` is set |
| `hybrid-api` | OpenAI transcription and language model, voices on the Render CPU | `OPENAI_API_KEY` is set |

The first hosted version kept turn-taking on Render and called speech-to-text, the language model and the voice on the pod
separately. Three measured replies took 1.3-1.5 s, against 681 ms with everything on one machine, because each call paid the
network; the pipeline was therefore moved to the pod. See `BENCHMARKS.md` section 0 for the hosted measurements.

Files: `render.yaml` (Blueprint), `Dockerfile.render`, `config/providers.render.yaml`, `backend/gpu_worker.py`,
`providers/remote.py`, and `ROLLY_POD_MODE=worker` in `infrastructure/pod_setup.sh`. Render redeploys on every push to the
deployment branch.

**Measuring without a browser:** `POST /api/selftest` (admin) with `{"provider": "selfhosted-gpu"}` makes the server run
scripted Hebrew and English conversations against itself; `GET /api/selftest/<id>` returns latencies and checks. The simulated
user sits next to the app, so the result includes the hop to the GPU but not a real user's network or audio device.
Stored sessions: `GET /api/sessions`, and `GET /api/sessions/<id>?events=1` (admin) for the raw timing events.

**Cost while it runs:** Render about $25/month plus $0.25/month for the disk; the GPU pod **$1.09 per hour (about $26 per day)
for as long as it exists** - terminate it in the RunPod console when nobody is testing. The pod's address contains its id, so a
new pod means updating `ROLLY_GPU_WORKER_URL` and `ROLLY_GPU_HEALTH_URL` in Render.

## Adding or switching a provider

Edit `config/providers.yaml`. A provider is a `type` (`modular`, `openai_realtime`, `gemini_live`, `mock`) plus settings;
for `modular` each stage (`stt`, `llm`, `tts`) picks an engine, so a hybrid is just a different combination.
Credentials are referenced by environment-variable name only.

## Status in one paragraph

The platform, the self-hosted Hebrew/English pipeline, proactive memory, the benchmark suite and the cost model are built.
On one rented NVIDIA L40S the self-hosted pipeline answered in 681 ms (median) and held 35 simultaneous conversations within a
1.5 s P95; the OpenAI Realtime baseline, run through the same harness, answered in 1.6–2.0 s at about fifty times the cost per
minute. Not done: human evaluation (nobody has listened to the output), Gemini Live, real networks and cars. See `FINAL_REPORT.md`.

To repeat the GPU run without shell access see `infrastructure/pod_autorun.sh`; with shell access, `infrastructure/pod_setup.sh`
followed by `infrastructure/pod_bench.sh`.
