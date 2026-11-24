# Licensing and commercial usage report

Project: Rolly voice companion POC (Hebrew + English). Status date: 2026-11-24.

**This document is not legal advice.** It is an engineering summary of licence and usage terms as recorded in the research reports under `docs/research/` and in files on disk. Every item marked for review must be confirmed by counsel against the current licence text before commercial launch.

## How to read the Verification column

- **VERIFIED-official** — the research report read the claim directly on the owner's own page, licence file, model card, SDK or docs on 2026-11-24.
- **PUBLISHED-thirdparty** — published by someone other than the owner; not confirmed against the owner.
- **ESTIMATE** — arithmetic or engineering judgement in the research reports or in this document.
- **UNVERIFIED** — could not be confirmed from a primary source (page blocked, search summary only, or sources conflict).
- **local file** — read from a file on disk in this repository: a downloaded model directory under `models/`, a GGUF header, installed-package metadata in `.venv`, or POC source and config.
- **not researched** — the reports are silent and no local file answers it. Treat as an open item, not as "no restriction".

A status is never upgraded here. Where two reports tag the same claim differently, the weaker tag is used.

---

## 1. Summary: items that need a decision or legal review before commercial launch

1. **espeak-ng data bundled with both English TTS models.** `models/kokoro-multi-lang-v1_0/espeak-ng-data` and `models/vits-piper-en_US-lessac-medium/espeak-ng-data` are present on disk (local file) and the Piper voice config declares `phoneme_type: espeak` (local file). The research records espeak-ng as GPL (PUBLISHED-thirdparty); the project brief treats it as GPL-3, a version the reports do not confirm. Decide whether server-side use is acceptable, and whether any client or on-device distribution would trigger copyleft duties. Alternative: replace the English phonemiser.
2. **Piper `en_US-lessac-medium` voice provenance.** The local `MODEL_CARD` names the Blizzard 2013 "lessac" dataset and links to its licence, but the terms were not researched. Piper publishes a per-voice commercial-use list and retrained several voices in late 2026 under unchanged file names (VERIFIED-official); whether this voice, and this download, is on the list is not researched. Do not ship it commercially until checked; Kokoro-82M is the lower-risk English voice.
3. **CC BY 4.0 attribution duties.** `thewh1teagle/piper-he-noa` (Hebrew voice) and `renikud/renikud` (Hebrew G2P) are CC BY 4.0 (local file; VERIFIED-official). The POC glue code is adapted from the `renikud-onnx` reference implementation, so attribution may also attach to that code. Counsel should define where attribution is shown (app "about" screen, documentation) and whether it extends to generated audio.
4. **`soxr` (python-soxr) is LGPL-2.1-or-later** (local file, package metadata). It is the only copyleft Python dependency found. Server-side use is normally unproblematic; redistribution in a client needs review. Bundled native libraries in other wheels (for example inside `soundfile`) were not researched.
5. **BlueV3 Hebrew TTS (`blue-onnx`) is pending, not approved.** A safety check declined installing the `blue-onnx` package; it stays a candidate until explicitly approved. Legal points if it is adopted: the vocoder is under BigScience OpenRAIL-M with use-based restrictions (VERIFIED-official), and the training-data provenance is undocumented (UNVERIFIED). Obtain the training-data list from the author first.
6. **Non-commercial models that must not ship.** Coqui XTTS-v2 (Coqui Public Model License; no commercial licence can be bought since Coqui shut down), MMS-TTS Hebrew and `facebook/mms-1b-all` (CC BY-NC 4.0), every SASPEECH or ILSpeech descendant (Phonikud-TTS checkpoints, official Piper `he_IL-saspeech-medium`, Hebrew Kokoro fine-tunes, Robo-Shaul, MamreTTS, Zonos-Hebrew), F5-TTS, OmniVoice, Fish Audio S2 Pro / Drama 3 / S1-mini, Higgs TTS 3, Voxtral 4B TTS, `Hebrish/*` ASR models, Cohere Aya Expanse / Command R / tiny-aya (CC BY-NC 4.0), LLaMA-Omni 2, Qwen2.5-Omni-3B, SeamlessStreaming, J-Moshi. See section 3.
7. **Mislabelled Hugging Face licence tags.** Several Hebrew repos carry a permissive tag over a non-commercial base or dataset (`Phoonnx/vits-he_il-shaul-phonikud`, `Yzamari/f5tts-hebrew-v2`, `voxtream2-he`). A licence tag is not a licence chain (tags VERIFIED-official; conclusion ESTIMATE).
8. **Turn-detection and VAD licence restrictions.** The LiveKit turn-detector model may only be used with LiveKit Agents (LiveKit Model License). TEN VAD and TEN Framework carry a clause against deployments that compete with Agora; TEN Framework also bars hosting on end-user mobile devices (all VERIFIED-official). Neither is used in the POC.
9. **NVIDIA Open Model License items.** `dicta-il/DictaLM-3.0-Nemotron-12B-Instruct` (commercially usable, but the grant is revocable under its conditions), `nvidia/personaplex-7b-v1` (licence terminates if a guardrail is bypassed without an equivalent) and `nvidia/parakeet_realtime_eou_120m-v1` (all VERIFIED-official). None is used in the POC.
10. **Gemma terms.** The planned GPU model `google/gemma-4-26B-A4B-it` is Apache-2.0 (VERIFIED-official); the Gemma Terms of Use apply only to Gemma 3 and 3n and are therefore not applicable. The FP8 build recommended for an L40S is a community repack (`RedHatAI/gemma-4-26B-A4B-it-FP8-dynamic`) whose own licence was not researched.
11. **POC LLM.** `Qwen3-4B-Instruct-2507` (unsloth GGUF Q4_K_M) declares `apache-2.0` in its GGUF header (local file), and the upstream model card `Qwen/Qwen3-4B-Instruct-2507` states `license: apache-2.0` (VERIFIED-official, card fetched 2026-11-24 after the research reports were written). The unsloth repack's own terms were not researched. This model is a CPU stand-in only and is not proposed for production.
12. **Benchmark data.** The Google FLEURS dataset card states "All datasets are licensed under the Creative Commons license (CC-BY)" (VERIFIED-official, card fetched 2026-11-24). Attribution is required when publishing results or redistributing clips; the exact CC BY version should be confirmed.
13. **Commercial API data terms are mostly unconfirmed.** OpenAI Realtime zero-data-retention eligibility and its approval requirement are UNVERIFIED. Google Live zero retention conflicts with the session resumption a 30-minute session needs (UNVERIFIED terms; ESTIMATE conflict). The POC connects to Gemini through the Gemini Developer API key path (local file), whose data terms were not researched. Data terms for the text LLM APIs (`gemini-3.1-flash-lite`, `gpt-6-luna`) were not researched.
14. **Model shutdown dates.** `gpt-realtime` and `gpt-realtime-mini` shut down 2027-01-20; `whisper-1` and `gpt-4o-*-transcribe` on 2027-02-26; OpenAI TTS models on 2027-01-06 (all VERIFIED-official). See section 4.
15. **Voice cloning.** Not needed and not used. Keep it that way to avoid consent questions (ESTIMATE). If ivrit.ai datasets are ever used for fine-tuning, their licence forbids voice deep-fakes and binds us directly (VERIFIED-official for the terms).
16. **Privacy.** Recording, retention and consent need review by counsel under the Israeli Privacy Protection Law and, for EU users or EU hosting, the GDPR. See section 6.

---

## 2. Components used in the POC

| Component | Role | Code licence | Weights / data licence | Commercial use | Hosting / redistribution restrictions | Attribution or other obligations | Verification |
|---|---|---|---|---|---|---|---|
| Custom FastAPI + WebSocket server | Transport and orchestration | Own code | n/a | Yes | None of its own; inherits from dependencies below | Glue code for Hebrew TTS is adapted from the `renikud-onnx` reference implementation (see ReNikud row) | local file |
| `fastapi` 0.165.0 | Web framework | MIT | n/a | Yes | Licence text not reviewed | Keep licence notice | local file |
| `uvicorn` 0.54.0, `websockets` 17.4, `httpx` 0.28.1, `psutil` 7.2.2 | Server, WebSocket, HTTP client, resource sampling | BSD-3-Clause | n/a | Yes | Licence text not reviewed | Keep licence notice | local file |
| `numpy` 2.5.5 | Arrays | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 | n/a | Yes | Licence text not reviewed | Keep licence notices | local file |
| `PyYAML` 6.0.4 | Config | MIT | n/a | Yes | Licence text not reviewed | Keep licence notice | local file |
| `soundfile` 0.14.0 | Audio file I/O | BSD 3-Clause | n/a | Yes | Bundled native libraries not researched | Keep licence notice | local file |
| `jiwer` 4.0.0, `huggingface_hub` 2.4.0 | WER scoring, model download | Apache-2.0 | n/a | Yes | Licence text not reviewed | Keep licence and notices | local file |
| `soxr` 1.1.0 (python-soxr) | Resampling | **LGPL-2.1-or-later** | n/a | Yes, with LGPL duties | Redistribution (for example in a client build) triggers LGPL obligations; server-side use to be confirmed by counsel | LGPL notice and relinking duties on distribution | local file |
| ONNX Runtime (`onnxruntime` 1.32.0) | Inference runtime for VAD and Hebrew TTS | MIT | n/a | Yes | Licence text not reviewed | Keep licence notice | local file |
| Silero VAD (`models/silero_vad.onnx`, from `snakers4/silero-vad`) | Voice activity detection, barge-in trigger | MIT | MIT | Yes | None recorded | README badge alt-text reads "CC BY-NC 4.0" but the LICENSE file and README body say MIT; the report concludes MIT. Version of the local file not recorded | VERIFIED-official |
| faster-whisper 1.2.1 | STT runtime | MIT | n/a | Yes | None recorded | Keep licence notice | VERIFIED-official |
| CTranslate2 4.9.1 | STT inference engine | MIT | n/a | Yes | Licence text not reviewed | Keep licence notice | local file |
| `ivrit-ai/whisper-large-v3-turbo-ct2` | Hebrew STT (primary) | n/a | Apache-2.0 weights. Training data is under the ivrit.ai licence, which binds the data, not the weights | Yes | None on the weights. Fine-tuning on ivrit.ai data would bring attribution, training-only and no-deep-fake terms | Keep licence and notices. Card is stale ("Release date: TBD") | VERIFIED-official; local file |
| `deepdml/faster-whisper-large-v3-turbo-ct2` (stock OpenAI large-v3-turbo) | STT benchmark arm | n/a | `mit` on the cached card; base `openai/whisper-large-v3-turbo` is MIT | Yes | The deepdml conversion repo itself was not researched | Keep licence notice | local file (card); VERIFIED-official (base model) |
| `Systran/faster-whisper-small` | STT benchmark arm | n/a | `mit` on the cached card | Yes per card | Not researched | Keep licence notice | local file |
| `Qwen3-4B-Instruct-2507` GGUF Q4_K_M (`unsloth/Qwen3-4B-Instruct-2507-GGUF`) | LLM in CPU-only POC runs | n/a | `apache-2.0` in the GGUF header, linking to the upstream Qwen licence file | Yes (Apache-2.0 on the upstream card) | The unsloth repack repo was not researched | Keep licence and notices | local file; upstream card VERIFIED-official (fetched 2026-11-24) |
| llama.cpp build b12676 | LLM runtime (CPU) | MIT | n/a | Yes | Copyright and permission notice must accompany copies | Keep licence notice | local file |
| `google/gemma-4-26B-A4B-it` | Planned GPU LLM | n/a | Apache-2.0 | Yes | None recorded. FP8 community repack licence not researched | Keep licence and notices | VERIFIED-official |
| vLLM 0.34.0 | Planned GPU LLM server | Apache-2.0 | n/a | Yes | None recorded | Keep licence and notices | VERIFIED-official |
| `gemini-3.1-flash-lite`, `gpt-6-luna` | Commercial LLM candidates for the hybrid | Proprietary API | Proprietary | Yes, under provider terms | Provider terms of service; data terms not researched | Not researched | VERIFIED-official (prices only); terms not researched |
| Kokoro-82M v1.0 multi-lang ONNX (sherpa-onnx bundle) | English TTS | n/a | Apache-2.0 (report, and `LICENSE` file in the model directory) | Yes | Bundle also contains `espeak-ng-data`, lexicons and a jieba dictionary whose licences were not researched | Keep licence and notices. Fixed voices, no cloning (PUBLISHED-thirdparty) | VERIFIED-official; local file |
| Piper `en_US-lessac-medium` | English TTS (second voice) | Piper engine is GPL-3.0-or-later but is **not used**; the ONNX file runs through sherpa-onnx | Dataset: Blizzard 2013 "lessac"; licence linked from `MODEL_CARD`, terms not researched | **Unconfirmed** | Check Piper's per-voice commercial-use list for this exact download | Not researched | local file; commercial status not researched |
| sherpa-onnx 1.13.8 | English TTS runtime | Apache-2.0 | n/a | Yes | Ships and loads espeak-ng data for phonemisation | Keep licence and notices | VERIFIED-official; local file |
| espeak-ng data (inside both English model directories) | English phonemisation data | GPL (version not confirmed in the reports; brief states GPL-3) | Same | To be decided | Copyleft duties on distribution; server-side position for counsel | Source-offer and notice duties if distributed | PUBLISHED-thirdparty (licence); local file (presence) |
| `thewh1teagle/piper-he-noa` (`he_IL-noa-medium.onnx`) | Hebrew TTS voice | Piper engine (GPL-3.0-or-later) **not used**; executed with ONNX Runtime and own glue code | CC BY 4.0. Trained on 24 h of synthetic Hebrew speech generated with Chatterbox (MIT) from Knesset sentences, plus public-domain LJSpeech | Yes | None beyond CC BY terms | **Attribution required.** Hebrew and English are different speakers in the same model | VERIFIED-official; local file |
| `renikud/renikud` (`renikud.onnx`) | Hebrew text to stressed IPA (G2P) | Reference package `renikud-onnx`; ReNikud is listed as CC BY 4.0 | CC BY 4.0 | Yes | None beyond CC BY terms | **Attribution required**, including for the adapted glue code; citation requested on the card | VERIFIED-official; local file |
| OpenAI Realtime API (`gpt-realtime-2.1`, `gpt-realtime-2.1-mini`) | Commercial baseline, implemented, not yet run live | Proprietary API | Proprietary | Yes, under provider terms | See section 4 | See section 4 | VERIFIED-official (protocol); UNVERIFIED (data terms) |
| Google Gemini Live API (`gemini-3.8-live`) | Commercial baseline, implemented, not yet run live | Proprietary API | Proprietary | Yes, under provider terms | See section 4 | See section 4 | VERIFIED-official (protocol, prices); UNVERIFIED (data terms) |
| Google FLEURS (`he_il`, `en_us` test splits) | Benchmark audio and references | n/a | CC BY per the dataset card (version not confirmed) | Yes with attribution | None stated on the card | Attribution | VERIFIED-official (card fetched 2026-11-24) |
| Synthetic benchmark audio and road noise | Benchmark audio | Own scripts | Generated with the TTS voices above | Internal use | Whether voice-licence terms (CC BY attribution, lessac dataset terms) attach to generated audio is a question for counsel | — | not researched |

Speech-to-speech (Architecture C) is NO-GO and not implemented, so it contributes no components.

---

## 3. Candidates evaluated and not selected (or pending)

| Component | Role | Code licence | Weights / data licence | Commercial use | Hosting / redistribution restrictions | Attribution or other obligations | Why not selected | Verification |
|---|---|---|---|---|---|---|---|---|
| BlueV3 v3.0.1 (`notmax123/BlueV3-onnx`, PyPI `blue-onnx`) | Hebrew + English TTS | MIT | MIT, except vocoder: BigScience OpenRAIL-M (derived from Supertonic-3) | Yes, subject to OpenRAIL-M use restrictions | Use-based restrictions travel with the vocoder | Consent and lawful use placed on the user | **Pending.** Package install declined by a safety check; needs explicit approval. Training data undocumented | VERIFIED-official; training data UNVERIFIED |
| RenikudPlus 0.5.0 | Hebrew G2P for BlueV3 | MIT (package) | Apache-2.0 | Yes | None recorded | Training data undocumented | Pending with BlueV3 | VERIFIED-official; training data UNVERIFIED |
| `Zyphra/ZONOS3-Mini` | Hebrew + English TTS | MIT | Apache-2.0 | Yes | None recorded | No watermark or cloning restriction found on the card | Needs a GPU; two weeks old; not run in the CPU POC | VERIFIED-official |
| `openbmb/VoxCPM2` | Hebrew TTS quality reference | Apache-2.0 | Apache-2.0 | Yes | None recorded | — | About 8 GB VRAM, 3–8 streams per GPU | VERIFIED-official |
| MOSS-TTS-Realtime | Hebrew-capable TTS | Apache-2.0 (code tag UNVERIFIED) | Apache-2.0 | Yes | None recorded | — | Not tested | VERIFIED-official |
| Chatterbox Multilingual V3 | Hebrew-listed TTS | MIT | MIT | Yes | Retired and unmaintained since August 2026 | Perth watermark embedded in every output | Retired, non-streaming, poor third-party Hebrew report | VERIFIED-official |
| pocket-tts-onnx + Hebrew adapter | CPU streaming TTS | CC BY 4.0 | CC BY 4.0 | Yes | — | Attribution required | Adapter training data undocumented | VERIFIED-official; adapter data UNVERIFIED |
| `voxtream2-he` | Hebrew streaming TTS | GPL-3.0 | GPL-3.0 on a CC BY-NC 4.0 base | **Conflicted** | Copyleft plus non-commercial base | — | Licence conflict; self-declared instability | VERIFIED-official |
| Piper engine (`OHF-Voice/piper1-gpl`) | TTS engine | GPL-3.0-or-later | n/a | Yes, with GPL duties | Shipping it inside an app is distribution | Source-offer duties | Avoided: ONNX voices run through sherpa-onnx or ONNX Runtime instead | VERIFIED-official; distribution reading ESTIMATE |
| Phonikud | Hebrew diacritisation and G2P | CC BY 4.0 | MIT (ONNX weights) | Yes | — | Attribution required | ReNikud chosen; Phonikud repo points to it as more accurate | VERIFIED-official |
| Coqui XTTS-v2 | Multilingual TTS (no Hebrew) | — | Coqui Public Model License | **No** | Non-commercial; no licence purchasable since Coqui shut down | — | Non-commercial, no Hebrew | VERIFIED-official; shutdown PUBLISHED-thirdparty |
| MMS-TTS Hebrew (`facebook/mms-tts-heb`), `facebook/mms-1b-all` | Hebrew TTS / ASR | — | CC BY-NC 4.0 | **No** | Non-commercial | — | Non-commercial | VERIFIED-official |
| SASPEECH / ILSpeech descendants (Phonikud-TTS checkpoints, Piper `he_IL-saspeech-medium`, `kokoro-hebrew-*`, Robo-Shaul, MamreTTS, Zonos-Hebrew) | Hebrew TTS | Varies | Non-commercial dataset terms; CC BY-NC variants | **No** | Commercial and broadcast use barred by the dataset owner | A permissive wrapper licence does not relax dataset terms | Non-commercial | VERIFIED-official (cards); PUBLISHED-thirdparty (SASPEECH terms) |
| F5-TTS, OmniVoice, Fish Audio S2 Pro / Drama 3 / S1-mini, Higgs TTS 3, Voxtral 4B TTS | TTS | Varies | CC BY-NC or vendor research licences | **No** without a paid licence | Non-commercial | Higgs prohibits cloning without consent | Non-commercial | VERIFIED-official |
| Supertonic 3 | TTS (no Hebrew) | MIT (sample code) | OpenRAIL-M | Yes, with use restrictions | Use-based restrictions | — | No Hebrew | VERIFIED-official |
| `ivrit-ai/zipformer2-66m-streaming-he` | Streaming Hebrew STT | Runs on sherpa-onnx (Apache-2.0) | CC BY 4.0 | Yes | — | Attribution in product documentation | English "spelled letter by letter"; 1.28 s chunks | VERIFIED-official |
| `MaorB/embeddinggemma-2-asr-hebrew-english-streaming` | Streaming Hebrew + English STT | Custom runtime | Apache-2.0 | Yes | — | — | Weeks old, single author | VERIFIED-official |
| `thewh1teagle/parakeet-tdt-0.6b-v3-he`, `dm15/parakeet-tdt-0.6b-hebrew` | Hebrew STT | — | CC BY 4.0 | Yes | — | Attribution required | Hebrew only; lower accuracy than ivrit.ai Whisper | VERIFIED-official |
| `nvidia/nemotron-3.5-asr-streaming-0.6b` | Streaming STT | — | OpenMDW-1.1 | Yes | Keep licence and notices on redistribution | Patent-litigation termination clause | Hebrew needs fine-tuning (17.1 / 36.5 WER out of the box) | VERIFIED-official; WER PUBLISHED-thirdparty |
| `Hebrish/*` ASR models | Code-switching STT | — | CC BY-NC 4.0, gated | **No** without a commercial licence | Non-commercial | — | Non-commercial; English-dominant | VERIFIED-official |
| `ufal/SimulStreaming` | Whisper streaming policy | MIT per author statement; no LICENSE file in repo | n/a | Unclear | Confirm before shipping | — | Not needed for endpoint-then-decode | VERIFIED-official (absence of file) |
| Pipecat Smart Turn v3.2 | End-of-turn model | BSD-2-Clause | BSD-2-Clause | Yes | None recorded | — | Hebrew not among its 23 languages; needs validation | VERIFIED-official |
| LiveKit turn detector (`v1`, `v1-mini`, text model) | End-of-turn model | Apache-2.0 (plugin) | **LiveKit Model License** | Only inside LiveKit Agents | No standalone use; outputs may not train other models | — | Framework lock-in; no Hebrew | VERIFIED-official |
| TEN VAD | VAD | Apache-2.0 with additional conditions | Same | Restricted | May not compete with Agora's offerings | Legal review needed | Non-compete clause | VERIFIED-official; risk reading ESTIMATE |
| TEN Framework | Agent framework | Apache-2.0 with added conditions | n/a | Restricted | No hosting on end-user mobile devices; no competing with Agora | — | Licence conditions and Agora coupling | VERIFIED-official |
| `nvidia/parakeet_realtime_eou_120m-v1` | ASR with end-of-utterance token | — | NVIDIA Open Model License | Yes ("commercially usable") | NVIDIA licence conditions | — | English only | VERIFIED-official |
| RNNoise; DeepFilterNet | Noise suppression | BSD-3-Clause; MIT OR Apache-2.0 | Same | Yes | None recorded | — | Optional stage; not needed in the POC | VERIFIED-official |
| Krisp VIVA SDK | Noise suppression | Proprietary | Proprietary | Licence key required | No public price | — | Proprietary; not needed | PUBLISHED-thirdparty |
| Pipecat 1.17.0 | Agent framework | BSD-2-Clause | n/a | Yes | None recorded | — | Evaluated; production candidate; custom server used in the POC | VERIFIED-official |
| LiveKit Agents 1.8.13; LiveKit server | Agent framework; WebRTC SFU | Apache-2.0 | n/a | Yes | None recorded for self-hosting | Best turn and interruption models are cloud-metered | Evaluated; production candidate | VERIFIED-official |
| FastRTC; Vocode | Agent libraries | MIT | n/a | Yes | None recorded | — | Stale releases; no per-stage metrics | VERIFIED-official |
| `dicta-il/DictaLM-3.0-24B-Thinking` | Hebrew LLM | n/a | Apache-2.0 | Yes | None recorded | — | Always emits a thinking block; suited to offline summarisation | VERIFIED-official |
| `dicta-il/DictaLM-3.0-Nemotron-12B-Instruct` | Hebrew LLM | n/a | **NVIDIA Open Model License** | Yes | Grant is revocable under its conditions | — | Weaker scores; non-Apache licence | VERIFIED-official |
| Qwen3.5 / 3.6 / 3.8 open models | LLM | n/a | Apache-2.0 (except `Qwen3.8-Flash-Next`: `qwen-community-1.0`, gated, terms not reviewed) | Yes | None recorded | — | No published Hebrew score | VERIFIED-official |
| Llama 3.3 / Llama 4 | LLM | n/a | Llama Community License | Yes, with conditions | "Built with Llama" notice on distribution; Acceptable Use Policy; Llama 4 multimodal withheld from EU-domiciled licensees | — | Weak Hebrew; licence conditions | VERIFIED-official; EU clause PUBLISHED-thirdparty |
| Gemma 3 / 3n | LLM | n/a | Gemma Terms of Use | Yes | Prohibited-use policy must be passed downstream; Google may restrict usage | — | Superseded by Gemma 4 (Apache-2.0) | PUBLISHED-thirdparty |
| Cohere Aya Expanse, Command R, tiny-aya | LLM | n/a | CC BY-NC 4.0 | **No** | Non-commercial | — | Excluded on licence | VERIFIED-official |
| `openai/gpt-oss-20b`, `-120b` | LLM | n/a | Apache-2.0 | Yes | None recorded | — | Always reasons; weak Hebrew translation score | VERIFIED-official |
| Kyutai Moshi | Open speech-to-speech | MIT / Apache | CC BY 4.0 | Yes with attribution; card says "for research only" | — | Attribution required | English only | VERIFIED-official |
| `nvidia/personaplex-7b-v1` | Open speech-to-speech | MIT | NVIDIA Open Model License (plus CC BY 4.0 notice for the Moshi base) | Yes | Terminates if a guardrail is bypassed without an equivalent | Gated: licence acceptance required | English only; about 2.5 min memory | VERIFIED-official |
| NVIDIA NemotronLabs VoiceChat 11B | Open speech-to-speech | Apache-2.0 | OpenMDW-1.1 | Yes | Notice retention | — | English only; 80 GB VRAM | VERIFIED-official |
| Haru-4B; Sophon-Realtime v1 | Open speech-to-speech | Apache-2.0 | Apache-2.0 (Sophon's "ears" component is published separately under CC BY-NC 4.0) | Yes on paper | Check Sophon component licences | — | No Hebrew | VERIFIED-official |
| LFM3-Audio-2B, LFM3-Omni-2B | Turn-based audio model | LFM Open License v1.0 | LFM Open License v1.0 | Only under $10M annual revenue | Revenue threshold | — | Voice chat English-only; revenue cap | VERIFIED-official |
| Ultravox v0.5–v0.7 | Speech-in LLM | MIT (adapter) | Backbone LLM licences apply separately | Yes | Inherits backbone terms | — | Hebrew not among its 42 languages | VERIFIED-official; backbone reading ESTIMATE |

---

## 4. Commercial API terms that matter

| Provider / endpoint | Term | Detail | Verification |
|---|---|---|---|
| OpenAI Realtime (`/v1/realtime`) | Training on customer data | Not used for training | UNVERIFIED |
| OpenAI Realtime | Retention | 30-day abuse-monitoring retention; no application state; eligible for Zero Data Retention, which needs prior approval from OpenAI | UNVERIFIED |
| OpenAI Realtime | Session limit | 60 minutes maximum | UNVERIFIED |
| OpenAI Realtime | Deprecations | `gpt-realtime`, `gpt-realtime-2025-08-28`, `gpt-realtime-mini`, `gpt-realtime-mini-2025-12-15` shut down 2027-01-20. The POC uses `gpt-realtime-2.1` / `-mini`, which are not on that list | VERIFIED-official |
| OpenAI Realtime | Input transcription | Runs through a separate transcription model and is billed separately. `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe-diarize` shut down 2027-02-26. The POC config uses `gpt-transcribe` | VERIFIED-official; local file (POC setting) |
| OpenAI Realtime | Concurrency | Realtime limits by tier not found | not researched |
| OpenAI GPT-Live (`/v1/live/sessions`) | Retention | Listed as ZDR-eligible "with limitations" | UNVERIFIED |
| OpenAI GPT-Live | Storage | Sessions stored only if `store: true`; default false | VERIFIED-official |
| OpenAI GPT-Live | Session limit | A duration limit exists; value not found (one blog says about 30 minutes) | VERIFIED-official (existence); UNVERIFIED (value) |
| OpenAI GPT-Live | Concurrency | 25 / 50 / 200 / 300 / 500 concurrent sessions at Tiers 1–5 | PUBLISHED-thirdparty |
| OpenAI TTS | Deprecation | `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts` shut down 2027-01-06 | VERIFIED-official |
| OpenAI `gpt-6-luna` (text) | Caching | Cache write 1.25× input for 30 minutes, reads 0.1×, minimum 1,024 tokens | VERIFIED-official |
| OpenAI `gpt-6-luna` (text) | Retention, training | Not researched | not researched |
| Google Gemini Live on Google Cloud | Retention | Zero data retention available only if session resumption is off; resumption caches text, audio and outputs for up to 24 hours | UNVERIFIED |
| Google Gemini Live | Retention vs design | A 30-minute session needs resumption, so it conflicts with strict zero retention on Google Cloud | ESTIMATE |
| Google Gemini Live via Gemini Developer API (the POC's configured path) | Retention, training | Not researched | not researched; local file (POC path) |
| Google Gemini Live | Session limit | About 15 minutes audio-only without context compression; about 10 minutes per connection; resumption handles valid 2 h (Gemini API) or 24 h (Google Cloud) | UNVERIFIED |
| Google Gemini Live | Billing rule | Whole session context is re-billed on every turn; no cached-input price | VERIFIED-official |
| Google Gemini Live | Concurrency | 1,000 concurrent sessions per project for the 2.5 native-audio model; 3.8 figure not found | UNVERIFIED |
| Google Gemini Live | Deprecations | `gemini-3.1-flash-live-preview` reported retired 2026-11-17; `gemini-live-2.5-flash-native-audio` discontinued 2026-12-13 | PUBLISHED-thirdparty |
| Google `gemini-3.1-flash-lite` (text) | Caching | Implicit caching on by default, 90% discount, no storage fee | VERIFIED-official |
| Google text models | Deprecation, price change | `gemini-2.5-flash-lite` retired 2026-10-20; `gemini-3.8-flash` price doubles after 2026-12-31 | VERIFIED-official |
| Google text and TTS models | Retention, training | Not researched | not researched |
| Google Gemini TTS previews | Price change | 3.8 Flash and Flash-Lite TTS prices double on 2027-01-01 | VERIFIED-official |
| Soniox (STT fallback candidate) | Deprecation | `stt-rt-v5` removed 2026-12-15, auto-routes to `stt-rt-v6` | VERIFIED-official |
| Deepgram (STT fallback candidate) | Price status, concurrency | Nova-3 prices are promotional; 150 concurrent streaming connections on pay-as-you-go | VERIFIED-official |
| STT APIs generally | Silence billing | Differs by vendor (Deepgram: per second of processed audio; Soniox: duration of audio or session) | VERIFIED-official |
| Cartesia (TTS fallback candidate) | Commercial use | Commercial use needs a paid plan | VERIFIED-official |
| Hume | Deprecation | Octave TTS API sunset 2026-11-13 | PUBLISHED-thirdparty |
| Alibaba Qwen3.8-Omni-Flash-Realtime | Data residency | Hosted in China (Beijing) and Singapore regions; sessions up to 120 minutes | VERIFIED-official |
| Soniox, Deepgram, Inworld, Cartesia, ElevenLabs, Azure, Alibaba | Retention, training on customer data | Not researched | not researched |
| LiveKit Cloud, Pipecat Cloud (managed hosting) | Data terms | Not researched | not researched |
| RunPod (recommended GPU host) | Endpoint exposure | HTTP proxy URL is public and unauthenticated; the application must enforce its own key | UNVERIFIED |

---

## 5. Voice synthesis usage restrictions and voice-cloning consent

| Item | Restriction or fact | Verification |
|---|---|---|
| Product position | Cloning is not needed: pick one stock or designed voice per persona and avoid the consent question | ESTIMATE |
| Kokoro-82M | Fixed voices, no cloning | PUBLISHED-thirdparty |
| `piper-he-noa` | Fixed synthetic voice "noa", trained on speech generated with Chatterbox; CC BY 4.0 attribution applies. The reference voice used to generate the training speech is not documented on the card | local file; VERIFIED-official |
| Chatterbox (source of the noa training speech) | Embeds Resemble's Perth neural watermark in every generated file | VERIFIED-official |
| Piper `en_US-lessac-medium` | Single-speaker voice from the Blizzard 2013 "lessac" dataset; dataset terms not researched | local file |
| BlueV3 / BlueTTS (pending) | Places responsibility for consent and lawful use on the user; vocoder carries OpenRAIL-M use-based restrictions | VERIFIED-official |
| ZONOS3-Mini | Clones from a reference clip; no watermark or cloning restriction found on the card | VERIFIED-official |
| Higgs TTS 3 | Prohibits voice cloning without consent, impersonation and fraud | VERIFIED-official |
| ivrit.ai dataset licence | No voice deep-fakes; applies to us only if we train on the datasets ourselves | VERIFIED-official |
| OpenAI Realtime voices | Fixed list (`marin`, `cedar` recommended) or a custom voice ID; terms for custom voices not researched | VERIFIED-official (list); not researched (custom-voice terms) |
| Disclosure that the voice is synthetic | Legal requirements were not researched | not researched |

Engineering position: use only stock voices; do not accept user-supplied reference audio; if a custom brand voice is ever recorded, obtain a written release from the speaker that covers synthetic reproduction. The last point is general practice, not a finding of the research.

---

## 6. Audio recording, retention and user consent

**Counsel review is required** under the Israeli Privacy Protection Law and, where EU users or EU hosting are involved, the GDPR. The research reports do not analyse either law. The points below are engineering facts and general practice only.

What the POC does today (local file: `backend/app/config.py`, `memory/store.py`, `backend/app/main.py`):

| Behaviour | Default | Setting | Verification |
|---|---|---|---|
| Raw user audio written to disk | Off | `ROLLY_RETAIN_AUDIO=false` | local file |
| Transcripts and telemetry stored | On | `ROLLY_STORE_TRANSCRIPTS=true` | local file |
| Transcript and telemetry retention | 30 days, purged at start-up and daily | `ROLLY_TRANSCRIPT_RETENTION_DAYS=30` | local file |
| Derived memory summaries | Kept until the user deletes them | — | local file |
| Erasure | `DELETE /api/users/{user_id}` removes profile, memory, transcripts and telemetry | — | local file |

Points to settle before launch (general engineering practice, not legal findings):

- Voice is personal data and may reveal sensitive information. Obtain clear, recorded consent before the first session, and state what is recorded, where it is processed and for how long.
- An in-car microphone captures passengers who have not consented. Product and counsel need a position on this.
- Long-lived memory summaries are a separate retention decision from raw transcripts.
- When a commercial API is in the path, the provider's own retention applies in addition to ours (section 4), and zero-retention modes may need provider approval.
- Keep raw audio retention off by default; if it is enabled for quality work, make it opt-in and time-limited.
- Hosting region matters. The research recommends EU GPU regions for latency and price (ESTIMATE; region availability UNVERIFIED); cross-border transfer implications were not researched.

---

## 7. Third-party data processing by architecture

| Architecture | What leaves our infrastructure | Recipient | Verification |
|---|---|---|---|
| A — commercial realtime, OpenAI | Continuous user microphone audio; system prompt and memory text; tool outputs. Input transcription (`gpt-transcribe`) is also performed by the provider | OpenAI (`api.openai.com`) | VERIFIED-official (protocol); local file (POC config) |
| A — commercial realtime, Google | Continuous user microphone audio; system prompt and memory text; with session resumption, cached session state held by the provider for up to 24 h | Google, via the Gemini Developer API endpoint as configured; Google Cloud endpoint is the alternative | VERIFIED-official (protocol); UNVERIFIED (resumption caching); local file (POC config) |
| B — self-hosted modular | No audio or text is sent to a model provider. Audio and text are processed on servers we rent | GPU or server host only (research recommends RunPod, EU region) | local file (POC config); UNVERIFIED (host details) |
| C — open speech-to-speech | Not implemented (NO-GO) | — | — |
| D — hybrid | Text only: user transcript, system prompt, memory and rolling history go to the LLM API. Raw audio stays on our servers (self-hosted VAD, STT, TTS) | Google (`gemini-3.1-flash-lite`) or OpenAI (`gpt-6-luna`) | local file (POC config) |
| Memory summariser (all architectures) | Session transcript text | The utility LLM endpoint; defaults to the local LLM, becomes a third party only if pointed at a commercial API | local file |
| Optional commercial fallbacks (not implemented) | STT fallback: user audio. TTS fallback: agent reply text | Soniox or Deepgram; Inworld or Cartesia | ESTIMATE |
| Benchmarks | FLEURS clips and synthetic audio only; no real user data | Same recipients as the architecture under test | local file |
| Model downloads | No user data; model identifiers only | Hugging Face Hub | local file |

---

## 8. Open questions for counsel

1. Does running sherpa-onnx with bundled espeak-ng data on our own servers create any GPL obligation? Would shipping the same components inside a mobile or in-car client?
2. What exact licence governs the Piper `en_US-lessac-medium` voice (Blizzard 2013 "lessac" dataset), and is commercial use permitted?
3. How and where must CC BY 4.0 attribution be given for `piper-he-noa`, `renikud` and the adapted `renikud-onnx` glue code? Does attribution attach to generated audio?
4. What are our obligations under LGPL-2.1-or-later for `soxr`, server-side and in any distributed client?
5. Is the BigScience OpenRAIL-M vocoder licence in BlueV3 acceptable for this product, and is undocumented training data an acceptable risk?
6. Which CC BY version applies to Google FLEURS, and what attribution wording should accompany published benchmark results?
7. Is the `apache-2.0` declaration in the Qwen3-4B-Instruct-2507 GGUF header sufficient, or must the upstream licence file and the unsloth repack terms be reviewed?
8. Which OpenAI and Google data-processing terms apply to the endpoints the product would use, can zero data retention be obtained, and is the Gemini Developer API path acceptable or must production use Google Cloud?
9. Is session resumption on Gemini Live (provider-side caching of audio for up to 24 hours) compatible with our retention commitments?
10. What consent wording and flow are required under the Israeli Privacy Protection Law and the GDPR for voice capture, transcripts and long-lived memory, including passengers?
11. Are there cross-border transfer requirements if Israeli users' audio is processed in EU or US data centres?
12. If we fine-tune STT on ivrit.ai datasets, what do the dataset terms (attribution, training-only use, no deep-fakes) require of the product?
13. Are there disclosure requirements for synthetic voices, and what release is needed if a custom brand voice is recorded?
14. If LiveKit Agents is adopted for production, is the LiveKit Model License on its turn detector acceptable given the framework lock-in?
