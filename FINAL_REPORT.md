# Final report — voice technology and economic feasibility of a proactive on-the-go AI agent

Status date: 2026-11-24. Scope executed: one working session on a 4-vCPU machine without a GPU and without human evaluators.
An OpenAI key became available at the end and was used for the measurements that work over plain HTTPS (a commercial language model
and transcription); the realtime speech-to-speech APIs could not be reached from this environment. Throughout this report each statement is one of:

- **Measured** — executed in this POC; raw output in `benchmarks/results/`.
- **Published** — read from a vendor page, SDK or model card.
- **Unverified** — from search excerpts or third-party trackers; the vendor page could not be reached.
- **Estimate / assumption** — our arithmetic or planning input.

---

## 1. Executive summary

**The product's voice core is technically buildable today from open components, and its running cost can be 10–50 times lower than
commercial speech-to-speech APIs. Hebrew conversation quality, the main doubt, looks solvable with a low-cost commercial language
model. Two things are not yet proven: real-time latency on a GPU, and how the result sounds to people. Both can be settled with about
$100–$250 and one to two weeks.**

What we built and ran:

- A working prototype: a browser voice client and a server in which the agent starts the conversation itself when a journey begins,
  using what it remembers about the user; the user can interrupt, change subject, correct it, and end by simply saying so; each
  journey is summarised into decisions, action items and open topics that the next journey builds on. It runs fully self-hosted in
  Hebrew and English.
- A measurement platform in which commercial, self-hosted and hybrid architectures plug into the same interface and are measured by the same code, including a blind evaluation page.
- A benchmark suite and a financial model.

What the evidence says:

| Question | Answer today | Confidence |
|---|---|---|
| Can it be much cheaper than commercial realtime voice APIs? | Yes. Commercial speech-to-speech costs about $0.03–$0.08 per minute (and more if prompt caching underperforms). A modular pipeline assembled from component APIs costs about $0.004–$0.006; self-hosted about $0.001–$0.003 in variable cost | Estimate on published and unverified prices; self-hosted capacity is an assumption |
| At 10,000 daily users (9 million minutes a month)? | About $280k–$700k per month on commercial speech-to-speech; about $53k–$74k on component APIs; about $35k–$52k self-hosted including staff | Estimate |
| Does speech recognition work in Hebrew, in a car? | Yes: 18.9 % word error rate on a hard read-speech test (13.9 % excluding digits and foreign terms), degrading only to 23.1 % in heavy road noise. English 5.6 %. It needs a different model per language | Measured |
| Do interruptions work? | Yes: interruption signalled about 160–300 ms after the user starts speaking; playback stops about 45 ms after that; the agent remembers only what was actually heard | Measured |
| Does proactive, memory-driven conversation work? | Yes, mechanically: the agent opened all 12 test sessions by itself, recalled stored facts, followed topic switches and corrections, and wrote usable summaries | Measured, small model |
| Is the Hebrew conversation good enough? | **Not with a small open model; yes, on paper, with a cheap commercial one.** The 4-billion-parameter model that fits on a CPU produced grammatically wrong, sometimes incoherent Hebrew. The same pipeline with OpenAI `gpt-6-luna` as the language model produced fluent, correct Hebrew that used the stored memory well and passed 28 of 28 scripted checks, for about $0.0004 per minute | Measured; the Hebrew judgement is from reading transcripts, not from listeners |
| Is it fast enough? | **Unknown.** Latency could not be measured without a GPU. Our projection is about 0.85–1.2 s from end of speech to audible reply, against a target median of 0.8 s | Estimate |
| Can open speech-to-speech models (Moshi-style) do this? | No. None supports Hebrew, and they hold 2–4 minutes of context against a 30-minute need | Published |

Recommendation: proceed, with a **modular pipeline that we orchestrate ourselves** — start with commercial components where they are
cheaper than staff (below a few thousand daily users), and move speech recognition, speech synthesis and then the language model onto
rented, autoscaled GPUs as volume grows. Do not build on commercial speech-to-speech APIs as the default path, and do not buy hardware.

Money spent so far: an estimated **$0.50 or less** of OpenAI usage (the account's billing is not visible from here); no GPU spend.
Decisions needed now: approve about $50–$200 of GPU rental; run the realtime baselines from a machine with normal internet access
(about $5–$20); recruit 5–10 evaluators including native Hebrew speakers (`BLOCKERS.md`).

---

## 2. Answers to the research questions

### Q1 — Natural conversation comparable to ChatGPT Voice?

**Not determined.** This needs (a) the commercial realtime baseline running, (b) the pipeline on a GPU, and (c) human listeners.
None of the three was available: the realtime APIs need a WebSocket, which this environment's network does not carry. What we can say: the conversational mechanics that make a voice agent feel natural — speaking first,
short turns, barge-in, following topic changes, remembering — are implemented and work (measured, section 4 of `BENCHMARKS.md`).
The voices used (Kokoro and Piper for English, a Piper-class Hebrew voice) are expected to sound less expressive than commercial
speech-to-speech; that is a research expectation, not something anyone listened to in this POC.

### Q2 — Excellent Hebrew and English?

- **Speech recognition — yes for each language separately (measured).** Hebrew-tuned Whisper: 18.9 % WER on FLEURS Hebrew
  (13.9 % on sentences without digits or foreign terms); the published figure for conversational Hebrew is 5–7 %. Stock Whisper turbo:
  5.6 % on English. The Hebrew-tuned model fails on English (29.0 %, often translating instead of transcribing), so sessions are routed to
  a model by language.
- **Mixed Hebrew-English speech — open.** No open model is documented to handle it, and our synthetic test was not valid for it.
  This is a real product risk for an Israeli tech audience that mixes English terms into Hebrew constantly.
- **Hebrew speech synthesis — functional, quality unknown.** A commercially licensed Hebrew voice runs 12 times faster than real
  time on a CPU and is intelligible to a recogniser (4.3 % WER round trip). Whether it sounds good needs listeners. English terms inside
  Hebrew sentences are only approximated. Stronger candidates exist (BlueV3, ZONOS3-Mini) and are untested.
- **Hebrew language model — not with a small open model; good with a cheap commercial one (measured).** The 4B model recalled the
  right facts in Hebrew but wrapped them in poor Hebrew, used the wrong grammatical gender, and once mixed Latin and Arabic script into a
  Hebrew sentence. With `gpt-6-luna` in the same pipeline the Hebrew was fluent and correct, recall was 12 of 12, and no unknown fact was
  invented in 8 probes. Whether a self-hostable open model can match it (the research pick is Gemma-4 26B) needs a GPU.
- **Commercial transcription is not better for Hebrew (measured).** OpenAI `gpt-transcribe`: 19.5 % against 18.9 % for the open
  Hebrew-tuned model on the same recordings (23.1 % each in road noise). For English it is somewhat better (3.5 % vs 5.6 %).

### Q3 — Interruptions and fluid real-time dialogue?

**Yes for interruptions (measured); fluidity depends on latency (not measured).** Barge-in is detected a median of 250–310 ms after
speech onset on real recordings and 162 ms in the pipeline test; the browser stops playback 43 ms after being told; history is cut to
what was heard. One weakness is measured: a fixed 544 ms silence threshold ends the user's turn too early in 10–13 % of long
sentences. A learned turn detector would fix this, but none of the available ones supports Hebrew.

### Q4 — Reliable in vehicles?

**Speech recognition and turn detection: yes under synthetic road noise (measured).** Down to 0 dB signal-to-noise there were no
missed utterances and no false interruptions; Hebrew WER rose from 18.9 % to 27.5 %, English from 5.6 % to 7.2 % at 5 dB.
Not tested: real cabin recordings, passengers talking, music, phone microphones at arm's length, cellular network loss (the POC uses
TCP and raw audio; production needs WebRTC with Opus, which was out of scope).

### Q5 — Significantly cheaper than commercial realtime APIs?

**Yes, by a wide margin (estimate).** See `COSTS.md`. Commercial speech-to-speech re-bills the growing conversation on every turn, which
is what makes 30-minute sessions expensive: `gpt-realtime-2.1` is about $0.06 in the first minute and $0.077 averaged over 30 minutes
with perfect caching, $0.22 at 90 % cache effectiveness; Gemini Live is $0.019 in the first minute and about $0.06 over 30 minutes with a
tight context window. A self-hosted pipeline has no such growth beyond the language-model prompt, where prefix caching bounds it
(measured: cached turns reach the first token 10 times sooner than the uncached first turn).

### Q6 — Thousands of concurrent users economically?

**Probably, but the key number is unmeasured.** 10,000 daily users at 30 minutes produce about 760 simultaneous conversations in the
busiest hour under a commute-shaped demand curve (assumption). The orchestration layer is cheap (measured: about 40 conversations per
CPU core with headroom). The cost then depends on how many conversations one GPU can serve within the latency target: the model
assumes 10–39 per L40S; the $0.005 target needs only about 6, the $0.001 stretch target needs about 32. The GPU concurrency benchmark
is ready to run and is the single most valuable next experiment.

Commute peaks matter more than average load: a fleet sized for the peak is idle about 80 % of the time, so owned or monthly-rented
hardware loses to hourly cloud rental in the model.

### Q7 — Self-host or API, per component?

| Component | Below about 2,000–4,000 daily users | Above | Reason |
|---|---|---|---|
| Orchestration (turn-taking, memory, proactive logic) | Own | Own | This is the product; it is cheap to run |
| Speech recognition | API (Soniox streaming, $0.002 per audio minute, best published Hebrew accuracy) or self-hosted Whisper if a GPU is running anyway | Self-host | Open Hebrew models are permissively licensed and matched OpenAI's transcription API on our Hebrew test |
| Language model | API with reasoning switched off: `gpt-6-luna` gave good Hebrew at a measured 948 prompt and 44 output tokens per turn, about $0.0004 per minute at the unverified list price | Self-host a strong open model if it passes the same Hebrew test and volume justifies an always-on GPU fleet | At this price the language model is under a tenth of the $0.005 budget; self-hosting it saves little |
| Speech synthesis, English | Self-host (small, fast, permissive) | Self-host | |
| Speech synthesis, Hebrew | Commercial (Inworld or Azure, about $0.002–$0.004 per conversational minute) until an open voice passes a listening test | Self-host if one passes | No open Hebrew voice is proven for conversational quality |
| Commercial speech-to-speech | Benchmark and possibly a premium tier | Same | 10–50 times the cost; Hebrew support uncertain |

Break-even against self-hosting everything (all-in, with staff): about 250–600 daily users versus commercial speech-to-speech; about
2,200–9,400 versus a pipeline of component APIs (estimate; `COSTS.md`).

---

## 3. Success criteria

| Criterion | Result | Basis |
|---|---|---|
| Median response latency below 800 ms | **Not measured.** Projection 0.85–1.2 s: at risk without incremental speech recognition | Estimate |
| P95 below 1.5 s | **Not measured.** Looks reachable | Estimate |
| Playback stops within 300 ms of a detected interruption | **Met** on the measured path: about 45 ms plus network | Measured (one browser run, localhost) |
| Hebrew conversational quality at least 4/5 | **Not evaluated by people.** Would not be met with the 4B model; transcripts with `gpt-6-luna` read as fluent, correct Hebrew. The voice itself has not been heard by anyone | No human evaluation performed |
| Stable 30-minute sessions | **Met for stability** (31.6 minutes, 50 turns, no failed turn or error). The run exposed a latency cliff after turn 40 and loss of an early fact, both caused by history trimming that defeated the LLM prefix cache; fixed with block compaction and re-verified in 13-minute runs, not yet in a full 30-minute run | Measured on CPU |
| Meaningful proactive initiation | **Met mechanically**: 12 of 12 sessions opened by the agent; 3 of 4 openers named the stored topic | Measured, keyword check |
| Reliable cross-session memory | **Met**: a summary written by one session is in the next session's context; recall probes 11 of 12 | Measured |
| Below $0.005 per minute at scale | **Plausible**: variable cost in every capacity scenario; all-in from about 10,000 daily users in the base case | Estimate on assumptions |
| Stretch $0.001 per minute | **Only in the optimistic capacity case**, variable cost only | Estimate on assumptions |

---

## 4. Recommended production architecture

```
 Phone (thin client)                  Edge / media                     Application                         Models
┌───────────────────┐   WebRTC     ┌────────────────┐   audio     ┌───────────────────────────┐      ┌────────────────────────────┐
│ mic + speaker     │ ◄─ Opus ───► │ self-hosted    │ ◄────────►  │ Conversation orchestrator │ ───► │ STT   : Whisper per language │
│ echo cancellation │              │ WebRTC SFU     │             │  · VAD + turn detection   │      │         (or streaming API)   │
│ journey detection │              │ (LiveKit)      │             │  · speculative turns      │ ───► │ LLM   : strong multilingual  │
│ (BT / motion)     │ ─ events ──► │                │             │  · barge-in + truncation  │      │         model, prefix-cached │
└───────────────────┘              └────────────────┘             │  · memory + proactive     │ ───► │ TTS   : English self-hosted, │
                                                                  │  · summaries (async)      │      │         Hebrew API → self    │
                                                                  └───────────┬───────────────┘      └────────────────────────────┘
                                                                              │                       autoscaled GPU pool, scheduled
                                                                     Postgres (profiles, memory)      ahead of commute peaks
```

1. **Modular, self-orchestrated pipeline.** Each stage is replaceable; this POC's provider interface already works that way.
2. **WebRTC with Opus** between phone and server (self-hosted LiveKit, Apache-2.0), not WebSocket with raw audio: mobile networks need loss concealment and jitter buffering.
3. **Speech recognition per language**, with a streaming recogniser as the next step to cut latency and handle mixed speech.
4. **One strong language model with prompt caching**, chosen by a Hebrew quality test, reasoning disabled, replies capped at two sentences. A larger or slower model can write the end-of-journey summary asynchronously.
5. **Hebrew speech synthesis from an API at first**, replaced when an open voice passes blind listening.
6. **Turn detection**: start with silence-based endpointing plus speculative processing (built); collect consented Hebrew turn-taking data to fine-tune a learned detector.
7. **Capacity**: hourly-autoscaled cloud GPUs in a region close to Israel, scaled on a schedule ahead of the morning and evening peaks; no owned hardware until the demand curve is known.
8. **Privacy by default**: no audio retention, short transcript retention, explicit memory consent, erasure by voice and in-app.

---

## 5. Known limitations and technical risks

| Risk | Severity | Evidence | Mitigation |
|---|---|---|---|
| Hebrew language-model quality in real time and at low cost | Medium (was high) | Measured failure of a 4B open model; measured success of `gpt-6-luna` through the API (fluent Hebrew, 0.67 s to first token with reasoning off). Open question: an open model of equal quality for self-hosting | Keep the language model on an API at first; test Gemma-4 26B and DictaLM on the GPU against the same probes |
| Latency target (median 800 ms) | High | Projection only | GPU benchmark; streaming speech recognition; shorter speculative window |
| Natural Hebrew voice | High | No open voice proven; POC voice is read-speech quality by expectation | Blind listening test of BlueV3, ZONOS3-Mini, commercial voices |
| Hebrew-English code-switching | High | No model documented for it; POC test invalid | Record a small consented test set of real mixed speech; test streaming and commercial recognisers |
| Long-session context handling | Medium | Measured: naive history trimming made first-token time 25 times slower after 40 turns and lost early facts; commercial realtime APIs bill the same uncached context | Block compaction with a cumulative synopsis (built); separate model for the synopsis; append-only fact list |
| Users cut off mid-sentence | Medium | Measured: 10–13 % of long sentences split by the fixed endpoint | Learned turn detection for Hebrew; adaptive thresholds |
| Capacity per GPU unknown | Medium | Assumption in the cost model | GPU concurrency ramp |
| Prices | Medium | GPU and OpenAI prices unverified; GPU rental prices rose in 2026 (published by third parties) | Re-verify; keep the architecture portable across clouds |
| Vendor churn | Medium | Several models named in mid-2026 are already retired or scheduled for shutdown | Provider abstraction; avoid coupling to one vendor's session semantics |
| Echo in real cars | Medium | Not tested; the browser's echo canceller was the only protection | In-car trials on phone speaker and Bluetooth; server-side reference-signal cancellation if needed |
| Real cabin noise and passengers | Medium | Only synthetic noise tested | Field recordings |
| Licences | Low to medium | GPL-licensed phonemiser data in the English voice packaging; attribution duties; unresearched dataset terms for one English voice | `LICENSES.md` section 1; replace or clear before launch |
| Privacy and passengers' speech | Medium | Product-level, not technical | `docs/PRIVACY.md`; legal review |
| Driver distraction and safety | Product risk | Out of scope here | Conversation design rules are in the system prompt; needs dedicated study |
| This POC's own limits | — | One machine, no GPU, synthetic users, small test sets (30–40 utterances), single runs | Stated next to every number |

Things that did not work or were not done: the commercial realtime speech-to-speech APIs were never reached (WebSocket connections
are not carried by this environment's network proxy; no Google key); GPU stack and Docker images never built; no human listened to
any output; mixed-language test invalid; the Hebrew TTS candidate BlueV3 was not installed (declined by a safety check, awaiting approval).

---

## 6. Proposed MVP roadmap

| Stage | Duration | Goal | Exit criteria |
|---|---|---|---|
| 0. Close the open measurements | 1–2 weeks, about $250 | GPU benchmark (latency, concurrency), commercial baselines, Hebrew LLM bake-off, Hebrew voice bake-off, blind evaluation with 8+ people | Measured median and P95 latency; conversations per GPU; Hebrew quality ≥ 4/5 for at least one configuration, or a clear statement of what blocks it |
| 1. Voice core v1 | 4–6 weeks | WebRTC transport, chosen models, streaming speech recognition, per-user authentication, privacy controls, monitoring | 30-minute sessions over cellular in a moving car with P95 under 1.5 s |
| 2. Closed alpha | 4 weeks, 20–50 users | Thin mobile client (or installable web app), journey detection from Bluetooth or motion, onboarding that builds the profile, memory v2 with retrieval | Users complete at least 3 journeys per week; retention and qualitative feedback |
| 3. Proactivity and outcomes | 4–6 weeks | Conversation planning across journeys, action-item follow-up, content suggestions, Hebrew turn-detection data | Measured share of journeys where users accept the proposed topic |
| 4. Beta at about 200–1,000 daily users | 8 weeks | Cost tracking per minute from real usage, autoscaling ahead of peaks, second region | Real cost per minute and real demand curve replace the model's assumptions |
| 5. Scale decision | — | Self-host more stages or stay on APIs, based on stage 4 data | Break-even recomputed with measured inputs |

Explicitly later: CarPlay / Android Auto, music and video integrations, multi-party conversations.

---

## 7. Deliverables

| # | Deliverable | Where | State |
|---|---|---|---|
| 1 | Working conversational voice prototype | `frontend/`, `backend/`, `providers/`; run instructions in `README.md` | Works self-hosted on CPU in Hebrew and English (slow), and as a hybrid with a commercial language model; verified in Chromium |
| 2 | Reproducible source code | this repository; `requirements.txt`; 17 automated tests | Done |
| 3 | Deployment scripts and documentation | `infrastructure/`, `Dockerfile`, `docker-compose.yml`, `infrastructure/GPU_RUNBOOK.md` | Dev scripts used; Docker and GPU files written but not executed |
| 4 | Model and provider comparison matrix | `docs/COMPARISON_MATRIX.md` | Done from research |
| 5 | Licensing and commercial usage report | `LICENSES.md` | Done; open review items listed |
| 6 | Raw benchmark results | `benchmarks/results/*.json`, `reports/benchmark_summary.json` | Done for CPU-measurable items |
| 7 | Human evaluation results | — | **None. Not performed.** Tooling and protocol: `frontend/eval.html`, `docs/HUMAN_EVALUATION.md` |
| 8 | Latency and concurrency analysis | `BENCHMARKS.md` sections 4, 5, 7 | CPU measurements plus a labelled projection; GPU pending |
| 9 | Infrastructure cost analysis | `COSTS.md`, `docs/research/06-gpu-and-infrastructure.md` | Done as a model |
| 10 | Financial projections for all user scenarios | `reports/cost_model.md`, `reports/cost_monthly.csv` | Done as a model |
| 11 | API versus self-hosting break-even | `COSTS.md`, `reports/cost_model.md` | Done as a model |
| 12 | Recommended production architecture | section 4 above | Provisional until stage 0 |
| 13 | Known limitations and technical risks | section 5 above | Done |
| 14 | MVP roadmap | section 6 above | Done |
| 15 | Executive summary | section 1 above | Done |

Tracking files: `PLAN.md`, `PROGRESS.md`, `DECISIONS.md`, `BLOCKERS.md`, `COSTS.md`, `BENCHMARKS.md`, `LICENSES.md`.
Research with sources: `docs/research/01` … `06`.
