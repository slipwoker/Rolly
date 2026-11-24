# Execution plan — AI on-the-go agent, voice technology and economic feasibility POC

Started 2026-11-24. This file is the plan; `PROGRESS.md` records what was actually done.

## Goal

Validate whether the core voice experience of a proactive commuting companion (Hebrew + English, interruptible,
30-minute sessions, in-car noise) is technically achievable and economically viable at thousands of concurrent
users, and decide which components to self-host versus buy.

## Research questions and how each is answered

| # | Question | Evidence that answers it | Where |
|---|---|---|---|
| 1 | Natural conversation comparable to ChatGPT Voice? | Blind human ratings of each architecture; response latency; playout stability | `frontend/eval.html`, `benchmarks/run_scenarios.py` |
| 2 | Excellent Hebrew and English? | Hebrew/English word error rate on human speech; blind Hebrew-quality ratings; LLM Hebrew probes | `benchmarks/stt_wer.py`, `benchmarks/llm_quality.py`, human eval |
| 3 | Interruptions and fluid dialogue? | Barge-in detection latency, time until playback stops, context truncation after interruption | `benchmarks/vad_bench.py`, scenario `s07`, browser telemetry |
| 4 | Reliable in vehicles? | WER and endpointing at 10 / 5 / 0 dB road noise; false barge-ins on noise | `benchmarks/stt_wer.py`, `benchmarks/vad_bench.py`, scenarios `s10a/b` |
| 5 | Much cheaper than commercial realtime APIs? | Cost model built from published prices and measured capacity | `finops/cost_model.py`, `COSTS.md` |
| 6 | Thousands of concurrent users economically? | Concurrency ramp on a GPU; peak-hour fleet sizing | `benchmarks/concurrency.py`, `COSTS.md` |
| 7 | Self-host versus API per component? | Per-component quality, licence and cost comparison; break-even analysis | `docs/COMPARISON_MATRIX.md`, `LICENSES.md`, `COSTS.md` |

## Phases

| Phase | Scope | Status criteria |
|---|---|---|
| 1 Research and selection | Six research reports with source tagging; candidate selection; licence verification | Reports in `docs/research/`, decisions in `DECISIONS.md` |
| 2 Unified test platform | Browser client, WebSocket backend, provider abstraction, telemetry, sessions, blind labels | Browser end-to-end test passes; automated tests pass |
| 3 Proactive behaviour and memory | Journey-start event, shared memory, proactive opener, summaries and action items | Opener references stored memory; summary feeds the next session |
| 4 Quality benchmarks | 13 scenarios, WER, endpointing, interruption, LLM probes, long session, blind human evaluation UI | Raw JSON in `benchmarks/results/`, summarised in `BENCHMARKS.md` |
| 5 Infrastructure and scalability | GPU selection, concurrency ramp 1/5/10/20/50, optimisation review | Maximum sustainable concurrency per GPU measured |
| 6 Financial feasibility | Cost model for 200 / 1k / 10k / 100k DAU, utilisation 30/60/80 %, break-even | `reports/cost_model.*`, `COSTS.md` |
| 7 Licensing, privacy, security | Licence report, retention policy, credential handling | `LICENSES.md`, `docs/PRIVACY.md` |

## Architectures

| | Architecture | Plan |
|---|---|---|
| A | Commercial realtime API | OpenAI Realtime and Google Gemini Live bridged server-side; quality baseline |
| B | Self-hosted modular pipeline | Silero VAD → Whisper (Hebrew-tuned) → open-weight LLM → open TTS |
| C | Self-hosted speech-to-speech | Evaluate; implement only if a model meets Hebrew + licence requirements |
| D | Hybrid | Same pipeline as B with individual stages swapped for commercial APIs by configuration |

## What requires a human (tracked in `BLOCKERS.md`)

1. API keys for the commercial baselines (OpenAI, Google).
2. A rented GPU for latency and concurrency measurement (about $50–$200).
3. Human evaluators for the blind test (native Hebrew speakers).
4. Approval to install third-party Hebrew TTS packages that are not yet vetted.

## Working rules

- Every number is labelled measured, published, estimate, assumption or unverified.
- Nothing is reported as successful unless it was executed here and the raw output is in the repository.
- No spending without explicit approval; no credentials in the repository; no raw audio retained by default.
