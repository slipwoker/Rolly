# Model and provider comparison matrix

Project: Rolly voice companion POC (Hebrew + English). Status date: 2026-11-24.
Sources: the six research reports in `docs/research/` (01–06) and files on disk under `models/`, `.venv` and `config/`. Nothing in this document was measured by the POC; measured results are reported separately.

## Reading guide

**Verification column.** One of: VERIFIED-official (read on the owner's own page, SDK, card or licence by the research), PUBLISHED-thirdparty, ESTIMATE (arithmetic or judgement), UNVERIFIED (no primary source reached, or sources conflict), local file (read from a file in this repository), not researched (reports silent). Where a row mixes statuses, each is named. No status has been upgraded; where two reports disagree on a status, the weaker one is used.

**Architectures.** A = commercial realtime speech-to-speech API. B = self-hosted modular pipeline (VAD, STT, LLM, TTS). C = self-hosted open speech-to-speech model. D = hybrid (self-hosted VAD, STT and TTS with a commercial LLM). These labels follow `config/providers.yaml`.

**Cost assumptions.** Tables keep each report's own assumptions; they are not identical across layers. Report 01: 40% user speech, 40% agent speech, 4 turns per minute, 1,500-token prompt. Report 03: 900 English or 750 Hebrew characters per generated minute, agent speaks about 50% of a conversational minute. Report 05: 3 turns per minute, 5,000 input and 60 output tokens per turn. The all-in target used by the reports is $0.005 per conversational minute.

---

## A. Commercial realtime voice APIs

All $/min figures are ESTIMATE unless the Notes say otherwise. "Min 1" is the first minute of a session; "30-min avg" is the mean per-minute cost over a 30-minute session.

| Model | Price basis | Est. $/min, min 1 | Est. $/min, 30-min avg | Hebrew status | Barge-in control | Session limit | Notes | Verification | POC decision |
|---|---|---|---|---|---|---|---|---|---|
| OpenAI Realtime `gpt-realtime-2.1` | Per 1M tokens: audio $32 in / $0.40 cached / $64 out; text $4 / $0.40 / $24 | $0.060 cached; $0.099 uncached | $0.077 ideal cache; $1.45 no caching | Not stated by OpenAI; mixed community reports | `server_vad` / `semantic_vad`, `interrupt_response`, `response.cancel`, `conversation.item.truncate` | 60 min | Cache hit rate is the main cost risk: 90% effectiveness gives $0.215. `far_field` noise reduction and `idle_timeout_ms` available | PUBLISHED-thirdparty (prices); VERIFIED-official (protocol); UNVERIFIED (Hebrew, session limit); ESTIMATE ($/min) | **Implemented as baseline; not yet run live (no API key)** |
| OpenAI Realtime `gpt-realtime-2.1-mini` | Per 1M tokens: audio $10 / $0.30 / $20; text $0.60 / $0.06 / $2.40 | $0.017 cached; $0.027 uncached | $0.030 ideal cache; $0.45 no caching | Same as above | Same as above | 60 min | Same code path as `gpt-realtime-2.1` | PUBLISHED-thirdparty (prices); UNVERIFIED (Hebrew, session limit); ESTIMATE ($/min) | **Implemented as cost variant; not yet run live** |
| OpenAI GPT-Live `gpt-live-1`, `gpt-live-1.1` | $0.05/min active; $0.02/min standby (WebRTC only) | $0.050 | $0.050 | No language list published | Handled inside the model; no cancel, truncate or commit events | A limit exists; value not found | Full duplex. Concurrency 25–500 by tier (PUBLISHED-thirdparty). Report 05 tags this price VERIFIED-official; report 01 tags it UNVERIFIED | UNVERIFIED (price, Hebrew); VERIFIED-official (protocol, limit exists) | Not implemented; suggested as a one-hour Hebrew spike |
| Google `gemini-3.8-live` | Per 1M tokens: audio $3 in / $12 out; text $0.75 / $4.50; no cached price; 25 tokens/s; context re-billed every turn | $0.019 | $0.23 no compression; $0.17 cookbook compression; $0.06 tight window | Listed as supported (`he`); a forum thread reports a Hebrew regression | `START_OF_ACTIVITY_INTERRUPTS`; server sends `interrupted`; no client cancel or truncate | About 15 min audio without compression; about 10 min per connection | 30-minute sessions need compression plus reconnect with resumption | VERIFIED-official (prices, protocol); UNVERIFIED (Hebrew listing, session limits); PUBLISHED-thirdparty (regression report); ESTIMATE ($/min) | **Implemented as baseline; not yet run live (no API key)** |
| Alibaba Qwen3.8-Omni-Flash-Realtime | not researched | not researched | not researched | Hebrew speech output listed as "Supported"; quality untested | Full duplex; `semantic_vad` | 120 min | Hosted in Beijing and Singapore regions; weights not published | VERIFIED-official (features); UNVERIFIED (Hebrew quality) | Not implemented; flagged for a later hosted comparison |
| ElevenLabs Agents | $0.08/min + LLM | about $0.09 | about $0.09–0.10 | Likely yes, depends on TTS model | not researched | not researched | Cascade, not native speech-to-speech | PUBLISHED-thirdparty (price); UNVERIFIED (Hebrew) | Not selected |
| Deepgram Voice Agent API | $0.075/min standard; $0.065 with own TTS (sources conflict) | $0.075 | $0.075 | STT yes; TTS not confirmed | not researched | not researched | Cascade | PUBLISHED-thirdparty (price); UNVERIFIED (Hebrew) | Not selected |
| Hume EVI (3, 4-mini) | about $0.02–0.06/min by plan | $0.02–0.06 | $0.02–0.06 | No; not in published list | not researched | not researched | — | PUBLISHED-thirdparty | Not selected (no Hebrew) |
| Amazon Nova 2 Sonic | Per 1M tokens: speech $3 in / $12 out | $0.009–0.023 audio only | Unknown | No; 7 languages | not researched | Not confirmed | — | PUBLISHED-thirdparty (price); UNVERIFIED (languages) | Not selected (no Hebrew) |
| Azure Voice Live | Token tiers; rates not retrievable | Not computable | Not computable | Listed | not researched | 30 min reported for Azure OpenAI realtime | Managed wrapper over OpenAI realtime and Azure Speech | UNVERIFIED; PUBLISHED-thirdparty (session limit) | Not selected |
| xAI Grok Voice `grok-voice-3.0` | $0.08/min (some pages say $0.05) | $0.05–0.08 | $0.05–0.08 | Unknown | not researched | not researched | — | PUBLISHED-thirdparty (price, conflicting); UNVERIFIED (Hebrew) | Not selected |
| Cartesia Line | $0.03 or $0.06/min + LLM (conflict) | $0.035–0.07 | $0.04–0.08 | TTS yes; streaming STT reportedly English-only | not researched | not researched | Cascade | UNVERIFIED | Not selected |
| Vapi | $0.05/min hosting + STT + LLM + TTS | $0.08–0.13 | $0.08–0.13 | Depends on components | not researched | not researched | Orchestrator | PUBLISHED-thirdparty | Not selected |
| Retell AI | $0.07–0.31/min | about $0.125 | about $0.125 | Hebrew not named | not researched | not researched | Orchestrator | PUBLISHED-thirdparty; UNVERIFIED (Hebrew) | Not selected |
| Ultravox Realtime (hosted) | $0.05/min | $0.050 | $0.050 | No; `he` absent from the v0.7 card | not researched | not researched | — | UNVERIFIED (price); VERIFIED-official (languages) | Not selected (no Hebrew) |

Cost targets (ESTIMATE): $0.05/min is reachable with `gpt-realtime-2.1-mini` (cached, bounded context), `gpt-live-1.1`, or `gemini-3.8-live` with a tight context window. $0.01/min and below are not reachable with any commercial speech-to-speech API; Gemini's audio-only floor is $0.009/min before any prompt or history.

---

## B. Speech-to-text

Hebrew WER is from the ivrit.ai leaderboard as "eval-d1 / eval-whatsapp" (podcast / phone voice notes), lower is better. No test set is in-car, noisy or code-switched. Leaderboard rows for commercial APIs date from May 2026 or earlier.

### B1. Self-hosted

| Model | Hebrew | Streaming | Licence | Published Hebrew WER (d1 / wa) | Footprint | Verification | POC decision |
|---|---|---|---|---|---|---|---|
| `ivrit-ai/whisper-large-v3-turbo-ct2` on faster-whisper 1.2.1 | Yes (Hebrew fine-tune; language detection degraded, set `language='he'`) | No; decode on VAD endpoint | Apache-2.0 | 5.3 / 7.1 | 809M params, 1.62 GB. 0–5 s utterance p50: 231 ms L40S, 325 ms A10, 405 ms L4 | VERIFIED-official | **Used: primary Hebrew STT** |
| `deepdml/faster-whisper-large-v3-turbo-ct2` (stock `openai/whisper-large-v3-turbo`) | Yes (99 languages) | No | MIT | 8.4 / 12.8 (stock large-v3-turbo row) | 809M params; L4: 31.5–41× real time, 1.1–2.3 GB VRAM | VERIFIED-official (base model); PUBLISHED-thirdparty (WER, throughput); local file (card licence) | **Used: benchmark arm (stock OpenAI large-v3-turbo)** |
| `Systran/faster-whisper-small` | Hebrew in card language list | No | MIT per cached card | not researched | not researched | local file | **Used: benchmark arm (CPU default)** |
| `ivrit-ai/whisper-large-v3-ct2` | Yes | No | Apache-2.0 | 5.1 / 7.2 | 1.55B params; about 2× slower than turbo | VERIFIED-official | Not selected (slower, same accuracy) |
| `ivrit-ai/zipformer2-66m-streaming-he` | Yes; English weak | Yes, 1.28 s chunks | CC BY 4.0 | 5.1 / 8.9 on card; 5.3 / 8.8 leaderboard (int8) | 66M; CPU or on-device | VERIFIED-official (self-reported WER) | Not selected; challenger |
| `MaorB/embeddinggemma-2-asr-hebrew-english-streaming` | Yes + English | Yes, 0.24 s steps | Apache-2.0 | Batch 5.8 / 10.3; streaming 6.5 / 11.7 | 351M; about 256 streams (fast) on one RTX 5090 | VERIFIED-official (self-reported) | Not selected; challenger (weeks old, single author) |
| `thewh1teagle/parakeet-tdt-0.6b-v3-he` | Yes; Hebrew only | Offline TDT | CC BY 4.0 | 6.1 / 8.8 | 0.6B | VERIFIED-official (self-reported WER) | Not selected |
| `nvidia/nemotron-3.5-asr-streaming-0.6b` | Needs fine-tuning | Yes, 80–1120 ms chunks | OpenMDW-1.1 | 17.1 / 36.5 out of the box | 600M; H100: about 240 streams at 80 ms | VERIFIED-official; PUBLISHED-thirdparty (WER) | Not selected; long-term fine-tune option |
| `openai/whisper-large-v3` | Yes | No | Apache-2.0 on HF card, MIT in GitHub | 9.8 / 13.2 | 1.55B; L4 15.5× real time | VERIFIED-official; PUBLISHED-thirdparty (WER) | Not selected |
| `nvidia/parakeet-tdt-0.6b-v3`, `nvidia/canary-1b-v2` | No | Offline | CC BY 4.0 | — | — | VERIFIED-official | Not selected (no Hebrew) |
| `facebook/mms-1b-all` | Yes | No | CC BY-NC 4.0 | — | 1B | VERIFIED-official | Excluded (non-commercial) |
| `Hebrish/*` | English with Hebrew words | Some | CC BY-NC 4.0, gated | Not readable | 0.6B | VERIFIED-official | Excluded (non-commercial) |
| Qwen3-ASR, Voxtral Realtime, Kyutai STT, Moonshine, Granite Speech, Phi-4-multimodal | No Hebrew audio | Varies | Apache-2.0 / CC BY 4.0 / MIT | — | — | VERIFIED-official | Not selected (no Hebrew) |

Self-hosted STT cost (ESTIMATE; inputs published, not measured): about $0.00045 per conversational minute on L4 and $0.00060 on L40S in endpoint-then-decode mode; adding interim partial decodes raises it to about $0.002–0.003. No source publishes concurrent stream counts for faster-whisper on L4 or A10.

### B2. Commercial streaming APIs

| Model | Hebrew | Streaming | Hebrew–English code-switching | Published Hebrew WER (d1 / wa) | Price per audio minute | Verification | POC decision |
|---|---|---|---|---|---|---|---|
| Soniox `stt-rt-v6` | Yes | Yes | Yes, mid-sentence | 4.8 / 9.0 (run predates v6) | $0.0020 ($0.12/h) | VERIFIED-official (price, features); PUBLISHED-thirdparty (WER) | Not implemented; recommended fallback |
| Deepgram Nova-3 (`language=he`) | Yes | Yes | Not in mono mode | 6.7 / 12.0 | $0.0048 (promotional) | VERIFIED-official; PUBLISHED-thirdparty (WER) | Not implemented; secondary fallback |
| Deepgram Nova-3 Multilingual | Yes | Yes | Yes | Not on leaderboard | $0.0058 (promotional) | VERIFIED-official | Not implemented |
| ElevenLabs Scribe v3 Live | Yes | Yes | Multilingual mode | Not on leaderboard | $0.0037 | VERIFIED-official | Not implemented |
| Speechmatics Melia 1 | Yes | Yes | Mid-sentence switching | Not on leaderboard | $0.0033 | VERIFIED-official | Not implemented |
| AssemblyAI `AssemblyAI-STT-3.7-Realtime` | Yes | Yes | Yes | Not on leaderboard | $0.0050 | VERIFIED-official | Not implemented |
| Google Speech-to-Text V2 / Chirp 3 | Preview (`iw-IL`) | Yes | Not documented | 21.1 / 35.2 (older model) | $0.0160 | VERIFIED-official; PUBLISHED-thirdparty (WER) | Not selected (price, Preview) |
| Azure Speech real-time | Yes (`he-IL`) | Yes | Not verified | Not on leaderboard | $0.0167 | VERIFIED-official | Not selected (price) |
| OpenAI `gpt-live-transcribe` | Language list did not render | Yes | Accepts multiple language hints | Not on leaderboard | $0.0170 | VERIFIED-official (price); UNVERIFIED (Hebrew) | Not selected (price) |
| OpenAI `gpt-transcribe` | Unconfirmed | File and realtime sessions | — | — | $0.0045 | VERIFIED-official (price); UNVERIFIED (Hebrew) | Configured only as the input-transcription model of the OpenAI Realtime baseline |
| Groq `whisper-large-v3-turbo` | Yes (stock Whisper) | No (file API) | Whisper behaviour | 8.4 / 12.8 (same model self-hosted) | $0.00067 | VERIFIED-official; PUBLISHED-thirdparty (WER) | Not selected (not streaming) |
| Amazon Transcribe streaming | Yes | Yes | — | 7.9 / 12.9 | Price did not render | PUBLISHED-thirdparty (WER); UNVERIFIED (price) | Not selected |

### B3. VAD and turn detection

| Component | Licence | Hebrew | Notes | Verification | POC decision |
|---|---|---|---|---|---|
| Silero VAD | MIT | Language-agnostic | Under 1 ms per 30 ms chunk on one CPU thread | VERIFIED-official | **Used (ONNX file on ONNX Runtime)** |
| Pipecat Smart Turn v3.2 | BSD-2-Clause | Not among its 23 languages | Audio-native, 8M params; transfer to Hebrew unproven | VERIFIED-official | Not used; production candidate after Hebrew validation |
| LiveKit turn detector | LiveKit Model License | No (14 languages) | LiveKit Agents only | VERIFIED-official | Not used |
| TEN VAD | Apache-2.0 with non-compete condition | Language-agnostic | Needs legal review | VERIFIED-official | Not used |
| Soniox semantic endpointing | Commercial API | Hebrew quality unconfirmed | Part of `stt-rt-v6` | UNVERIFIED | Not used |

---

## C. Text-to-speech

Price per generated minute is ESTIMATE in every row (list price × assumed characters per minute, or vendor throughput ÷ assumed hardware price). Halve it for cost per conversational minute. No audio quality claim is the research's own; nothing was listened to by the research.

### C1. Self-hosted

| Model | Hebrew | English | Streaming / time to first audio | Licence (weights) | Est. $ per generated minute | Verification | POC decision |
|---|---|---|---|---|---|---|---|
| Kokoro-82M v1.0 multi-lang ONNX via sherpa-onnx 1.13.8 | No | Yes | Sentence-chunked; speed figures not checked | Apache-2.0; phonemisation uses espeak-ng (GPL) | Not verified; expected in the BlueV3 range or lower | VERIFIED-official (licence); PUBLISHED-thirdparty (espeak-ng); UNVERIFIED (speed); local file (bundle) | **Used: English TTS** |
| Piper `en_US-lessac-medium` via sherpa-onnx 1.13.8 | No | Yes | Sentence-level | Dataset licence linked in `MODEL_CARD`; terms not researched; uses espeak-ng data | not researched | local file; commercial status not researched | **Used: second English voice (benchmark)** |
| `thewh1teagle/piper-he-noa` + `renikud/renikud` on ONNX Runtime | Yes, via ReNikud stressed IPA | Separate `ljspeech` speaker (voice changes) | Sentence-level; CPU; 77 MB + 20.6 MB | CC BY 4.0 (both) | Not verified; expected in the BlueV3 range or lower | VERIFIED-official; local file | **Used: Hebrew TTS (Piper GPL engine not used)** |
| BlueV3 v3.0.1 (`notmax123/BlueV3-onnx`, `blue-onnx`) | Yes (bundled RenikudPlus) | Yes, same voices; `<en>` tags for mixed text | Sentence-by-sentence; 5× real time on 2 CPUs | MIT + OpenRAIL-M vocoder | about $0.0002–0.0003 on CPU | VERIFIED-official; UNVERIFIED (training data, CPU price) | **Pending: package install declined by a safety check; needs explicit approval** |
| `Zyphra/ZONOS3-Mini` | Yes, native, unvocalised text | Yes | Frame-level; 80 ms median at 8 concurrent requests on an H100 | Apache-2.0 | about $0.0001 at peak; $0.0005 derated | VERIFIED-official; UNVERIFIED (GPU price) | Not run (needs GPU); recommended for the GPU bake-off |
| `openbmb/VoxCPM2` | Yes, native | Yes | Streaming API; real-time factor 0.13–0.30 on RTX 4090 | Apache-2.0 | about $0.002–0.004 | VERIFIED-official; UNVERIFIED (GPU price) | Not run; quality reference |
| MOSS-TTS-Realtime | Yes | Yes | 180 ms time to first byte | Apache-2.0 | not researched | VERIFIED-official | Not selected |
| Chatterbox Multilingual V3 | Listed; poor third-party report | Yes | No streaming claim | MIT; retired August 2026 | not researched | VERIFIED-official; PUBLISHED-thirdparty (Hebrew report) | Not selected |
| pocket-tts-onnx + Hebrew adapter | Yes, via ReNikud | Yes | 80 ms frames; first audio 20–80 ms on CPU | CC BY 4.0 | not researched | VERIFIED-official; UNVERIFIED (adapter data) | Not selected |
| `voxtream2-he` | Yes | Mixed in | 80 ms frames | GPL-3.0 on a CC BY-NC base | — | VERIFIED-official | Excluded (licence conflict) |
| Qwen3-TTS | No | Yes | First packet 97 ms | Apache-2.0 | not researched | VERIFIED-official | Not selected (no Hebrew) |
| Coqui XTTS-v2 | No | Yes | Streaming | Coqui Public Model License | — | VERIFIED-official | Excluded (non-commercial) |
| MMS-TTS Hebrew; SASPEECH / ILSpeech voices | Yes | No | — | CC BY-NC or non-commercial dataset | — | VERIFIED-official | Excluded (non-commercial) |

The research's own statement: as of 2026-11-24 no self-hostable Hebrew TTS is both commercially licensed and demonstrated production-grade for conversational speech (ESTIMATE).

### C2. Commercial

| Model | Hebrew | English | Streaming latency claim | List price per 1M characters | Est. $ per generated minute (EN / HE) | Verification | POC decision |
|---|---|---|---|---|---|---|---|
| Inworld `inworld-tts-2-flash` | Yes, Tier 1 | Yes | 20 ms P90 time to first byte | $15 ($7 on the $1,500/month plan) | 0.0135 / 0.0113 (0.0063 / 0.0053 on plan) | VERIFIED-official (price, latency claim); ESTIMATE ($/min) | Not implemented; recommended Hebrew fallback |
| Cartesia `sonic-3.6` | Yes | Yes | Under 90 ms | $37.38 (Scale plan) | 0.0336 / 0.0280 | VERIFIED-official; ESTIMATE ($/min) | Not implemented; second source |
| Azure Neural (`he-IL-HilaNeural`, `he-IL-AvriNeural`) | Yes | Yes | No figure | $15; $12 → $6 on commitment | 0.0135 / 0.0113; down to 0.0054 / 0.0045 | VERIFIED-official; ESTIMATE ($/min) | Not implemented |
| ElevenLabs `eleven_v4_turbo` | Yes | Yes | About 100 ms median | $40 | 0.0360 / 0.0300 | VERIFIED-official; ESTIMATE ($/min) | Not implemented |
| ElevenLabs Flash v2.5 | No | Yes | 75–100 ms | $40 | 0.0360 / — | VERIFIED-official | Not selected (no Hebrew) |
| Google Chirp 3 HD | Yes (`he-IL`) | Yes | No figure | $30 | 0.0270 / 0.0225 | VERIFIED-official; ESTIMATE ($/min) | Not implemented |
| Gemini 3.8 Flash-Lite TTS (Preview) | Not confirmed | Yes | — | $6 per 1M audio tokens to 2026-12-31, then $12 | 0.0090, then 0.0180 | VERIFIED-official (price); UNVERIFIED (Hebrew) | Not implemented |
| MiniMax `speech-2.8-turbo` | Yes | Yes | Not found | $60 | 0.0540 / 0.0450 | VERIFIED-official; ESTIMATE ($/min) | Not selected (price) |
| OpenAI `gpt-4o-mini-tts` | Yes | Yes | Chunked | Token-priced | about 0.015 | VERIFIED-official (price, shutdown 2027-01-06); UNVERIFIED ($/min) | Not selected (deprecated) |
| Deepgram Flux TTS / Aura-2, Amazon Polly, Rime | No | Yes | — | $16–45 (Rime is billed per minute) | 0.0144–0.0405 / — (Rime 0.030–0.050) | VERIFIED-official (prices); ESTIMATE ($/min) | Not selected (no Hebrew) |
| Hume Octave | Not listed | — | — | — | — | PUBLISHED-thirdparty | Not selected (API sunset 2026-11-13) |

---

## D. Open speech-to-speech models

| Model | Hebrew in / out | Full-duplex | Licence | GPU for one stream | Context limit | Verdict | Verification | POC decision |
|---|---|---|---|---|---|---|---|---|
| Kyutai Moshi | No / No | Yes | CC BY 4.0 (weights) | 24 GB | About 4 min (3000 frames); no text system prompt | English only; no tools | VERIFIED-official; ESTIMATE (4 min) | NO-GO |
| `nvidia/personaplex-7b-v1` | No / No | Yes | NVIDIA Open Model License | 24–48 GB; one conversation per process | About 2.5 min sliding window; about 375 text tokens of prompt | Best English-only reference | VERIFIED-official; ESTIMATE (GPU fit, token budget) | NO-GO; optional English reference, not run |
| NVIDIA NemotronLabs VoiceChat 11B | No / No | Yes | OpenMDW-1.1 | 80 GB | 2 min audio window; ASCII-only prompts | "Not suitable for noisy … environments" | VERIFIED-official | NO-GO |
| Haru-4B | No / No (9 languages) | Yes | Apache-2.0 | About 12 GB | Trained on conversations up to 60 min | Research base model | VERIFIED-official | NO-GO |
| Sophon-Realtime v1 | No / No | Yes | Apache-2.0 | 80 GB; 16–40 users per GPU claimed | Not stated | New, unvetted vendor | VERIFIED-official (self-reported) | NO-GO |
| MiniCPM-o 4.5 | No / No | Yes (duplex mode) | Apache-2.0 | 19 GB bf16, 11 GB int4 | Not stated | English and Chinese speech only | VERIFIED-official | NO-GO |
| Qwen3-Omni-30B-A3B | No / No | No, turn-based | Apache-2.0 | 78.85 GB minimum (BF16) | 32K–65K in vLLM examples | No Hebrew speech | VERIFIED-official | NO-GO |
| LFM3-Audio-2B / LFM3-Omni-2B | Listed for ASR and TTS; voice chat English-only | No, turn-based | LFM Open License (under $10M revenue) | Small (2B) | 32K tokens | Component only | VERIFIED-official | NO-GO |
| `dm15/moshi-hebrew-v3-ckpt1800` | Yes / Yes ("rough") | In principle | None stated | About 14 GB | Moshi context | Hobby POC checkpoint | PUBLISHED-thirdparty | NO-GO |
| Ultravox v0.7 (speech in, text out) | No (42 languages) | No | MIT adapter + backbone licence | Depends on backbone | Backbone context | English half-cascade only | VERIFIED-official | NO-GO |
| Qwen3.5-Omni / Qwen3.8-Omni-Flash-Realtime | Yes / Yes | Yes | API only, weights not published | Not self-hostable | 196,608 input tokens; 120-min sessions | Hosted API, not Architecture C | VERIFIED-official | See table A |

Verdict of report 04: no open-weight model combines Hebrew, real-time full-duplex streaming and a commercial licence. Each model's language list is VERIFIED-official; the overall negative is UNVERIFIED by nature (a one-day search).

---

## E. LLMs

"Hebrew evidence" is the unweighted mean of five tasks on the Dicta / MAFAT Hebrew chat leaderboard (ESTIMATE computed from PUBLISHED-thirdparty scores) unless stated. No benchmark covers spoken or code-switched Hebrew. "$/conv-min" assumes 15,000 input and 180 output tokens per minute at a 90% cache hit rate (ESTIMATE).

### E1. Self-hosted

| Model | Licence | Hebrew evidence | Price / footprint | Latency notes | Verification | POC decision |
|---|---|---|---|---|---|---|
| `Qwen3-4B-Instruct-2507` (GGUF Q4_K_M, unsloth) on llama.cpp b12676 | `apache-2.0` per GGUF header | Not researched. Nearest published prior: `Qwen3-14B` mean 27.3 with translation 0.9; report 05 calls older Qwen3 small models close to unusable for Hebrew generation | CPU; footprint not researched | No llama.cpp concurrency figures found | local file (licence); PUBLISHED-thirdparty (prior); UNVERIFIED (latency) | **Used: LLM for CPU-only POC runs** |
| `google/gemma-4-26B-A4B-it` | Apache-2.0 | Mean 52.8 | 25.8B total, 3.8B active; L40S at FP8. Est. $0.00029–0.00177/conv-min at 50–150 conversations per L40S | Hosted reference: TTFT 0.45 s (1K prompt), 68–73 tok/s on DeepInfra | VERIFIED-official (licence, size); PUBLISHED-thirdparty (Hebrew, latency); ESTIMATE (cost, capacity) | **Planned GPU model on vLLM; not yet run** |
| `google/gemma-4-31B-it` | Apache-2.0 | Mean 59.9; AlephBench 88.1 | 31.3B dense; L40S at 4-bit or FP8 | Dense 30B-class on L40S holds only 10–20 tok/s per stream | VERIFIED-official; PUBLISHED-thirdparty; ESTIMATE | Not selected (per-stream speed) |
| `google/gemma-4-12B-it` (QAT `-qat-w4a16-ct`) | Apache-2.0 | None published | 11.96B; fits L4 at 4-bit | not researched | VERIFIED-official; UNVERIFIED (Hebrew) | Not run; L4 fallback arm |
| `dicta-il/DictaLM-3.0-24B-Thinking` | Apache-2.0 | Mean 62.4; summarisation 56.9 | 23.6B; L40S at FP8 or W4A16 | Always emits a thinking block (+303% tokens) | VERIFIED-official; PUBLISHED-thirdparty | Not run; candidate offline summariser |
| `dicta-il/DictaLM-3.0-Nemotron-12B-Instruct` | NVIDIA Open Model License | Mean 48.4 | 12.3B; L4 at FP8 or W4A16 | Non-thinking | VERIFIED-official; PUBLISHED-thirdparty; ESTIMATE (fit) | Not selected |
| `Qwen/Qwen3.6-35B-A3B` | Apache-2.0 | None published | 36.0B total, 3B active; L40S at FP8 | Thinks by default; disable per request | VERIFIED-official; UNVERIFIED (Hebrew) | Not run; comparison arm |
| `Qwen/Qwen3.5-9B`, `Qwen3.5-4B` | Apache-2.0 | No Hebrew score | 9.65B, 4.66B; L4 | Hosted 9B: TTFT 0.24 s (1K prompt) | VERIFIED-official; PUBLISHED-thirdparty (latency); UNVERIFIED (Hebrew) | Not selected |
| `openai/gpt-oss-20b` | Apache-2.0 | None for 20b (120b: mean 48.4) | Within 16 GB | Always reasons; no off switch | VERIFIED-official; PUBLISHED-thirdparty | Not selected |
| `mistralai/Ministral-3-14B-Instruct-2512` | Apache-2.0 | None | 24 GB at FP8 | Hosted TTFT 0.48 s (1K prompt) | VERIFIED-official; UNVERIFIED (Hebrew) | Not selected |
| `meta-llama/Llama-3.3-70B-Instruct` | Llama 3.3 Community License | Mean 41.0 (nikud 4.1) | 70.6B; H100 at 4-bit only | — | VERIFIED-official; PUBLISHED-thirdparty | Not selected |
| `CohereLabs/aya-expanse-*`, `c4ai-command-r-08-2024` | CC BY-NC 4.0 | `aya-expanse-32b` mean 45.3 | — | — | VERIFIED-official | Excluded (non-commercial) |

### E2. Commercial

| Model | Price per 1M tokens (in / cached / out) | Est. $/conv-min | Hebrew evidence | Latency notes | Verification | POC decision |
|---|---|---|---|---|---|---|
| Google `gemini-3.1-flash-lite` | $0.25 / $0.025 / $1.50 | $0.00098 | Family only: 2.5 Flash-Lite 56.3; 3 Flash preview 74.0 | TTFT 3.8 s (1K) and 4.8 s (10K) at default thinking; must be tested with thinking minimal | VERIFIED-official (price); PUBLISHED-thirdparty (latency, Hebrew); ESTIMATE (cost) | **Hybrid candidate; not yet run (no API key)** |
| OpenAI `gpt-6-luna` | $0.10 / $0.01 / $0.50 | $0.00041 | None for this generation | First answer token 1.30 s with reasoning off (all-workload average) | VERIFIED-official (price); PUBLISHED-thirdparty (latency); UNVERIFIED (Hebrew); ESTIMATE (cost) | **Hybrid candidate; not yet run (no API key)** |
| Anthropic `claude-haiku-5-5` | $0.10 / $0.01 / $0.50 | $0.00041 | None for this generation (`claude-haiku-4.5` mean 49.9) | First answer 6.4 s at `low`; no figure with thinking disabled | VERIFIED-official (price); PUBLISHED-thirdparty (latency) | Not selected for the POC |
| Google `gemini-3.5-flash-lite` | $0.30 / $0.03 / $2.50 | $0.00131 | Family only | TTFT 5.5 s (1K) | VERIFIED-official; PUBLISHED-thirdparty | Not selected |
| DeepSeek `deepseek-flash` | $0.15–0.30 / $0.003–0.006 / $0.60–1.20 | $0.00037–0.00075 | `deepseek-chat-v3.1` mean 56.4 | TTFT 0.77 s (1K); peak pricing overlaps Israeli morning | VERIFIED-official; PUBLISHED-thirdparty | Not selected |
| Mistral `mistral-small-2603` | $0.15 / $0.015 / $0.60 | $0.00054 | None | TTFT 0.60 s (1K) | PUBLISHED-thirdparty; UNVERIFIED (Hebrew) | Not selected |
| Groq `openai/gpt-oss-20b` | $0.075 / $0.0375 / $0.30 | $0.00067 | See gpt-oss-120b (48.4) | TTFT 0.20 s (1K) | VERIFIED-official; PUBLISHED-thirdparty | Not selected |
| DeepInfra `gemma-4-26B-A4B-it` | $0.07 / — / $0.34 | $0.00111 (no cache discount) | Mean 52.8 | TTFT 0.45 s (1K); 68–73 tok/s | PUBLISHED-thirdparty | Not implemented; burst option for the self-hosted model |
| Alibaba `qwen3.7-flash` | $0.03 / $0.006 / $0.13 | $0.00016 | None | Not checked | PUBLISHED-thirdparty; UNVERIFIED (Hebrew) | Not selected |

---

## F. Frameworks and transport

| Option | Licence | Transport | Semantic turn detection (Hebrew) | Local model support | Managed price | Notes | Verification | POC decision |
|---|---|---|---|---|---|---|---|---|
| Custom thin FastAPI + WebSocket server | Own code; dependencies in `LICENSES.md` | WebSocket (TCP) | None; Silero VAD silence endpointing | Direct: faster-whisper, sherpa-onnx, ONNX Runtime, OpenAI-compatible LLM | None | Report 05 warns that a WebSocket POC lacks WebRTC echo cancellation and jitter buffering, and under-reports their delay | local file (design); ESTIMATE (caveat) | **Used in the POC** |
| Pipecat 1.17.0 | BSD-2-Clause | Daily, LiveKit, SmallWebRTC, WebSocket | Smart Turn v3, local, free; no Hebrew | First-party faster-whisper, Kokoro, Piper, OpenAI-compatible LLM, OpenAI Realtime, Gemini Live | Pipecat Cloud $0.01 per active minute | Research's recommendation for the POC; you build your own worker dispatch | VERIFIED-official | Evaluated, not used; production candidate |
| LiveKit Agents 1.8.13 + self-hosted LiveKit server | Apache-2.0 | WebRTC SFU, SIP | Turn detector: 14 languages, no Hebrew; LiveKit Agents only | No first-party local Whisper, Kokoro or Piper plugin | LiveKit Cloud $0.01 per agent-session minute | 10–25 concurrent jobs per 4-core agent server | VERIFIED-official; managed price PUBLISHED-thirdparty in report 05 and UNVERIFIED in report 06 | Evaluated, not used; production recommendation |
| FastRTC | MIT | WebRTC or WebSocket | Pause detection only | Any Python function | — | Last release 2025-11-24; no per-stage metrics | VERIFIED-official | Not selected |
| Vocode | MIT | Telephony-centred | not researched | not researched | — | Last release August 2024 | VERIFIED-official | Not selected |
| TEN Framework | Apache-2.0 with added conditions | Agora | TEN Turn Detection (English, Chinese) | — | — | No hosting on end-user mobile devices; non-compete with Agora | VERIFIED-official | Not selected |
| Kyutai Unmute | MIT | WebSocket | Built into Kyutai STT | Kyutai STT and TTS (English, French) | — | Reference architecture only | VERIFIED-official | Not selected |
| `aiortc` 1.16.0 | BSD-3-Clause | WebRTC | Build your own | Build your own | — | Maximum control, most work | VERIFIED-official | Not selected |

Production implication (ESTIMATE): WebRTC from the phone with TURN fallback; managed agent hosting at $0.01/min is twice the all-in budget, so the media layer must be self-hosted.

---

## G. GPU options

**No GPU price in report 06 is VERIFIED-official.** No provider pricing page could be fetched; every figure comes from a search-index excerpt (tagged UNVERIFIED when from the provider's own domain, PUBLISHED-thirdparty when from a tracker). Treat every price below as unverified until checked on the live page. Report 06 also records that rental prices rose through 2026 (PUBLISHED-thirdparty).

| GPU (VRAM) | Cheapest credible on-demand $/h | Marketplace / community floor $/h | Hyperscaler reference $/h | Dedicated monthly (≈ $/GPU-h at 730 h) | Owned, 36-month amortised $/GPU-h at 100% / 40% use | Verification | POC decision |
|---|---|---|---|---|---|---|---|
| T4 (16 GB) | 0.526 (AWS g4dn.xlarge) | — | GCP 0.35 + VM | — | — | PUBLISHED-thirdparty | Not selected |
| L4 (24 GB) | 0.69 (RunPod Secure) | 0.44 (RunPod Community) | GCP 0.71; AWS 0.805 | OVH Scale-GPU-1, GPU count not retrieved | 0.29 / 0.73 (8× L4 server) | UNVERIFIED; ESTIMATE (owned) | Candidate low-cost class; not run |
| A10 / A10G (24 GB) | 1.006 (AWS g5.xlarge) | — | Modal 1.10; Lambda 1.29 | — | — | PUBLISHED-thirdparty | Not selected |
| RTX PRO 4000 Blackwell SFF (24 GB) | — | — | — | Hetzner GEX45 €214/month ≈ 0.34 | — | UNVERIFIED; ESTIMATE (hourly) | Cheapest always-on option found; not used |
| RTX 4090 (24 GB) | 0.89 (RunPod Secure) | 0.34 (RunPod Community) | — | — | — | UNVERIFIED | Not selected |
| RTX 5090 (32 GB) | 1.39 (RunPod Secure) | 0.63 (Vast median) | — | — | 0.74–0.81 / 1.85–2.01 | UNVERIFIED; PUBLISHED-thirdparty (medians); ESTIMATE (owned) | Optional comparison |
| RTX A6000 (48 GB) | 0.50 (Hyperstack) | 0.33 (RunPod Community) | — | — | — | UNVERIFIED | Optional low-cost reference |
| L40S (48 GB) | 1.09 (RunPod Secure) | 0.79 (RunPod Community); 0.74 (Latitude.sh) | AWS g6e.xlarge 1.861 | Scaleway 8× L40S ≈ 1.61 | 0.69 / 1.73 (8× server); 0.88 / 2.21 (single) | UNVERIFIED; PUBLISHED-thirdparty (AWS, Latitude, Scaleway); ESTIMATE (owned) | **Recommended by research for the GPU benchmark phase (RunPod Secure, EU region); POC runs to date are CPU-only** |
| A100 40 GB | 1.99 (Lambda) | — | Modal 2.10; GCP 3.67 | — | — | PUBLISHED-thirdparty | Not selected |
| A100 80 GB | 1.35 (Hyperstack PCIe) | 0.73–0.84 (Vast median) | Azure 3.67; GCP 5.07 | — | 1.02 / 2.55 | UNVERIFIED; ESTIMATE (owned) | Not selected |
| H100 80 GB | 2.50 (Hyperstack PCIe) | 1.93 (Vast median); 1.99 (RunPod Community) | AWS about 5.19–6.88; Azure 6.98; GCP 11.06 | Vultr 8× H100 2.30–2.99 | 2.19 / 5.47 | UNVERIFIED; PUBLISHED-thirdparty (trackers); ESTIMATE (owned) | Optional (TTS and larger LLM arms) |
| H200 141 GB | 4.54 (Modal) | 3.59 (RunPod Community) | GCP about 10.71 | — | — | UNVERIFIED | Not selected |
| RTX PRO 6000 Blackwell (96 GB) | Modal 3.03 | 1.73 (Vast median) | — | Hetzner GEX430 €3,599/month for 4 GPUs ≈ 1.42 per GPU | — | UNVERIFIED; ESTIMATE (conversion at assumed 1 EUR = 1.15 USD) | Not selected |

Notes (all from report 06): owned-hardware figures assume zero residual value, 10% of capex per year for maintenance and $292/kW/month for colocation and energy (ESTIMATE). Owning no longer clearly beats renting, and at 40% utilisation owned costs are 2.5× higher. Scale-to-zero serverless cannot serve a live call from cold; a true cold start is estimated at 1–5 minutes (ESTIMATE).

---

## Architecture summary

All cost figures are ESTIMATE built on the reports' assumptions and on unverified GPU prices. Self-hosted sums add per-layer estimates that use different utilisation assumptions and exclude orchestration servers, transport and idle capacity; they are indicative only. POC-measured figures are reported separately.

| Architecture | Meets Hebrew? | Interruptions | Est. $/min | Verdict | Verification |
|---|---|---|---|---|---|
| A — commercial realtime (`gpt-realtime-2.1`, `gpt-realtime-2.1-mini`, `gemini-3.8-live`) | Unproven. Google lists Hebrew but a regression is reported; OpenAI publishes no statement | Strong, server-side: OpenAI `conversation.item.truncate`; Gemini `interrupted` flag | 30-min average: $0.077 (`gpt-realtime-2.1`, ideal cache), $0.030 (mini, ideal cache), $0.06–0.23 (Gemini, by context window) | Quality baseline; 6–46× the $0.005 target. Implemented, not yet run live | ESTIMATE (cost); UNVERIFIED (Hebrew); VERIFIED-official (interruption protocol) |
| B — self-hosted modular (Silero VAD, ivrit.ai Whisper, Gemma 4 or Qwen3-4B, Kokoro / piper-he-noa) | STT: yes, published 5.3 / 7.1 WER. LLM: published for Gemma 4, not for the CPU POC model. TTS: commercially licensed but not proven production-grade | Application-level: VAD-triggered stop and buffer flush; sentence-level TTS wastes at most one sentence; no Hebrew semantic turn detector; in-car barge-in depends on echo cancellation | Component estimates per conversational minute: STT $0.00045–0.0006, LLM $0.00029–0.00177, TTS about $0.00005–0.00025; indicative sum about $0.0008–0.0026 | Only route with a path to the cost target; Hebrew TTS quality and code-switching are the open risks. Running on CPU in the POC | ESTIMATE (cost); VERIFIED-official and PUBLISHED-thirdparty (Hebrew evidence, see tables B, C, E) |
| C — open speech-to-speech | No. No open full-duplex model supports Hebrew | Native in English-only models | English-only PersonaPlex reference: about $0.01–0.02 at one session per GPU | NO-GO; not implemented | VERIFIED-official (language lists); UNVERIFIED (overall negative); ESTIMATE (cost) |
| D — hybrid (self-hosted VAD, STT, TTS + `gemini-3.1-flash-lite` or `gpt-6-luna`) | STT and TTS as in B. LLM: Gemini family leads Hebrew leaderboards; no score for either current model | Same as B | STT and TTS as in B plus LLM $0.00041 (`gpt-6-luna`) or $0.00098 (`gemini-3.1-flash-lite`) at 90% cache; indicative sum about $0.0009–0.0018 | Viable; LLM first-token latency in non-thinking mode is unpublished and must be measured. Not yet run live | ESTIMATE (cost); PUBLISHED-thirdparty (Hebrew family evidence, latency) |

---

## Known inconsistencies between the research reports

| Topic | Conflict | Handling here | Verification |
|---|---|---|---|
| Architecture labels | Report 01 calls the commercial realtime API "Architecture A"; report 04 (section 6.3) calls the full self-hosted cascade "Architecture A" | Labels follow `config/providers.yaml` (A commercial, B modular, C speech-to-speech, D hybrid) | local file |
| OpenAI realtime and GPT-Live prices | Report 01 tags them PUBLISHED-thirdparty or UNVERIFIED (pages blocked); report 05 tags the same prices VERIFIED-official | Weaker status used | UNVERIFIED |
| LiveKit Cloud agent-minute price ($0.01) | Report 05 tags it PUBLISHED-thirdparty; report 06 tags it UNVERIFIED | Both shown in table F | UNVERIFIED |
| GPU prices | Report 03 assumes $2–3 per H100-hour; report 05 cites an H100 median of $3.92 and L40S at $0.92–1.86; report 06 cites H100 from $2.50 and L40S at $1.09 (RunPod Secure); report 02 derives L4 at about $0.49 | Table G uses report 06; every price is unverified | UNVERIFIED |
| Smart Turn version | Report 02 says v3.2; report 05 says v3 | v3.2 used in B3 | VERIFIED-official (both reports read official pages) |
| Ultravox | Report 04: v0.7 (December 2025), 42 languages. Report 05: README news stops at v0.5, "no Hebrew evidence" | Report 04 used (read from the model card) | VERIFIED-official (report 04) |
| Kyutai Unmute Hebrew | Report 04: STT and TTS are English and French only. Report 05: Hebrew support "not established" | Report 04 used | VERIFIED-official (report 04); UNVERIFIED (report 05) |
| `piper-he-noa` front-end | Model card says phonemes follow ReNikud; Piper's upstream Hebrew phonemiser source describes Nakdimon plus rules | POC uses ReNikud, as the card states | VERIFIED-official (both statements); local file (card) |
| POC framework | Report 05 recommends Pipecat with SmallWebRTC for the POC; the POC uses a custom FastAPI + WebSocket server | Recorded as a decision; WebSocket caveat noted in table F | local file (POC design); ESTIMATE (caveat) |
| ElevenLabs v3 Conversational latency | Docs say about 165 ms; pricing page says about 280 ms | Not used in a decision | VERIFIED-official (both pages) |

## Addendum: what the POC measured afterwards

The tables above are research. These rows were then measured in the POC (details and caveats in `BENCHMARKS.md`; small test sets, synthetic users):

| Layer | Item | Measured result | Effect on the POC decision |
|---|---|---|---|
| STT | `ivrit-ai/whisper-large-v3-turbo-ct2`, Hebrew (FLEURS, 40 utterances) | 18.9 % WER clean, 23.1 % at 5 dB road noise, 27.5 % at 0 dB | Hebrew sessions use this model |
| STT | `deepdml/faster-whisper-large-v3-turbo-ct2` (stock turbo), Hebrew | 28.6 % WER clean, 34.1 % at 5 dB | Not used for Hebrew |
| STT | Stock turbo, English (FLEURS, 30 utterances) | 5.6 % WER clean, 7.2 % at 5 dB | **English sessions use this model** (changed after measurement) |
| STT | Hebrew-tuned model, English | 29.0 % WER; translated 6 of 30 utterances into Hebrew | Must not be used for English; language routing added |
| STT | `Systran/faster-whisper-small`, Hebrew | 46.5 % WER | Rejected |
| VAD | Silero VAD, 544 ms endpoint, 256 ms speculative point | No missed utterances or false triggers down to 0 dB; 10–13 % of long sentences split by a pause | Kept; learned turn detection needed later |
| TTS | `thewh1teagle/piper-he-noa` + `renikud/renikud` on ONNX Runtime | About 12x real time on CPU; 4.3 % WER when its speech is transcribed back | Used for Hebrew in the POC; naturalness not assessed |
| TTS | Kokoro-82M v1.0 / Piper lessac via sherpa-onnx 1.13.8, CPU | Real-time factor about 0.5 / 0.07 | Piper used for CPU runs, Kokoro planned for GPU |
| LLM | `Qwen3-4B-Instruct-2507` Q4 on llama.cpp, CPU | English usable; Hebrew grammatically poor; recall 11 of 12; 2 of 8 unknown-fact probes answered with invented content | CPU stand-in only; not a production candidate |
| Transport | Custom WebSocket session layer | About 0.006 CPU-seconds per session-second (plus 0.0065 for VAD) | About 40 sessions per vCPU with headroom |

| STT | OpenAI `gpt-transcribe` (API) | Hebrew 19.5 % WER clean, 23.1 % at 5 dB; English 3.5 % | No accuracy advantage for Hebrew over the open Hebrew-tuned model |
| LLM | OpenAI `gpt-6-luna` (API, reasoning off) | Recall 12 of 12; 0 of 8 unknown-fact probes invented; fluent Hebrew in transcripts; 0.67 s median to first token through the session proxy; about 950 prompt + 44 output tokens per turn | **Hybrid with this model is the recommended starting point** |

| LLM | `RedHatAI/gemma-4-26B-A4B-it-FP8-dynamic` on vLLM, one L40S | First token 52 ms, 117 tokens/s; recall 12 of 12; fluent Hebrew; Hebrew number words garbled in 2 of 3 probes | **Selected self-hosted model** |
| Pipeline | Fully self-hosted on one L40S (GPU: both Whisper models + Gemma; CPU: speech synthesis) | 681 ms median / 1,072 ms P95 response (56 turns, no network); 35 simultaneous conversations at P95 1.48 s; 30 minutes, 134 turns, no drift | **Recommended architecture** |
| Pipeline | Hybrid on the same host (API language model `gpt-6-luna`) | 1,333 ms median / 2,441 ms P95; API first token 711 ms | Fallback route |
| Commercial realtime | OpenAI `gpt-realtime-2.1`, called from the pod | 1.62 s (server VAD) to 2.05 s (semantic, auto) median; 28 of 28 checks; $0.070–0.075 per connected minute from reported usage at unverified list prices | Baseline; not the default path |
| Commercial realtime | OpenAI `gpt-realtime-2.1-mini` | 1.65–1.73 s median, P95 about 5.1 s; 55 of 56 checks; weaker Hebrew; $0.020 per connected minute | Baseline |
| GPU | RunPod L40S, Secure Cloud, on demand | $1.09 per hour (API-listed and billed); other 48 GB options listed the same day: A40 $0.59, RTX A6000 $0.69, L40 $0.82, RTX 6000 Ada $1.09 | Used for the benchmark |

Not measured: Google Gemini Live, other GPU types, commercial speech synthesis, and anything involving human listeners.

