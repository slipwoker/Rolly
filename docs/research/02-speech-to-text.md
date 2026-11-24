# 02 — Speech-to-Text, VAD and Turn Detection

Research date: **2026-11-24**. Scope: ASR + voice-activity / turn detection for a modular real-time voice pipeline (Hebrew + English, code-switching, in-car noise, barge-in, thousands of concurrent users, target ≤ $0.005 per conversational minute all-in).

## 0. How to read this document

### Evidence tags

| Tag | Meaning |
|---|---|
| **[VERIFIED-official]** | Read today, directly, on the owner's own page (model card, LICENSE file, pricing page, docs, vendor API). It certifies *"the owner publishes this"*; self-reported accuracy/throughput numbers are still the owner's claim, not an independent measurement. |
| **[PUBLISHED-thirdparty]** | Published by someone other than the product's owner (e.g. ivrit.ai's leaderboard scoring Deepgram, a cloud provider benchmarking Whisper, a vendor quoting a competitor's price). Read directly unless noted "via search snippet". |
| **[ESTIMATE]** | My own arithmetic or engineering judgement. Inputs are stated. |
| **[UNVERIFIED]** | Could not be confirmed from a primary source today. |

Nothing in this document was measured by us. Every latency / throughput / WER number is **published-not-measured**.

### Retrieval notes

- Hugging Face model cards, raw LICENSE/README files, the ivrit.ai leaderboard data files, PyPI metadata and vendor pricing/docs pages were fetched directly over HTTPS and read as text.
- Pages that render prices with JavaScript returned placeholders: **Azure pricing page** (prices taken from the official Azure Retail Prices API instead), **AWS Transcribe pricing**, **OpenAI language lists**, **Groq marketing pricing page** (prices taken from Groq console docs instead).
- `github.com` HTML and `api.github.com` were blocked by the session proxy (403); `raw.githubusercontent.com` worked, so licenses were read from raw files. `gigagpu.com` returned 403.
- Gated Hugging Face repos (ivrit.ai datasets, `Hebrish/*` models) returned 401; only their public metadata was read.

---

## 1. Executive summary

1. **Best open Hebrew accuracy is still ivrit.ai's Whisper fine-tunes, and they are Apache-2.0** — the custom "ivrit.ai license" applies to the *datasets*, and it explicitly permits training commercial AI models. `ivrit-ai/whisper-large-v3-turbo-ct2`: 5.3% WER on eval-d1, 7.1% on eval-whatsapp (ivrit.ai leaderboard). [VERIFIED-official]
2. **Whisper is not a streaming model**, but ivrit.ai publishes per-utterance latency for exactly this model on cloud GPUs: p50 **231 ms on L40S, 325 ms on A10, 405 ms on L4** for 0–5 s utterances. So "VAD-endpointed chunk → one decode" meets the < 300 ms goal on L40S-class GPUs, is borderline on A10 and misses on L4. [VERIFIED-official, published-not-measured]
3. **True streaming Hebrew models appeared in October 2026.** `ivrit-ai/zipformer2-66m-streaming-he` (66 M params, CC-BY-4.0, runs on CPU and in the browser) reports 5.1 / 8.9 WER — on par with the Whisper turbo fine-tune on podcasts — but its card says *"English is weak (spelled letter by letter)"*. `MaorB/embeddinggemma-2-asr-hebrew-english-streaming` (351 M, Apache-2.0) is the only open *Hebrew + English* streaming model found; self-reported 6.5 / 11.7 WER streaming, ~256 streams on one RTX 5090. Both are weeks old and single-author. [VERIFIED-official, self-reported]
4. **No open model verifiably handles Hebrew↔English code-switching.** The ivrit.ai Whisper card says language detection was degraded and it is "intended for mostly-hebrew audio". Code-switching quality is the single biggest unknown for the POC and must be measured on our own audio. [VERIFIED-official for the limitation; behaviour UNVERIFIED]
5. **NVIDIA Parakeet v3 / Canary v2 do not support Hebrew** (25 European languages). NVIDIA's newer streaming model, Nemotron 3.5 ASR, lists Hebrew only as "adaptation-ready (requires fine-tuning)" and scores 17.1 / 36.5 WER out of the box on the ivrit.ai leaderboard. Community Hebrew fine-tunes of Parakeet exist (6.1 / 8.8). [VERIFIED-official / PUBLISHED-thirdparty]
6. **Commercial fallback: Soniox `stt-rt-v6` at $0.12/hour ($0.002/min)** — Hebrew, mid-sentence code-switching, semantic endpointing, and the best API score on the ivrit.ai leaderboard (4.8 / 9.0). It is 2.4× cheaper than Deepgram Nova-3 Hebrew ($0.0048/min) and 8× cheaper than Azure/Google/OpenAI live transcription. [VERIFIED-official for price/features; PUBLISHED-thirdparty for WER]
7. **Turn detection has a Hebrew gap.** Neither LiveKit's turn detector (14 languages; licence restricts use to LiveKit Agents) nor Pipecat Smart Turn v3.2 (23 languages, BSD-2) lists Hebrew. Silero VAD (MIT, v6.3 released 2026-11-23) is language-agnostic and safe. [VERIFIED-official]
8. **The OpenAI transcription line-up changed**: `whisper-1`, `gpt-4o-transcribe` and `gpt-4o-mini-transcribe` are deprecated and shut down on 2027-02-26; the live replacement `gpt-live-transcribe` costs $0.017/min — 3.4× our entire per-minute budget. [VERIFIED-official]

---

## 2. Comparison table — open-weight / self-hostable ASR

WER columns are from the ivrit.ai Hebrew leaderboard unless marked otherwise: **d1** = `ivrit-ai/eval-d1` (podcast conversation), **wa** = `ivrit-ai/eval-whatsapp` (voice notes). Lower is better.

| Model (exact ID) | Hebrew | Streaming | License → commercial OK? | Size | Published Hebrew WER (d1 / wa) | Self-host footprint (published) |
|---|---|---|---|---|---|---|
| `ivrit-ai/whisper-large-v3-turbo-ct2` | Yes (Hebrew-only fine-tune) | No (30 s window; chunk on VAD endpoint) | Apache-2.0 → **yes** | 809 M params; `model.bin` 1.62 GB | **5.3 / 7.1** (2025-05-13 build) | 0–5 s utterance p50: 231 ms L40S, 325 ms A10, 405 ms L4 |
| `ivrit-ai/whisper-large-v3-ct2` | Yes | No | Apache-2.0 → **yes** | 1.55 B params | **5.1 / 7.2** | ~2× slower than turbo (Runpod: 15.5× vs 31.5× RTFx on L4 for the base models) |
| `ivrit-ai/zipformer2-66m-streaming-he` (mirror of `thewh1teagle/…`) | Yes (English weak) | **Yes**, 1.28 s chunks | CC-BY-4.0 → **yes, with attribution** | 66 M; int8 encoder 70 MB | 5.1 / 8.9 on card (fp32); leaderboard row 5.3 / 8.8 (int8) | CPU / WASM / on-device; no GPU figures published |
| `MaorB/embeddinggemma-2-asr-hebrew-english-streaming` | **Yes + English** | **Yes**, 0.24 s steps | Apache-2.0 → **yes** | 351 M | Batch 5.8 / 10.3; streaming 6.5 / 11.7 (self-reported) | ~256 streams (fast) or 40–60 (accurate) on one RTX 5090 |
| `thewh1teagle/parakeet-tdt-0.6b-v3-he` | Yes (Hebrew only; English → Hebrew letters) | Offline TDT (not cache-aware streaming) | CC-BY-4.0 → **yes, with attribution** | 0.6 B | 6.1 / 8.8 (self-reported, leaderboard normalisation) | Not published |
| `dm15/parakeet-tdt-0.6b-hebrew` (v4) | Yes | Card claims streaming-capable | CC-BY-4.0 → yes | 617 M | 7.9 / 11.4 (self-reported) | Not published |
| `openai/whisper-large-v3-turbo` | Yes (99 languages) | No | MIT → **yes** | 809 M | 8.4 / 12.8 | L4: 31.5–41× RTFx, 1.1–2.3 GB VRAM |
| `openai/whisper-large-v3` | Yes | No | Apache-2.0 on HF card, MIT in GitHub LICENSE → **yes** | 1.55 B | 9.8 / 13.2 | L4: 15.5× RTFx; 3.3–4.4 GB fp16 |
| `distil-whisper/distil-large-v3.5` | **No** (English only) | No | MIT | 756 M | — | ~1.5× faster than turbo |
| `nvidia/nemotron-3.5-asr-streaming-0.6b` | "Adaptation-ready" — needs fine-tuning | **Yes**, cache-aware, 80–1120 ms chunks | OpenMDW-1.1 → **yes** | 600 M | 17.1 / 36.5 out of the box | One H100: 240 streams @ 80 ms, 2,400 @ 1120 ms |
| `nvidia/parakeet-tdt-0.6b-v3` | **No** (25 European languages) | Offline | CC-BY-4.0 | 0.6 B | — | — |
| `nvidia/canary-1b-v2` | **No** (25 European languages) | Offline | CC-BY-4.0 | 1 B | — | — |
| `nvidia/nemotron-labs-unified-asr-0.6b` | **No** (25 European languages) | Yes (≥ 160 ms) | OpenMDW-1.1 | 0.6 B | — | — |
| `nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B` | Yes | **No** ("This is an offline model") | OpenMDW-1.1 | 30 B | 20.97 (card's own Hebrew row; benchmark name not captured) | Far too large for this use |
| `kyutai/stt-1b-en_fr`, `kyutai/stt-2.6b-en` | **No** (EN/FR, EN) | Yes (0.5 s / 2.5 s delay) | CC-BY-4.0 | 1 B / 2.6 B | — | H100: 400 real-time streams; L40S: 64 connections at 3× RTF |
| Moonshine (`moonshine-voice` 0.1.6) | **No** (EN, ES, DE, ZH, JA, KO, VI, TL, UK, AR) | Yes | MIT (streaming models) | 1 MB – large | — | On-device |
| `FunAudioLLM/SenseVoiceSmall` | **No** (zh, en, ja, ko, yue) | No | FunASR Model License (custom) | ~Whisper-small | — | 70 ms per 10 s audio |
| `FunAudioLLM/Fun-ASR-MLT-Nano-2512` | **No** (31 languages, Hebrew not listed) | — | Apache-2.0 | 800 M | — | — |
| `facebook/omniASR-*` (Omnilingual ASR) | Yes (`heb_Hebr` in language list) | **No** | Apache-2.0 → yes | 300 M – 7 B | Not published on card | CTC-300M: ~2 GB VRAM, 96× RTFx; LLM variants ~1× real time |
| `facebook/mms-1b-all` | Yes | No | **CC-BY-NC-4.0 → no** | 1 B | — | — |
| `Qwen/Qwen3-ASR-1.7B`, `-0.6B` | **No** (30 languages + Chinese dialects; Hebrew absent) | Yes (vLLM backend) | Apache-2.0 | 1.7 B / 0.6 B | — | 0.6B: "2000× throughput at concurrency 128" |
| `flowty1/qwen-asr-0.6b-he` (community fine-tune) | Yes + English | Yes (claimed) | Apache-2.0 | 0.6 B | None published | Not published |
| `mistralai/Voxtral-Mini-4B-Realtime-2602` | **No** (13 languages) | **Yes**, 480 ms recommended delay | Apache-2.0 | 4 B | — | ≥ 16 GB GPU |
| `mistralai/Voxtral-Mini-3B-2507` | **No** (8 languages) | No | Apache-2.0 | 3 B | — | — |
| `ibm-granite/granite-speech-5.0-2b` | **No** (EN, FR, DE, ES, PT, JA) | No | Apache-2.0 | 2 B | — | — |
| `microsoft/Phi-4-multimodal-instruct` | **No** for audio (8 audio languages; Hebrew is text-only) | No | MIT | 5.6 B | — | — |
| `microsoft/VibeVoice-ASR` | Yes (50+ languages, "natively handles code-switching") | **No** (60-minute single-pass, offline) | MIT | Not captured | Not published | Not suitable for real time |
| `microsoft/VibeVoice-ASR-Streaming-1.5B` / `-7B` | **No** (10 languages) | Yes | MIT | 1.5 B / 7 B | — | — |
| `CohereLabs/cohere-transcribe-03-2026` | **No** (14 languages) | — | Apache-2.0 (gated) | — | — | — |
| `Hebrish/Sabich-Rolling`, `Hebrish/Shakshuka` etc. | English speech with Hebrew words (code-switching) | Some streaming | **CC-BY-NC-4.0, gated; commercial licence required** | 0.6 B | Not readable (gated) | — |

All rows: [VERIFIED-official] for language list, licence and size (read on the model card / LICENSE today), except WER figures for models not owned by ivrit.ai, which are [PUBLISHED-thirdparty] (ivrit.ai leaderboard) or self-reported as marked.

## 3. Comparison table — commercial streaming STT APIs

Prices are public pay-as-you-go list prices read today. $/min = $/hour ÷ 60.

| Provider / model | Hebrew | Streaming | Hebrew↔English code-switching | List price | ≈ $/audio min | Hebrew WER (ivrit.ai leaderboard, d1 / wa) |
|---|---|---|---|---|---|---|
| **Soniox `stt-rt-v6`** | Yes | Yes | Yes — "detects and transcribes language switches mid-sentence" | $0.12/hr real-time ($0.10/hr async) | **$0.0020** | **4.8 / 9.0** (run dated 2026-05-03) |
| **Deepgram Nova-3** (`language=he`) | Yes (added 2026-02-12) | Yes | Not in mono mode | $0.0048/min (promo; "was $0.0077"); Growth $0.0042 | $0.0048 | 6.7 / 12.0 (run dated 2026-05-03) |
| Deepgram Nova-3 Multilingual (`language=multi`) | Yes — Hebrew is in the 55-language multilingual list | Yes | Yes (multilingual code-switching, `language_hint`) | $0.0058/min (promo; "was $0.0092"); Growth $0.0050 | $0.0058 | Not on leaderboard |
| Deepgram Flux STT Multilingual | **No** (en, es, fr, de, hi, ru, pt, ja, it, nl) | Yes, model-native turn detection | — | $0.0078/min | $0.0078 | — |
| **ElevenLabs Scribe v3 Live** | Yes (90+ languages, `heb` listed for Scribe) | Yes | "Multilingual mode for mid-sentence language switches" | $0.22/hr | $0.0037 | Not on leaderboard (Scribe v1 batch: 20.0 / 26.4) |
| ElevenLabs Scribe v2 Realtime | Yes | Yes (~150 ms) | — | $0.22/hr | $0.0037 | — |
| AssemblyAI `AssemblyAI-STT-3.7-Realtime` | Yes (32 languages incl. `he`) | Yes | "All streaming models code-switch across 32 languages" | $0.30/hr | $0.0050 | Not on leaderboard |
| AssemblyAI `…-Realtime-Agent` | Yes | Yes, turn detection | Yes | $0.45/hr | $0.0075 | — |
| Speechmatics Melia 1 (real-time) | Yes (`he`) | Yes | "55+ languages … switches language mid-sentence" | $0.20/hr | $0.0033 | Not on leaderboard |
| Speechmatics Linden 1 (agent STT) | Same languages as real-time | Yes, built-in turn detection | — | $0.15/hr | $0.0025 | — |
| Speechmatics Enhanced (real-time) | Yes | Yes | No Hebrew bilingual pack listed | $0.40/hr | $0.0067 | — |
| Google Speech-to-Text V2 / Chirp 3 | Hebrew (`iw-IL`) is **Preview** | Yes (`StreamingRecognize`) | Not documented for Hebrew | $0.016/min (first 500k min/month), down to $0.004 above 2 M min | $0.0160 | 21.1 / 35.2 for "google-speech" (older model, date unknown) |
| Azure Speech real-time | Yes (`he-IL`, real-time ✅) | Yes | Not verified for Hebrew | $1.00/hr (S1, eastus) | $0.0167 | Not on leaderboard |
| OpenAI `gpt-live-transcribe` | **[UNVERIFIED]** — language list did not render | Yes | Accepts multiple `languages` hints | $0.017/min | $0.0170 | Not on leaderboard |
| OpenAI `gpt-transcribe` | [UNVERIFIED] | File + realtime sessions | — | $0.0045/min | $0.0045 | — |
| OpenAI `gpt-4o-transcribe` / `-mini-` | Yes (leaderboard tested) | — | — | **Deprecated; shutdown 2027-02-26** | — | 7.3 / 12.6 and 9.0 / 15.8 |
| Gladia real-time (Solaria-1) | Yes (Solaria-1 only; Solaria-3 no) | Yes | "For conversations mixing languages, use Solaria-1" | €0.68/hr | €0.0113 | Not on leaderboard |
| Groq `whisper-large-v3-turbo` | Yes (stock Whisper) | **No** — HTTP file API | Whisper behaviour | $0.04/hr | $0.00067 | Same model self-hosted: 8.4 / 12.8 |
| Groq `whisper-large-v3` | Yes | No | — | $0.111/hr | $0.00185 | 9.8 / 13.2 |
| Amazon Transcribe streaming | Yes (leaderboard tested) | Yes | — | [UNVERIFIED] — price table did not render | — | 7.9 / 12.9 (stream), 6.6 / 10.4 (batch) |

Price, language and feature cells: [VERIFIED-official] unless marked. WER column: [PUBLISHED-thirdparty] (ivrit.ai).

---

## 4. The ivrit.ai Hebrew ASR leaderboard

Source: `benchmark.csv` and `timing.csv` in the Space `ivrit-ai/hebrew-transcription-leaderboard` (Space last modified 2026-10-14). Evaluation uses `jiwer` WER with ivrit.ai's text normalisation. [VERIFIED-official for ivrit.ai's own models; PUBLISHED-thirdparty for everyone else]

### 4.1 Accuracy (WER, fraction → %)

| Engine | Model | eval-d1 | eval-whatsapp | SASpeech | FLEURS he | Kan |
|---|---|---|---|---|---|---|
| Soniox | stt | 4.8 | 9.0 | 6.5 | 17.7 | 11.4 |
| faster-whisper | ivrit-ai/whisper-large-v3-ct2-20250513 | 5.1 | 7.2 | 6.4 | 17.4 | 8.1 |
| faster-whisper | **ivrit-ai/whisper-large-v3-turbo-ct2-20250513** | **5.3** | **7.1** | 6.6 | 18.1 | 8.2 |
| sherpa-onnx | thewh1teagle/zipformer2-66m-streaming-he | 5.3 | 8.8 | 6.4 | 23.4 | 11.8 |
| faster-whisper | ivrit-ai/whisper-large-v3-turbo-ct2-20250403 | 5.5 | 6.1 | 7.4 | 20.8 | 10.0 |
| faster-whisper | ivrit-ai/whisper-large-v3-ct2-20250403 | 5.5 | 7.5 | 7.1 | 20.0 | 9.5 |
| faster-whisper | ivrit-ai/faster-whisper-v2-d4 | 6.1 | 9.8 | 8.0 | 24.1 | 11.3 |
| amazon-transcribe | batch | 6.6 | 10.4 | 8.5 | 23.0 | 9.0 |
| deepgram | nova-3 | 6.7 | 12.0 | 10.2 | 23.3 | 21.0 |
| openai | gpt-4o-transcribe | 7.3 | 12.6 | 10.9 | 21.0 | 39.4 |
| faster-whisper | large-v2 | 7.7 | 12.1 | 9.8 | 26.6 | 16.4 |
| amazon-transcribe | stream | 7.9 | 12.9 | 9.0 | 28.7 | 13.1 |
| faster-whisper | large-v3-turbo (stock OpenAI) | 8.4 | 12.8 | 10.4 | 28.9 | 15.6 |
| openai | gpt-4o-mini-transcribe | 9.0 | 15.8 | 15.0 | 30.0 | 46.8 |
| faster-whisper | large-v3 (stock OpenAI) | 9.8 | 13.2 | 9.4 | 26.2 | 13.4 |
| nemotron | nemotron-3.5-asr-streaming-0.6b | 17.1 | 36.5 | 24.2 | 46.0 | 54.2 |
| elevenlabs | scribe_v1 | 20.0 | 26.4 | 6.8 | 18.1 | 10.9 |
| google-speech | google-speech | 21.1 | 35.2 | 18.9 | 38.5 | 29.2 |

Reading notes:

- The Hebrew fine-tune cuts stock Whisper turbo error by roughly 37% on podcasts (8.4 → 5.3) and 45% on voice notes (12.8 → 7.1). [ESTIMATE from the table]
- `eval-whatsapp` (phone voice notes recorded by volunteers) is the closest published proxy for a commuter speaking into a phone. None of the test sets is in-car, noisy, or code-switched. [VERIFIED-official for dataset descriptions]
- Soniox and Deepgram result folders are dated 2026-05-03, so the Soniox row predates `stt-rt-v6` (pricing page says "Updated June 2026"); ElevenLabs was tested on Scribe **v1** only, and the Google row is an unspecified older model. Treat those rows as stale. [ESTIMATE from folder names]
- FLEURS Hebrew is hard for every system (17–46%); it is read encyclopedic text with rare names and should not be used to predict conversational accuracy.

### 4.2 Latency of `ivrit-ai/whisper-large-v3-turbo-ct2` on faster-whisper (published-not-measured)

Latency = wall-clock transcription time for one segment, by segment length. Speed-up = audio seconds per compute second for segments ≥ 30 s.

| GPU | 0–5 s p50 / p90 (ms) | 5–15 s p50 / p90 (ms) | 15–30 s p50 / p90 (ms) | ≥ 30 s speed-up p50 / p90 |
|---|---|---|---|---|
| RTX 5090 | 231 / 353 | 380 / 497 | 440 / 625 | 61.2× / 39.4× |
| **L40S** | **231 / 267** | 290 / 348 | 357 / 493 | 60.0× / 45.8× |
| **A10** | **325 / 382** | 417 / 485 | 513 / 668 | 42.8× / 32.3× |
| RTX 2080 Ti | 388 / 448 | 500 / 597 | 634 / 819 | 33.9× / 26.4× |
| **L4** | **405 / 449** | 495 / 584 | 603 / 809 | 31.0× / 24.9× |
| T4 | 582 / 628 | 683 / 797 | 832 / 1085 | 24.1× / 18.6× |

[VERIFIED-official — ivrit.ai `timing.csv`; single-request timing, not concurrent load.] Decoding parameters (beam size, precision) are not stated in the CSV. [UNVERIFIED]

Implication for the "< 300 ms end-of-speech → final transcript" goal: one decode per finished utterance fits on L40S (p90 267 ms for short turns) but not on L4. Turns longer than ~5 s exceed 300 ms on every data-centre GPU listed unless interim decodes are run while the user is still speaking. [ESTIMATE]

---

## 5. Per-candidate notes — open weights

### 5.1 ivrit.ai Whisper fine-tunes

- **License.** `ivrit-ai/whisper-large-v3-turbo-ct2`, `whisper-large-v3-turbo`, `whisper-large-v3-ct2`, `whisper-large-v3` and the `-ggml` variants all carry `license: apache-2.0` in the card front-matter; the turbo card repeats "License: Apache-2.0" in the body. [VERIFIED-official]
- **The custom license is on the data, not the weights.** ivrit.ai license v2 (2024-10-01): CC-BY-4.0, plus the data "may only be used, modified and distributed for the express purpose of either (a) training AI models, or (b) academic research", no voice deep-fakes, export-control compliance. The licence page states the intent is use "for training AI models for any reasonable purpose – including commercial ones". [VERIFIED-official]
- **Commercial use of the weights: allowed** under Apache-2.0. If we fine-tune further on ivrit.ai data ourselves, the data licence (attribution, no deep-fakes, training-only) binds us directly. [ESTIMATE — not legal advice]
- **Training.** Turbo: continued training of `openai/whisper-large-v3-turbo`; ~4,700 h Knesset plenums pre-training, then ~300 h crowd-transcribe-v5 + ~50 h crowd-recital + 150 h filtered Knesset; trained April 2025 on 8× A40. [VERIFIED-official]
- **Stale card.** The `-ct2` card still says "Release date: TBD" and describes a smaller data mix (295 h + 93 h); the non-ct2 card is the up-to-date description. The leaderboard's best row is the `20250513` build. [VERIFIED-official]
- **Limitations stated by ivrit.ai:** "Language detection capability of this model has been degraded during training - it is intended for mostly-hebrew audio transcription. Language token should be explicitly set to Hebrew." Translation is also degraded. [VERIFIED-official]
- **Code-switching consequence.** How the fine-tune renders embedded English words (Latin script, Hebrew transliteration, or errors) is not documented anywhere I could find. [UNVERIFIED — test in POC]
- **Distribution formats.** CTranslate2 (`-ct2`, 60,194 downloads last month for turbo), GGML for whisper.cpp, ONNX. [VERIFIED-official]
- **Other ivrit.ai releases.** Yiddish Whisper models (`yi-whisper-*`, 2025-10 → 2026-10), `zipformer2-66m-streaming-he` (2026-10-14), speaker-recognition and pyannote mirrors. No newer Hebrew Whisper than the May 2025 build. [VERIFIED-official]

### 5.2 `ivrit-ai/zipformer2-66m-streaming-he`

- Developed by Yakov Kolani (`thewh1teagle/zipformer2-66m-streaming-he`); ivrit.ai mirrors it with extra ONNX exports and uses it for `live-transcribe.ivrit.ai` on-device transcription. [VERIFIED-official]
- Zipformer2 transducer fine-tuned from icefall's English streaming Zipformer; decodes in **1.28 s chunks**; runs through sherpa-onnx (Apache-2.0). [VERIFIED-official]
- Card WER: 5.1 / 8.9 (fp32), 5.3 / 8.8 (int8). The card notes the other models in its comparison are "offline (full-utterance)". [VERIFIED-official, self-reported]
- Limitations on the card: "English is weak (spelled letter by letter)"; inconsistent number formatting. [VERIFIED-official]
- Trained on ~20k h of ivrit.ai audio pseudo-labelled by ivrit.ai Whisper models, so it inherits teacher errors. [VERIFIED-official]
- License CC-BY-4.0 (attribution required in product documentation). [VERIFIED-official]
- Why it matters: at 66 M parameters it can run on CPU or on the phone, which would take STT off the GPU bill entirely. Its 1.28 s chunk adds latency, and the English weakness is disqualifying for code-switching unless paired with a second model. [ESTIMATE]

### 5.3 `MaorB/embeddinggemma-2-asr-hebrew-english-streaming`

- 351 M parameters; EmbeddingGemma 2 audio tower (causal conformer) + 43 M "reader" + transducer head; one checkpoint for batch and streaming. [VERIFIED-official]
- Self-reported WER (d1 / wa / FLEURS he / LibriSpeech clean): batch 5.80 / 10.30 / 23.39 / 3.97; streaming-accurate 6.51 / 11.72 / 24.70 / 4.53; streaming-fast 7.23 / 12.45 / 26.88 / 4.71. [VERIFIED-official, self-reported]
- Capacity on one RTX 5090: ~256 real-time streams in fast mode (text every 0.48 s), ~40–60 in accurate mode (0.24 s). Batch RTFx up to 604. [VERIFIED-official, self-reported]
- Limitations on the card: no punctuation or capitalisation; about 1 point worse than Whisper turbo on podcasts and 3 on voice notes; English trained on read audiobooks only ("conversational English is weaker than LibriSpeech suggests"). The card does not claim intra-sentence code-switching. [VERIFIED-official]
- License Apache-2.0; base `google/embeddinggemma-2` is tagged Apache-2.0 on Hugging Face. [VERIFIED-official]
- Maturity: created 2026-10-16, 101 downloads, single author, custom `kolstream` runtime. High potential, high risk. [VERIFIED-official for metadata; judgement is ESTIMATE]

### 5.4 Hebrew Parakeet / Nemotron fine-tunes (community)

- `thewh1teagle/parakeet-tdt-0.6b-v3-he` — CC-BY-4.0; 6.1 / 8.8; Hebrew only ("English words come out in Hebrew letters"); FLEURS accuracy 76.8 vs ~82 for the best models; trained on ~9k h pseudo-labelled by ivrit.ai Whisper turbo. [VERIFIED-official, self-reported]
- `dm15/parakeet-tdt-0.6b-hebrew` v4 — CC-BY-4.0; 7.90 / 11.37 / 24.71 (d1 / wa / FLEURS); card concedes ivrit.ai Whisper turbo is more accurate (4.80 / 7.68 / 18.88 under its normalisation). [VERIFIED-official, self-reported]
- `notmax123/nemotron-3.5-asr-hebrew-streaming-0.6b` — Apache-2.0 on the card (the base model is OpenMDW-1.1, so the card's "same as the base" statement is inaccurate); 17.41% WER on a VoxKnesset dev set; ~80 ms streaming. [VERIFIED-official for card text]
- `mralexivy/nemotron-3.5-asr-streaming-0.6b-hebrew` — normalised WER 33.2% (from 39.4%); not competitive. [VERIFIED-official, self-reported]
- `Hebrish/*` — a family of English-with-Hebrew-words code-switching models (Parakeet v2 / Nemotron EN bases). CC-BY-NC-4.0, gated; "commercial use needs a commercial licence". Aimed at English-dominant dictation, the reverse of our Hebrew-dominant case. [VERIFIED-official from public metadata]

### 5.5 NVIDIA Parakeet / Canary / Nemotron

- `nvidia/parakeet-tdt-0.6b-v3` and `nvidia/canary-1b-v2`: 25 European languages (bg, hr, cs, da, nl, en, et, fi, fr, de, el, hu, it, lv, lt, mt, pl, pt, ro, sk, sl, es, sv, ru, uk). The word "Hebrew" does not appear on either card. CC-BY-4.0. [VERIFIED-official]
- `nvidia/nemotron-3.5-asr-streaming-0.6b` (released on HF 2026-06-04): cache-aware FastConformer-RNNT, 600 M, 40 language-locales, chunk sizes 80/160/320/560/1120 ms, "ready for commercial use", OpenMDW-1.1. Hebrew (he-IL) is in the **adaptation-ready** tier: "recognized by the tokenizer; fine-tune on in-domain data to unlock full transcription". [VERIFIED-official]
- OpenMDW-1.1 grants permission "to deal in the Model Materials without restriction", requires keeping the licence and notices on redistribution, and places no restriction on outputs. [VERIFIED-official]
- Throughput on one H100: ~240 concurrent streams at 80 ms chunks and ~2,400 at 1120 ms, versus 14 and 400 for the buffered Parakeet RNNT 1.1B. [VERIFIED-official, vendor-reported]
- Strategic read: this is the most scalable open streaming architecture found, and NVIDIA publishes a fine-tuning guide. A properly trained Hebrew + English Nemotron 3.5 fine-tune would be the long-term cost winner, but none of today's community fine-tunes is close to ivrit.ai Whisper accuracy. [ESTIMATE]

### 5.6 Whisper runtimes and streaming wrappers

| Project | License | Role | Notes |
|---|---|---|---|
| `openai/whisper` | MIT (repo LICENSE) | Reference | Card: "cannot be used for real-time transcription out of the box" |
| faster-whisper 1.2.1 (CTranslate2 4.9.1) | MIT | **Recommended runtime** | Large-v2 on RTX 3070 Ti: 1m03s vs 2m23s for openai/whisper on 13 min audio; batched 17 s; int8 2.9 GB VRAM |
| whisper.cpp | MIT | CPU / edge | ivrit.ai ships GGML weights |
| WhisperX 3.8.6 | BSD-2-Clause | Batch + word alignment + diarization | Not a streaming server |
| `ufal/whisper_streaming` | MIT | LocalAgreement streaming | Author: "becoming outdated in 2025 … replaced by SimulStreaming" |
| `ufal/SimulStreaming` | MIT per the author's statement; no LICENSE file at repo root | AlignAtt streaming policy | Recommends ≥ 10 GB VRAM for large-v3; torch backend only |
| `collabora/WhisperLive` | MIT | WebSocket server | Backends: faster_whisper, TensorRT, OpenVINO; `--max_clients` |
| WhisperLiveKit 0.2.28 | Apache-2.0 | WebSocket server, multi-user | Backends: Whisper (LocalAgreement / SimulStreaming), Voxtral, Qwen3-ASR, FunASR |
| WhisperKit | MIT | Apple on-device | Relevant only for an on-device iOS path |

All [VERIFIED-official] (raw LICENSE / README / PyPI metadata).

Two ways to use Whisper in a turn-based agent:

1. **Endpoint-then-decode.** VAD and turn detection decide the turn is over; one decode of the whole utterance. Simplest, best accuracy, latency = decode time (§4.2). No partial transcripts, so semantic barge-in handling must rely on VAD alone.
2. **Incremental re-decoding** (LocalAgreement / AlignAtt). Partial transcripts every ~0.5–1 s; GPU cost multiplies by the number of re-decodes; E2E Networks measured a 3.5-point absolute WER regression when Whisper turbo chunks are cut to 10 s. [PUBLISHED-thirdparty]

### 5.7 Everything else, briefly

- **Kyutai STT** — EN/FR only; has a built-in semantic VAD; excellent batching. No Hebrew, no newer multilingual release on Hugging Face. [VERIFIED-official]
- **Moonshine** — now MIT for all streaming models; 10 STT languages, Hebrew not among them. [VERIFIED-official]
- **SenseVoice / Fun-ASR** — East-Asian focus; no Hebrew. [VERIFIED-official]
- **Meta Omnilingual ASR** — Apache-2.0, 1,600+ languages including `heb_Hebr`; CTC and LLM suites accept only audio shorter than 40 s (newer "Unlimited" LLM variants exist); LLM variants run at ~1× real time. No Hebrew WER on the card. Not a streaming option. [VERIFIED-official]
- **Meta MMS** — CC-BY-NC-4.0; unusable commercially. [VERIFIED-official]
- **Qwen3-ASR** — strong, Apache-2.0, streaming via vLLM, but Hebrew is not in its 30-language list. [VERIFIED-official]
- **Voxtral Realtime** — Apache-2.0, 13 languages, no Hebrew. Mistral released an Arabic realtime variant focused on code-switching in 2026-10, which shows the vendor path for a language-specific realtime fine-tune, but nothing for Hebrew. [VERIFIED-official]
- **IBM Granite Speech 5.0** — 6–7 languages, no Hebrew. [VERIFIED-official]
- **Phi-4-multimodal** — Hebrew is supported for text only; audio covers 8 languages. [VERIFIED-official]
- **VibeVoice-ASR** — Hebrew and code-switching are claimed, MIT, but it is an offline long-form model; the streaming variants drop to 10 languages without Hebrew. Worth a one-off offline test as a code-switching reference transcriber. [VERIFIED-official]
- **BuzzASR/hebrew** — MIT Whisper-large-v3 fine-tune trained on FLEURS + Common Voice; FLEURS WER 28.58, i.e. worse than ivrit.ai on the same set. Not a candidate. [VERIFIED-official, self-reported]

---

## 6. Per-candidate notes — commercial APIs

- **Soniox.** `stt-rt-v6` is current; `stt-rt-v5` is removed on 2026-12-15 and auto-routes to v6. Token-based billing "equivalent to about $0.12/hour" for real-time; diarization, language ID and formatting are bundled. 60+ languages in one model, Hebrew included. Semantic endpoint detection returns an `<end>` token. In the Pipecat STT benchmark (English, 1,000 samples, as republished by Soniox) v6 has the lowest semantic WER (0.74%) with 266 ms median time-to-final-segment. [VERIFIED-official for product facts; the benchmark is PUBLISHED-thirdparty and English-only]
- **Deepgram.** Hebrew launched on Nova-3 on 2026-02-12 as a monolingual model, streaming and batch, with Keyterm Prompting. Hebrew also appears in the Nova-3 **multilingual** language list ("Nova-3 multilingual supports 55 languages"). Flux STT (model-native turn detection) has no Hebrew. Pay-as-you-go allows 150 concurrent streaming connections. Current prices are labelled promotional. [VERIFIED-official]
- **ElevenLabs.** Scribe v3 Live is the current real-time model ("44% lower semantic WER than Scribe v2 Realtime on FLEURS", turn prediction, multilingual mode); both Live and v2 Realtime list at $0.22/hr. Third-party pages still quote the old $0.39/hr. [VERIFIED-official]
- **AssemblyAI.** The streaming product is now named `AssemblyAI-STT-3.7-Realtime` ($0.30/hr) and `…-Realtime-Agent` ($0.45/hr); "Universal-Streaming" is no longer a priced line on the pricing page (only a research navigation link remains). Hebrew is in the 32-language streaming table and code-switching is on by default. [VERIFIED-official]
- **Speechmatics.** Three relevant real-time models: Melia 1 (multilingual, mid-sentence switching, $0.20/hr), Linden 1 (voice-agent STT with turn detection, $0.15/hr) and Enhanced ($0.40/hr). Hebrew (`he`) is a supported language; no Hebrew–English bilingual pack exists for Enhanced. [VERIFIED-official]
- **Google.** Chirp 3 supports `StreamingRecognize`; Hebrew (`iw-IL`) is listed as **Preview**, not GA. V2 recognition is $0.016/min at low volume. Soniox's page quotes a newer `gemini-3.5-transcribe-live` at about $0.54/hr. [VERIFIED-official for Chirp 3 and price; the Gemini figure is PUBLISHED-thirdparty]
- **Azure.** `he-IL` supports real-time transcription. Azure Retail Prices API: S1 Speech To Text $1.00 per hour in eastus. [VERIFIED-official]
- **OpenAI.** `gpt-live-transcribe` ($0.017/min) is the recommended streaming model; it does not support `server_vad` or `semantic_vad`, and returns no timestamps or confidence. `gpt-transcribe` is $0.0045/min. `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` and `gpt-4o-transcribe-diarize` "will shut down on February 26, 2027". [VERIFIED-official]
- **Gladia.** Real-time €0.68/hr on self-serve, 30 concurrent real-time sessions; Hebrew only on Solaria-1. [VERIFIED-official]
- **Groq.** Hosted stock Whisper at $0.04/hr (turbo) with a 216× speed factor. It is a file API, so it can only serve the endpoint-then-decode pattern, and it cannot host the ivrit.ai fine-tune. Cheapest hosted option, at stock-Whisper Hebrew accuracy. [VERIFIED-official]

---

## 7. VAD, turn detection and noise suppression

| Component | Version / date | License → commercial OK? | Hebrew? | Notes |
|---|---|---|---|---|
| **Silero VAD** | PyPI `silero-vad` 6.3 (2026-11-23) | MIT → **yes** | Language-agnostic ("trained on … over 6000 languages") | < 1 ms per 30 ms chunk on one CPU thread; 8 kHz and 16 kHz |
| **TEN VAD** | PyPI `ten-vad` 1.0.6.9 (2026-10-09) | Apache-2.0 **with additional conditions** → restricted | Language-agnostic | Claims faster speech→non-speech transition than Silero; 10/16 ms hops |
| **Pipecat Smart Turn** | v3.2 (HF repo `pipecat-ai/smart-turn-v3`) | BSD-2-Clause → **yes** | **Not in the 23-language list** | Audio-native (Whisper Tiny encoder, 8 M params, 8 MB int8); 10–100 ms on CPU; runs after VAD detects silence; training code and data are open |
| **LiveKit turn detector (multimodal `v1` / `v1-mini`)** | `livekit-plugins-turn-detector` 1.8.13 (2026-11-18) | Plugin code Apache-2.0; **model under LiveKit Model License** → LiveKit Agents only | **No** (14 languages) | `v1` runs on LiveKit Inference; `v1-mini` runs locally on CPU |
| LiveKit turn detector (text model, HF `livekit/turn-detector`) | v0.4.1 | LiveKit Model License | **No** (14 languages) | Qwen2.5-0.5B, text-only, needs STT output |
| TEN Turn Detection | — | Apache-2.0 | **No** (English + Chinese) | Qwen2.5-7B based, text-only |
| `nvidia/parakeet_realtime_eou_120m-v1` | — | NVIDIA Open Model License ("commercially usable") | **No** (English only) | Joint ASR + `<EOU>` token, 80–160 ms |
| Soniox semantic endpointing | part of `stt-rt-v6` | Commercial API | Presumably all languages [UNVERIFIED for Hebrew quality] | Returns `<end>` token |
| **RNNoise** | — | BSD-3-Clause → **yes** | n/a | Tiny, CPU, 48 kHz; trained mostly on stationary noise |
| **DeepFilterNet** | PyPI 0.5.6 (2023-08-31) | MIT OR Apache-2.0 (code and weights) → **yes** | n/a | 48 kHz full-band, real-time; no release since 2023 |
| Krisp VIVA SDK | — | Proprietary; licence key required; no public price | n/a | Server-side voice isolation aimed at voice agents |

All [VERIFIED-official] except the Krisp row, which is [PUBLISHED-thirdparty, via search snippets] — krisp.ai was not fetched.

Details that affect the decision:

- **LiveKit Model License**: "you may use these LiveKit models freely but can only use them together with the LiveKit Agents framework. You cannot use the LiveKit models on a standalone basis or with any other frameworks", and outputs may not be used to develop other models. Adopting it locks the pipeline to LiveKit Agents. Docs add: "Unmapped languages keep the calibrated default". [VERIFIED-official]
- **TEN VAD licence conditions**: "You may not Deploy the ten-vad in a way that competes with Agora's offerings and/or that allows others to compete with Agora's offerings". A real-time voice product is close enough to Agora's business that this needs legal review before use. [VERIFIED-official; risk assessment is ESTIMATE]
- **Silero's README badge** has alt-text "CC BY-NC 4.0" but renders "MIT" and links to an MIT LICENSE file; the README body says "Published under permissive license (MIT)". The licence is MIT. [VERIFIED-official]
- **Smart Turn's 23 languages**: Arabic, Bengali, Chinese, Danish, Dutch, German, English, Finnish, French, Hindi, Indonesian, Italian, Japanese, Korean, Marathi, Norwegian, Polish, Portuguese, Russian, Spanish, Turkish, Ukrainian, Vietnamese. Because it works on prosody from raw audio, some transfer to Hebrew is plausible but unproven. [VERIFIED-official for the list; transfer is ESTIMATE]
- **In-car noise.** Neither RNNoise nor DeepFilterNet publishes in-car results. Whisper-family models are trained on noisy audio, and a denoiser in front of ASR can remove speech cues and raise WER, so the denoiser should feed the VAD / turn detector first and reach the ASR only if an A/B test shows a gain. [ESTIMATE]
- **Barge-in in a car** depends on acoustic echo cancellation more than on VAD: without AEC the agent's own voice from the car speakers triggers the VAD. Phone OS voice-processing modes (iOS voice-processing I/O, Android `VOICE_COMMUNICATION`) provide AEC + noise suppression for free on-device. [ESTIMATE]

---

## 8. Published GPU concurrency / throughput data (published-not-measured)

| Source | Model / runtime | GPU | Published figure | Tag |
|---|---|---|---|---|
| ivrit.ai `timing.csv` | `ivrit-ai/whisper-large-v3-turbo-ct2`, faster-whisper | L4 / A10 / L40S | See §4.2 (0–5 s p50 405 / 325 / 231 ms; ≥ 30 s speed-up 31× / 43× / 60×) | [VERIFIED-official] |
| Runpod guide (updated 2026-10-15) | whisper-large-v3-turbo int8, faster-whisper | L4 | 31.5× real time, 1.1 GB peak VRAM, $0.0156 per audio hour | [PUBLISHED-thirdparty] |
| ″ | ″ | L40S | 58.3×, 1.5 GB, $0.0187 per audio hour | ″ |
| ″ | ″ | A100 PCIe / SXM | 45.1× / 34.0× | ″ |
| ″ | ″ | H100 NVL / SXM / PCIe | 57.8× / 52.8× / 34.3× | ″ |
| ″ | whisper-large-v3 (full) | L4 / L40S / H100 SXM | 15.5× / 23.1× / 24.9×; fp16 peak 3.3–4.4 GB | ″ |
| E2E Networks (2026-03-27) | `openai/whisper-large-v3-turbo`, HF transformers | L4 | 34.2× at batch 1 (p50 198 ms/utterance, 2.1 GB); best 41.1× at batch 4 bf16; throughput saturates at batch 4 | [PUBLISHED-thirdparty] |
| ″ | `nvidia/nemotron-speech-streaming-en-0.6b` | L4 | 84–88× at batch 1; up to 259× at batch 8; 1.7–3.3 GB | ″ |
| Baseten blog | Whisper large-v3-turbo, proprietary pipeline | One H100 MIG slice | "40+ concurrent streams" (20+ for large-v3) with real-time diarization; full node 2,400× RTF | [PUBLISHED-thirdparty, vendor] |
| NVIDIA model card | `nvidia/nemotron-3.5-asr-streaming-0.6b` | H100 | ~240 streams at 80 ms chunks; ~2,400 at 1120 ms | [VERIFIED-official] |
| Kyutai README | `kyutai/stt-1b-en_fr` | H100 / L40S | 400 real-time streams / 64 connections at 3× RTF | [VERIFIED-official] |
| MaorB model card | `embeddinggemma-2-asr-hebrew-english-streaming` | RTX 5090 | ~256 streams (fast), ~40–60 (accurate) | [VERIFIED-official, self-reported] |
| Qwen model card | `Qwen3-ASR-0.6B` | not stated | "2000 times throughput at a concurrency of 128" | [VERIFIED-official] |
| Spheron guide | whisper large-v3 int8 | H100 | "250+" concurrent; no methodology | [UNVERIFIED — search snippet only] |
| gigagpu | whisper large-v3 | RTX 3090 | 5 real-time streams | [UNVERIFIED — page returned 403] |

Gaps: **no source publishes concurrent real-time stream counts for faster-whisper on L4 or A10**, and nothing at all for A100 beyond sequential RTFx. The Runpod and ivrit.ai numbers are single-request. This must be measured in the POC.

### 8.1 Rough self-host cost model

Inputs, all published-not-measured: L4 decode of a 0–5 s utterance ≈ 0.4 s (ivrit.ai); implied Runpod on-demand GPU prices of ≈ $0.49/hr for L4 and ≈ $1.09/hr for L40S, derived as (RTFx × $/audio-hour) from the Runpod table.

Assumptions: user speaks ~40% of a conversational minute in ~5 s turns → about 5 final decodes per minute; endpoint-then-decode; GPU held to ~60% utilisation to protect tail latency.

| GPU | Decode per turn | GPU-seconds per conversational minute | Streams per GPU at 60% utilisation | STT cost per conversational minute |
|---|---|---|---|---|
| L4 | ~0.40 s | ~2.0 s | ~18 | ~$0.00045 |
| L40S | ~0.23 s | ~1.2 s | ~30 | ~$0.00060 |

[ESTIMATE] Adding interim (partial) decodes every second of speech multiplies GPU time by roughly 4–6×, to about $0.002–0.003/min — the same as buying Soniox. Batched decoding across streams would pull the number back down but is unmeasured for this model.

Consequence: self-hosted Whisper is roughly 4× cheaper than the cheapest API **only** in endpoint-then-decode mode. If product quality needs live partials, either a true streaming model (Zipformer / EmbeddingGemma-ASR / a Nemotron fine-tune) or the commercial API is the economical choice.

---

## 9. Recommendations

### (a) Self-hosted Hebrew + English STT

**Primary: `ivrit-ai/whisper-large-v3-turbo-ct2` (Apache-2.0) on faster-whisper, endpoint-then-decode, on L40S-class GPUs.**

- Best published open Hebrew accuracy (5.3 / 7.1), permissive licence, mature runtime, 60k downloads a month.
- Published latency meets the 300 ms target only on L40S (p90 267 ms for short turns); A10 is ~325 ms p50; L4 ~405 ms.
- Force `language='he'` as ivrit.ai instructs.
- **English and code-switching plan** — this is the unresolved part. Options to A/B in the POC, in order of effort:
  1. ivrit.ai turbo alone, with English terms supplied through `initial_prompt` / hotwords; measure how embedded English is rendered.
  2. Two models on the same GPU: ivrit.ai turbo for Hebrew-dominant turns and stock `openai/whisper-large-v3-turbo` (MIT) for English-dominant turns, routed by a cheap language-ID pass. The turbo checkpoints are ~1.6 GB each, so both fit easily.
  3. Fall back to Soniox for sessions flagged as heavy code-switchers.

**Challengers to benchmark in the same POC** (all commercially usable):

| Candidate | Why test it | Main risk |
|---|---|---|
| `MaorB/embeddinggemma-2-asr-hebrew-english-streaming` (Apache-2.0) | Only open Hebrew + English streaming model; true partials at 0.24 s; ~10× the stream density of Whisper | Weeks old, single author, no punctuation, ~3 points worse on voice notes |
| `ivrit-ai/zipformer2-66m-streaming-he` (CC-BY-4.0) | CPU / on-device; could remove STT from the GPU bill | English "spelled letter by letter"; 1.28 s chunks |
| `thewh1teagle/parakeet-tdt-0.6b-v3-he` (CC-BY-4.0) | Faster non-autoregressive decode than Whisper | Hebrew only; offline TDT |

**Longer-term option:** fine-tune `nvidia/nemotron-3.5-asr-streaming-0.6b` (OpenMDW-1.1) on ivrit.ai data plus English and synthetic code-switched data, distilling from ivrit.ai Whisper. The architecture supports hundreds to thousands of streams per H100 and Hebrew is already in its tokenizer. This is a training project, not a POC item.

### (b) Commercial fallback STT

**Primary: Soniox `stt-rt-v6` — $0.12/hour ≈ $0.002 per audio minute.**

- Hebrew, mid-sentence Hebrew↔English code-switching, semantic endpointing, diarization and formatting included in the price.
- Best API result on the ivrit.ai leaderboard (4.8 / 9.0), though that run predates v6.
- At $0.002/min it consumes 40% of the $0.005 all-in budget, so it works as a fallback or for a code-switching tier, not as the default at scale.

**Secondary: Deepgram Nova-3** — `language=he` at $0.0048/min, or `language=multi` (Hebrew included) at $0.0058/min. Mature infrastructure and 150 concurrent streams on pay-as-you-go, but the monolingual price alone nearly exhausts the budget, and the Hebrew leaderboard result (6.7 / 12.0) is worse than the self-hosted model.

**Worth a quote / test:** ElevenLabs Scribe v3 Live ($0.0037/min, multilingual mode) and Speechmatics Melia 1 ($0.0033/min) — both claim mid-sentence switching with Hebrew, neither has a published Hebrew WER.

**Not recommended:** OpenAI `gpt-live-transcribe`, Azure, Google (all ≈ $0.016–0.017/min; Google's Hebrew on Chirp 3 is Preview); Deepgram Flux (no Hebrew); Groq (not streaming, stock Whisper accuracy).

### (c) VAD + turn detection

**Silero VAD 6.x (MIT) for speech activity and barge-in triggering, plus Pipecat Smart Turn v3.2 (BSD-2-Clause) for end-of-turn, validated and if necessary fine-tuned on Hebrew.**

- Silero is language-agnostic, sub-millisecond on CPU and unencumbered.
- Smart Turn is the only fully open, framework-independent, audio-native end-of-turn model; its training code and datasets are public, so adding Hebrew is a tractable fine-tune. Until validated, keep a conservative VAD-silence fallback (e.g. 600–800 ms) for Hebrew. [ESTIMATE]
- Do **not** build on the LiveKit turn detector unless the whole agent runs on LiveKit Agents: its licence forbids standalone use and Hebrew is not supported.
- Hold TEN VAD until legal has read the non-compete condition; its latency advantage over Silero is a vendor claim.
- When the commercial fallback is active, use Soniox's own `<end>` endpoint token instead of a second turn model.
- Noise: rely first on on-device AEC + noise suppression from the phone's voice-processing mode; keep RNNoise (BSD-3) or DeepFilterNet (MIT/Apache-2.0) as an optional server-side stage in front of the VAD only. Krisp is proprietary with unpublished pricing and is not needed for a POC.

### What the POC must measure (nothing below is published)

1. WER of each candidate on **our own** in-car Hebrew recordings, including a Hebrew↔English code-switched subset.
2. Concurrent-stream capacity and p95 end-of-speech → final latency of faster-whisper with the ivrit.ai turbo model on L4, A10 and L40S.
3. Smart Turn v3.2 end-of-turn accuracy on Hebrew speech.
4. Whether a denoiser in front of ASR helps or hurts WER with road noise.
5. How the ivrit.ai fine-tune renders embedded English words.

---

## 10. Open questions and caveats

- ivrit.ai leaderboard rows for commercial APIs are dated May 2026 or older; Soniox v6, ElevenLabs Scribe v3 Live, AssemblyAI 3.7, Speechmatics Melia/Linden and Deepgram's multilingual Hebrew have no independent Hebrew WER. [VERIFIED-official that they are absent]
- Deepgram's Nova-3 prices are marked promotional ("was $0.0077"); budget against the non-promo price for anything beyond the POC. [VERIFIED-official]
- Whether commercial APIs bill silence inside an open stream differs by vendor (Deepgram: "billed per second of processed audio"; Soniox: "duration of audio or streaming session"). A proactive companion with long quiet stretches should gate audio with client-side VAD. [VERIFIED-official for the quotes; advice is ESTIMATE]
- OpenAI Hebrew support for `gpt-live-transcribe` / `gpt-transcribe` could not be confirmed because the language list is loaded dynamically. [UNVERIFIED]
- Amazon Transcribe streaming price could not be read. [UNVERIFIED]
- `ufal/SimulStreaming` has no LICENSE file at the repository root; the MIT statement comes from the author's note in the `whisper_streaming` README. Confirm before shipping. [VERIFIED-official for the absence]

---

## 11. Sources

All accessed **2026-11-24**.

### ivrit.ai

- https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ct2
- https://huggingface.co/ivrit-ai/whisper-large-v3-turbo
- https://huggingface.co/ivrit-ai/whisper-large-v3-ct2
- https://huggingface.co/ivrit-ai/whisper-large-v3
- https://huggingface.co/ivrit-ai/zipformer2-66m-streaming-he
- https://huggingface.co/api/models?author=ivrit-ai (model list, dates, licences)
- https://huggingface.co/spaces/ivrit-ai/hebrew-transcription-leaderboard — files `benchmark.csv`, `timing.csv`, `src/about.py`, `generate_timing.py`, `results/timing/iai-wlv3t-l4/machine.json`
- https://www.ivrit.ai/en/the-license/
- https://raw.githubusercontent.com/ivrit-ai/asr-training/master/README.md

### Hebrew community models

- https://huggingface.co/thewh1teagle/zipformer2-66m-streaming-he
- https://huggingface.co/MaorB/embeddinggemma-2-asr-hebrew-english-streaming (also reachable as `MaorB/kol-stream-he-en`)
- https://huggingface.co/thewh1teagle/parakeet-tdt-0.6b-v3-he
- https://huggingface.co/dm15/parakeet-tdt-0.6b-hebrew
- https://huggingface.co/notmax123/nemotron-3.5-asr-hebrew-streaming-0.6b
- https://huggingface.co/mralexivy/nemotron-3.5-asr-streaming-0.6b-hebrew
- https://huggingface.co/flowty1/qwen-asr-0.6b-he
- https://huggingface.co/BuzzASR/hebrew
- https://huggingface.co/api/models?author=Hebrish and https://huggingface.co/api/models/Hebrish/Sabich-Rolling (public metadata; repos gated)

### Open-weight ASR (general)

- https://huggingface.co/openai/whisper-large-v3
- https://huggingface.co/openai/whisper-large-v3-turbo
- https://raw.githubusercontent.com/openai/whisper/main/LICENSE
- https://huggingface.co/distil-whisper/distil-large-v3.5
- https://huggingface.co/Systran/faster-whisper-large-v3
- https://raw.githubusercontent.com/SYSTRAN/faster-whisper/master/README.md and `/LICENSE`
- https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/LICENSE
- https://raw.githubusercontent.com/m-bain/whisperX/main/LICENSE
- https://raw.githubusercontent.com/ufal/whisper_streaming/main/README.md and `/LICENSE`
- https://raw.githubusercontent.com/ufal/SimulStreaming/main/README.md
- https://raw.githubusercontent.com/collabora/WhisperLive/main/README.md and `/LICENSE`
- https://raw.githubusercontent.com/QuentinFuxa/WhisperLiveKit/main/README.md and `/LICENSE`
- https://raw.githubusercontent.com/argmaxinc/WhisperKit/main/LICENSE
- https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3
- https://huggingface.co/nvidia/canary-1b-v2
- https://huggingface.co/nvidia/canary-qwen-2.5b
- https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b
- https://huggingface.co/nvidia/nemotron-labs-unified-asr-0.6b
- https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B
- https://huggingface.co/nvidia/parakeet_realtime_eou_120m-v1
- https://openmdw.ai/license/1-1/
- https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/
- https://huggingface.co/kyutai/stt-1b-en_fr and https://huggingface.co/kyutai/stt-2.6b-en
- https://raw.githubusercontent.com/kyutai-labs/delayed-streams-modeling/main/README.md
- https://huggingface.co/UsefulSensors/moonshine
- https://raw.githubusercontent.com/moonshine-ai/moonshine/main/README.md and `/LICENSE`
- https://huggingface.co/FunAudioLLM/SenseVoiceSmall
- https://huggingface.co/FunAudioLLM/Fun-ASR-MLT-Nano-2512
- https://huggingface.co/facebook/omniASR-LLM-7B
- https://raw.githubusercontent.com/facebookresearch/omnilingual-asr/main/README.md and `/src/omnilingual_asr/models/wav2vec2_llama/lang_ids.py`
- https://huggingface.co/facebook/mms-1b-all
- https://huggingface.co/Qwen/Qwen3-ASR-1.7B
- https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602
- https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-Arabic
- https://huggingface.co/mistralai/Voxtral-Mini-3B-2507
- https://huggingface.co/ibm-granite/granite-speech-5.0-2b
- https://huggingface.co/ibm-granite/granite-speech-5.0-470m-turboctc
- https://huggingface.co/microsoft/Phi-4-multimodal-instruct
- https://huggingface.co/microsoft/VibeVoice-ASR
- https://huggingface.co/microsoft/VibeVoice-ASR-Streaming-1.5B
- https://huggingface.co/api/models/CohereLabs/cohere-transcribe-03-2026

### Commercial STT

- https://deepgram.com/pricing
- https://developers.deepgram.com/docs/models-languages-overview
- https://developers.deepgram.com/docs/multilingual-code-switching
- https://deepgram.com/blog/speech-to-text-for-hebrew-persian-urdu-on-nova-3
- https://soniox.com/pricing
- https://soniox.com/speech-to-text/hebrew
- https://soniox.com/docs/stt/concepts/supported-languages
- https://soniox.com/docs/stt/models
- https://soniox.com/docs/stt/rt/endpoint-detection
- https://soniox.com/benchmarks
- https://www.assemblyai.com/pricing
- https://www.assemblyai.com/docs/getting-started/supported-languages
- https://www.assemblyai.com/docs/universal-streaming/multilingual-transcription
- https://www.speechmatics.com/pricing
- https://docs.speechmatics.com/speech-to-text/languages
- https://cloud.google.com/speech-to-text/pricing
- https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3
- https://prices.azure.com/api/retail/prices (filter: Azure Speech, eastus)
- https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support
- https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/ (prices not rendered)
- https://elevenlabs.io/pricing/api
- https://elevenlabs.io/docs/overview/models
- https://elevenlabs.io/docs/overview/capabilities/speech-to-text
- https://platform.openai.com/docs/pricing
- https://developers.openai.com/api/docs/guides/speech-to-text
- https://developers.openai.com/api/docs/guides/realtime-transcription
- https://developers.openai.com/api/docs/models/gpt-live-transcribe
- https://developers.openai.com/api/docs/models/gpt-transcribe
- https://developers.openai.com/api/docs/models/gpt-4o-transcribe
- https://www.gladia.io/pricing
- https://docs.gladia.io/chapters/language/supported-languages
- https://console.groq.com/docs/speech-to-text
- https://console.groq.com/docs/models
- https://aws.amazon.com/transcribe/pricing/ (prices not rendered)

### VAD / turn detection / noise

- https://raw.githubusercontent.com/snakers4/silero-vad/master/README.md and `/LICENSE`
- https://pypi.org/pypi/silero-vad/json
- https://raw.githubusercontent.com/TEN-framework/ten-vad/main/README.md and `/LICENSE`
- https://huggingface.co/TEN-framework/TEN_Turn_Detection
- https://huggingface.co/livekit/turn-detector and its `LICENSE`
- https://docs.livekit.io/agents/logic/turns/turn-detector.md
- https://pypi.org/pypi/livekit-plugins-turn-detector/json
- https://huggingface.co/pipecat-ai/smart-turn-v3
- https://raw.githubusercontent.com/pipecat-ai/smart-turn/main/README.md and `/LICENSE`
- https://raw.githubusercontent.com/xiph/rnnoise/main/COPYING
- https://raw.githubusercontent.com/Rikorose/DeepFilterNet/main/README.md
- https://pypi.org/project/livekit-plugins-krisp (via search snippet)

### Throughput / GPU benchmarks

- https://www.runpod.io/articles/guides/best-gpu-for-whisper
- https://e2enetworks.com/blog/benchmarking-asr-models-nvidia-l4-parakeet-whisper-nemotron
- https://www.baseten.co/blog/the-fastest-whisper-transcription-with-streaming-and-diarization/
- https://perspectives.nvidia.com/nemotron-speech/task/faq/open-asr-models-throughput-benchmarks/ (page is labelled AI-generated; not relied upon)
- https://docs.nvidia.com/deeplearning/riva/user-guide/docs/asr/asr-performance.html (no Whisper tables found)
- https://www.spheron.network/blog/faster-whisper-gpu-cloud-production-deployment-guide/ (search snippet only)
- https://gigagpu.com/whisper-concurrent-streams-by-gpu/ (403, not read)
