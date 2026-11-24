# 06 — GPU rental, dedicated servers, owned hardware and non-GPU infrastructure prices

Research date (all "accessed" dates): **2026-11-24**. Currency USD unless stated. EUR figures converted at an **assumed 1 EUR = 1.15 USD [ESTIMATE]** (rate not verified; original EUR values are always given so it can be recomputed). Month = 730 h.

Companion machine-readable file: `docs/research/06-gpu-prices.json` (169 rows).

---

## 0. Verification status — read this first

**No provider pricing page could be fetched in this session.** Every direct request (WebFetch and `curl`) to `runpod.io`, `lambda.ai`, `modal.com`, `coreweave.com`, `vast.ai`, `hetzner.com`, `aws.amazon.com` and others was refused by the session's egress proxy (`CONNECT tunnel failed, response 403` / `ENOTFOUND`): those hosts are outside the session's allowed network domains. Only the web-search tool worked. Consequently:

- **Zero figures in this report are `[VERIFIED-official]`.** Every `verified` flag in the JSON is `false`.
- Figures were read from **search-index excerpts** of pages, not from the live pages. Excerpts can be stale, mis-parsed from tables, or regional.

Tag meaning as used here:

| Tag | Meaning in this report |
|---|---|
| `[VERIFIED-official]` | Official page fetched directly this session. **Not used — nothing qualified.** |
| `[UNVERIFIED]` | Figure comes from a search-index excerpt of the **provider's own domain** (pricing page or docs); the page itself was not fetched. Best available, but must be re-checked on the live page before money is committed. |
| `[PUBLISHED-thirdparty]` | Figure comes from a third-party tracker, aggregator or blog (also via search excerpt, not fetched). |
| `[ESTIMATE]` | My own calculation or assumption. |

To upgrade these to verified, the following hosts need to be allowed in the session's network settings: `www.runpod.io`, `docs.runpod.io`, `lambda.ai`, `modal.com`, `www.coreweave.com`, `vast.ai`, `www.hetzner.com`, `aws.amazon.com`, `cloud.google.com`, `azure.microsoft.com`, `www.oracle.com`, `www.hyperstack.cloud`, `nebius.com`, `www.crusoe.ai`, `www.scaleway.com`, `www.ovhcloud.com`, `www.digitalocean.com`, `www.vultr.com`, `www.latitude.sh`, `www.baseten.co`, `www.together.ai`, `fireworks.ai`, `livekit.io`, `www.twilio.com`, `developers.cloudflare.com`, `grafana.com`, `www.datadoghq.com`.

**Market context that affects every number below [PUBLISHED-thirdparty]:** GPU rental prices have been *rising* through 2026, not falling. Silicon Data puts the median H100 rate at ~$3.70/h (week of 2026-10-19), +24 % year on year; SemiAnalysis reports 1-year H100 contracts up ~40 % (Oct 2025 → Mar 2026); CoreWeave reported 30–50 % quarter-on-quarter increases on older Ampere/Hopper fleets (Q3 2026 call); Lambda raised H100/B200 ~15 % effective 2026-11-16; Nebius raised H100 ~17 % on 2026-10-01; Scaleway raised list prices 2026-06-01; Hetzner's GEX131 went from €889 to €1,499/month. Any price remembered from 2025 or early 2026 is probably too low.

---

## 1. GPU rental prices (per GPU, USD/hour)

### 1.1 Cheapest credible option per GPU type

"Credible" = self-serve, single-GPU purchasable, datacenter-hosted. Peer-to-peer marketplace floors are shown separately because host quality and availability vary.

| GPU (VRAM) | Cheapest credible on-demand | $/h | Marketplace / community floor | Hyperscaler reference | Tag |
|---|---|---|---|---|---|
| T4 (16 GB) | AWS g4dn.xlarge / Azure NC4as_T4_v3 | 0.526 | — | GCP T4 GPU-only 0.35 + VM | `[PUBLISHED-thirdparty]` |
| L4 (24 GB) | RunPod Secure | 0.69 | RunPod Community 0.44 | GCP g2-standard-4 0.71; AWS g6.xlarge 0.805 | `[UNVERIFIED]` |
| A10 / A10G (24 GB) | AWS g5.xlarge | 1.006 | — | Modal 1.10; Lambda 1.29 | `[PUBLISHED-thirdparty]` |
| RTX 4090 (24 GB) | RunPod Secure | 0.89 | RunPod Community 0.34; TensorDock 0.35; Vast median 0.50 | n/a | `[UNVERIFIED]` |
| RTX 5090 (32 GB) | RunPod Secure | 1.39 | Vast median 0.63; RunPod Community 0.69; TensorDock 0.56 | n/a | `[UNVERIFIED]` |
| RTX A6000 (48 GB) | Hyperstack | 0.50 | RunPod Community 0.33 (Secure 0.69) | n/a | `[UNVERIFIED]` |
| RTX 6000 Ada (48 GB) | TensorDock | 0.75 | — | RunPod ~1.09; DigitalOcean 1.57 | `[UNVERIFIED]` |
| L40S (48 GB) | RunPod Secure | 1.09 | RunPod Community 0.79; Vast median 0.80; Latitude.sh 0.74 | AWS g6e.xlarge 1.861 | `[UNVERIFIED]` |
| A100 40 GB | Lambda | 1.99 | — | Modal 2.10; GCP 3.67 | `[PUBLISHED-thirdparty]` |
| A100 80 GB | Hyperstack (PCIe) | 1.35 | RunPod Community 1.19; Vast median 0.73–0.84 | Azure 3.67; GCP 5.07 | `[UNVERIFIED]` |
| H100 80 GB | Hyperstack (PCIe) | 2.50 | RunPod Community 1.99; Vast median 1.93 | AWS ~5.19–6.88; Azure 6.98; GCP 11.06 | `[UNVERIFIED]` |
| H200 141 GB | Modal | 4.54 | RunPod Community 3.59 | GCP ~10.71 | `[UNVERIFIED]` |
| B200 180 GB | Modal | 6.25 | — | CoreWeave 8.60; Nebius 8.50 | `[UNVERIFIED]` |
| RTX PRO 6000 Blackwell (96 GB) | Hetzner GEX430 dedicated (per GPU) | 1.42 | Vast median 1.73 | Modal 3.03 | `[UNVERIFIED]` + `[ESTIMATE]` (conversion) |

Notes:
- Nebius H200 appears at both $3.50 and $5.40 in two excerpts of the same docs site; the table uses neither as "cheapest" because of that conflict `[UNVERIFIED]`.
- Independent market medians for sanity: H100 on-demand median ≈ $3.70–3.91/h (Silicon Data, GetDeploying); RTX 5090 median $0.72/h across 16 providers on 2026-11-23 (GetDeploying) `[PUBLISHED-thirdparty]`.

### 1.2 Specialised GPU clouds — full table

All rows: accessed 2026-11-24, page not fetched.

| Provider | GPU (VRAM) | On-demand $/h | Spot / interruptible | Committed | Billing | Tag |
|---|---|---|---|---|---|---|
| **RunPod Secure** | RTX 4090 (24) | 0.89 | — | n/r | per-second | `[UNVERIFIED]` |
| | RTX 5090 (32) | 1.39 | — | | | `[UNVERIFIED]` |
| | L4 (24) | 0.69 | — | | | `[UNVERIFIED]` |
| | RTX A6000 (48) | 0.69 | — | | | `[UNVERIFIED]` |
| | L40 (48) | 0.82 | — | | | `[UNVERIFIED]` |
| | L40S (48) | 1.09 | — | | | `[UNVERIFIED]` |
| | A100 PCIe / SXM (80) | 2.09 / 2.19 | — | | | `[UNVERIFIED]` |
| | H100 PCIe / SXM (80) | 2.89 / 4.39 | — | | | `[UNVERIFIED]` |
| | H200 (141) | 5.29 | — | | | `[UNVERIFIED]` |
| **RunPod Community** | 4090 / 5090 | 0.34 / 0.69 | | | per-second | `[UNVERIFIED]` |
| | L4 / A6000 / L40 / L40S | 0.44 / 0.33 / 0.69 / 0.79 | | | | `[UNVERIFIED]` |
| | A100 PCIe / SXM | 1.19 / 1.39 | | | | `[UNVERIFIED]` |
| | H100 PCIe / SXM / H200 | 1.99 / 2.69 / 3.59 | | | | `[UNVERIFIED]` |
| **RunPod Serverless (flex)** | 24 GB (L4/A5000/3090) / 4090 | 0.75 / 1.34 | scale-to-zero | active workers 30–40 % off (sources conflict) | per-second, rounded up; startup + idle window billed | `[UNVERIFIED]` |
| | 48 GB A6000/A40 / L40-L40S-6000Ada | 1.22 / 1.89 | | | | `[UNVERIFIED]` |
| | A100 / H100 / H200 | 2.99 / 5.89 / 6.99 | | | | `[UNVERIFIED]` |
| **Modal** | T4 / L4 / A10 | 0.59 / 0.80 / 1.10 | scale-to-zero | — | per-second, no minimum; CPU+RAM extra | `[UNVERIFIED]` |
| | L40S (48) | 1.95 | | | | `[UNVERIFIED]` |
| | A100 40 / 80 | 2.10 / 2.50 | | | | `[UNVERIFIED]` |
| | H100 / H200 / B200 | 3.95 / 4.54 / 6.25 | | | | `[UNVERIFIED]` |
| | RTX PRO 6000 (96) | 3.03 | | | | `[UNVERIFIED]` |
| **Lambda** | A10 (24) | 1.29 | none | reserved via sales | usage-based (granularity n/r) | `[PUBLISHED-thirdparty]` |
| | RTX A6000 (48) | 1.09 | | | | `[UNVERIFIED]` (excerpt ~623 days old) |
| | A100 40 / 80 SXM | 1.99 / 2.79 | | | | `[PUBLISHED-thirdparty]` |
| | H100 PCIe / SXM 1x / SXM 8x | 3.29 / 4.29 / 4.59 | | | | mixed; 8x figure post 2026-11-16 `[PUBLISHED-thirdparty]` |
| | B200 (180) | 6.99 (pre-increase) | | | | `[UNVERIFIED]` |
| **CoreWeave** (8-GPU nodes ÷ 8) | L40 / L40S | 1.25 / 2.25 | L40S 0.99 | | hourly rate; node minimum | `[UNVERIFIED]` |
| | A100 (80) | 2.70 | 1.19 | | | `[UNVERIFIED]` |
| | H100 / H200 | 6.16 / 6.31 | 2.46 / 2.58 | H100 from 2.23 on 2-year contract | | `[UNVERIFIED]` |
| | B200 | 8.60 | 4.26 | | | `[UNVERIFIED]` |
| **Vast.ai** (marketplace median, 2026-11-16) | RTX 3090 / 4090 / 5090 | 0.20 / 0.50 / 0.63 | bid-based, "50 %+ cheaper" | reserved discounts exist | per-second; storage and per-byte bandwidth (both directions) extra; $5 minimum deposit | `[PUBLISHED-thirdparty]` (medians); `[UNVERIFIED]` (billing) |
| | L40S | 0.80 (floor 0.47) | | | | `[PUBLISHED-thirdparty]` |
| | A100 PCIe / SXM4 | 0.73 / 0.84 | | | | `[PUBLISHED-thirdparty]` |
| | H100 SXM | 1.93 (floor 1.73) | | | | `[PUBLISHED-thirdparty]` |
| **Crusoe** | L40S / A100 80 / H100 / H200 | 1.00 / 1.95 / 3.90 / 4.29 | exists, rates n/r | via sales | per-hour or per-second | `[UNVERIFIED]` (FAQ ~400 days old — likely stale) |
| **Nebius** | L40S (48) | 1.35 GPU-only (1.55 bundled) | 0.65–0.74 | n/r | usage-based | `[UNVERIFIED]` |
| | H100 / H200 / B200 | 4.50 / 5.40 (or 3.50) / 8.50 | dynamic spot since 2026-10-08 | | | `[UNVERIFIED]`, low confidence (conflicting excerpts) |
| **Hyperstack** | RTX A6000 (48) | 0.50 | 0.40 | from 0.35 | per-minute (pricebook says "hourly basis"); public IP billed hourly | `[UNVERIFIED]` |
| | L40 (48) | 1.00 | 0.80 | from 0.70 | | `[UNVERIFIED]` |
| | A100 PCIe / SXM (80) | 1.35 / 1.60 | 1.08 | from 0.95 | | `[UNVERIFIED]` |
| | H100 PCIe / SXM | 2.50 / 3.20 | 1.52 | from 1.75 | | `[UNVERIFIED]` |
| **TensorDock** | 4090 / 6000 Ada / L40 / H100 | 0.35 / 0.75 / 0.95 / 2.25 | — | — | per-second (older page) | `[UNVERIFIED]` |
| | 5090 / A6000 / L40S | 0.56 / 0.42 / 0.49 | | | | `[PUBLISHED-thirdparty]` |
| **Baseten** (dedicated) | T4 / L4 / A10G | 0.63 / 0.85 / 1.21 | scale-to-zero | — | per-minute | `[UNVERIFIED]` |
| | A100 / H100 / B200 | 4.00 / 6.50 / 9.98 | | | | `[UNVERIFIED]` |
| **Together** (dedicated endpoints) | L40 / L40S | 1.49 / 2.10 | — | via sales | billed while deployed | `[UNVERIFIED]` |
| | A100 80 PCIe / SXM | 2.40 / 2.59 | | | | `[UNVERIFIED]` |
| | H100 / H200 | 3.36 / 4.99 (blog) vs 5.49 / 5.99 (pricing page) | | | | `[UNVERIFIED]`, conflicting |
| **Fireworks** (on-demand deployments) | H100 / H200 / B200 | 8.00 / 8.00 / 13.00 | preemptible −50 % | — | per GPU-second; scales to zero after 1 h idle; region-pinned ×1.5 | `[UNVERIFIED]` |
| **DigitalOcean** GPU Droplets | RTX 4000 Ada (20) / 6000 Ada / L40S / H100 | 0.76 / 1.57 / 1.57 / 4.41 | — | — | per-second, 5-minute minimum | `[UNVERIFIED]` |
| **Paperspace** | RTX4000 (8) / H100 | 0.56 / 5.95 | — | H100 2.24 on 3-year | hourly | `[UNVERIFIED]` |
| **Scaleway** (Paris) | L4 / L40S | €0.792 / €1.47 (≈0.91 / 1.69) | — | — | per-minute | `[UNVERIFIED]` |
| | H100 PCIe / SXM | €2.73 / €6.61 (≈3.14 / 7.60) | | | | `[UNVERIFIED]` |
| **OVHcloud** Public Cloud | L4 / L40S | 1.00 / 1.80 | — | monthly ≈ ×720 | hourly | `[UNVERIFIED]` (table ~237 days old) |
| | H100 / A100 80 | 2.99 / 3.07 | | | | `[UNVERIFIED]` (stale Asia list) |
| **Vultr** | L40S cloud / bare metal | 1.671 / from 0.848 | — | prepaid terms n/r | hourly | `[UNVERIFIED]` (page ~570 days old) |
| **Latitude.sh** | L40S / H100 PCIe | 0.74 / 1.66 (sold out) | — | — | per-hour | `[PUBLISHED-thirdparty]` |

n/r = not retrieved.

### 1.3 Hyperscalers

| Provider | GPU / instance | On-demand $/h | Spot | 1-year | 3-year | Tag |
|---|---|---|---|---|---|---|
| AWS (us-east-1) | T4 — g4dn.xlarge | 0.526 | n/r | n/r | n/r | `[PUBLISHED-thirdparty]` |
| | A10G — g5.xlarge | 1.006 | n/r | n/r | n/r | `[PUBLISHED-thirdparty]` |
| | L4 — g6.xlarge | 0.805 (another tracker 0.978) | n/r | n/r | n/r | `[PUBLISHED-thirdparty]` |
| | L40S — g6e.xlarge | 1.861 | ~0.63–0.87 | ~1.339 | n/r | `[PUBLISHED-thirdparty]` |
| | A100 40 — p4d.24xlarge ÷ 8 | 2.74 (conflict: 4.10) | n/r | n/r | n/r | `[PUBLISHED-thirdparty]`, conflicting |
| | H100 — p5.48xlarge ÷ 8 | 6.88 (conflict: ~5.19; ~12.29) | n/r | n/r | n/r | `[PUBLISHED-thirdparty]`, conflicting |
| Google Cloud | T4 GPU-only (us-west8) | 0.35 + VM | n/r | 0.22 | 0.16 | `[UNVERIFIED]` |
| | L4 — g2-standard-4 | 0.71 | 0.42 | 0.45 | 0.32 | `[UNVERIFIED]` |
| | A100 40 — a2-highgpu-1g | 3.67 | 2.20 | 2.31 | 1.29 | `[UNVERIFIED]` |
| | A100 80 — a2-ultragpu-1g | 5.07 | 3.04 | 4.20 | 3.50 | `[UNVERIFIED]` |
| | H100 — a3-highgpu-8g ÷ 8 | 11.06 | 6.59 | 7.67 | 4.86 | `[UNVERIFIED]` (÷8 is `[ESTIMATE]`) |
| | Cloud Run L4 (GPU only) | 0.672 | — | — | — | `[UNVERIFIED]` (excerpt ~490 days old) |
| Azure (East US) | T4 — NC4as_T4_v3 | 0.526 | ~70–82 % off | 0.316 | 0.211 | `[PUBLISHED-thirdparty]` |
| | A10 — NV36ads_A10_v5 | 3.20 | n/r | n/r | n/r | `[PUBLISHED-thirdparty]` |
| | A100 80 — NC24ads_A100_v4 | 3.67 | ~0.68 | n/r | ~1.36 | `[PUBLISHED-thirdparty]` |
| | H100 — NC40ads_H100_v5 | 6.98 | n/r | ~4.53 | ~3.14 | `[PUBLISHED-thirdparty]` |
| Oracle (OCI) | A10 / L40S / A100 / H100 | 2.00 / 3.50 / 4.00 / 10.00 | n/r | n/r | n/r | `[PUBLISHED-thirdparty]` (official price list returned no rates) |

AWS billing is per-second with a 60 s minimum and GCP/Azure are per-second — `[UNVERIFIED]` (from memory, not re-checked this session).

### 1.4 Egress / data-transfer fees

| Provider | Policy | Tag |
|---|---|---|
| RunPod | "No fees for data transfer"; compute and storage billed per second | `[UNVERIFIED]` |
| Vast.ai | Bandwidth billed per byte in **both** directions at a host-set rate | `[UNVERIFIED]` |
| Lambda, Crusoe, CoreWeave, Nebius | Reported as no egress charge | `[PUBLISHED-thirdparty]` |
| Hyperstack | "No bandwidth charges" reported; public IP billed hourly | `[PUBLISHED-thirdparty]` |
| Modal | Network priced separately from GPU (rate n/r) | `[UNVERIFIED]` |
| AWS | $0.09/GB first 10 TB/month, 100 GB/month free | `[PUBLISHED-thirdparty]` |
| Google Cloud | Premium tier $0.12/GiB for 1 GiB–1 TiB; Standard tier first 200 GiB free then $0.085/GiB to 10 TiB | `[UNVERIFIED]` |
| Hetzner | Dedicated: 1 Gbit, unmetered traffic reported; Cloud EU: 20 TB/month included, ~€1/TB after | `[PUBLISHED-thirdparty]` |

### 1.5 Region availability (EU and Israel / Middle East)

| Provider | EU | Israel / Middle East | Tag |
|---|---|---|---|
| RunPod | EU-RO-1 (Romania), EU-CZ-1, EU-NL-1, EU-SE-1, EU-FR-1, Iceland EUR-IS-1…5, Norway EUR-NO-1/2 | none found | `[UNVERIFIED]` (RunPod blog) + `[PUBLISHED-thirdparty]` (directory) |
| Google Cloud | many | **me-west1 (Tel Aviv): T4 and A100 40/80 GB, both flagged limited; no L4, no H100.** Dammam (me-central2) has L4 | `[UNVERIFIED]` |
| AWS | many | il-central-1 (Tel Aviv): G5 was named at region launch; current GPU family list **not confirmed** | `[UNVERIFIED]` |
| Azure | many | Israel Central: GPU SKU availability **not confirmed** | `[UNVERIFIED]` |
| Oracle | many | Jerusalem region exists; GPU shapes there **not confirmed** | `[UNVERIFIED]` |
| Nebius | eu-north1 (Finland; L40S only there) | **Israel data centre launched Oct 2025 with NVIDIA Blackwell**; ILS price list published | `[UNVERIFIED]` |
| Scaleway | Paris PAR-2 for L40S/H100 | none | `[UNVERIFIED]` |
| Hetzner | Germany (FSN/NBG), Finland (HEL) | none | `[PUBLISHED-thirdparty]` |
| Hyperstack | "Europe and North America" | none found | `[UNVERIFIED]` |
| Vultr | several | Tel Aviv GPU availability **not found** | `[UNVERIFIED]` |

Latency implication `[ESTIMATE]`: Israeli users to Romania/Frankfurt is typically ~40–70 ms round trip, which is acceptable for a voice pipeline whose model latency budget is several hundred ms. In-country GPU supply is thin and expensive, so plan production in the EU (Romania, Germany, Finland) and treat Nebius-Israel / GCP me-west1 as optional later.

---

## 2. Dedicated / bare-metal monthly GPU servers

| Provider / model | GPU | Monthly | Setup fee | Min. term | $/GPU-h at 730 h | Tag |
|---|---|---|---|---|---|---|
| Hetzner **GEX45** | 1× RTX PRO 4000 Blackwell SFF, 24 GB; i5-13500, 64 GB RAM | €214 | €209 | monthly; ~30-day notice (third parties report "no minimum term") | **0.34** (0.37 with setup spread over 12 months) | `[UNVERIFIED]` price; `[ESTIMATE]` hourly |
| Hetzner **GEX63** | 1× RTX PRO 6000 Blackwell Max-Q, 96 GB | €999 | €999 | same | 1.57 (1.71) | `[UNVERIFIED]` / `[ESTIMATE]` |
| Hetzner **GEX131** | 1× RTX PRO 6000 Blackwell Max-Q, 96 GB (larger host; up to 3 GPUs) | from €1,499 | €1,499 | same | 2.36 (2.56) | `[UNVERIFIED]` / `[ESTIMATE]` |
| Hetzner **GEX430** | 4× RTX PRO 6000 Blackwell, 384 GB total | €3,599 | €3,599 | same | **1.42 per GPU** (1.54) | `[UNVERIFIED]` / `[ESTIMATE]` |
| OVHcloud Scale-GPU-1 | NVIDIA L4 (count n/r) | CA$1,551.99 (UK £834.24 ex VAT) | equal to one month | n/r | n/r | `[UNVERIFIED]` |
| OVHcloud HGR-AI-2 | NVIDIA L40S (count n/r) | US$3,505 (CA$4,751.99; UK £3,173.99) | equal to one month | n/r | 2.40 if 2 GPUs, 1.20 if 4 GPUs | `[UNVERIFIED]` price; `[ESTIMATE]` hourly |
| Latitude.sh | L40S bare metal | hourly only found | n/r | per-hour | 0.74 | `[PUBLISHED-thirdparty]` |
| Latitude.sh | H100 PCIe | — | n/r | per-hour | 1.66 (sold out) | `[PUBLISHED-thirdparty]` |
| Vultr bare metal | L40S | n/r | n/r | n/r | from 0.848 | `[UNVERIFIED]` (stale) |
| Vultr bare metal | 8× H100 | n/r | n/r | n/r | 2.30–2.99 | `[PUBLISHED-thirdparty]` |
| Scaleway L40S-8-48G (cloud, not bare metal) | 8× L40S | €8,176 | none | per-minute | €1.40 (≈1.61) | `[PUBLISHED-thirdparty]` |
| Serverion | 8× L40S | €10,512 | n/r | n/r | €1.80 (≈2.07) | `[PUBLISHED-thirdparty]` |

Observations:
- The older GEX44 (RTX 4000 SFF Ada 20 GB, ~€184/month) and GEX130 (RTX 6000 Ada 48 GB, ~€838/month) appear in third-party listings but are **not** in the current Hetzner lineup reported for November 2026 (GEX45 / GEX63 / GEX131 / GEX430) `[PUBLISHED-thirdparty]`.
- Hetzner and OVH setup fees are now roughly one month's rent, so a one- or two-month trial is expensive relative to hourly rental.
- For 24/7 base load, **Hetzner GEX45 at ~$0.34/GPU-h is the cheapest always-on 24 GB GPU found**, and GEX430 at ~$1.42/h per 96 GB card undercuts every hourly 48 GB+ datacenter offer on a per-GB basis.

---

## 3. Owned hardware

### 3.1 Street prices (November 2026)

| Item | Price | Tag |
|---|---|---|
| NVIDIA L4 24 GB | $3,599 (Newegg) – $3,950 (Amazon) – $4,599 (eBay) new, 2026-10-09; $2,600 refurbished | `[PUBLISHED-thirdparty]` |
| NVIDIA L40S 48 GB | $7,500–10,000; used $7,000–9,000 | `[PUBLISHED-thirdparty]` |
| RTX 5090 32 GB | **$6,200–6,600** (Newegg $6,199.99 on 2026-11-13; $6,249.99 on 11-14; Tom's Hardware best $6,449). MSRP $1,999; ~$3,500 in Feb 2026 | `[PUBLISHED-thirdparty]` |
| A100 80 GB PCIe | $15,499–19,789 asking (eBay/Newegg, 2026-11-17); older guides $7,000–12,000 | `[PUBLISHED-thirdparty]` |
| H100 80 GB PCIe | $29,500–36,000 new (Newegg, 2026-11-17); used $15,000–35,000 | `[PUBLISHED-thirdparty]` |
| 8× L40S complete server | $82,999 (Lambda Scalar, 2× EPYC 9354, 768 GB); $85,271 (Supermicro SYS-421GE-TNRT, Newegg, out of stock) | `[UNVERIFIED]` (Lambda shop) / `[PUBLISHED-thirdparty]` |
| 8× H100 HGX server | $250,000–320,000, typical ~$285,000 | `[PUBLISHED-thirdparty]` |
| 4-GPU 4U barebone (MSI, 5090/RTX PRO 6000/H200-capable) | $6,700, GPUs apparently not included | `[PUBLISHED-thirdparty]` |
| 8-GPU L4 server | $22,000–32,000 (dated guide; inconsistent with current card prices) | `[PUBLISHED-thirdparty]` |

### 3.2 Power draw (card TDP)

| Card | TDP | Tag |
|---|---|---|
| L4 | 72 W | `[PUBLISHED-thirdparty]` |
| L40S | 350 W | `[PUBLISHED-thirdparty]` |
| RTX 5090 | 575 W | `[PUBLISHED-thirdparty]` |
| A100 PCIe 40 GB / SXM4 80 GB | 250 W / 400 W (80 GB PCIe usually quoted 300 W) | `[PUBLISHED-thirdparty]` |
| H100 PCIe / SXM | 350 W / 700 W | `[PUBLISHED-thirdparty]` |

### 3.3 Colocation

| Market | Rate | Tag |
|---|---|---|
| US wholesale average (CBRE H2 2025, 250–500 kW) | ~$196/kW/month | `[PUBLISHED-thirdparty]` |
| US retail (<500 kW), tier-1 metros | $120–180/kW/month; GPU high-density $150–250 | `[PUBLISHED-thirdparty]` |
| US small published plans (1–4 GPU box, all-in) | $210–470/kW/month | `[PUBLISHED-thirdparty]` |
| Europe outside FLAP-D | €130–200/kW/month | `[PUBLISHED-thirdparty]` |
| London / Frankfurt | €150–300/kW/month; Nordics 20–40 % cheaper power | `[PUBLISHED-thirdparty]` |
| Per-U pricing | not retrieved | — |

Sources disagree on whether quoted rates include metered energy; that is the single biggest uncertainty in the table below.

### 3.4 Amortisation over 36 months — effective $/GPU-hour

Explicit assumptions (all `[ESTIMATE]` unless noted):

| Assumption | Value |
|---|---|
| Amortisation period | 36 months = 26,280 h per GPU |
| Residual value at month 36 | $0 (conservative) |
| Cost of capital / financing | 0 % (not modelled) |
| Maintenance, spares, remote hands | 10 % of capex per year (30 % over the term) |
| Colocation (space, cooling, redundant power capacity) | $150 per committed kW per month, energy metered separately |
| Energy | $0.15/kWh × PUE 1.3 → $142/kW/month |
| Total facility cost | $292/kW/month ($10,525 per kW over 36 months) |
| Sustained draw | card TDP × count + host overhead, as listed per row |
| Network transit, staff time, insurance | excluded |
| Availability | 100 % (every hour sellable) |

| Configuration | GPUs | Capex | Draw (kW) | Maintenance 36 mo | Colo + energy 36 mo | Total 36 mo | **$/GPU-h @100 %** | $/GPU-h if only 40 % of hours are used |
|---|---|---|---|---|---|---|---|---|
| 1× RTX 5090 + host ($6,300 + $3,500) | 1 | $9,800 | 0.8 | $2,940 | $8,420 | $21,160 | **0.81** | 2.01 |
| 4× RTX 5090 server (4 × $6,300 + $12,000) | 4 | $37,200 | 2.8 | $11,160 | $29,469 | $77,829 | **0.74** | 1.85 |
| 8× L4 server (8 × $3,600 + $10,000) | 8 | $38,800 | 1.0 | $11,640 | $10,525 | $60,965 | **0.29** | 0.73 |
| 1× L40S server ($9,000 + $4,000) | 1 | $13,000 | 0.6 | $3,900 | $6,315 | $23,215 | **0.88** | 2.21 |
| 8× L40S server (Lambda list) | 8 | $83,000 | 3.6 | $24,900 | $37,889 | $145,789 | **0.69** | 1.73 |
| 8× A100 80 GB server (8 × $15,500 + $15,000) | 8 | $139,000 | 3.2 | $41,700 | $33,679 | $214,379 | **1.02** | 2.55 |
| 8× H100 HGX server | 8 | $285,000 | 8.5 | $85,500 | $89,459 | $459,959 | **2.19** | 5.47 |

Reading the table:
- **Owning no longer clearly beats renting.** Owned L40S ($0.69) vs RunPod Community $0.79 / Secure $1.09; owned H100 ($2.19) vs Hyperstack $2.50 / RunPod Community $1.99; owned RTX 5090 ($0.74–0.81) is *more* expensive than renting one ($0.63–0.69 community) because the card now costs ~3× MSRP.
- The diurnal load profile is decisive: at 40 % utilisation of owned hours the owned figures are 2.5× higher, whereas per-second rental only bills used hours.
- Only the 8× L4 box ($0.29/h vs $0.44–0.69 rental) and Hetzner-style dedicated rental show a clear always-on advantage.
- Caveat `[UNVERIFIED]` (from memory, not re-checked): NVIDIA's GeForce driver licence restricts datacenter deployment of consumer cards such as the RTX 5090; check before colocating them.

---

## 4. Serverless / autoscaling facts

### 4.1 Cold starts and billing granularity

| Platform | Published cold-start figure | Scale-to-zero and billing | Tag |
|---|---|---|---|
| **Modal** | GPU memory snapshot (experimental) cut a Ministral 3 3B cold start from ~118 s to ~12 s (single vendor benchmark) | Per-second, no minimum increment. `scaledown_window` default 60 s, range 2 s–20 min; idle container time is billed | `[UNVERIFIED]` |
| **RunPod Serverless** | Vendor benchmark: median ~1.5 s over 151 trials to wake a *sleeping* worker; 13 of 15 woke in 1.0–2.0 s, **2 of 15 needed a full boot of ~4 minutes**. Marketing "sub-200 ms FlashBoot" applies to active endpoints. First worker of a new endpoint must download the model: minutes | Per-second rounded up, from worker start to full stop, including startup and idle window. Default idle timeout 5 s | `[UNVERIFIED]` |
| **Baseten** | No duration published; docs say weight loading dominates | Per-minute per running replica; default `min_replica` 0; scale-down delay default 900 s (0–3,600 s); replica start-up is billable | `[UNVERIFIED]` |
| **Cloud Run GPU** | L4 instance with drivers starts in ~5 s (model load is on top); startup allowed up to 30 min | Scale to zero; GPU billed per second; instance-based billing is mandatory, so idle-but-alive instances are billed for their whole lifecycle | `[UNVERIFIED]` |
| **Fireworks on-demand** | n/r | Per GPU-second; scales to zero after 1 h idle by default | `[UNVERIFIED]` |

For our stack `[ESTIMATE]`: a true cold start = image pull (10–20 GB) + loading STT + LLM (4B–32B, 8–65 GB of weights) + TTS + vLLM warm-up, i.e. **1–5 minutes** on a cold node unless snapshots or pre-pulled images on a warm volume are used. A voice product cannot serve a live call from a scale-to-zero pool; serverless is suitable for the burst tier only if it is pre-warmed.

### 4.2 Guidance for diurnal peaks

- AWS EKS inference guidance: do **not** autoscale on GPU utilisation (a vLLM server sits near 100 % across a wide load range). Use request **queue depth** as the primary trigger, p95 latency as a guard, KV-cache utilisation as backstop; example thresholds 25 waiting requests per pod or p95 > 5 s; 300 s scale-down stabilisation; node provisioning (Karpenter) plus model load is the slow step `[UNVERIFIED]`.
- KEDA cron scaler: define start/end cron windows and `desiredReplicas` to pre-scale before a predictable peak; scale-down happens after the default 5-minute cooldown `[UNVERIFIED]`.
- Modal: `min_containers` (always warm), `buffer_containers` (extra warm headroom while active), and `update_autoscaler(...)` called from a scheduled function to raise the warm pool before a known window `[UNVERIFIED]`.
- Baseten: `min_replica: 1` to avoid scale-from-zero latency, 2 for redundancy `[UNVERIFIED]`.

### 4.3 Demand shape for the cost model `[ESTIMATE]`

| DAU | Minutes / month | Average concurrent sessions | Peak-hour concurrent (10 % → 15 % of daily minutes in one hour) | Peak ÷ average |
|---|---|---|---|---|
| 200 | 180,000 | 4.2 | 10 → 15 | 2.4–3.6× |
| 1,000 | 900,000 | 20.8 | 50 → 75 | |
| 10,000 | 9,000,000 | 208 | 500 → 750 | |
| 100,000 | 90,000,000 | 2,083 | 5,000 → 7,500 | |

Add 20–30 % for within-hour burstiness. GPU cost per conversation-minute:

`$/min = P ÷ (60 × S × U)` where P = $/GPU-h, S = concurrent sessions one GPU sustains at the latency SLA (**the number the benchmark must produce**), U = share of paid GPU-hours actually serving.

Illustration at P = $1.09 (L40S), 9,000,000 min/month: S = 20, U = 0.40 → $0.0023/min → ~$20,400/month; S = 40, U = 0.60 → $0.00076/min → ~$6,800/month. S values are placeholders, not measurements.

Recommended production shape `[ESTIMATE]`: base pool sized to the daily average on dedicated/committed capacity (Hetzner GEX or reserved), plus a per-second burst pool pre-warmed by cron 15–20 minutes before each commute peak and drained on queue depth.

---

## 5. Non-GPU infrastructure unit prices

### 5.1 Compute, database, storage, egress, monitoring

| Item | Price | Tag |
|---|---|---|
| AWS m7i.large (2 vCPU, 8 GiB), us-east-1 | $0.1008/h → $0.0504 per vCPU-h bundled with 4 GiB | `[PUBLISHED-thirdparty]` |
| AWS m7i.xlarge (4 vCPU, 16 GiB) | $0.2016/h | `[PUBLISHED-thirdparty]` |
| GCP n2-standard-4 (4 vCPU, 16 GiB), us-central1 | $0.1942/h → $0.0486 per vCPU-h bundled | `[PUBLISHED-thirdparty]` |
| GCP e2-standard-4 | $0.134/h; unbundled **$0.0218/vCPU-h and $0.0029/GB-h**; 1-yr CUD ~$0.084, 3-yr ~$0.060 | `[PUBLISHED-thirdparty]` |
| Model inputs to use | $0.04/vCPU-h + $0.005/GB-RAM-h (N2/M7i class) or $0.022 + $0.003 (E2 class) | `[ESTIMATE]` |
| RDS PostgreSQL db.t4g.micro | ~$12/month (~$0.016/h) | `[PUBLISHED-thirdparty]` |
| RDS db.t4g.medium | ~$47/month (~$0.064/h; engine row ambiguous) | `[PUBLISHED-thirdparty]` |
| RDS db.m7g.large | ~$123/month (~$0.168/h; engine unconfirmed) | `[PUBLISHED-thirdparty]` |
| RDS billing | per-second, 10-minute minimum; gp3 storage price n/r | `[UNVERIFIED]` |
| Supabase Pro | $25/month incl. $10 compute credit (one Micro instance), 8 GB database, 250 GB egress | `[PUBLISHED-thirdparty]` |
| Cloud SQL per-vCPU rates | not retrieved | — |
| S3 Standard | $0.023/GB-month first 50 TB | `[PUBLISHED-thirdparty]` |
| GCS Standard | $0.020/GB-month | `[PUBLISHED-thirdparty]` |
| Cloudflare R2 | $0.015/GB-month; Class A $4.50/M, Class B $0.36/M; **egress $0**; 10 GB free | `[UNVERIFIED]` |
| Egress AWS | $0.09/GB to 10 TB; first 100 GB/month free | `[PUBLISHED-thirdparty]` |
| Egress GCP | Premium $0.12/GiB (1 GiB–1 TiB); Standard $0.085/GiB (200 GiB–10 TiB), first 200 GiB free | `[UNVERIFIED]` |
| Egress Cloudflare Realtime (SFU + TURN) | $0.05/GB after 1,000 GB/month free (pooled); ingress free; TURN free when used with the SFU | `[UNVERIFIED]` |
| Egress Hetzner | Cloud EU: 20 TB/month included, ~€1/TB overage (one source €1.19); dedicated: unmetered 1 Gbit reported | `[PUBLISHED-thirdparty]` |
| Twilio Network Traversal (TURN) | $0.40/GB US and Europe; $0.60 Asia; $0.80 Oceania | `[UNVERIFIED]` |
| LiveKit Cloud plans | Build $0; Ship $50/month; Scale $500/month | `[UNVERIFIED]` |
| LiveKit agent-session minutes | included 1,000 / 5,000 / 50,000; overage **$0.01/min** | `[UNVERIFIED]` |
| LiveKit WebRTC participant minutes | included 5,000 / 150,000 / 1.5 M; overage $0.0005 (Ship) / $0.0004 (Scale) per minute | `[PUBLISHED-thirdparty]` |
| LiveKit bandwidth | 50 GB / 250 GB / 3 TB included; overage $0.10–0.12/GB | `[PUBLISHED-thirdparty]` |
| Grafana Cloud | free tier; Pro $19/month platform fee plus usage (one source says per user) | `[PUBLISHED-thirdparty]` |
| Datadog Infrastructure Pro | $15/host/month annual, $18 on-demand; logs separate | `[PUBLISHED-thirdparty]` |

### 5.2 Bandwidth of a bidirectional Opus voice stream `[ESTIMATE]`

Assumptions: Opus 24–32 kbps per direction, 20 ms frames (50 packets/s), WebRTC transport. Per-packet overhead: IPv4 20 B + UDP 8 B + RTP 12 B + SRTP auth tag 10 B = 50 B → 20 kbps.

| Opus bitrate | On-wire per direction | MB / min per direction | **MB / min both directions** |
|---|---|---|---|
| 24 kbps | 44 kbps | 0.33 | **0.66** |
| 32 kbps | 52 kbps | 0.39 | **0.78** |

Add ~5–10 % for RTCP, RTP header extensions, ICE keep-alives and TURN framing; IPv6 adds 8 kbps per direction. Opus DTX during silence would reduce it. Over WebSocket/TLS/TCP instead of WebRTC, per-frame overhead is ~70–80 B, giving roughly 0.8–0.95 MB/min.

**Planning figure: 0.8 MB per conversation-minute total (0.4 MB server→client egress); use 1.0 MB/min for a WebSocket transport.**

| DAU | Minutes / month | Egress GB / month (0.4 MB/min) | AWS @ $0.09 | Cloudflare Realtime @ $0.05 after 1 TB | Hetzner |
|---|---|---|---|---|---|
| 200 | 180,000 | 72 | $0 (free tier) | $0 | $0 |
| 1,000 | 900,000 | 360 | $23 | $0 | $0 |
| 10,000 | 9,000,000 | 3,600 | $315 | $130 | $0 |
| 100,000 | 90,000,000 | 36,000 | ~$3,100 | $1,750 | ~€16 over 20 TB (cloud) or $0 (dedicated) |

Voice bandwidth is a rounding error next to GPU cost. Media-platform *per-minute* fees are not: at 10,000 DAU, LiveKit Cloud agent-session overage would be 9,000,000 × $0.01 ≈ **$90,000/month**, and participant minutes alone (2 participants per call at $0.0004) ≈ $7,200/month `[ESTIMATE]`. Twilio TURN at $0.40/GB is 8× Cloudflare's rate; if every call were relayed in both directions, 7,200 GB ≈ $2,880/month, though typically only a minority of sessions need TURN `[ESTIMATE]`. Self-hosted LiveKit OSS or coturn on a Hetzner box, or Cloudflare Realtime, is the cost-rational choice.

---

## 6. Recommendation for this POC

### 6.1 What to rent

**RunPod Secure Cloud, on-demand Pod, one NVIDIA L40S 48 GB at $1.09/h, in a European data centre (EU-RO-1 Romania preferred for Israel latency; otherwise EU-CZ-1 / EU-NL-1 / EU-SE-1 / EU-FR-1).** `[UNVERIFIED]` prices and regions.

Why it fits the requirements:

| Requirement | RunPod Secure Pod | Tag |
|---|---|---|
| Fast provisioning | Self-serve, container starts in about a minute, no quota request | `[UNVERIFIED]` (vendor claim) |
| Per-second billing | Compute and storage billed per second, no minimum | `[UNVERIFIED]` |
| Docker / SSH | Pods are Docker containers; SSH via exposed TCP port 22 | `[UNVERIFIED]` |
| 24–48 GB VRAM | L40S 48 GB (also A6000 48 GB at $0.69, RTX 5090 32 GB at $1.39, RTX 4090 24 GB at $0.89) | `[UNVERIFIED]` |
| Public TCP / HTTPS port | HTTP proxy URL `https://<POD_ID>-<PORT>.proxy.runpod.net` and "Direct TCP Ports" with a public IP | `[UNVERIFIED]` |
| Simple API-key auth | Not provided by the platform — the proxy URL is public and unauthenticated. Use vLLM `--api-key` and a bearer-token check in the WebSocket gateway | `[UNVERIFIED]` |
| Low minimum deposit | Prepaid credits; must hold at least one hour of the chosen configuration to deploy. Exact minimum top-up not confirmed (commonly cited as $10) | `[UNVERIFIED]` |
| Egress | No data-transfer fees | `[UNVERIFIED]` |

Why L40S: it is the datacenter 48 GB card most widely available for production (RunPod, Nebius, Scaleway, OVH, AWS g6e, CoreWeave, Hetzner-class alternatives), so benchmark numbers transfer to the cost model. With 48 GB it holds Whisper-class STT + a 4B–14B LLM + TTS on one card, or a 32B model in 4–8-bit quantisation.

**Important WebSocket caveat `[UNVERIFIED]`:** RunPod's HTTP proxy sits behind Cloudflare with a 100-second limit (524 error if no response; one RunPod guide describes it as applying to inactive connections) and RunPod's docs recommend TCP exposure for persistent connections. For the streaming endpoint, expose a **TCP port** and connect to `public-ip:external-port`. The external port differs from the internal port and changes when the Pod is reset. Terminate TLS yourself (Caddy/nginx with your own domain), or run `cloudflared` in the container for a `wss://` URL with a valid certificate.

### 6.2 Expected cost

| Line | Hours | Rate | Cost |
|---|---|---|---|
| L40S 48 GB, Secure, main benchmarking | 40 | $1.09 | $43.60 |
| Volume disk 150 GB + container disk 50 GB for ~1 week ($0.10/GB/month running) | — | — | ~$5 |
| **Core total** | | | **~$50** |
| Optional: RTX 5090 32 GB comparison | 10 | $1.39 | $13.90 |
| Optional: H100 PCIe for the 32B model | 10 | $2.89 | $28.90 |
| Optional: RTX A6000 48 GB low-cost reference | 10 | $0.69 | $6.90 |
| **Total with all comparisons** | 70 | | **~$100** |
| Contingency ×2 (idle time, debugging, re-downloads) | | | **$100–200 all-in** |

All `[ESTIMATE]` built on `[UNVERIFIED]` rates. This is well under the $300–700 budget; the remaining budget could fund a one-month Hetzner GEX45 (€214 + €209 setup) to measure the cheapest always-on option, or a Modal / RunPod Serverless cold-start experiment. Main cost risk: a forgotten running Pod costs ~$26/day on an L40S, and a *stopped* Pod still bills its volume at $0.20/GB/month.

### 6.3 Fallbacks

| Option | When to use | Rate | Tag |
|---|---|---|---|
| Hyperstack RTX A6000 / L40 VM | Want a full VM with public IP and normal ports | $0.50 / $1.00 | `[UNVERIFIED]` |
| Vast.ai RTX 5090 or L40S | Cheapest; accept host variability and bandwidth charges | median $0.63 / $0.80; $5 minimum deposit | `[PUBLISHED-thirdparty]` / `[UNVERIFIED]` |
| RunPod Community Cloud | Same workflow, half the price, less reliable hosts | L40S $0.79, A6000 $0.33, 5090 $0.69 | `[UNVERIFIED]` |
| Modal L40S | To measure serverless cold starts specifically | $1.95 + CPU/RAM | `[UNVERIFIED]` |
| Scaleway L40S (Paris) | EU-invoiced, per-minute | €1.47 | `[UNVERIFIED]` |

### 6.4 Account setup — step by step (RunPod)

Console labels are from memory of the RunPod UI and were not re-checked this session `[UNVERIFIED]`; names may differ slightly.

1. Go to `https://www.runpod.io` → **Sign up** (email, Google or GitHub). Verify the email address.
2. **Billing** → **Add credits** → pay by card. Load **$50** to start (covers the core plan); top up to $100 only if you run the comparison GPUs. Leave **auto-pay / auto-recharge off** so spend is capped by the balance. If a spend-limit setting is offered, set it.
3. On your own machine create an SSH key if you have none: `ssh-keygen -t ed25519`. In RunPod **Settings** → **SSH Public Keys**, paste the contents of `~/.ssh/id_ed25519.pub`.
4. **Settings** → **API Keys** → **Create API Key**, name it `rolly-poc`, scope read/write. Copy it once into a password manager; it is only needed for `runpodctl` or scripted start/stop. This is the *platform* key, not the key that protects your endpoint.
5. Generate a separate random secret for your own endpoint (`openssl rand -hex 32`); this becomes vLLM's `--api-key` and the gateway bearer token.
6. **Pods** → **Deploy**. Choose **Secure Cloud**, filter region to **Europe** (EU-RO-1 if available), select **L40S (48 GB)**, **On-Demand** (not Spot/Interruptible).
7. Template: a recent **RunPod PyTorch / CUDA** image, or your own Docker image. Click **Edit template** and set:
   - Container disk 50 GB; **Volume disk 150 GB mounted at `/workspace`** (model weights survive restarts).
   - **Expose HTTP ports:** `8888` (optional Jupyter).
   - **Expose TCP ports:** `22, 8000, 8443` (SSH, vLLM, WebSocket gateway).
   - Environment variables: `HF_TOKEN`, `POC_API_KEY` (the secret from step 5).
8. **Deploy**. When the Pod is running open **Connect** and note the public IP and external ports under **Direct TCP Ports**. SSH in with `ssh root@<ip> -p <external-port-for-22>`.
9. Start services bound to `0.0.0.0`, for example `vllm serve <model> --port 8000 --api-key $POC_API_KEY`. Test from your laptop against `http://<ip>:<external-port-for-8000>/v1/models` with the bearer header.
10. When finished for the day: **Stop** (keeps the volume, bills $0.20/GB/month). When the POC is over: **Terminate** the Pod and delete any network volume so billing ends. Check **Billing** shows no further accrual.

---

## 7. Things that were surprising

1. Not one pricing page could be opened from this session (proxy 403); the whole report rests on search excerpts.
2. GPU rental prices rose through 2026 (H100 median +24 % YoY; provider-specific hikes of 15–50 %).
3. An RTX 5090 costs ~$6,200–6,600 at retail, about 3× MSRP, so owning one (~$0.74–0.81/GPU-h all-in) is now dearer than renting one ($0.63–0.69).
4. Hetzner replaced the GEX44/GEX130 line; setup fees now equal a month's rent, and the GEX131 rose from €889 to €1,499/month.
5. RunPod's HTTP proxy is public, unauthenticated and limited to 100 s; a WebSocket endpoint should use a direct TCP port.
6. Google's Tel Aviv region offers only T4 and A100 (both limited); Nebius has an Israeli data centre with Blackwell GPUs.
7. LiveKit Cloud's $0.01 per agent-session minute would cost ~$90k/month at 10,000 DAU; Twilio TURN is 8× Cloudflare's per-GB rate.
8. Several providers' own pages disagree with each other (RunPod, Together, Nebius, Lambda, Vultr), so any single figure needs a live check.

---

## 8. Not retrieved / open items

- Live confirmation of every price (see section 0).
- AWS il-central-1, Azure Israel Central and Oracle Jerusalem GPU availability and regional uplift.
- Oracle official per-GPU rates; AWS P5/P4d current on-demand (trackers disagree by 2×).
- RunPod minimum top-up amount, savings-plan / committed rates.
- GPU count in OVH Scale-GPU-1 and HGR-AI-2; Latitude.sh and Vultr monthly bare-metal list prices.
- Cloud SQL per-vCPU pricing; RDS gp3 storage price; colocation per-U pricing.
- Baseten published cold-start durations (none exist in the docs excerpts).
- Actual EUR/USD rate on 2026-11-24.

---

## 9. Sources

All accessed 2026-11-24 **through search-index excerpts only; none of these pages was fetched directly.**

Specialised GPU clouds
- RunPod pricing — https://www.runpod.io/pricing
- RunPod RTX 4090 / RTX 5090 pages — https://www.runpod.io/gpu-models/rtx-4090 , https://www.runpod.io/gpu-models/rtx-5090
- RunPod Serverless product page — https://www.runpod.io/product/serverless
- RunPod docs: serverless pricing — https://docs.runpod.io/serverless/pricing ; pods pricing — https://docs.runpod.io/pods/pricing ; billing — https://docs.runpod.io/accounts-billing/billing ; expose ports — https://docs.runpod.io/pods/configuration/expose-ports ; list data centers — https://docs.runpod.io/api-reference-v2/catalog/list-data-centers
- RunPod blog: proxy guide — https://www.runpod.io/blog/runpod-proxy-guide ; serverless benchmarks — https://www.runpod.io/blog/serverless-gpu-inference ; scaling — https://www.runpod.io/blog/serverless-scaling-strategy-runpod ; global networking — https://www.runpod.io/blog/runpod-global-networking-expansion
- Lambda pricing — https://lambda.ai/pricing ; https://lambda.ai/service/gpu-cloud ; Lambda Scalar configurator — https://shop.lambdalabs.com/deep-learning/servers/blade/customize
- Modal pricing — https://modal.com/pricing ; cold start — https://modal.com/docs/guide/cold-start ; scaling — https://modal.com/docs/guide/scale ; GPU snapshot blog — https://modal.com/blog/mistral-3
- CoreWeave pricing — https://www.coreweave.com/pricing ; https://www.coreweave.com/products/hgx-h100-h200
- Vast.ai pricing — https://vast.ai/pricing ; billing docs — https://docs.vast.ai/guides/reference/billing ; pricing docs — https://docs.vast.ai/documentation/instances/pricing
- Crusoe pricing — https://www.crusoe.ai/cloud/pricing ; FAQ — https://support.crusoecloud.com/hc/en-us/articles/37421109850907-FAQ-Determining-On-Demand-Pricing-for-Crusoe-Offerings
- Nebius — https://nebius.com/prices ; https://docs.nebius.com/compute/resources/pricing ; Israel announcement — https://nebius.com/newsroom/nebius-brings-nvidia-blackwell-to-israel-with-one-of-the-country-s-first-ai-infrastructure-deployments
- Hyperstack — https://www.hyperstack.cloud/gpu-pricing ; pricebook — https://docs.hyperstack.cloud/docs/billing/pricebook
- TensorDock — https://marketplace.tensordock.com/cloud-gpus.html ; https://apis.io/plans/tensordock/tensordock-plans-pricing/
- Baseten — https://www.baseten.co/pricing/ ; https://docs.baseten.co/deployment/resources ; autoscaling — https://docs.baseten.co/deployment/autoscaling/overview ; cold starts — https://docs.baseten.co/deployment/autoscaling/cold-starts
- Together AI — https://www.together.ai/pricing ; https://docs.together.ai/docs/dedicated-endpoints/pricing
- Fireworks — https://fireworks.ai/pricing ; https://docs.fireworks.ai/guides/ondemand-deployments
- DigitalOcean — https://www.digitalocean.com/pricing/gpu-droplets ; Paperspace — https://docs.digitalocean.com/products/paperspace/pricing/ , https://www.paperspace.com/pricing
- Scaleway — https://www.scaleway.com/en/pricing/gpu/ ; price update — https://www.scaleway.com/en/blog/a-transparent-update-on-scaleway-pricing/
- OVHcloud — https://us.ovhcloud.com/public-cloud/prices/ ; https://www.ovhcloud.com/asia/public-cloud/prices/ ; GPU dedicated — https://www.ovhcloud.com/en/bare-metal/gpu-dedicated-server/ ; AI servers — https://www.ovhcloud.com/en/bare-metal/ai-server/
- Vultr — https://www.vultr.com/pricing/ ; https://docs.vultr.com/products/compute/bare-metal/explore-gpu-variants
- Latitude.sh (via tracker) — https://www.gpuperhour.com/providers/latitudesh

Hyperscalers
- Google Cloud — https://cloud.google.com/products/compute/gpus-pricing ; https://cloud.google.com/products/compute/pricing/accelerator-optimized ; GPU locations — https://docs.cloud.google.com/compute/docs/regions-zones/gpu-regions-zones ; Cloud Run pricing — https://cloud.google.com/run/pricing ; Cloud Run GPU — https://docs.cloud.google.com/run/docs/configuring/services/gpu ; network tiers — https://cloud.google.com/network-tiers/pricing
- AWS (trackers) — https://www.thundercompute.com/blog/ec2-gpu-instances ; https://calculator.holori.com/aws/ec2/g6e.xlarge/us-east-1 ; https://compute.doit.com/spot/us-east-1/g6e.xlarge ; https://www.opslyft.com/blog/aws-gpu-pricing ; https://www.doit.com/compute/spot/us-east-1/m7i.xlarge ; region launch — https://aws.amazon.com/blogs/aws/now-open-aws-israel-tel-aviv-region/ ; EKS autoscaling — https://docs.aws.amazon.com/eks/latest/userguide/ml-inference-autoscaling-hpa-keda.html ; RDS — https://aws.amazon.com/rds/postgresql/pricing/ , https://www.bytebase.com/dbcost/rds/instance/db.t4g.micro/
- Azure (trackers) — https://www.thundercompute.com/blog/azure-gpu-instances ; https://cloudprice.net/vm/Standard_NC4as_T4_v3 ; https://cloudprice.net/vm/Standard_NV36ads_A10_v5
- Oracle — https://www.oracle.com/cloud/price-list/ ; https://computeprices.com/providers/oracle

Dedicated and hardware
- Hetzner — https://www.hetzner.com/dedicated-rootserver/matrix-gpu/ ; GEX430 press release — https://www.hetzner.com/pressroom/hetzner-introduces-its-first-multi-gpu-server-with-four-nvidia-blackwell-gpus/ ; GEX63 — https://www.hetzner.com/pressroom/hetzner-expands-gpu-portfolio-with-new-gex63-featuring-nvidia-rtx-pro-6000-blackwell-max-q/ ; GEX131 — https://www.hetzner.com/pressroom/new-gex131/ ; comparison — https://wz-it.com/en/blog/hetzner-gpu-server-comparison/ ; cancellation — https://docs.hetzner.com/general/billing-and-account-management/cancellation/30-days-to-the-end-of-the-month
- RTX 5090 street price — https://www.tomshardware.com/pc-components/gpus/lowest-gpu-prices-tracking ; https://www.techspot.com/article/3192-gpu-pricing-q4-2026/ ; https://cpubld.com/rtx-5090-price/
- H100 / A100 purchase — https://aliteq.com/h100-price ; https://aliteq.com/a100-price ; https://www.cloudzero.com/blog/h100-gpu-cost/ ; https://compute.exchange/blogs/h100-gpu-price-2026
- L4 / L40S purchase — https://gpudojo.com/l4 ; https://www.newegg.com/p/1WK-0025-037U0 ; https://fluence.ai/blog/nvidia-l40s/ ; https://pcserverandparts.com/news/used-gpu-server-buying-guide-2026-l40s-vs-a100-vs-rtx-4090/
- Servers — https://www.newegg.com/p/N82E16859152404 ; https://empoweredpc.com/products/custom-msi-g4101-04-4u-rack-server
- Colocation — https://www.aitooldiscovery.com/ai-infra/colocation-data-center-explained ; https://armason.co.uk/data-center-colocation-pricing-in-2026-what-the-market-publishes-and-what-operators-are-actually-asking/ ; https://cologpu.com/blog/colocation-pricing-2026 ; https://aliteq.com/ai-server-colocation-cost-2026
- Power — https://www.pny.com/company/support/nvidia-data-center-gpus ; https://www.supermicro.com/de-de/accelerators/nvidia-certified-systems

Market trend
- https://www.silicondata.com/blog/h100-price-spike ; https://newsletter.semianalysis.com/p/the-great-gpu-shortage-rental-capacity ; https://getdeploying.com/gpu-price-trends ; https://www.economize.cloud/blog/why-are-gpu-prices-rising/ ; Vast medians — https://markaicode.com/pricing/vast-ai-pricing/ ; 5090 rental median — https://getdeploying.com/gpus/nvidia-rtx-5090

Non-GPU
- Cloudflare Realtime — https://developers.cloudflare.com/realtime/sfu/pricing/ ; https://developers.cloudflare.com/realtime/turn/ ; R2 — https://developers.cloudflare.com/r2/pricing/
- Twilio (TURN rates on voice pricing pages) — https://www.twilio.com/en-us/voice/pricing/us
- LiveKit — https://livekit.io/pricing ; https://docs.livekit.io/home/cloud/pricing/ ; https://docs.livekit.io/deploy/admin/billing.md ; https://usagepricing.com/blueprint/livekit
- Hetzner traffic — https://docs.hetzner.com/cloud/billing/faq/ ; https://wz-it.com/en/blog/public-internet-egress-costs-comparison-aws-azure-gcp-hetzner/
- GCP compute (trackers) — https://www.devzero.io/blog/google-cloud-server-cost ; https://cloud.cloudquell.com/gcp/compute/
- S3 — https://aws.amazon.com/s3/pricing/ ; https://upstash.com/blog/aws-s3-pricing-explained-2026
- Supabase — https://supabase.com/pricing
- Monitoring — https://grafana.com/compare/grafana-vs-datadog ; https://tech-insider.org/datadog-pricing-vs-new-relic-grafana-dynatrace-elastic-2026/
- KEDA cron — https://keda.sh/docs/scalers/cron/
- Opus RTP payload — https://www.rfc-editor.org/rfc/rfc7587
