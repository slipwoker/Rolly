# Final report — voice technology and economic feasibility of a proactive on-the-go AI agent

Status date: 2026-11-24. Executed in one working session: research, a working prototype, benchmarks on a CPU container, and a
3-hour run on one rented NVIDIA L40S that also called the OpenAI APIs. Each statement below is one of:

- **Measured** — executed in this POC; raw output in `benchmarks/results/`.
- **Published** — read from a vendor page, SDK or model card.
- **Unverified** — from search excerpts or third-party trackers; the vendor page could not be reached.
- **Estimate / assumption** — our arithmetic or planning input.

Not done at all: human evaluation. Nobody has listened to any audio produced in this POC.

---

## 1. Executive summary

**A fully self-hosted Hebrew + English voice agent, built from open models on one rented GPU, answered faster than OpenAI's
realtime voice API in our tests and at roughly one fiftieth of its cost per minute. The remaining unknowns are about how it
sounds and behaves with real people, not about whether it can be built or afforded.**

What was measured on one NVIDIA L40S (rented at $1.09 per hour), same scripted conversations for every system:

| System | Median response | P95 | Cost per conversation minute |
|---|---:|---:|---:|
| Self-hosted pipeline (Whisper + Gemma-4 26B + open voices) | **0.68 s** | 1.07 s | **about $0.001–$0.002** (measured capacity and GPU price) |
| Hybrid: self-hosted speech + OpenAI `gpt-6-luna` | 1.33 s | 2.44 s | about $0.002–$0.004 (estimate) |
| OpenAI Realtime `gpt-realtime-2.1`, fastest of three turn-detection modes | 1.62 s | 1.78 s | **$0.07** (from reported token usage, list prices unverified) |
| OpenAI Realtime `gpt-realtime-2.1-mini` | 1.65–1.73 s | 5.1 s | $0.02 |

Latency is from the end of the user's speech to the first audio of the reply, measured next to the server; a mobile network and
the phone's audio stack add roughly 0.1 s. Samples are small (14–56 turns per row) and the users were synthetic.

Other measured results:

- **Capacity**: that single GPU ran speech recognition and the language model for 35 simultaneous conversations within a 1.5 s P95,
  and for 50 without a failed turn.
- **Stability**: a 30-minute conversation of 134 turns ran with no failures and no slow-down, and the agent recalled at the end a
  fact stated in the first minute.
- **The product behaviour works**: the agent opens the conversation itself from what it remembers, can be interrupted (signalled
  about 0.17 s after the user starts speaking), follows topic changes and corrections, ends when told, and writes a summary with
  action items that the next journey builds on. All 56 scripted checks passed on the GPU.
- **Hebrew**: speech recognition with the open Hebrew-tuned model matched OpenAI's transcription API on the same recordings
  (18.9 % vs 19.5 % word error rate on a hard test; 23.1 % each in heavy road noise). The self-hosted 26B language model wrote fluent,
  grammatical Hebrew in the transcripts.

What 10,000 daily users (9 million conversation minutes a month) would cost, all-in:

| Approach | Per month | Basis |
|---|---:|---|
| OpenAI Realtime `gpt-realtime-2.1` | about $630,000–$700,000 | measured $0.07 per minute on short sessions; estimate $0.077 for 30-minute sessions |
| OpenAI Realtime mini | about $190,000–$280,000 | measured $0.02; estimate $0.03 for 30-minute sessions |
| Pipeline assembled from component APIs | about $53,000–$74,000 | estimate on published prices |
| Self-hosted on rented GPUs, including staff | **about $38,000–$43,000** | measured capacity (20–35 conversations per GPU) and GPU price; staffing and demand curve assumed |

What is still unknown:

1. **How it sounds.** The voices used are functional stand-ins; no open Hebrew voice is proven to sound natural. This is the largest
   open question and needs listeners.
2. **Mixed Hebrew-English speech**, which Israeli professionals use constantly, could not be tested validly.
3. **Real conditions**: mobile networks, a real car cabin, real hesitant speech. A fixed end-of-turn wait cut the speaker off in
   10–13 % of long read sentences.
4. One defect in the self-hosted language model: it garbled Hebrew number words in two of three probes.

Recommendation: **proceed, and build on the self-hosted modular pipeline from the start** — a pair of rented GPUs covers the first
several hundred daily users, the latency advantage is the product, and nothing in the stack carries a per-minute fee. Keep an API
language model as a fallback route, and decide the Hebrew voice (open or commercial) by a blind listening test.

Money spent: **$3.58** of GPU rental (exact) and an estimated **$3–$4** of OpenAI usage, out of a $300–$700 budget.

---

## 2. Answers to the research questions

### Q1 — Natural conversation comparable to ChatGPT Voice?

**Responsiveness: better than the commercial baseline in our test (measured). Naturalness of the voice: unknown.**
The self-hosted pipeline answered in 0.68 s (median) against 1.6–2.0 s for `gpt-realtime-2.1`, started speaking 0.2 s after a journey
began against 1.9 s, and handled interruption, topic switches and corrections equally well on the scripted checks. What cannot be
claimed is that it *sounds* as good: commercial speech-to-speech models produce more expressive speech than the Kokoro/Piper-class
voices used here, and that difference was not assessed by anyone.

### Q2 — Excellent Hebrew and English?

- **Speech recognition — yes, with one model per language (measured).** Hebrew-tuned Whisper 18.9 % WER on FLEURS Hebrew (13.9 % on
  sentences without digits or foreign terms; the published figure on conversational Hebrew is 5–7 %); stock Whisper turbo 5.6 % on
  English. The Hebrew-tuned model fails on English (29.0 %, often translating instead of transcribing), so sessions are routed by
  language. OpenAI's transcription API was no better on Hebrew (19.5 %).
- **Language model — yes with a 26B open model or a commercial one; no with a 4B model (measured).** Gemma-4 26B on the GPU and
  `gpt-6-luna` through the API both produced fluent, correct Hebrew and recalled 12 of 12 stored facts. A 4B model that fits on a CPU
  did not. Gemma's garbled number words are a known, fixable defect.
- **Speech synthesis — functional, quality unknown.** The commercially licensed Hebrew voice is fast (12 times real time on a CPU)
  and intelligible to a recogniser. Whether it sounds good, and how it handles English words inside Hebrew, is untested.
- **Mixed Hebrew-English — open.** No open model is documented for it and our synthetic test was not valid.

### Q3 — Interruptions and fluid real-time dialogue?

**Yes (measured).** Interruption signalled 171 ms after speech onset on the GPU; the browser stops playback 43 ms after being told;
the conversation history keeps only what was actually heard. Responses arrive in 0.68 s. The measured weakness is turn-taking: a
fixed 544 ms silence threshold ends the user's turn early in 10–13 % of long sentences, and shortening it to gain speed makes that
worse (27–33 % at 320 ms). No available learned turn detector supports Hebrew.

### Q4 — Reliable in vehicles?

**Yes under synthetic road noise (measured); real cabins untested.** Down to 0 dB signal-to-noise there were no missed utterances
and no false interruptions; Hebrew WER rose from 18.9 % to 27.5 %, English from 5.6 % to 7.2 % at 5 dB. Not tested: real recordings,
passengers, music, cellular loss. The POC streams raw audio over TCP; production needs WebRTC with Opus.

### Q5 — Significantly cheaper than commercial realtime APIs?

**Yes, by about 40–60 times in variable cost (measured inputs on both sides).** OpenAI Realtime cost $0.070–0.075 per connected
minute from the token usage it reported in our runs. The self-hosted pipeline costs $0.0011–0.0017 per minute at the measured 20–35
conversations per $1.09/h GPU and the utilisation an autoscaled fleet reaches, including the CPU for speech synthesis.

### Q6 — Thousands of concurrent users economically?

**Yes on the evidence of one GPU (measured), with the usual caution about extrapolating.** 10,000 daily users produce about 760
simultaneous conversations in the busiest hour under a commute-shaped demand curve (assumption). At 35 per GPU that is about 33 L40S
at the peak and a GPU bill of about $7,700 a month; at a conservative 20 per GPU, 57 GPUs and $12,900. The orchestration layer is
light (about 80 conversations per CPU core at full load without speech synthesis, about 6 with it). Commute peaks matter more than averages: a
fleet sized for the peak sits idle about 80 % of the time, so hourly rental beats owned or monthly hardware. Cold start was about 3
minutes with cached weights, so capacity has to be scheduled ahead of the peaks.

Rental supply is a practical risk: the L40S was reported out of stock minutes before we obtained one.

### Q7 — Self-host or API, per component?

| Component | Recommendation | Evidence |
|---|---|---|
| Orchestration (turn-taking, memory, proactive logic) | Own | It is the product, and cheap to run |
| Speech recognition | **Self-host** | Open Hebrew model equals the commercial API on Hebrew; 63 ms on the GPU; permissive licence |
| Language model | **Self-host Gemma-4 26B** (or equivalent); keep an API model as fallback | Self-hosted first token 52 ms against 711 ms through the API; equal recall; fluent Hebrew; no per-token fee. The API model costs about $0.0004 per minute, so cost is not the deciding factor — latency is |
| Speech synthesis, English | Self-host | Small, fast, runs on CPU |
| Speech synthesis, Hebrew | **Undecided** until a blind listening test: open voice if it passes, otherwise a commercial voice (about $0.002–$0.004 per conversation minute) | No evidence either way |
| Commercial speech-to-speech | Benchmark only | Slower in our test and about 50 times the cost |

Break-even against self-hosting (all-in, with assumed staffing): about 260–570 daily users versus commercial speech-to-speech; about
2,200–5,200 versus a pipeline of component APIs. Below that range an all-API pipeline is cheaper on paper because of staff cost, but
it answered in 1.33 s instead of 0.68 s.

---

## 3. Success criteria

| Criterion | Result | Basis |
|---|---|---|
| Median response latency below 800 ms | **Met next to the server: 681 ms** (740 ms over the 30-minute session). With 80–150 ms for mobile network and playout it lands on the target, not clearly under it | Measured on one L40S; network not measured |
| P95 below 1.5 s | **Met: 1,072 ms**; 944 ms in the 30-minute session; 1,482 ms with 35 simultaneous conversations | Measured |
| Playback stops within 300 ms of a detected interruption | **Met**: about 45 ms plus network after detection; about 0.2–0.3 s from the user's speech onset | Measured |
| Hebrew conversational quality at least 4/5 | **Not evaluated by people.** Transcripts read as fluent, correct Hebrew; the voice has not been heard | No human evaluation |
| Stable 30-minute sessions | **Met**: 134 turns, no failures, no drift, early fact recalled | Measured on the GPU |
| Meaningful proactive initiation | **Met**: every session opened by the agent from stored memory; all opener checks passed on the GPU | Measured, keyword checks |
| Reliable cross-session memory | **Met**: summaries feed the next session; recall 12 of 12 | Measured |
| Below $0.005 per minute at scale | **Met for variable cost** ($0.0011–0.0017). All-in with staff: $0.0042–0.0048 at 10,000 daily users, higher below that | Measured capacity and price; staffing assumed |
| Stretch $0.001 per minute | **Borderline for variable cost** (about $0.0009–0.0011 at 35 conversations per GPU and 60–80 % utilisation); not all-in | Measured capacity; utilisation assumed |

---

## 4. Recommended production architecture

```
 Phone (thin client)                  Edge / media                     Application                         Models (rented GPUs)
┌───────────────────┐   WebRTC     ┌────────────────┐   audio     ┌───────────────────────────┐      ┌─────────────────────────────┐
│ mic + speaker     │ ◄─ Opus ───► │ self-hosted    │ ◄────────►  │ Conversation orchestrator │ ───► │ STT : Whisper per language   │
│ echo cancellation │              │ WebRTC SFU     │             │  · VAD + turn detection   │      │ LLM : Gemma-4 26B on vLLM,   │
│ journey detection │              │ (LiveKit)      │             │  · speculative turns      │ ───► │       prefix-cached          │
│ (BT / motion)     │ ─ events ──► │                │             │  · barge-in + truncation  │      │ TTS : CPU or GPU; Hebrew     │
└───────────────────┘              └────────────────┘             │  · memory + compaction    │ ───► │       voice to be chosen     │
                                                                  │  · summaries (async)      │      │ fallback: API LLM            │
                                                                  └───────────┬───────────────┘      └─────────────────────────────┘
                                                                     Postgres (profiles, memory)      autoscaled, scheduled ahead of peaks
```

1. **Self-orchestrated modular pipeline** with every stage replaceable; the POC's provider interface already works this way.
2. **Speech recognition and the language model on the same GPU pool**; one L40S-class card holds both with room to spare (36 of 46 GB).
3. **Speculative processing during the end-of-turn wait** (worth about 300 ms, measured) and a 544 ms wait until a Hebrew-capable
   learned turn detector exists.
4. **Conversation history compacted in blocks with a running synopsis**, never trimmed turn by turn (measured: trimming destroyed the
   prompt cache and made first-token time 25 times slower after 40 turns).
5. **WebRTC with Opus** to the phone (self-hosted LiveKit), not raw audio over WebSocket.
6. **Hourly-autoscaled rented GPUs** in a region near Israel, scaled on a schedule; at least two providers, given the stock risk.
7. **Text normalisation before speech synthesis** (numbers, dates, English terms in Hebrew), which also removes the number-word defect.
8. **Privacy by default**: no audio retention, short transcript retention, explicit memory consent, erasure by voice and in-app.

---

## 5. Known limitations and technical risks

| Risk | Severity | Evidence | Mitigation |
|---|---|---|---|
| Voice naturalness, especially Hebrew | High | No open Hebrew voice proven; nobody listened to the output | Blind listening test of open candidates (BlueV3, ZONOS3-Mini) and commercial voices |
| Hebrew-English code-switching | High | No model documented for it; test invalid | Record a small consented test set of real mixed speech; test streaming and commercial recognisers |
| Users cut off mid-sentence | Medium to high | Measured: 10–13 % of long sentences split at the default wait | Learned turn detection for Hebrew; adaptive wait; collect consented turn-taking data |
| Results on synthetic users next to the server | Medium | All latency figures exclude network and real speech | In-car trials over cellular before committing to targets |
| GPU supply and price | Medium | L40S reported out of stock shortly before we rented one; rental prices rose in 2026 (third-party reports) | Two providers; architecture portable; measured alternatives (A40, RTX 6000 Ada) |
| Self-hosted LLM defects | Medium | Garbled Hebrew number words in two of three probes; small probe sets | Text normaliser; test unquantised weights; larger Hebrew evaluation |
| Extrapolating one GPU to a fleet | Medium | One machine, one run per level | Repeat on a second GPU type and at 2–4 GPUs with a load balancer |
| Vendor and model churn | Medium | Several models named in mid-2026 are retired or scheduled for shutdown | Provider abstraction; open weights pinned locally |
| Echo in real cars | Medium | Untested | Trials on phone speaker and Bluetooth; reference-signal cancellation if needed |
| Licences | Low to medium | GPL phonemiser data in the English voice packaging; unresolved dataset terms for the stand-in English voice; attribution duties | `LICENSES.md` section 1 |
| Privacy, passengers' speech | Medium | Product-level | `docs/PRIVACY.md`; legal review |
| Staffing assumption | Medium | The cost model's largest remaining assumption | Track real operations effort during the alpha |
| Driver distraction | Product risk | Out of scope | Dedicated study |

Things that did not work or were not done: no human evaluation; Google Gemini Live never called (no key); Docker images never built;
mixed-language test invalid; the Hebrew voice candidate BlueV3 not installed (declined by a safety check, awaiting approval); the
commercial APIs were only run on short sessions, not 30 minutes; speech synthesis ran on CPU with stand-in voices.

---

## 6. Proposed MVP roadmap

| Stage | Duration | Goal | Exit criteria |
|---|---|---|---|
| 0. Close the human questions | 1–2 weeks, about $100 | Blind evaluation with 8+ people including native Hebrew speakers; Hebrew voice bake-off; a recorded mixed-language test set; Gemini Live baseline; one trial over a mobile network | Hebrew quality ≥ 4/5 for at least one voice, or a clear statement of what blocks it |
| 1. Voice core v1 | 4–6 weeks | WebRTC transport, text normalisation, chosen voices, per-user authentication, privacy controls, monitoring, two-GPU deployment with autoscaling | 30-minute sessions over cellular in a moving car with P95 under 1.5 s |
| 2. Closed alpha | 4 weeks, 20–50 users | Thin mobile client, journey detection from Bluetooth or motion, onboarding that builds the profile, memory with retrieval | Users complete at least 3 journeys per week |
| 3. Proactivity and outcomes | 4–6 weeks | Conversation planning across journeys, action-item follow-up, content suggestions, Hebrew turn-detection data | Share of journeys where users accept the proposed topic |
| 4. Beta at 200–1,000 daily users | 8 weeks | Real cost per minute, real demand curve, second region or provider | Measured cost and utilisation replace the model's assumptions |
| 5. Scale decision | — | Owned base-load hardware or stay fully rented, from stage 4 data | Break-even recomputed |

Explicitly later: CarPlay / Android Auto, music and video integrations, multi-party conversations.

---

## 7. Deliverables

| # | Deliverable | Where | State |
|---|---|---|---|
| 1 | Working conversational voice prototype | `frontend/`, `backend/`, `providers/`; `README.md` | Runs self-hosted, hybrid, and against OpenAI Realtime; verified in Chromium |
| 2 | Reproducible source code | this repository; 17 automated tests | Done |
| 3 | Deployment scripts and documentation | `infrastructure/` (`pod_setup.sh` and `pod_bench*.sh` were executed on the GPU pod; Docker files were not built) | Done, Docker untested |
| 4 | Model and provider comparison matrix | `docs/COMPARISON_MATRIX.md` | Done, with a measured addendum |
| 5 | Licensing and commercial usage report | `LICENSES.md` | Done; open review items listed |
| 6 | Raw benchmark results | `benchmarks/results/*.json`, `reports/benchmark_summary.*` | Done |
| 7 | Human evaluation results | — | **None. Not performed.** Tooling: `frontend/eval.html`, `docs/HUMAN_EVALUATION.md` |
| 8 | Latency and concurrency analysis | `BENCHMARKS.md` section 0 | Measured on one L40S |
| 9 | Infrastructure cost analysis | `COSTS.md`, `docs/research/06-gpu-and-infrastructure.md` | Done |
| 10 | Financial projections for all user scenarios | `reports/cost_model.md`, `reports/cost_monthly.csv` | Done, on measured capacity |
| 11 | API versus self-hosting break-even | `COSTS.md` | Done |
| 12 | Recommended production architecture | section 4 | Done; voice choice pending |
| 13 | Known limitations and technical risks | section 5 | Done |
| 14 | MVP roadmap | section 6 | Done |
| 15 | Executive summary | section 1 | Done |

Tracking files: `PLAN.md`, `PROGRESS.md`, `DECISIONS.md`, `BLOCKERS.md`, `COSTS.md`, `BENCHMARKS.md`, `LICENSES.md`.
Research with sources: `docs/research/01` … `06`.
