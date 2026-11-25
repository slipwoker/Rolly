# Costs

Two things are tracked here: what the experiment itself cost, and what the product would cost to run.

## 1. Spend during the POC

| Item | Spent | How it is known |
|---|---:|---|
| GPU rental: one RunPod L40S, about 3 h 20 min at $1.09/h, plus volume | **$3.66** | Exact: RunPod balance went from $50.00 to $46.34; the pod is terminated |
| OpenAI API | **about $3–$4** (estimate) | Realtime runs: $2.36 computed from the token usage in the saved result files, plus one interrupted realtime run of about ten minutes that left no file (about $0.70), plus language-model and transcription calls (under $0.60). List prices are unverified and the account's billing page is the authority |
| Model downloads, datasets | $0 | Open weights and FLEURS |
| Inworld speech API (voice test, 2026-11-25) | **a few cents** (estimate) | About 2,600 characters sent; list price $15-$25 per million characters according to the research phase; the account's billing page was not read |
| Hosted demo (from 2026-11-25): Render Standard about $25/month; RunPod L40S $1.09/h while the pod exists | **running** | Not a one-off: the pod costs about $26 per day until it is terminated. Setup of the pod used about 20 minutes ($0.40) |
| **Total of the measurements** | **about $7–$8** | of a $300–$700 budget; the hosted demo is on top of this |

## 2. Projected operating cost

Source: `python -m finops.cost_model` → `reports/cost_model.md`, `reports/cost_model.json`, `reports/cost_monthly.csv`.
Inputs: `config/pricing.yaml`, where every figure carries a status.

### How reliable are the inputs

| Input | Status | Value |
|---|---|---|
| L40S rental price | **measured** (read from the RunPod API and billed) | $1.09 per GPU-hour, on demand, Secure Cloud |
| Conversations per L40S, whole self-hosted pipeline | **measured** on one GPU (`BENCHMARKS.md` 0.3) | 20 (P95 1.30 s) · 35 (P95 1.48 s, at the latency limit) · 50 (P95 1.70 s, outside it) |
| CPU per conversation with speech synthesis on CPU | **measured** | 0.15–0.18 CPU-seconds per session-second: about 3 conversations per vCPU with headroom |
| CPU per conversation, session layer only | **measured** | about 40 conversations per vCPU with headroom |
| OpenAI Realtime cost per minute | **measured token usage** × unverified list prices | $0.070–0.075 (`gpt-realtime-2.1`), $0.020–0.021 (mini), on 1–2 minute sessions |
| Commercial language-model usage per turn | **measured** (`gpt-6-luna`) | about 950 prompt + 45 output tokens: about $0.0004 per minute at the unverified list price |
| Commercial STT / TTS list prices | published | Soniox $0.002 per audio minute; Hebrew TTS $0.005–$0.011 per generated minute |
| Other GPU prices (L4, H100, Hetzner, owned hardware) | unverified / estimate | Their capacity is scaled from the L40S measurement |
| Capacity of hybrid splits (GPU running only some stages) | assumption | Not measured in isolation |
| Demand curve (15 % of daily minutes in the busiest hour) | assumption | Drives fleet size and utilisation |
| Staffing (0.2–3.5 FTE at $15k per month) | assumption | Dominates total cost below about 5,000 daily users |

### Cost per conversational minute — variable cost only

| Architecture | $ / minute | Status |
|---|---:|---|
| A. OpenAI `gpt-realtime-2.1` | 0.070–0.075 measured on short sessions; 0.077 estimated for 30-minute sessions with ideal caching; 0.22 at 90 % cache effectiveness | measured usage × unverified prices / estimate |
| A. Google `gemini-3.8-live`, tight context window | 0.060 | estimate, not run |
| A. OpenAI `gpt-realtime-2.1-mini` | 0.020 measured on short sessions; 0.030 estimated for 30-minute sessions | measured usage × unverified prices / estimate |
| D. Hybrid, every stage through an API, list prices | 0.0064 | estimate on published prices |
| D. Same with a committed TTS tier | 0.0040 | estimate on published prices |
| D. Self-hosted speech on GPU + commercial language model | 0.0018–0.0033 | assumption for the split capacity |
| **B. Fully self-hosted on rented L40S, 20 conversations per GPU** | **0.0017** | measured capacity and price |
| **B. Fully self-hosted on rented L40S, 35 conversations per GPU** | **0.0011** | measured capacity and price |

Self-hosted figures include the CPU for speech synthesis ($0.0002 per minute) and assume the roughly 60–65 % utilisation that an
hourly-autoscaled fleet reaches under the assumed commute curve. The requested utilisation grid for the rented L40S:

| Conversations per GPU | 30 % utilisation | 60 % | 80 % |
|---:|---:|---:|---:|
| 20 | $0.0033 | $0.0018 | $0.0014 |
| 35 | $0.0020 | $0.0011 | $0.0009 |
| 50 (outside the latency target) | $0.0015 | $0.0009 | $0.0007 |

The same grid for every GPU option is in `reports/cost_model.md`.

### Which targets are realistic

| Target $/min | Verdict | Basis |
|---:|---|---|
| 0.05 | Reachable by everything except `gpt-realtime-2.1` and Gemini Live | measured / estimate |
| 0.01 | Not reachable with commercial speech-to-speech. Reachable with component APIs and with self-hosting | measured / estimate |
| 0.005 | **Variable cost: reached with a wide margin** — it needs about 6 conversations per L40S at 60 % utilisation; we measured 20–35. **All-in** with staff: reached at about 10,000 daily users ($0.0042–0.0048), not below | measured capacity; staffing assumed |
| 0.001 | Variable cost needs about 41 conversations per $1.09 GPU at 60 % utilisation (26 on a $0.69 GPU). At the measured 35 it is $0.0011 at 60 % and $0.0009 at 80 %: borderline. All-in it is not reached at any modelled scale (best $0.0015–0.0017 at 100,000 daily users) | measured capacity; utilisation assumed |

### Monthly cost (all-in: APIs or GPUs, CPU, infrastructure, operations staff)

| Daily active users | Minutes / month | OpenAI Realtime mini (30-minute estimate) | Hybrid, all APIs (committed TTS) | Self-hosted speech + API language model | Fully self-hosted, rented L40S (20 … 35 per GPU) |
|---:|---:|---:|---:|---:|---:|
| 200 | 180,000 | $8,559 | $6,876 | $7,942 | $16,766 |
| 1,000 | 900,000 | $31,897 | $12,979 | $12,361 | $21,425 … $21,032 |
| 10,000 | 9,000,000 | $279,470 | $52,790 | $37,417 | $42,921 … $37,722 |
| 100,000 | 90,000,000 | $2,727,701 | $400,901 | $241,812 | $206,653 … $154,235 |

For `gpt-realtime-2.1` multiply the mini column by about 2.5 ($702,470 at 10,000 daily users).

At 10,000 daily users the GPU bill is $7,650–$12,850 per month (33–57 L40S at the evening peak) and CPU $2,320; assumed staff
($26,250) is the largest line. At 200 daily users two always-on GPUs cost $1,570 and the fully self-hosted option is the most
expensive only because of the staffing assumption (one engineer) — the hardware is not the obstacle at small scale.

### Peak demand and fleet strategy

- 10,000 daily users × 30 minutes = 5,000 conversation-hours a day; average concurrency 208; about 760 in the busiest hour (950 with
  burst headroom) under the assumed commute curve.
- A fixed fleet sized for that peak is used about 18 % of the time. Monthly-rented dedicated servers or owned hardware sized for the
  peak therefore cost more per minute than hourly rental ($46k–$67k versus $38k per month at 10,000 daily users).
- Owning the base load and renting the peaks is marginally cheaper than renting everything ($37.1k versus $37.7k) — not worth
  buying hardware before the demand curve is known.
- Cold start measured at about 3 minutes with cached weights: capacity must be added on a schedule ahead of the commute peaks.
- Supply: the L40S was reported out of stock shortly before we rented one. Plan for more than one provider and GPU type.

### Break-even: when does self-hosting beat an API?

All-in monthly cost, fully self-hosted on rented L40S (20–35 conversations per GPU), with the staffing assumptions:

| Compared with | Break-even (daily active users) |
|---|---:|
| Google `gemini-3.8-live` (estimate) | about 260 |
| OpenAI `gpt-live-1.1` (unverified flat price) | about 320 |
| OpenAI `gpt-realtime-2.1-mini` | about 560–570 |
| Pipeline of component APIs, list prices | about 2,300–2,500 |
| Pipeline of component APIs, committed TTS tier | about 4,200–5,200 |

Against commercial speech-to-speech, self-hosting pays for its staff within a few hundred daily users. Against a pipeline of cheap
component APIs the cost advantage only appears at a few thousand daily users — but that pipeline answered in 1.33 s where the
self-hosted one answered in 0.68 s, so the choice below break-even is latency against operational effort, not cost alone.

### Cost categories

| Category | Type | Included as |
|---|---|---|
| Commercial API fees | variable | $/minute per architecture |
| GPU rental / dedicated / owned (36-month amortisation with colocation, power, 10 %/year maintenance) | variable or fixed by fleet mode | hourly fleet sizing with 20 % redundancy and a 2-GPU minimum |
| CPU for session handling, VAD and speech synthesis | variable | measured: $0.0002 per minute with CPU speech synthesis |
| Network egress | variable | 0.8 MB per minute with Opus, $0.09/GB: about $0.00004 per minute |
| Storage (transcripts, memory) | variable | negligible |
| Database, monitoring, logging | fixed | $150–$8,000 per month by scale (assumption) |
| Idle infrastructure and redundancy | fixed | inside fleet sizing |
| Licensing | — | $0: the selected self-hosted components are permissively licensed (open review items in `LICENSES.md`) |
| Operations and engineering | fixed | 0.2–3.5 FTE by architecture and scale (assumption) |
| One-time development of the voice stack | one-time | $60k (API) / $105k (hybrid) / $150k (self-hosted), assumption |

Not modelled: a commercial Hebrew voice if the open one fails the listening test (adds about $0.002–$0.004 per minute), customer
support, mobile app development, retrieval infrastructure for large memories, TURN relay traffic, taxes, and price changes.
