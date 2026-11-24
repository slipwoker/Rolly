# Costs

Two different things are tracked here: what the experiment itself has cost so far, and what the product would cost to run.

## 1. Spend during the POC

| Item | Authorised | Spent | Notes |
|---|---:|---:|---|
| Commercial API usage | $0 (no key provided) | **$0** | Bridges implemented, not run live |
| GPU rental | $0 (not yet approved) | **$0** | All runs on the 4-vCPU session container |
| Model downloads, datasets | — | $0 | Open weights and FLEURS |
| **Total external spend** | | **$0** | Budget of $300–$700 untouched |

Proposed next spend (needs approval, see `BLOCKERS.md`): about $50–$200 GPU rental and up to about $60 of API usage.

## 2. Projected operating cost

Source: `python -m finops.cost_model` → `reports/cost_model.md`, `reports/cost_model.json`, `reports/cost_monthly.csv`.
Inputs: `config/pricing.yaml`, where every figure carries a status.

### How reliable are the inputs

| Input | Status | Consequence |
|---|---|---|
| Session-layer CPU: 40 sessions per vCPU | **measured** here (transport 0.006 + VAD 0.0065 CPU-seconds per session-second, 50 % headroom) | CPU cost is negligible: about $0.00002 per minute |
| Commercial STT / TTS list prices | published | Hybrid-API numbers are fairly solid |
| Commercial realtime $/minute | **estimate** from token prices that are themselves unverified for OpenAI | Could be off by tens of percent; cache effectiveness alone moves `gpt-realtime-2.1` from $0.077 to $0.22 per minute |
| GPU rental prices | **unverified** (vendor pages unreachable) | Re-check before committing |
| Conversations per GPU (STT 40, LLM 100, TTS 80 on an L40S in the base case) | **assumption** | The largest uncertainty in the model. It is exactly what the GPU concurrency benchmark measures |
| Demand curve (15 % of daily minutes in the busiest hour) | assumption | Drives fleet size and utilisation |
| Staffing (0.5–3.5 FTE at $15k per month) | assumption | Dominates total cost below about 5,000 DAU |

### Cost per conversational minute — variable cost only

| Architecture | $ / minute | Status |
|---|---:|---|
| A. OpenAI `gpt-realtime-2.1`, ideal caching | 0.077 | estimate |
| A. OpenAI `gpt-realtime-2.1`, 90 % cache effectiveness | 0.22 | estimate |
| A. Google `gemini-3.8-live`, tight context window | 0.060 | estimate |
| A. OpenAI `gpt-live-1.1`, flat price | 0.050 | unverified |
| A. OpenAI `gpt-realtime-2.1-mini`, ideal caching | 0.030 | estimate |
| D. Hybrid, every stage through an API (Soniox STT + Gemini Flash-Lite + Inworld TTS), list prices | 0.0064 | estimate on published prices |
| D. Same with the committed TTS tier | 0.0040 | estimate on published prices |
| D. Self-hosted STT + TTS, commercial LLM (base capacity) | 0.0021 | assumption |
| B. Self-hosted, L40S on demand at $1.09/h, **low** capacity (10.5 conversations per GPU) | 0.0027 | assumption |
| B. Self-hosted, L40S on demand, **base** capacity (21 per GPU) | 0.0014 | assumption |
| B. Self-hosted, L40S on demand, **high** capacity (39 per GPU) | 0.0008 | assumption |

Self-hosted figures are at the fleet utilisation an hourly-autoscaled fleet reaches under the assumed commute curve (about 61–66 % at 10,000 DAU).
The requested 30 / 60 / 80 % utilisation grid for every GPU option is in `reports/cost_model.md`; for an L40S at $1.09/h and base capacity it is $0.0029 / $0.0015 / $0.0011 per minute.

### Which targets are realistic

| Target $/min | Verdict | Basis |
|---:|---|---|
| 0.05 | Reachable with commercial realtime APIs only in their cheapest configurations (`gpt-realtime-2.1-mini`, `gpt-live-1.1`), and by every hybrid or self-hosted option | estimate |
| 0.01 | Not reachable with commercial speech-to-speech APIs. Reachable with an all-API modular pipeline (about $0.004–0.006) and with self-hosting | estimate / assumption |
| 0.005 | Variable cost: reachable when one L40S serves at least about 6 conversations at 60 % utilisation — well below even the pessimistic capacity assumption. **All-in** (with staff and fixed costs) it is reached at roughly 10,000 DAU in the base case, not below | assumption |
| 0.001 | Variable cost needs about 32 conversations per $1.09/h GPU at 60 % utilisation (20 on an owned L40S at $0.69/h): only the optimistic capacity case. All-in it is not reached at any modelled scale (best case $0.0014 at 100,000 DAU) | assumption |

### Monthly cost (all-in: APIs or GPUs, infrastructure, operations staff)

| Daily active users | Minutes / month | Commercial realtime, cheapest (`gpt-realtime-2.1-mini`) | Hybrid, all APIs (committed TTS) | Self-hosted speech + API LLM | Self-hosted, cloud L40S (low … base … high capacity) |
|---:|---:|---:|---:|---:|---:|
| 200 | 180,000 | $8,559 | $6,876 | $7,905 | $16,762 … $16,729 … $16,729 |
| 1,000 | 900,000 | $31,897 | $12,979 | $12,176 | $22,155 … $21,174 … $20,815 |
| 10,000 | 9,000,000 | $279,470 | $52,790 | $35,567 | $51,862 … $40,286 … $34,989 |
| 100,000 | 90,000,000 | $2,727,701 | $400,901 | $223,312 | $298,418 … $181,842 … $127,953 |

At 10,000 DAU the GPU bill itself is only $7k–$24k per month (29–108 L40S at the evening peak); staff ($26k) is the larger line.
At 200 DAU every self-hosted option is dominated by staff cost and is the most expensive choice.

### Peak demand and fleet strategy

- 10,000 DAU × 30 minutes = 5,000 conversation-hours per day, average concurrency 208, peak-hour concurrency about 758 (947 with burst headroom) under the assumed commute curve.
- A fixed fleet sized for that peak is used about 18 % of the time. Dedicated servers (Hetzner) or owned hardware sized for the peak therefore cost **more** per minute than hourly cloud rental ($0.0061–0.0099 versus $0.0045 all-in at 10,000 DAU), despite the lower hourly rate.
- Owning the base load and renting the peaks gives the best result in the model ($39.6k versus $40.3k per month at 10,000 DAU) — a small gain that does not justify buying hardware before demand is proven.
- Cold start matters for autoscaling: GPU capacity must be requested before the commute peak, not in reaction to it (schedule-based scaling). Cold-start times were not measured.

### Break-even: when does self-hosting beat an API?

All-in monthly cost, self-hosted on cloud L40S:

| Compared with | Break-even (daily active users) |
|---|---:|
| Google `gemini-3.8-live` | about 260 |
| OpenAI `gpt-live-1.1` | about 320 |
| OpenAI `gpt-realtime-2.1-mini` | about 560–580 |
| Hybrid all-API pipeline, list prices | about 2,200–3,300 |
| Hybrid all-API pipeline, committed TTS tier | about 3,800–9,400 |

Reading: against commercial speech-to-speech, self-hosting pays for its staff within a few hundred daily users. Against a modular
pipeline assembled from cheap component APIs it only pays off at several thousand daily users, and the answer is sensitive to the
unmeasured capacity per GPU.

### Cost categories

| Category | Type | Included as |
|---|---|---|
| Commercial API fees | variable | $/minute per architecture |
| GPU rental / dedicated / owned (36-month amortisation with colocation, power, 10 %/year maintenance) | variable or fixed by fleet mode | hourly fleet sizing with 20 % redundancy and a 2-GPU minimum |
| CPU for session handling and VAD | variable | measured, $0.00002/minute |
| Network egress | variable | 0.8 MB per minute with Opus, $0.09/GB: about $0.00004/minute |
| Storage (transcripts, memory) | variable | negligible |
| Database, monitoring, logging | fixed | $150–$8,000 per month by scale (assumption) |
| Idle infrastructure and redundancy | fixed | inside fleet sizing |
| Licensing | — | $0: all selected self-hosted components are permissively licensed (see `LICENSES.md` for open review items) |
| Operations and engineering | fixed | 0.2–3.5 FTE by architecture and scale (assumption) |
| One-time development of the voice stack | one-time | $60k (API) / $105k (hybrid) / $150k (self-hosted), assumption |

Not modelled: customer support, mobile app development, memory/retrieval infrastructure beyond a small database, taxes, payment fees, TURN relay traffic for users behind restrictive networks, and price changes (GPU rental prices rose during 2026 according to the research).
