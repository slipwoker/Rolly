# 04 — Self-hosted native speech-to-speech models ("Architecture C")

Research date: 2026-11-24. Scope: open-weight speech-to-speech / audio-to-audio conversational models that could be self-hosted for a proactive Hebrew + English voice companion (barge-in, 30-minute sessions with injected memory, commercial use, thousands of concurrent users, very low cost per minute).

## 0. Bottom line

**NO-GO for Architecture C as a product path in this POC.** No open-weight model meets the minimum bar of Hebrew + English, real-time full-duplex streaming and a commercial licence. [VERIFIED-official] for each model's documented language list (sections 3–4); the absence of any other such model is [UNVERIFIED] in the strict sense, because it is a negative result from searching Hugging Face and the web on one day.

- Every open full-duplex model found is English-only, or covers a fixed set of major languages that excludes Hebrew. [VERIFIED-official]
- The only Hebrew full-duplex artefact found is a hobbyist Moshi LoRA whose own card calls it "still rough — POC checkpoint", with no licence stated. [PUBLISHED-thirdparty]
- The only open-weight native audio models that list Hebrew speech at all are Liquid AI's LFM3-Audio-2B and LFM3-Omni-2B. They are turn-based 2B edge models, the LFM3-Audio card says voice chat "currently supports English only", and Hebrew is absent from LFM3-Omni's text-language list. [VERIFIED-official]
- A Hebrew-capable native speech-to-speech model does exist, but only as a hosted API: Alibaba's Qwen3.5-Omni and Qwen3.8-Omni-Flash-Realtime list Hebrew as a supported speech-output language. Their weights are not published, so they belong to the hosted-API architecture, not Architecture C. [VERIFIED-official]

**Optional English-only reference:** NVIDIA PersonaPlex-7B-v1 on one 24–48 GB GPU, for a latency and naturalness comparison only (section 6.2).

## 1. Method, tags and limits of this research

Tags used on every factual claim:

| Tag | Meaning |
|---|---|
| [VERIFIED-official] | I read it today (2026-11-24) in the official model card, repository README, source code, licence text or vendor documentation. It is still the vendor's own claim; nothing here was run or benchmarked by us. |
| [PUBLISHED-thirdparty] | From a third-party article, benchmark or community model card, or from a search-result summary of an official page I could not open. |
| [ESTIMATE] | My own inference or arithmetic from verified inputs. |
| [UNVERIFIED] | Could not be confirmed today (page unreachable, gated, or only recalled from training data). |

In tables, the "Evidence" column gives the tag that applies to the whole row; a cell that differs carries its own tag.

Access limits in this session:

- Reachable: `huggingface.co` (raw model cards and the model API), `raw.githubusercontent.com`, `help.aliyun.com`, `nvidia.com`, `ai.google.dev`, `docs.vllm.ai`, vendor blogs.
- Not reachable: `arxiv.org`, `github.com` HTML pages and API, `alibabacloud.com`, `kyutai.org`, `research.nvidia.com`. Papers were therefore not read; paper-only facts are tagged [UNVERIFIED] or [PUBLISHED-thirdparty].
- Gated model cards whose README returned HTTP 401: `nvidia/personaplex-7b-v1`, `sesame/csm-1b`, `google/gemma-3n-E4B-it`, `kyutai/moshika-rl-seamless`, `kyutai/pocket-tts`, `FlashLabs/Chroma-4B`. For these, only the public API metadata (licence, languages, files) and the GitHub README were read.
- Nothing was deployed. All latency, VRAM and concurrency numbers are published figures, not measurements.

## 2. Minimum-bar screen

Minimum bar: (a) open weights, (b) Hebrew speech in and out, (c) English, (d) real-time streaming with barge-in, (e) commercial licence.

| Model | Open weights | Hebrew in / out | Real-time + barge-in | Commercial licence | Passes? |
|---|---|---|---|---|---|
| Kyutai Moshi | Yes | No / No | Yes (full-duplex) | Yes (CC-BY 4.0) | No — English only |
| NVIDIA PersonaPlex-7B-v1 | Yes (gated) | No / No | Yes (full-duplex) | Yes (NVIDIA Open Model License) | No — English only |
| NVIDIA NemotronLabs VoiceChat 11B | Yes | No / No | Yes (full-duplex) | Yes (OpenMDW-1.1) | No — English only |
| Haru-4B | Yes | No / No | Yes (full-duplex) | Yes (Apache-2.0) | No — 9 languages, no Hebrew |
| Sophon-Realtime v1 | Yes | No / No | Yes (full-duplex) | Yes (Apache-2.0) | No — no Hebrew |
| MiniCPM-o 4.5 | Yes | No / No | Yes (duplex mode) | Yes (Apache-2.0) | No — English and Chinese speech |
| Qwen3-Omni-30B-A3B | Yes | No / No | Streaming, turn-based | Yes (Apache-2.0) | No — Hebrew in neither speech list |
| LFM3-Audio-2B / LFM3-Omni-2B | Yes | Listed / Listed (ASR, TTS, translation) | Streaming, turn-based | Only under $10M annual revenue | No — voice chat English-only (Audio); not full-duplex |
| dm15/moshi-hebrew-v3 (LoRA) | Yes | Yes / Yes ("rough") | Yes in principle | No licence stated | No — hobby POC |
| Qwen3.5-Omni / Qwen3.8-Omni-Flash-Realtime | **No (API only)** | Yes / Yes | Yes (full-duplex) | Commercial API | Not Architecture C |

Evidence for every row is in sections 3–5. All rows [VERIFIED-official] except the dm15 row [PUBLISHED-thirdparty].

## 3. Comparison table A — identity, licence, languages

Evidence column applies to the whole row unless a cell says otherwise. Source numbers refer to section 8.

### 3.1 Native full-duplex speech-to-speech

| Model | Open weights (HF ID) | Code licence | Weights licence | Commercial use | Input languages | Output speech languages | Hebrew in / out | Evidence |
|---|---|---|---|---|---|---|---|---|
| Kyutai Moshi (Moshiko, Moshika) | `kyutai/moshiko-pytorch-bf16`, `kyutai/moshika-pytorch-bf16` (+ q8, MLX, Candle) | MIT (Python, web client), Apache (Rust) | CC-BY 4.0 | Yes with attribution; card also says "for research only … we do not recommend it for … any professional duty" | English | English | No / No | [VERIFIED-official] S1, S2 |
| NVIDIA PersonaPlex-7B-v1 | `nvidia/personaplex-7b-v1` (gated: accept licence) | MIT | NVIDIA Open Model License (plus CC-BY-4.0 notice for the Moshi base) | Yes — licence text: "Models are commercially usable" | English | English | No / No | [VERIFIED-official] S4, S5, S6 |
| NVIDIA NemotronLabs VoiceChat 11B | `nvidia/NVIDIA-NemotronLabs-VoiceChat-11B` | Apache-2.0 (NeMo) | OpenMDW-1.1 | Yes — licence permits dealing "without restriction" | English | English (single fixed voice) | No / No | [VERIFIED-official] S7, S8, S9 |
| Kyutai MoshiRAG | `kyutai/moshika-rag-pytorch-bf16` | MIT / Apache | CC-BY 4.0 | Yes with attribution | English | English | No / No | [VERIFIED-official] S12 |
| Haru-4B (higurashi-ai, Nov 2026) | `higurashi-ai/Haru-4B` | Apache-2.0 | Apache-2.0 | Yes; card: "pretrained base model, released for research" | en, es, pt, de, fr, zh, ja, ru, ko | Same nine | No / No | [VERIFIED-official] S19 |
| Sophon-Realtime v1 (adventists-ai, Nov 2026) | `adventists-ai/Sophon-Realtime-v1` (+ 32B-Tag, -Flash, -E2E) | Apache-2.0 | Apache-2.0; "third-party components keep their own licences" | Yes — card: "free for commercial use" | zh, en fully; it, de, es, fr, pt "ready"; ja, ru on Flash | Same | No / No | [VERIFIED-official] S20 |
| MiniCPM-o 4.5 (duplex mode) | `openbmb/MiniCPM-o-4_5` | Apache-2.0 | Apache-2.0 | Yes | Speech conversation in English and Chinese | English, Chinese | No / No | [VERIFIED-official] S27 |
| J-Moshi | `nu-dialogue/j-moshi-ext` | — | CC BY-NC 4.0 | No | Japanese | Japanese | No / No | [VERIFIED-official] S14 |
| LLM-jp-Moshi v1 | `llm-jp/llm-jp-moshi-v1` | — | Apache-2.0 | Yes | Japanese | Japanese | No / No | [VERIFIED-official] S14 |
| Moshi-Hebrew v3 LoRA | `dm15/moshi-hebrew-v3-ckpt1800` | — | None stated (base is CC-BY 4.0) | Unclear | Hebrew | Hebrew, "recognizable … but still rough" | Yes / Yes (POC quality) | [PUBLISHED-thirdparty] S15 |
| Moshika Swahili | `rlabz/quantum-s2s` | — | CC-BY 4.0 | Yes | Swahili | Swahili | No / No | [PUBLISHED-thirdparty] S15 |
| Kyutai moshika-rl-seamless | `kyutai/moshika-rl-seamless` (gated) | — | CC BY-NC 4.0 | No | English | English | No / No | [VERIFIED-official] S39 |
| Tencent Covo-Audio-Chat | `tencent/Covo-Audio-Chat` | own LICENSE file (not read) | own LICENSE file (not read) | [UNVERIFIED] | en, zh | en, zh | No / No | [VERIFIED-official] S39 |
| Freeze-Omni | `VITA-MLLM/Freeze-Omni` | [UNVERIFIED] | [UNVERIFIED] | [UNVERIFIED] | [UNVERIFIED] | [UNVERIFIED] | No evidence of Hebrew | [UNVERIFIED] S39 |
| SALMONN-omni | No public weights located | — | — | — | — | — | — | [UNVERIFIED] S39 |

### 3.2 Turn-based "omni" speech-to-speech (speech in, streamed speech out; barge-in needs external VAD)

| Model | Open weights (HF ID) | Code licence | Weights licence | Commercial use | Input languages | Output speech languages | Hebrew in / out | Evidence |
|---|---|---|---|---|---|---|---|---|
| Qwen2.5-Omni-7B | `Qwen/Qwen2.5-Omni-7B` | Apache-2.0 | Apache-2.0 | Yes | Not enumerated on card [UNVERIFIED: Chinese and English] | Two voices, Chelsie and Ethan; languages not enumerated [UNVERIFIED] | No evidence / No evidence | [VERIFIED-official] S22 |
| Qwen2.5-Omni-3B | `Qwen/Qwen2.5-Omni-3B` | — | Qwen Research License | No — "for non-commercial purposes only" | As 7B | As 7B | No evidence | [VERIFIED-official] S22 |
| Qwen3-Omni-30B-A3B (Instruct, Thinking, Captioner) | `Qwen/Qwen3-Omni-30B-A3B-Instruct` etc. | Apache-2.0 | Apache-2.0 | Yes | Card says 19 speech-input languages and lists: English, Chinese, Korean, Japanese, German, Russian, Italian, French, Spanish, Portuguese, Malay, Dutch, Indonesian, Turkish, Vietnamese, Cantonese, Arabic, Urdu. 119 text languages | 10: English, Chinese, French, German, Russian, Italian, Spanish, Portuguese, Japanese, Korean | **No / No** | [VERIFIED-official] S21 |
| Qwen3.5-Omni (Plus, Flash) and Qwen3.5-Omni-Realtime | **API only** — no repo under the `Qwen` HF org | — | Not published | Commercial API | 113 input languages and dialects | Mandarin + 28 non-Chinese languages including Hebrew | Yes / **Yes** | [VERIFIED-official] S23, S24 |
| Qwen3.8-Omni-Flash-Realtime | **API only** | — | Not published | Commercial API | 113 input languages and dialects | Same speech-output languages as Qwen3.5-Omni-Realtime; Hebrew row "Supported" | Yes / **Yes** | [VERIFIED-official] S24 |
| MiniCPM-o 2.6 | `openbmb/MiniCPM-o-2_6` | Apache-2.0 | Apache-2.0 | Yes | Speech conversation in English and Chinese | English, Chinese | No / No | [VERIFIED-official] S27 |
| GLM-4-Voice | `zai-org/glm-4-voice-9b` | Apache-2.0 | glm-4-voice licence | Only after registering with Zhipu; "Built with glm-4" notice required | Chinese, English | Chinese, English | No / No | [VERIFIED-official] S28 |
| Step-Audio 2 mini | `stepfun-ai/Step-Audio-2-mini` | Apache-2.0 | Apache-2.0 | Yes | en, zh (ASR tables also cover Japanese, Cantonese, Arabic) | en, zh | No / No | [VERIFIED-official] S29 |
| Kimi-Audio-7B-Instruct | `moonshotai/Kimi-Audio-7B-Instruct` | MIT (Qwen-derived parts Apache-2.0) | MIT | Yes | en, zh | en, zh | No / No | [VERIFIED-official] S30 |
| VITA-1.5 | `VITA-MLLM/VITA-1.5` | [UNVERIFIED] | [UNVERIFIED] | [UNVERIFIED] | English, Chinese | English, Chinese | No / No | [VERIFIED-official] S31 |
| VITA-Audio | `VITA-MLLM/VITA-Audio-*` | Tencent licence file (not read in full) | [UNVERIFIED] | [UNVERIFIED] | [UNVERIFIED] | [UNVERIFIED] | No evidence | [UNVERIFIED] S31 |
| LFM2-Audio-1.5B, LFM2.5-Audio-1.5B | `LiquidAI/LFM2-Audio-1.5B`, `LiquidAI/LFM2.5-Audio-1.5B` | LFM Open License v1.0 | LFM Open License v1.0 | Only if annual revenue is under $10M | English | English | No / No | [VERIFIED-official] S32 |
| LFM3-Audio-2B (Sep 2026) | `LiquidAI/LFM3-Audio-2B` | LFM Open License v1.0 | LFM Open License v1.0 | Only if annual revenue is under $10M | 18 speech languages including **Hebrew** (ASR, translation). Voice chat: "currently supports English only" | Same 18 including **Hebrew** (TTS) | Listed / Listed — not for voice chat | [VERIFIED-official] S32 |
| LFM3-Omni-2B (Oct 2026) | `LiquidAI/LFM3-Omni-2B` | LFM Open License v1.0 | LFM Open License v1.0 | Only if annual revenue is under $10M | Same speech list including **Hebrew**; text-language list does not include Hebrew | Same list including **Hebrew** | Listed / Listed — Hebrew dialogue quality undocumented | [VERIFIED-official] S32 |
| Baichuan-Omni-1.5 | `baichuan-inc/Baichuan-Omni-1d5` | Apache-2.0 | Apache-2.0 + Baichuan community licence | Requires an emailed application | Chinese, English | Chinese, English | No / No | [VERIFIED-official] S39 |
| OpenS2S | `CASIA-LM/OpenS2S` | Apache-2.0 | Apache-2.0 | Yes | [UNVERIFIED: English, Chinese] | [UNVERIFIED] | No evidence | [VERIFIED-official] S39 |
| LLaMA-Omni 2 | `ICTNLP/LLaMA-Omni2-*` | Apache-2.0 | Academic research only | **No** — "may NOT be used for commercial purposes" | English; Bilingual variants add Chinese | Same | No / No | [VERIFIED-official] S39 |
| Ming-3.0-audio-flash | `inclusionAI/Ming-3.0-audio-flash` | MIT | MIT | Yes | Chinese, English | Chinese, English (optional Talker) | No / No | [VERIFIED-official] S39 |

### 3.3 Speech in, text out (candidates for a half-cascade)

| Model | Open weights (HF ID) | Licence | Commercial use | Audio input languages | Speech output | Hebrew audio in | Evidence |
|---|---|---|---|---|---|---|---|
| Ultravox v0.5, v0.6, v0.7 | `fixie-ai/ultravox-v0_7-glm-4_6`, `-v0_6-llama-3_3-70b`, `-v0_6-gemma-3-27b`, `-v0_6-qwen-3-32b`, `-v0_5-llama-3_2-1b` | MIT (adapter; backbone LLM licences apply separately [ESTIMATE]) | Yes | 42 languages: ar, be, bg, bn, cs, cy, da, de, el, en, es, et, fa, fi, fr, gl, hi, hu, it, ja, ka, lt, lv, mk, mr, nl, pl, pt, ro, ru, sk, sl, sr, sv, sw, ta, th, tr, uk, ur, vi, zh | None — "takes in audio and emits streaming text" | **No** (not in list) | [VERIFIED-official] S33 |
| Voxtral Mini 3B, Voxtral Small 24B (2507) | `mistralai/Voxtral-Mini-3B-2507`, `mistralai/Voxtral-Small-24B-2507` | Apache-2.0 | Yes | en, es, fr, pt, hi, de, nl, it | None | **No** | [VERIFIED-official] S35 |
| Gemma 4 E2B, E4B, 12B | `google/gemma-4-E4B-it` etc. | Apache 2.0 | Yes | "Multilingual speech recognition … in various languages"; no list published | None | [UNVERIFIED] — not enumerated | [VERIFIED-official] S36 |
| Gemma 3n | `google/gemma-3n-E4B-it` (gated) | Gemma licence | [UNVERIFIED] | [UNVERIFIED] | None | [UNVERIFIED] | [UNVERIFIED] S36 |
| Phi-4-multimodal | `microsoft/Phi-4-multimodal-instruct` | MIT | Yes | Audio: English, Chinese, German, French, Italian, Japanese, Spanish, Portuguese (Hebrew is text-only) | None | **No** | [VERIFIED-official] S37 |
| Nemotron 3 Nano Omni 30B | `nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-BF16` | NVIDIA Open Model Agreement | Yes — "available for commercial use" | "Language support: English only" | None | **No** | [VERIFIED-official] S39 |

### 3.4 Components and non-dialogue models on the brief's list

| Model | What it is | Licence | Languages | Hebrew | Evidence |
|---|---|---|---|---|---|
| Kyutai Unmute | Cascade: Kyutai STT + any text LLM + Kyutai TTS | MIT code; STT/TTS weights CC-BY 4.0 | STT `stt-1b-en_fr` English and French; TTS `tts-1.6b-en_fr` English and French | No | [VERIFIED-official] S16, S17 |
| Kyutai Pocket TTS | CPU TTS | CC-BY 4.0 | en, fr, de, pt, it, es | No | [VERIFIED-official] S17 |
| Kyutai Hibiki | Simultaneous speech translation | CC-BY 4.0 | French to English only | No | [VERIFIED-official] S18 |
| Kyutai Hibiki-Zero | Simultaneous speech translation | CC BY-NC-SA 4.0 | fr, es, pt, de to English | No | [VERIFIED-official] S18 |
| Sesame CSM-1B | Conversational speech generation (text + audio context in, audio out) | Apache-2.0 | English | No — "likely won't do well" on other languages | [VERIFIED-official] S34 |
| Voxtral Mini 4B Realtime (2602) | Streaming ASR only | Apache-2.0 | 13: ar, de, en, es, fr, hi, it, nl, pt, zh, ja, ko, ru | No | [VERIFIED-official] S35 |
| Voxtral 4B TTS (2603) | TTS | CC BY-NC 4.0 | 9: en, fr, es, pt, it, nl, de, ar, hi | No; non-commercial | [VERIFIED-official] S35 |
| Meta SeamlessStreaming | Streaming translation and ASR | CC BY-NC 4.0 | ASR in 96 languages (metadata includes `he`); speech output in 36 target languages | Hebrew input yes; Hebrew speech output [UNVERIFIED]; non-commercial | [VERIFIED-official] S38 |

## 4. Comparison table B — runtime properties

| Model | Real-time audio streaming | Full-duplex | Barge-in | Context; how prompt and memory are injected | Tool calling / external LLM | VRAM and hardware for one stream | Published concurrency per GPU | Maturity | Evidence |
|---|---|---|---|---|---|---|---|---|---|
| Moshi | Yes; 80 ms frames; 160 ms theoretical, "as low as 200ms on an L4 GPU" | Yes | Native (always listening) | `context: 3000` frames at 12.5 Hz = 4 min [ESTIMATE from config]. No text system prompt in base model | None — card: "cannot access tools" | README: PyTorch needs "a GPU with a significant amount of memory (24GB)". bf16 weights 15.4 GB, q8 weights 8.0 GB | None. Reference Python server holds an `asyncio.Lock` with `batch_size=1`: one conversation per process | Since Sep 2024; 293k downloads of Moshiko bf16 | [VERIFIED-official] S1, S2, S3 |
| PersonaPlex-7B-v1 | Yes; same Moshi server | Yes | Native | 2048-frame context; system prompt (voice + text) pinned for the whole session; "conversation memory is still limited to a sliding window of the last ~2.5 minutes". Prompt passed as `text_prompt` and `voice_prompt` query parameters; default `--max-pinned-frames 512` (12.5 frames per second of voice prompt + 1 per text token + 11) | None | Weights 16.7 GB bf16 (8.37B parameters); `--cpu-offload` flag for smaller GPUs. Model card names an A100 80 GB as test hardware [PUBLISHED-thirdparty, search summary of the gated card] | None. Same one-conversation `asyncio.Lock` | Released Dec 2025; 322k downloads, 3,021 likes; most-liked audio-to-audio model on HF | [VERIFIED-official] S4, S5 |
| NemotronLabs VoiceChat 11B | Yes; bidirectional WebSocket, ~80 ms chunks; turn-taking latency 448 ms, interruption latency 480 ms | Yes | Native; but "the user cannot interrupt the agent during tool calling execution" | Trained on audio windows of at most 2 minutes; "context beyond this window may not be retained reliably". `session.instructions` "applied to the first inference call of the session only". System prompts and tool responses must be ASCII-only | Yes — first open full-duplex model with tool calling; OpenAI-Realtime-style events; max 5 tools recommended | "NVIDIA GPU with at least 80 GB of VRAM" (A100, H100, RTX 6000 Pro, B200); x86_64; weights 44.4 GB | None (client has a `--num-streams` load-test flag, no numbers) | Released 2026-08-03 as a "Labs" checkpoint. Known limitations include self-talk, loops, "non-recoverable gibberish after several turns", and "not suitable for noisy or highly reverberant environments" | [VERIFIED-official] S7, S8 |
| MoshiRAG | Yes | Yes | Native | Moshi context (3000 frames). Retrieved text is encoded and injected into Moshi's conditioning path | Yes — asynchronous retrieval from an external OpenAI-compatible text LLM; "sensitive to retrieval delays over 3 seconds" | Front end 24 GB GPU, plus the retrieval LLM and a streaming ASR | None | Released Mar 2026; research code | [VERIFIED-official] S12 |
| Haru-4B | Yes; 7.5 Hz frames (133 ms); ~65 ms end-to-end on a MacBook, ~15 ms per step on a B300 | Yes | Native | Character card as system turn + 3 s–3 min voice clip. Trained on conversations up to 60 minutes. "Does not follow instructions the way an assistant does" | None | "NVIDIA GPU (about 12 GB of memory)"; weights 10.5 GB | "Many concurrent conversations" via vLLM-Omni; no number | Released 2026-11-12; research base model; 951 likes in 12 days | [VERIFIED-official] S19 |
| Sophon-Realtime v1 (32B) | Yes; first audio 0.25–0.6 s | Yes (continuous listening; turn decision at each pause) | Yes; history keeps only what the user heard | LoRA fine-tuning for persona; `/v1/realtime` OpenAI-compatible API. Context limit not stated [UNVERIFIED] | Yes — FDB-v3 Pass@1 48%; "Live mode … lets it work with a larger backend model" | One 80 GB GPU for every build; 4B builds measured under a 24 GB budget | **16 users (Tag, E2E) or 40 users (Flash) per 80 GB GPU** | Released 2026-11-07; unknown vendor; 33 downloads on the main repo; untested by third parties | [VERIFIED-official] S20 |
| MiniCPM-o 4.5 | Yes; time to first token 0.6 s | Yes in duplex mode | Yes | System prompt + voice reference at session start. **Proactive**: decides at 1 Hz whether to speak | Not documented for speech mode [UNVERIFIED] | 19.0 GB bf16, 11.0 GB int4 | None | Released Feb 2026; 157k downloads | [VERIFIED-official] S27 |
| Qwen3-Omni-30B-A3B | Streaming text and speech output | No — turn-based | External VAD needed [ESTIMATE] | System prompt; vLLM examples use 32,768–65,536 max model length | Yes — audio function-call cookbook | Instruct BF16: 78.85 GB minimum for a 15 s video input; `disable_talker()` saves about 10 GB. Community int4: 20.3 GB [PUBLISHED-thirdparty, OpenBMB table] | None | Released Sep 2025; 342k downloads; vLLM-Omni serving with a "turn-based /v1/realtime endpoint" | [VERIFIED-official] S21, S26 |
| Qwen2.5-Omni-7B | Streaming | No | External VAD [ESTIMATE] | System prompt | [UNVERIFIED] | BF16: 31.11 GB minimum for a 15 s video; actual use "at least 1.2 times higher" | None | Released Mar 2025; 231k downloads | [VERIFIED-official] S22 |
| LFM3-Audio-2B, LFM3-Omni-2B | Streaming speech generation; causal encoder with incremental prefill; "time to first token … as low as 50 ms" | No — turn-based | External VAD [ESTIMATE] | 32K tokens (input + output); ChatML system prompt | Yes — tool calling from spoken requests | 2B parameters; Omni weights 4.3 GB; designed for laptops and phones | None | Sep–Oct 2026; Omni has 31k downloads | [VERIFIED-official] S32 |
| Ultravox v0.7 | Audio in, streamed text out | No | Via the surrounding pipeline | Text system prompt + `<|audio|>` token; context of the backbone LLM | Inherits backbone tool calling [ESTIMATE] | Depends on backbone (1B Llama to GLM 4.6) | None | v0.5 Feb 2025, v0.7 Dec 2025 | [VERIFIED-official] S33 |
| Voxtral Mini 3B / Small 24B | Audio in, text out | No | Via pipeline | 32k tokens; audio up to 30 min (transcription) or 40 min (understanding) | Yes — "function-calling straight from voice" (experimental in Small) | ~9.5 GB (Mini), ~55 GB (Small) | None | Jul 2025 | [VERIFIED-official] S35 |
| Gemma 4 E2B / E4B / 12B | Audio in, text out; **30-second maximum clip** | No | Via pipeline | 128K (E2B, E4B) or 256K (12B); native system role; 25 tokens per second of audio | Yes — native function calling | Small (E-series are edge models) | None | Mar–May 2026; millions of downloads | [VERIFIED-official] S36 |
| Qwen3.8-Omni-Flash-Realtime (API only) | Yes; WebSocket, WebRTC | Yes — "supports full-duplex interaction" | Yes; `semantic_vad` | 196,608 input tokens; a WebSocket session "can last up to 120 minutes"; oldest history discarded | Yes — function calling, remote MCP, web search | Not self-hostable | Rate-limited API | Hosted in China (Beijing) and Singapore regions | [VERIFIED-official] S24 |

## 5. Per-model notes

### 5.1 Kyutai Moshi and its fine-tunes

- Moshi is a 7B-class full-duplex speech-text model that models its own speech and the user's speech as parallel token streams over the Mimi codec. [VERIFIED-official] S1, S2
- Language is English only on the model card. [VERIFIED-official] S2
- Weights are CC-BY 4.0; code is MIT (Python, web client) and Apache (Rust). [VERIFIED-official] S1
- The card states the model "has limited abilities for complex tasks and cannot access tools" and "is for research only". [VERIFIED-official] S2
- Third-party benchmarking puts Moshi at 1.7% on Big Bench Audio and 61.0% on Artificial Analysis's Full Duplex Bench subset. [PUBLISHED-thirdparty] S11
- Fine-tuning path: `kyutai-labs/moshi-finetune` uses LoRA on stereo audio (one speaker per channel) transcribed to word-level JSON. [VERIFIED-official] S13
- Language-adaptation precedents:
  - J-Moshi (Japanese, CC BY-NC 4.0) and LLM-jp-Moshi v1 (Japanese, Apache-2.0); both need 24 GB VRAM. J-Moshi training used 128 V100 32 GB GPUs. [VERIFIED-official] S14
  - `rlabz/quantum-s2s` (Swahili LoRA, CC-BY 4.0). [PUBLISHED-thirdparty] S15
  - `dm15/moshi-hebrew-v3-ckpt1800`: LoRA rank 128 on Moshiko, "~5000 synthesized Hebrew dialogues", 1,800 steps on one RTX 5090, about 14 GB VRAM at inference. The author's own verdict: "Recognizable Hebrew with conversational phrasing but still rough — POC checkpoint." 30 downloads, no licence in metadata. [PUBLISHED-thirdparty] S15
- A production-grade Hebrew Moshi would need a large two-channel Hebrew conversational corpus plus a strong Hebrew TTS for synthetic dialogue. That is a research programme, not a POC task. [ESTIMATE]
- MoshiRAG (Mar 2026) keeps Moshi's full-duplex front end and calls an external text LLM asynchronously for facts. It is the cleanest open example of "native S2S front end delegating to a text LLM", but is English-only. [VERIFIED-official] S12
- No Moshi successor or multilingual Kyutai STT was found; Kyutai's 2026 speech releases are Pocket TTS (6 languages), Hibiki-Zero and MoshiRAG. [PUBLISHED-thirdparty] S41

### 5.2 Kyutai Unmute and Hibiki

- Unmute is explicitly a cascade: "a system that allows text LLMs to listen and speak by wrapping them in Kyutai's Text-to-speech and Speech-to-text models". It is not a native S2S model. [VERIFIED-official] S16
- It needs a GPU with at least 16 GB VRAM; STT uses 2.5 GB, TTS 5.3 GB, default LLM 6.1 GB. [VERIFIED-official] S16
- TTS latency is ~750 ms on a single L40S and ~450 ms with components on separate GPUs. [VERIFIED-official] S16
- Kyutai's STT server handles 64 simultaneous connections at 3x real time on an L40S, and "a H100 can process 400 streams in real-time". [VERIFIED-official] S17
- The STT and TTS models are English and French only, so Unmute cannot serve Hebrew without replacing both models. [VERIFIED-official] S17
- Hibiki translates French to English; Hibiki-Zero translates French, Spanish, Portuguese and German to English and is CC BY-NC-SA. Neither is a dialogue model. [VERIFIED-official] S18
- Hibiki-Zero's card says it "can be adapted to a new input language with less than 1000h of speech data" — a useful order of magnitude for what language adaptation costs in this model family. [VERIFIED-official] S18

### 5.3 NVIDIA PersonaPlex-7B-v1

- Built on Moshi's architecture and weights; adds persona control through a text role prompt and an audio voice prompt (16 packaged voices). [VERIFIED-official] S4
- English only (`language: en` in metadata). [VERIFIED-official] S5
- Code is MIT; weights are under the NVIDIA Open Model License, whose text says "Models are commercially usable" and "You are free to create and distribute Derivative Models". [VERIFIED-official] S4, S6
- The licence terminates if you bypass a model guardrail "without a substantially similar Guardrail appropriate for your use case". [VERIFIED-official] S6
- Memory is the binding constraint for this product:
  - The model attends to 2048 frames; the system prompt is pinned, the rest slides, so "conversation memory is still limited to a sliding window of the last ~2.5 minutes". [VERIFIED-official] S4
  - The default pinned prompt budget is 512 frames. With a 10-second voice prompt (125 frames) and 11 overhead frames, about 375 text tokens remain for role and user memory. [ESTIMATE from the README formula]
  - A 30-minute session therefore cannot recall anything said more than ~2.5 minutes ago unless an external process rewrites the prompt, which the server only reads at connection time. [ESTIMATE]
- No tool calling. [VERIFIED-official] S4
- Third-party benchmarking: 91.0% on the Full Duplex Bench subset (best open model) but 12.6% on Big Bench Audio. [PUBLISHED-thirdparty] S11
- Concurrency: the reference server serialises conversations behind one lock, so one process serves one user. No batching figures are published. [VERIFIED-official] S4

### 5.4 NVIDIA NemotronLabs VoiceChat 11B (new, August 2026)

- An 11B full-duplex model: FastConformer streaming encoder, Nemotron Nano 9B v2 backbone, TTS decoder, and a separate output channel for tool calls. [VERIFIED-official] S7
- English only; single fixed voice, no voice cloning. [VERIFIED-official] S7, S8
- OpenMDW-1.1 licence: permission "to deal in the Model Materials without restriction", with notice retention and a patent-litigation termination clause. [VERIFIED-official] S9
- Serving: an NVIDIA container (Triton + vLLM) exposing `ws://<host>:9000/v1/realtime` with OpenAI-Realtime-style events (`session.update`, `response.function_call_arguments.done`, `conversation.item.create`). [VERIFIED-official] S8
- Hardware: at least 80 GB VRAM. A community port by pipecat-ai runs a quantised build on one DGX Spark. [VERIFIED-official] S8, S10
- Limits that matter here:
  - Trained with audio context windows of at most 2 minutes. [VERIFIED-official] S8
  - "Not suitable for noisy or highly reverberant environments, especially where background speech may occur" — a direct conflict with commuter use. [VERIFIED-official] S8
  - System prompts must be ASCII-only, which rules out Hebrew text in the prompt. [VERIFIED-official] S8
  - Pipecat describes it as a "research-oriented 'Labs' checkpoint". [PUBLISHED-thirdparty] S10
- Third-party benchmarking (March 2026, earlier V1): 77.8% Full Duplex Bench subset, 29.2% Big Bench Audio. [PUBLISHED-thirdparty] S11

### 5.5 Haru-4B and Sophon-Realtime (both new, November 2026)

- Haru-4B is an Apache-2.0 full-duplex base model on a Qwen3.5-4B backbone at 7.5 Hz, pretrained on "40 million hours of real speech". [VERIFIED-official] S19
- Its data spans "over 160 languages, with a primary focus on nine"; Hebrew is not one of the nine supported languages. [VERIFIED-official] S19
- It is released for research and "does not follow instructions the way an assistant does". [VERIFIED-official] S19
- It is the most plausible open base for a future Hebrew fine-tune: permissive licence, ~12 GB VRAM, multilingual pretraining, long-conversation training. That is a hypothesis, not a tested path. [ESTIMATE]
- Sophon-Realtime v1 is an Apache-2.0 32B full-duplex family with the only published per-GPU concurrency found: 16 or 40 users per 80 GB GPU. [VERIFIED-official] S20
- Sophon supports Chinese and English fully, five European languages "ready for conversation", Japanese and Russian on one build. Hebrew is absent. [VERIFIED-official] S20
- Sophon's vendor is new and the main repository had 33 downloads at access time; every number is self-reported. Its "ears" component family, DuplexJev, is published separately under CC BY-NC 4.0, which should be checked against the Apache-2.0 claim before any commercial use. [VERIFIED-official] S20, S39

### 5.6 Qwen omni family

- **Open weights:** only Qwen2.5-Omni (7B, 3B and quantised 7B) and Qwen3-Omni-30B-A3B (Instruct, Thinking, Captioner) exist under the `Qwen` organisation on Hugging Face. [VERIFIED-official] S23
- **API only:** Qwen3-Omni-Flash, Qwen3.5-Omni (Plus, Flash, Realtime) and Qwen3.8-Omni-Flash(-Realtime) appear only in Alibaba Cloud Model Studio documentation; no weights repository was found. [VERIFIED-official] S23, S24
- The Decoder reported at launch that Alibaba "hasn't published model weights or named a license" for Qwen3.5-Omni. [PUBLISHED-thirdparty] S25
- Qwen3-Omni licence is Apache-2.0. [VERIFIED-official] S21
- Qwen3-Omni Hebrew status: absent from both the speech-input list and the 10-language speech-output list. [VERIFIED-official] S21
- Qwen3-Omni memory: 78.85 GB minimum in BF16 for the Instruct model with a 15-second video input. [VERIFIED-official] S21
- Qwen3-Omni is a Thinker–Talker turn-based design; vLLM-Omni documents a "turn-based /v1/realtime endpoint". It is not full-duplex. [VERIFIED-official] S26
- **Hosted Hebrew:** Alibaba's supported-languages table marks Hebrew "Supported" (speech and text output) for Qwen3.8-Omni-Flash-Realtime and Qwen3.5-Omni, and "Unsupported" for Qwen3-Omni-Flash. The voice list names Hebrew among 28 non-Chinese languages for the 3.8 and 3.5 series voices. [VERIFIED-official] S24
- The hosted realtime API supports full-duplex interaction, `semantic_vad`, function calling, MCP and 120-minute sessions; regions are China (Beijing) and Singapore. [VERIFIED-official] S24
- Hebrew quality of the hosted models is undocumented and untested here. [UNVERIFIED]

### 5.7 Liquid AI LFM audio models

- LFM2-Audio-1.5B and LFM2.5-Audio-1.5B: English only. [VERIFIED-official] S32
- LFM3-Audio-2B: 18 speech languages including Hebrew for transcription, synthesis and translation; voice chat "currently supports English only". [VERIFIED-official] S32
- LFM3-Omni-2B: same speech list including Hebrew; its text-language list (16 languages) omits Hebrew; its multilingual ASR benchmark covers nine languages, none of them Hebrew. [VERIFIED-official] S32
- Licence (LFM Open License v1.0): Apache-like grants, but "Commercial Use … conditioned upon You or Your Legal Entity not exceeding the Threshold" of $10M annual revenue. [VERIFIED-official] S32
- Both LFM3 models are turn-based with streaming output, 32K-token context and tool calling. [VERIFIED-official] S32
- Practical reading: possibly useful as a small Hebrew ASR or TTS component worth a quick listening test; not a Hebrew conversational S2S model. [ESTIMATE]

### 5.8 MiniCPM-o, GLM-4-Voice, Step-Audio 2, Kimi-Audio, VITA, Baichuan, others

- MiniCPM-o 4.5 (9B, Apache-2.0) is notable for a documented proactive mechanism — "decides at a frequency of 1Hz to speak or not" — and full-duplex streaming. Speech conversation is English and Chinese only. [VERIFIED-official] S27
- GLM-4-Voice: Chinese and English; commercial use requires registration with Zhipu. [VERIFIED-official] S28
- Step-Audio 2 mini: Apache-2.0, English and Chinese, tool calling and web search. [VERIFIED-official] S29
- Kimi-Audio: MIT, English and Chinese. [VERIFIED-official] S30
- VITA-1.5: English and Chinese, ~1.5 s end-to-end latency. [VERIFIED-official] S31
- Baichuan-Omni-1.5: Chinese and English; commercial licence by application. [VERIFIED-official] S39
- LLaMA-Omni 2: non-commercial. [VERIFIED-official] S39
- None of these list Hebrew. [VERIFIED-official]

### 5.9 Speech-in LLMs (Ultravox, Voxtral, Gemma, Phi-4)

- Ultravox couples a fine-tuned Whisper-large-v3-turbo encoder to a frozen text LLM through a trained adapter; it outputs text only. [VERIFIED-official] S33
- Its 42-language list (model-card metadata and the v0.5 blog) does not include Hebrew, although it includes Arabic and Persian. [VERIFIED-official] S33
- The Ultravox repo anticipates training on "your own audio data, for example to add support for a new language". [VERIFIED-official] S33
- Voxtral Mini and Small understand 8 languages, none Hebrew; Voxtral Realtime is a 13-language streaming ASR, none Hebrew; Voxtral TTS is 9 languages, none Hebrew, and CC BY-NC. Mistral has no open speech-to-speech model. [VERIFIED-official] S35
- Gemma 4 E2B, E4B and 12B accept audio but cap clips at 30 seconds and do not publish a language list. [VERIFIED-official] S36
- Phi-4-multimodal lists Hebrew for text only; audio covers 8 languages. [VERIFIED-official] S37

### 5.10 Sesame CSM and SeamlessStreaming

- CSM-1B generates speech from text plus audio context; "it cannot generate text. We suggest using a separate LLM". It is a context-aware TTS, English only. [VERIFIED-official] S34
- SeamlessStreaming is a translation and ASR model under CC BY-NC 4.0; not a dialogue model and not commercially usable. [VERIFIED-official] S38

## 6. The three explicit answers

### 6.1 Is there a Hebrew-capable open full-duplex S2S model today?

**No.** [VERIFIED-official] for each model checked; the overall negative is [UNVERIFIED] by nature.

Evidence:

1. Every open full-duplex model with an official card lists languages that exclude Hebrew: Moshi (English), PersonaPlex (English), NemotronLabs VoiceChat (English), MoshiRAG (English), Haru-4B (nine languages), Sophon-Realtime (nine languages), MiniCPM-o 4.5 (English, Chinese), J-Moshi and LLM-jp-Moshi (Japanese). [VERIFIED-official] S2, S5, S7, S12, S14, S19, S20, S27
2. A Hugging Face search for "moshi-hebrew" returns one repository, the dm15 LoRA, self-described as a rough POC. A search for Hebrew models with the audio-to-audio tag returns nothing. [PUBLISHED-thirdparty] S15
3. A web search for Hebrew audio LLMs returned only ASR and TTS models; ivrit.ai's Hugging Face organisation publishes Whisper fine-tunes, a streaming Zipformer and diarisation models, and no dialogue model. [VERIFIED-official] S40, [PUBLISHED-thirdparty] S41
4. The closest open-weight items are LFM3-Audio-2B and LFM3-Omni-2B, which list Hebrew for speech tasks but are turn-based and not documented for Hebrew dialogue. [VERIFIED-official] S32
5. The only Hebrew-capable native S2S found is hosted: Qwen3.5-Omni and Qwen3.8-Omni-Flash-Realtime. [VERIFIED-official] S24

### 6.2 Best English-only S2S reference, GPU, and how to deploy it

**Recommendation: NVIDIA PersonaPlex-7B-v1.** [ESTIMATE — a judgement from the evidence below]

Why this one:

- Best measured conversational dynamics among open models (91.0% on Artificial Analysis's Full Duplex Bench subset). [PUBLISHED-thirdparty] S11
- Persona and voice are set by a text prompt and a voice prompt, which is the closest open analogue to a companion persona. [VERIFIED-official] S4
- Commercially usable licence, MIT code, and the largest user base of any open full-duplex model. [VERIFIED-official] S5, S6
- It fits on one mid-size GPU, unlike VoiceChat (80 GB) and Sophon-32B (80 GB). [VERIFIED-official] S5, S8, S20

What it will not show: reasoning quality (12.6% Big Bench Audio), tool use, or memory beyond ~2.5 minutes. [PUBLISHED-thirdparty] S11, [VERIFIED-official] S4

GPU:

- Weights are 16.7 GB in bf16. [VERIFIED-official] S5
- A 24 GB card (L4, A10G, RTX 4090) should hold one session; a 48 GB L40S or an A100 gives safe headroom. [ESTIMATE]
- The upstream Moshi README states a 24 GB requirement and 200 ms practical latency on an L4. [VERIFIED-official] S1
- NVIDIA's card names an A100 80 GB as test hardware. [PUBLISHED-thirdparty] S41
- One server process serves one conversation. [VERIFIED-official] S4

Deployment:

```bash
sudo apt install libopus-dev
git clone https://github.com/NVIDIA/personaplex && cd personaplex
pip install moshi/.
export HF_TOKEN=<token for an account that accepted the model licence>
SSL_DIR=$(mktemp -d); python -m moshi.server --ssl "$SSL_DIR"   # add --cpu-offload on small GPUs
```

[VERIFIED-official] S4

Protocol, read from `moshi/moshi/server.py`: [VERIFIED-official] S4

- HTTPS web UI on port 8998; WebSocket endpoint `/api/chat`.
- Session parameters are query-string values: `text_prompt`, `voice_prompt` (for example `NATF2.pt`), optional `seed`.
- Binary frames with a one-byte type prefix: `0x00` handshake (server ready), `0x01` Opus-encoded audio in either direction, `0x02` UTF-8 text tokens from the model.
- Audio is 24 kHz mono in Mimi frames of 80 ms. [VERIFIED-official] S1

Alternative if an 80 GB GPU is available and tool calling matters: NemotronLabs VoiceChat 11B. [VERIFIED-official] S8

```bash
ngc registry model download-version nim/nvidia/nemotron-labs-voicechat:1.0.0
docker run -it --rm --runtime=nvidia --gpus '"device=0"' --shm-size=8GB \
  -e NIM_HTTP_API_PORT=9000 -p 9000:9000 \
  -v $(pwd)/nemotron-labs-voicechat_v1.0.0:/data/models \
  --entrypoint /s2s/run_s2s_server.sh nvcr.io/nim/nvidia/nemotron-labs-voicechat:latest
# health: curl http://localhost:9000/v1/realtime/health ; client: ws://localhost:9000/v1/realtime
```

- Client audio is 24 kHz PCM16 in ~80 ms chunks, base64 in JSON events. [VERIFIED-official] S8
- Sophon-Realtime (`pip install "sophon-realtime[trt]"; sophon-realtime serve`, port 8000) is the one to watch for cost per user, but is too new to recommend. [VERIFIED-official] S20

Cost framing: cost per conversation-minute = GPU price per hour ÷ 60 ÷ concurrent sessions. With one session per GPU, PersonaPlex cannot reach "very low cost per minute"; at an assumed $0.5–1 per hour for a 24 GB cloud GPU that is roughly $0.01–0.02 per minute at 100% utilisation, before idle capacity. [ESTIMATE — GPU prices not checked today]

### 6.3 Which half-cascade designs are viable for Hebrew?

**Self-hosted, off the shelf: none with documented Hebrew audio understanding.** [VERIFIED-official]

| Speech-in model | Hebrew audio documented? | Verdict for Hebrew half-cascade | Evidence |
|---|---|---|---|
| Ultravox v0.5–v0.7 | No (42 languages, Hebrew absent) | Not viable as shipped; viable for English | [VERIFIED-official] S33 |
| Qwen3-Omni (open, talker disabled) | No (speech-input list excludes Hebrew) | Not viable | [VERIFIED-official] S21 |
| Voxtral Mini / Small | No (8 languages) | Not viable | [VERIFIED-official] S35 |
| Phi-4-multimodal | No (8 audio languages) | Not viable | [VERIFIED-official] S37 |
| Nemotron 3 Nano Omni | No (English only) | Not viable | [VERIFIED-official] S39 |
| Gemma 4 E2B / E4B / 12B | Not stated; 30 s clip limit | Unproven; would need a Hebrew test | [VERIFIED-official] S36 |
| LFM3-Omni-2B / LFM3-Audio-2B | Hebrew listed for speech tasks | Only as an ASR or TTS component; 2B model, Hebrew not a text language, revenue-capped licence | [VERIFIED-official] S32 |
| Qwen3.5-Omni / Qwen3.8-Omni-Flash (hosted) | Yes (113 input languages; Hebrew speech output) | Viable but hosted; belongs in the hosted-API comparison | [VERIFIED-official] S24 |

What is viable:

1. **Hosted speech-in LLM + separate Hebrew TTS.** Viable in principle; evaluated in the hosted-API report, not here. [ESTIMATE]
2. **Self-hosted "half-cascade" for Hebrew collapses into the full cascade**: streaming Hebrew ASR (for example ivrit.ai Whisper or Zipformer models) + text LLM + Hebrew TTS. That is Architecture A, not C. [ESTIMATE] S40
3. **Fine-tuning Ultravox for Hebrew** is technically plausible: its encoder is Whisper-large-v3-turbo, for which Hebrew fine-tunes exist (`ivrit-ai/whisper-large-v3-turbo`), and its repo supports adding a language. It is a training project with unknown data needs and quality. [ESTIMATE] S33, S40
4. **English half-cascade** (Ultravox v0.7 + a streaming TTS) is viable today and is a sensible English baseline alongside PersonaPlex. [VERIFIED-official] S33

On the TTS half: none of the open speech-output models on the brief's list speaks Hebrew — Kyutai TTS (English, French), Pocket TTS (6 languages), Voxtral TTS (9 languages, non-commercial), Sesame CSM (English). Hebrew TTS must come from the dedicated TTS research. [VERIFIED-official] S17, S34, S35

## 7. Go / no-go recommendation for Architecture C

**NO-GO as a candidate architecture for the Hebrew + English product.** Document it as a limitation, as the brief instructs.

Reasons, in order of weight:

1. **Hebrew.** No open full-duplex S2S model supports it. [VERIFIED-official]
2. **Session memory.** The mature open models retain 2–4 minutes of audio context (Moshi 4 min, PersonaPlex ~2.5 min, VoiceChat 2 min) against a 30-minute requirement, and accept only a few hundred tokens of injected prompt. [VERIFIED-official] S3, S4, S8
3. **Intelligence.** Open full-duplex models score far below text LLMs on speech reasoning (PersonaPlex 12.6%, VoiceChat 29.2% on Big Bench Audio); Artificial Analysis notes that open-weight S2S models "still significantly underperform leading proprietary offerings". [PUBLISHED-thirdparty] S11, S41
4. **Cost at scale.** The reference servers for Moshi and PersonaPlex serve one conversation per process; VoiceChat needs an 80 GB GPU. The only published concurrency (Sophon, 16–40 users per 80 GB GPU) is an unvetted vendor claim for a model with no Hebrew. [VERIFIED-official] S3, S4, S8, S20
5. **Noise robustness.** NVIDIA states VoiceChat is "not suitable for noisy or highly reverberant environments", which is the commuter setting. [VERIFIED-official] S8

Recommended actions:

- **Do not build** the product on Architecture C in this POC.
- **Optional, time-boxed (about half a day, one GPU):** stand up PersonaPlex-7B-v1 in English to record a reference for turn-taking latency, barge-in feel and naturalness against the cascade and hosted candidates. Do not extend it with memory or tools.
- **Take one design idea forward:** MoshiRAG and Sophon's "Live mode" both pair a fast full-duplex front end with a slower, smarter text LLM. That split (reflex layer + reasoning layer) is worth copying in a cascade design. [VERIFIED-official] S12, S20
- **Flag for the hosted-API comparison:** Qwen3.8-Omni-Flash-Realtime officially supports Hebrew speech output with full-duplex and 120-minute sessions. Data residency (Beijing, Singapore) and Hebrew quality need checking. [VERIFIED-official] S24
- **Optional 1-hour listening test:** LFM3-Omni-2B Hebrew ASR and TTS quality, purely as a component data point. [ESTIMATE]

What would reopen the decision:

- Alibaba releasing Qwen3.5-Omni or Qwen3.8-Omni weights (Qwen3-Omni was released under Apache-2.0, so there is precedent). [VERIFIED-official] S21
- A vendor-grade Hebrew fine-tune of Moshi, PersonaPlex or Haru-4B.
- A funded fine-tuning effort with several hundred to a few thousand hours of Hebrew conversational audio; Hibiki-Zero's "<1000h" figure for adding an input language is the only published order of magnitude found, and it is for translation, not dialogue. [VERIFIED-official] S18, [ESTIMATE]

## 8. Sources

All accessed 2026-11-24. Hugging Face model cards were read as raw README files (`https://huggingface.co/<id>/raw/main/README.md`) and API metadata (`https://huggingface.co/api/models/<id>`).

- **S1** Kyutai Moshi README — https://raw.githubusercontent.com/kyutai-labs/moshi/main/README.md (repo: https://github.com/kyutai-labs/moshi)
- **S2** Moshi model cards — https://huggingface.co/kyutai/moshiko-pytorch-bf16 ; https://huggingface.co/kyutai/moshika-pytorch-bf16 ; https://huggingface.co/kyutai/moshiko-pytorch-q8
- **S3** Moshi source — https://raw.githubusercontent.com/kyutai-labs/moshi/main/moshi/moshi/server.py ; https://raw.githubusercontent.com/kyutai-labs/moshi/main/moshi/moshi/models/loaders.py ; https://raw.githubusercontent.com/kyutai-labs/moshi/main/rust/README.md
- **S4** NVIDIA PersonaPlex README and server — https://raw.githubusercontent.com/NVIDIA/personaplex/main/README.md ; https://raw.githubusercontent.com/NVIDIA/personaplex/main/moshi/moshi/server.py
- **S5** PersonaPlex Hugging Face metadata (card gated, HTTP 401) — https://huggingface.co/nvidia/personaplex-7b-v1 ; https://huggingface.co/api/models/nvidia/personaplex-7b-v1
- **S6** NVIDIA Open Model License Agreement (last modified October 24, 2025) — https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/
- **S7** NVIDIA NemotronLabs VoiceChat 11B model card — https://huggingface.co/nvidia/NVIDIA-NemotronLabs-VoiceChat-11B
- **S8** NVIDIA-NeMo/Speech, branch `nemotron-labs-voicechat` — https://raw.githubusercontent.com/NVIDIA-NeMo/Speech/nemotron-labs-voicechat/README.md ; `.../voicechat_realtime_instructions/prerequisites.md` ; `.../deploy.md` ; `.../api-reference.md`
- **S9** OpenMDW License 1.1 — https://raw.githubusercontent.com/OpenMDW/OpenMDW/main/1.1/LICENSE.OpenMDW-1.1
- **S10** Pipecat DGX Spark port — https://raw.githubusercontent.com/pipecat-ai/nemotron-voicechat-dgx-spark/main/README.md ; https://huggingface.co/pipecat-ai/NVIDIA-NemotronLabs-VoiceChat-11B-Spark
- **S11** Artificial Analysis, "NVIDIA Nemotron 3 VoiceChat: Leading the Open Weights Frontier…", March 13, 2026 — https://artificialanalysis.ai/articles/nemotron-3-voicechat-leader-speech-pareto
- **S12** Kyutai MoshiRAG — https://huggingface.co/kyutai/moshika-rag-pytorch-bf16 ; https://raw.githubusercontent.com/kyutai-labs/moshi-rag/main/README.md
- **S13** Kyutai moshi-finetune — https://raw.githubusercontent.com/kyutai-labs/moshi-finetune/main/README.md
- **S14** J-Moshi — https://huggingface.co/nu-dialogue/j-moshi-ext ; LLM-jp-Moshi — https://huggingface.co/llm-jp/llm-jp-moshi-v1
- **S15** Community Moshi fine-tunes — https://huggingface.co/dm15/moshi-hebrew-v3-ckpt1800 ; https://huggingface.co/rlabz/quantum-s2s ; search https://huggingface.co/api/models?search=moshi-hebrew
- **S16** Kyutai Unmute — https://raw.githubusercontent.com/kyutai-labs/unmute/main/README.md ; https://raw.githubusercontent.com/kyutai-labs/unmute/main/LICENSE
- **S17** Kyutai STT and TTS — https://raw.githubusercontent.com/kyutai-labs/delayed-streams-modeling/main/README.md ; https://huggingface.co/kyutai/stt-1b-en_fr ; https://huggingface.co/kyutai/tts-1.6b-en_fr ; https://huggingface.co/api/models/kyutai/pocket-tts
- **S18** Kyutai Hibiki — https://huggingface.co/kyutai/hibiki-1b-pytorch-bf16 ; Hibiki-Zero — https://huggingface.co/kyutai/hibiki-zero-3b-pytorch-bf16
- **S19** Haru-4B — https://huggingface.co/higurashi-ai/Haru-4B ; https://raw.githubusercontent.com/higurashi-ai/Haru/main/README.md ; https://blog.higurashi.ai/melte/haru4b/
- **S20** Sophon-Realtime v1 — https://huggingface.co/adventists-ai/Sophon-Realtime-v1 ; https://raw.githubusercontent.com/adventists-ai/sophon-realtime/main/README.md
- **S21** Qwen3-Omni — https://huggingface.co/Qwen/Qwen3-Omni-30B-A3B-Instruct ; https://raw.githubusercontent.com/QwenLM/Qwen3-Omni/main/README.md
- **S22** Qwen2.5-Omni — https://huggingface.co/Qwen/Qwen2.5-Omni-7B (and `/raw/main/LICENSE`) ; https://huggingface.co/Qwen/Qwen2.5-Omni-3B (and `/raw/main/LICENSE`)
- **S23** Hugging Face listing of Qwen omni repositories — https://huggingface.co/api/models?author=Qwen&search=Omni
- **S24** Alibaba Cloud Model Studio documentation — https://help.aliyun.com/en/model-studio/omni/ ; https://help.aliyun.com/en/model-studio/realtime ; https://help.aliyun.com/en/model-studio/omni-voice-list
- **S25** The Decoder on Qwen3.5-Omni (search summary; weights statement not found in the fetched page text) — https://the-decoder.com/qwen3-5-omni-learned-to-write-code-from-spoken-instructions-and-video-without-anyone-training-it-to/
- **S26** vLLM-Omni, Qwen3-Omni online serving — https://docs.vllm.ai/projects/vllm-omni/en/latest/user_guide/examples/online_serving/qwen3_omni/
- **S27** MiniCPM-o — https://huggingface.co/openbmb/MiniCPM-o-4_5 ; https://huggingface.co/openbmb/MiniCPM-o-2_6
- **S28** GLM-4-Voice — https://huggingface.co/zai-org/glm-4-voice-9b (and `/raw/main/LICENSE`) ; https://raw.githubusercontent.com/zai-org/GLM-4-Voice/main/README.md
- **S29** Step-Audio 2 mini — https://huggingface.co/stepfun-ai/Step-Audio-2-mini ; Step-Audio R1.1 — https://huggingface.co/stepfun-ai/Step-Audio-R1.1
- **S30** Kimi-Audio — https://huggingface.co/moonshotai/Kimi-Audio-7B-Instruct
- **S31** VITA — https://raw.githubusercontent.com/VITA-MLLM/VITA/main/README.md ; VITA-Audio — https://raw.githubusercontent.com/VITA-MLLM/VITA-Audio/main/README.md
- **S32** Liquid AI — https://huggingface.co/LiquidAI/LFM3-Omni-2B (and `/raw/main/LICENSE`) ; https://huggingface.co/LiquidAI/LFM3-Audio-2B ; https://huggingface.co/LiquidAI/LFM2.5-Audio-1.5B ; https://huggingface.co/LiquidAI/LFM2-Audio-1.5B ; https://raw.githubusercontent.com/Liquid4All/liquid-audio/main/README.md ; https://www.liquid.ai/blog/lfm3
- **S33** Ultravox — https://huggingface.co/fixie-ai/ultravox-v0_7-glm-4_6 ; https://huggingface.co/fixie-ai/ultravox-v0_6-llama-3_3-70b ; https://raw.githubusercontent.com/fixie-ai/ultravox/main/README.md ; https://www.ultravox.ai/blog/ultravox-v0-5-taking-the-lead-in-speech-understanding
- **S34** Sesame CSM — https://raw.githubusercontent.com/SesameAILabs/csm/main/README.md ; https://huggingface.co/api/models/sesame/csm-1b
- **S35** Mistral Voxtral — https://huggingface.co/mistralai/Voxtral-Mini-3B-2507 ; https://huggingface.co/mistralai/Voxtral-Small-24B-2507 ; https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602 ; https://huggingface.co/mistralai/Voxtral-4B-TTS-2603
- **S36** Gemma — https://huggingface.co/google/gemma-4-E4B-it ; https://ai.google.dev/gemma/docs/capabilities/audio ; https://huggingface.co/api/models/google/gemma-3n-E4B-it
- **S37** Phi-4-multimodal — https://huggingface.co/microsoft/Phi-4-multimodal-instruct
- **S38** Meta Seamless — https://huggingface.co/facebook/seamless-streaming ; https://raw.githubusercontent.com/facebookresearch/seamless_communication/main/README.md
- **S39** Other models — https://huggingface.co/baichuan-inc/Baichuan-Omni-1d5 ; https://raw.githubusercontent.com/CASIA-LM/OpenS2S/main/README.md ; https://raw.githubusercontent.com/VITA-MLLM/Freeze-Omni/main/README.md ; https://raw.githubusercontent.com/ictnlp/LLaMA-Omni2/main/README.md ; https://huggingface.co/tencent/Covo-Audio-Chat ; https://huggingface.co/inclusionAI/Ming-3.0-audio-flash ; https://huggingface.co/nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-BF16 ; https://huggingface.co/adventists-ai/DuplexJev-4B-Para ; https://huggingface.co/api/models/kyutai/moshika-rl-seamless ; https://huggingface.co/kyutai/glm-4-voice-of-reason-9b ; SALMONN-omni: no repository found at `bytedance/SALMONN-omni` (404) or via https://huggingface.co/api/models?search=salmonn
- **S40** ivrit.ai models — https://huggingface.co/api/models?author=ivrit-ai
- **S41** Web-search summaries of pages that could not be opened directly: arXiv 2609.21967 (VoiceChat), 2602.06053 (PersonaPlex), 2604.15804 (Qwen3.5-Omni), 2410.00037 (Moshi); the gated PersonaPlex model card (commercial-use statement, A100 80 GB test hardware); Artificial Analysis Speech-to-Speech Index announcement (https://artificialanalysis.ai/articles/announcing-the-artificial-analysis-speech-to-speech-index); kyutai.org blog and STT pages; NYU Shanghai RITS summaries of VoiceChat and Qwen3.5-Omni
