# Research closeout (2026-11-26)

The feasibility experiment is finished. Product work continues in `apps/` (Phase 1). This page is the one place that says what the
experiment concluded, what it did not do, and what was retired. Details stay in the documents linked below.

## Question and answer

Can a proactive, interruptible Hebrew + English voice companion be built on open models, fast enough and cheap enough?

**Yes, with caveats.** On one rented NVIDIA L40S ($1.09/h) the self-hosted pipeline answered in 681 ms median (P95 1,072 ms),
held 35 simultaneous conversations within a 1.5 s P95, and ran a 30-minute conversation without failures. The OpenAI Realtime
baseline, through the same harness, answered in 1.6-2.0 s at about $0.07 per minute. Source: `FINAL_REPORT.md`, `BENCHMARKS.md`
section 0, raw results in `benchmarks/results/`, cost model in `COSTS.md` and `reports/`.

Latencies come from scripted synthetic users next to the server. Phone, mobile network and car were not part of the experiment;
Phase 1 measures them on the phone (see `docs/PHASE1_PROGRESS.md`).

## Decisions the experiment produced

| Topic | Decision | Where |
|---|---|---|
| Architecture | self-hosted modular pipeline on a GPU pod: VAD -> STT -> LLM -> TTS | `DECISIONS.md` |
| Hebrew voice | BlueV3, voice `daniel`, speed 1.2 (chosen by the owner from listening reels); Piper as fallback | `DECISIONS.md` D23 |
| Withdrawn | ZONOS3-Mini cloned voice (cut sentence endings); OpenAI `gpt-4o-mini-tts` for Hebrew | `DECISIONS.md` D22, `BENCHMARKS.md` 0.10 |
| Commercial fallback | Inworld TTS (tested, not deployed) | `BENCHMARKS.md` 0.11 |

## Not done

- **Scored human evaluation.** The blind listening test with native speakers (blocker B3) was never run and no ratings exist.
  Informal feedback from three team members is recorded in `PROGRESS.md`. From Phase 1 on, quality is followed through real rides
  and the backoffice (`docs/AGENT_AUDIT.md`).
- **Gemini Live baseline** (B1): the bridge exists and was tested only against an emulator.
- **Vendor prices** (B5): GPU and token prices in `config/pricing.yaml` are marked `unverified`, so the cost figures carry that caveat.
- **Real conditions:** mobile network, car cabin, mixed Hebrew-English speech, BlueV3 under concurrency.

## What was retired

The browser tester (`rolly-voice` on Render, pages `/`, `/eval.html`, `/dashboard.html`) is no longer part of the product
architecture. The phone app talks to `rolly-api`, which relays to the GPU pod and is observed through the backoffice at `/admin`.

Retired as a surface, **kept in the repository**:

| Item | Why it stays |
|---|---|
| `backend/gpu_worker.py`, `providers/modular/`, `providers/base.py` | this is the GPU pod's worker; `rolly-api` depends on it |
| `backend/app/`, `frontend/`, `providers/commercial/`, `providers/remote.py`, `render.yaml` | the tester and its Render blueprint, needed to reproduce the research or to bring the tester back |
| `benchmarks/`, `finops/`, `tests/` | reproduce every number in the reports |

Before the Render service `rolly-voice` is suspended (owner action, in the Render dashboard):

1. Export ratings and sessions while the service is up: `GET /api/ratings/export` and `GET /api/sessions` (admin token).
2. Check that nothing else points at it: it hosts `POST /api/selftest`, which the research documents use as a regression check.
   `rolly-api` has its own self-test (`POST /v1/admin/selftest`).
3. Do not push changes to `render.yaml` casually: it redeploys the service and drops live conversations.

Suspending it saves about $25 per month plus the 1 GB disk.
