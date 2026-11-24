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

## Adding or switching a provider

Edit `config/providers.yaml`. A provider is a `type` (`modular`, `openai_realtime`, `gemini_live`, `mock`) plus settings;
for `modular` each stage (`stt`, `llm`, `tts`) picks an engine, so a hybrid is just a different combination.
Credentials are referenced by environment-variable name only.

## Status in one paragraph

The platform, the self-hosted Hebrew/English pipeline, proactive memory, the benchmark suite and the cost model are built
and were run on a 4-vCPU machine without a GPU. Speech-recognition accuracy, endpointing, interruption handling, context
retention and memory were measured there, and a hybrid configuration with a commercial language model was run through the
same scenarios. Real-time latency, concurrency per GPU, the commercial realtime speech-to-speech baselines and human
ratings were **not** measured (no GPU, no WebSocket egress in the build environment, no evaluators) — the tooling for each is ready.
