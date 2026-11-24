# 03 — Text-to-Speech for the modular voice pipeline (Hebrew + English)

**Research date / access date for every source: 2026-11-24.**
Scope: streaming TTS for a proactive real-time voice companion (Hebrew + English, mixed sentences, barge-in, thousands of concurrent users, target ≤ $0.005 per conversational minute all-in, time-to-first-audio < 200–300 ms).

## How to read this document

Every factual claim carries one of four tags:

| Tag | Meaning |
|---|---|
| **[VERIFIED-official]** | Read on 2026-11-24 from the vendor's / author's own page: model card, repo README, LICENSE, official docs, official pricing page or official pricing API. |
| **[PUBLISHED-thirdparty]** | Published by someone other than the party the claim is about (a competitor's benchmark, a blog, a search-result summary). Not reproduced by us. |
| **[ESTIMATE]** | Our own arithmetic or judgment. The inputs are stated. |
| **[UNVERIFIED]** | Could not be confirmed from a primary source in this session. Treat as a to-do, not a fact. |

In tables, the **Evidence** column gives the tag for the whole row; a cell that differs carries its own tag.

**Method note.** The session's page-fetch tool could not resolve most hosts (huggingface.co, elevenlabs.io, cartesia.ai, zyphra.com). Those pages were instead downloaded with `curl` through the session proxy and read as text, and Hugging Face metadata came from the Hugging Face API (`/api/models/<id>`) and raw `README.md` files. Pages that render prices with JavaScript (Azure, Hume, Zyphra Cloud, Gemini API docs) returned no usable numbers; Azure prices were taken from Microsoft's official Retail Prices API instead. Nothing here was listened to: **no audio quality claim in this document is our own**.

---

## 1. Summary

1. **Self-hosted TTS is the only way to hit the cost target.** The cheapest commercial Hebrew-capable streaming APIs found cost about $0.005 (with a volume commitment) to $0.011 (list price) per generated Hebrew minute, which alone consumes half or all of the $0.005 budget. Self-hosted candidates cost roughly $0.0001–0.0005 per generated minute. [ESTIMATE]
2. **Commercially licensed, self-hostable Hebrew TTS now exists** — this changed in 2026. Four candidates have permissive licenses on the weights: **ZONOS3-Mini** (Apache-2.0), **BlueV3** (MIT, with an OpenRAIL-M vocoder), **piper-he-noa** (CC BY 4.0) and **VoxCPM2** (Apache-2.0). [VERIFIED-official]
3. **None of them is proven production-grade for conversational Hebrew.** Two are weeks old, the Hebrew evidence is vendor-published, and one has undocumented training data. A native-listener bake-off in the POC is required before committing. [ESTIMATE]
4. **The classic Hebrew stack (Phonikud + Piper/StyleTTS2, Robo-Shaul, SASPEECH, MMS-TTS, Zonos-Hebrew) is non-commercial** and cannot ship in this product. [VERIFIED-official]
5. **Three widely assumed options are gone or going:** Resemble's Chatterbox was retired in August 2026, OpenAI is shutting down `gpt-4o-mini-tts` on 2027-01-06, and Hume's Octave TTS API was sunset on 2026-11-13. See section 7.

### Recommendations

| Need | Pick | Model ID | License (weights) | Why |
|---|---|---|---|---|
| (a) Self-hosted English | **ZONOS3-Mini**, with Kokoro-82M as the proven low-risk baseline | `Zyphra/ZONOS3-Mini`; `onnx-community/Kokoro-82M-v1.0-ONNX` | Apache-2.0; Apache-2.0 | One voice for both languages, frame-level streaming, 80 ms time-to-first-audio published. Kokoro is the fallback because ZONOS3-Mini is two weeks old. |
| (b) Self-hosted Hebrew | **Bake-off: ZONOS3-Mini vs BlueV3** (VoxCPM2 as quality reference, piper-he-noa as CPU floor) | `Zyphra/ZONOS3-Mini`; `notmax123/BlueV3-onnx`; `openbmb/VoxCPM2`; `thewh1teagle/piper-he-noa` | Apache-2.0; MIT + OpenRAIL-M; Apache-2.0; CC BY 4.0 | All are commercially usable. None is proven production-grade — see section 4.5 for the honest statement. |
| (c) Commercial Hebrew fallback | **Inworld Realtime TTS-2 Flash**; second source Cartesia Sonic 3.6 | `inworld-tts-2-flash`; `sonic-3.6` | n/a | Hebrew is a Tier 1 language at Inworld; lowest price found and lowest published latency. |

---

## 2. Assumptions used for all per-minute conversions

| Assumption | Value | Basis |
|---|---|---|
| English characters per minute of speech | **900** | ~150 words/min × ~6 characters per word including the space. [ESTIMATE] |
| Hebrew characters per minute of speech | **750** | Unvocalized Hebrew words are shorter (no written vowels). [ESTIMATE] Cartesia's own calculator implies 750 characters/min (8M credits ≈ 10,667 min). [VERIFIED-official] Rime states "about 1K characters per minute". [VERIFIED-official] |
| Share of a conversational minute in which the agent speaks | **~50 %** | A conversational minute needs about half a generated minute. Halve the per-generated-minute figures to get TTS cost per conversational minute. [ESTIMATE] |
| GPU rental | **$2–3 per H100-hour** | Not researched in this document; taken as a round planning number. [UNVERIFIED] |

---

## 3. Open-weight / self-hostable candidates — comparison table

Hebrew column: **native** = the model accepts Hebrew text itself; **G2P** = it needs an external diacritization/phonemization front-end; **no** = not supported.

### 3.1 Candidates with Hebrew support

| Model | Size / memory | Hebrew | English | Streaming and latency | Code license | Weights license | Commercial use | Evidence |
|---|---|---|---|---|---|---|---|---|
| **ZONOS3-Mini** (Zyphra, Nov 2026) | 800M total, ~100M active per token (mixture of experts); 44.1 kHz | Native, one of 43 languages. Non-normalized languages "pass through as written", so it takes unvocalized Hebrew. | Yes | Frame-level streaming. Median time-to-first-audio 80 ms at 8 concurrent requests on one H100; peak 457 s of audio per second per H100. | MIT | Apache-2.0 | Yes | [VERIFIED-official] |
| **BlueV3 v3.0.1** (Max Melichov, Nov 2026) | ONNX bundle ~0.5 GB plus a 1.2 GB Hebrew G2P model; 44.1 kHz | G2P: RenikudPlus + Hebrew text normalizer, both shipped. Takes plain Hebrew text. Hebrew-first model. | Yes, same voices; inline `<en>…</en>` tags for mixed text | Sentence-by-sentence streaming (non-autoregressive flow matching, 8 steps). 5× real time on a 2-CPU cloud server, 15× on a Ryzen 9, 22× on an Apple M5. | MIT | MIT, except the vocoder: BigScience OpenRAIL-M (derived from Supertonic-3) | Yes, subject to OpenRAIL-M use restrictions | [VERIFIED-official]; training-data provenance [UNVERIFIED] |
| **piper-he-noa** (thewh1teagle, Oct 2026) | VITS medium, 77 MB ONNX, 22.05 kHz, CPU | G2P: stressed IPA via ReNikud per the model card | Second speaker (`ljspeech`) in the same model — a different voice | Piper synthesizes per sentence; the engine's new split-decoder mode gives first sound in ~0.2 s. | Piper engine GPL-3.0-or-later | CC BY 4.0 | Yes | [VERIFIED-official] |
| **VoxCPM2** (OpenBMB) | 2B, ~8 GB VRAM, 48 kHz | Native, one of 30 languages | Yes | Streaming API. Real-time factor ~0.30 on an RTX 4090, ~0.13 with Nano-vLLM. | Apache-2.0 | Apache-2.0 | Yes | [VERIFIED-official] |
| **MOSS-TTS-Realtime** (OpenMOSS) | Size not checked [UNVERIFIED] | Native, one of 20 languages | Yes | Built for voice agents; time-to-first-byte 180 ms. | Apache-2.0 [UNVERIFIED] | Apache-2.0 | Yes | [VERIFIED-official] |
| **Chatterbox Multilingual V3** (Resemble) | 0.5B | Listed among 23 languages. A third party reports unintelligible Hebrew without a Dicta diacritizer loaded. [PUBLISHED-thirdparty] | Yes | No streaming claim in the repo. | MIT | MIT | Yes, but **retired and unmaintained since August 2026** | [VERIFIED-official] |
| **pocket-tts-onnx + Hebrew adapter** (thewh1teagle, on Kyutai Pocket TTS) | 100M base; 0.73M-parameter Hebrew IPA adapter; 177–231 MB ONNX; CPU | G2P: ReNikud, via an "english-ipa" model with a Hebrew adapter | Yes | Streaming in 80 ms frames; first audio in 20–80 ms on CPU. | CC BY 4.0 | CC BY 4.0 | Yes | [VERIFIED-official]; adapter training data [UNVERIFIED] |
| **QwenTTS-he-1.7B** (LoRA on Qwen3-TTS) | 1.7B base + 246 MB adapter | G2P: input must be stressed IPA | Base model, with the adapter disabled | Card example uses non-streaming mode. | Apache-2.0 | Apache-2.0 | Yes on paper; training-data provenance [UNVERIFIED] | [VERIFIED-official] |
| **neutts-air-he** (LoRA on NeuTTS Air) | LoRA rank 32 | G2P: Phonikud | Base model | Not stated | Apache-2.0 | Apache-2.0 | Yes on paper; training data [UNVERIFIED] | [VERIFIED-official] |
| **voxtream2-he** (flowtyone) | Small, fully streaming | G2P: ReNikud, with espeak-ng for English; mixed Hebrew/English supported | Mixed in | One ~80 ms frame at a time; first chunk in "tens of milliseconds". Card warns outputs "are not always stable". | GPL-3.0 | GPL-3.0, **but the base `herimor/voxtream2` is CC BY-NC 4.0** | **Conflicted** — do not rely on it | [VERIFIED-official] |
| **OmniVoice** (k2-fsa) | Not checked | Native (600+ languages) | Yes | Real-time factor as low as 0.025. | Apache-2.0 | **CC BY-NC** | No | [VERIFIED-official] |
| **Fish Audio S2 Pro** | 4B + 400M | Native (80+ languages) | Yes | Time-to-first-audio ~100 ms, real-time factor 0.195. | — | Fish Audio Research License | No (paid license required) | [VERIFIED-official] |
| **Fish Audio Drama 3** (Oct 2026) | 35B total, 3B active | Native | Yes | Time-to-first-audio 89 ms at 1 stream, 210 ms at 16 streams on an H200. | — | Fish Audio Community/Research License — non-commercial per the repo metadata | No without a license | [VERIFIED-official] |
| **Higgs TTS 3** (Boson) | 4B | Native (100+ languages) | Yes | "Sub-second" time-to-first-audio; mean latency 617–1079 ms in the card's table. | — | Boson Research and Non-Commercial License | No | [VERIFIED-official] |
| **Phonikud-TTS checkpoints** (Piper, StyleTTS2) | Small | G2P: Phonikud | No | Real-time on CPU | Non-commercial | "non commercial (cc-nc)" | No | [VERIFIED-official] |
| **Official Piper `he_IL-saspeech-medium`** | 63 MB | G2P | No | CPU | GPL-3.0-or-later | SASPEECH: non-commercial; Piper lists it under "not on the commercial list" | No | [VERIFIED-official] |
| **kokoro-hebrew-saspeech / kokoro-hebrew-nc** | 82M | G2P | No | — | — | SASPEECH non-commercial | No | [VERIFIED-official] |
| **MMS-TTS Hebrew** (`facebook/mms-tts-heb`) | VITS | Native, quality not assessed | No | — | — | CC BY-NC 4.0 | No | [VERIFIED-official] |
| **Zonos-Hebrew** (fine-tune of Zonos v0.1) | — | G2P: Phonikud | — | — | — | CC BY-NC 4.0 | No | [VERIFIED-official] |
| **Robo-Shaul**, **MamreTTS** | — | — | No | — | — | CC BY-NC-SA 4.0; CC BY-NC 4.0 | No | [VERIFIED-official] |
| **HebTTS** (slp-rl, Interspeech 2024), **LoTHM** | — | Diacritic-free language-model approach | No | — | Not found | Not found | Unknown | [UNVERIFIED] |
| **ivrit.ai** | — | No TTS model found on its Hugging Face organization — only speech recognition models | — | — | — | — | — | [VERIFIED-official] |

### 3.2 Candidates without Hebrew

| Model | Size | Languages | Streaming and latency | Weights license | Commercial use | Evidence |
|---|---|---|---|---|---|---|
| **Kokoro-82M** | 82M; ONNX 86–326 MB | American and British English, Japanese, Mandarin, Spanish, French, Hindi, Italian, Brazilian Portuguese. **No Hebrew.** | Sentence-chunked; speed figures not checked [UNVERIFIED] | Apache-2.0. Inference depends on espeak-ng (GPL) for fallback [PUBLISHED-thirdparty] | Yes | [VERIFIED-official] |
| **Chatterbox Turbo / Nano** | 350M / 110M | English | Turbo: single-step decoder. Nano: 3× real time on 8 CPU cores. | MIT | Yes; retired August 2026 | [VERIFIED-official] |
| **Qwen3-TTS** (0.6B, 1.7B) | 0.6B / 1.7B | 10 languages, no Hebrew | First packet as low as 97 ms | Apache-2.0 | Yes | [VERIFIED-official] |
| **Kyutai Pocket TTS** | 100M (English down to 1.9M) | English, French, German, Portuguese, Italian, Spanish | CPU only; ~200 ms to first chunk; ~6× real time on a MacBook Air M4 | CC BY 4.0 | Yes | [VERIFIED-official] |
| **Kyutai TTS 1.6B** | 1.6B | English, French | Streaming [UNVERIFIED latency] | CC BY 4.0 | Yes | [VERIFIED-official] |
| **Gradium phonon-31m-en** (Oct 2026) | 31M | English | One 80 ms frame at a time | Apache-2.0 (the 40M multilingual variants are CC BY-NC) | Yes | [VERIFIED-official] |
| **Supertonic 3** | ~99M | 31 languages, no Hebrew | On-device | OpenRAIL-M (sample code MIT) | Yes, with use restrictions | [VERIFIED-official] |
| **CosyVoice 2 / Fun-CosyVoice3** | 0.5B | 9 languages, no Hebrew | Streaming [UNVERIFIED latency] | Apache-2.0 | Yes | [VERIFIED-official] |
| **Orpheus 3B** | 3B | English | [UNVERIFIED] | Apache-2.0 | Yes | [VERIFIED-official] |
| **Sesame CSM-1B** | 1B | English; the repo says other languages "likely won't do well" | [UNVERIFIED] | Apache-2.0 | Yes | [VERIFIED-official] |
| **NeuTTS Air / Nano** | — | English | [UNVERIFIED] | Air: Apache-2.0. Nano: "other" | Air: yes | [VERIFIED-official] |
| **VibeVoice 1.5B / Realtime-0.5B** | 1.5B / 0.5B | English, Chinese / English | [UNVERIFIED] | MIT | Yes | [VERIFIED-official] |
| **Dia 1.6B / Dia2-2B** | 1.6B / 2B | English | [UNVERIFIED] | Apache-2.0 | Yes | [VERIFIED-official] |
| **IndexTTS-2** | — | English, Chinese | [UNVERIFIED] | No license in the repo metadata [UNVERIFIED] | Unknown | [VERIFIED-official] |
| **MeloTTS** | — | No Hebrew [UNVERIFIED] | CPU real time [UNVERIFIED] | MIT | Yes | [VERIFIED-official] |
| **StyleTTS2** | — | English | — | Not in repo metadata [UNVERIFIED] | Unknown | [UNVERIFIED] |
| **F5-TTS** | — | English, Chinese | — | CC BY-NC 4.0 (code MIT) | No | [VERIFIED-official] |
| **Coqui XTTS-v2** | — | 17 languages, **no Hebrew** | Streaming | Coqui Public Model License — non-commercial. Coqui shut down in January 2024, so no commercial license can be bought. [PUBLISHED-thirdparty] | No | [VERIFIED-official] |
| **OpenAudio / Fish S1-mini** | — | 13 languages, no Hebrew | — | CC BY-NC-SA 4.0 | No | [VERIFIED-official] |
| **Voxtral 4B TTS** (Mistral) | 4B | 9 languages, no Hebrew | — | CC BY-NC 4.0 | No | [VERIFIED-official] |
| **Higgs Audio v2** | 3B | — | — | Could not fetch | Unknown | [UNVERIFIED] |

### 3.3 Voice-cloning restrictions

- **Chatterbox** embeds Resemble's Perth neural watermark in every generated file. [VERIFIED-official]
- **Higgs TTS 3** prohibits voice cloning without consent, impersonation and fraud. [VERIFIED-official]
- **BlueTTS** places responsibility for consent and lawful use entirely on the user; its vocoder carries OpenRAIL-M use-based restrictions. [VERIFIED-official]
- **ZONOS3-Mini** clones from a reference clip with no transcript needed; no watermark or cloning restriction was found on the model card. [VERIFIED-official]
- **Kokoro** has fixed voices and no cloning. [PUBLISHED-thirdparty]
- For this product, cloning is not needed: pick one stock or designed voice per persona and avoid the consent question. [ESTIMATE]

---

## 4. Hebrew TTS — the hard part

### 4.1 Why Hebrew needs a front-end

Everyday Hebrew is written without vowel marks (niqqud), so the same letters can be read as different words, and stress is not written at all. A model that sees only letters must guess the vowels from context. There are two ways to solve it:

- **Front-end approach:** a separate model restores the vowels or converts text straight to phonemes (IPA with stress), and a small, fast acoustic model speaks the phonemes. Errors in the front-end become mispronunciations.
- **End-to-end approach:** a large multilingual model learns to read unvocalized Hebrew directly. No front-end, but the model must be big enough and have seen enough Hebrew.

### 4.2 Front-ends (diacritization and phonemization)

| Front-end | What it does | Size / speed | License | Evidence |
|---|---|---|---|---|
| **Phonikud** (thewh1teagle; arXiv 2506.12311) | Adds niqqud plus stress and vocal-shva marks, then rule-based conversion to IPA. Expands dates and numbers. English can be mixed in through a fallback phonemizer function. | ONNX, real-time | Code CC BY 4.0. ONNX weights (`Phonikud/phonikud-onnx`) MIT. | [VERIFIED-official] |
| **ReNikud** (Melichov, Kolani, Alper; IEEE SLT 2026; arXiv 2606.20179) | Audio-supervised Hebrew text → stressed IPA in one step. Passes non-Hebrew text through. The Phonikud repo itself points to it as "higher-accuracy G2P". | 20.6 MB ONNX; ONNX Runtime only, no PyTorch; `pip install renikud-onnx` | CC BY 4.0 | [VERIFIED-official] |
| **RenikudPlus 0.5.0** (Melichov) | Larger successor; the Hebrew front-end of BlueV3 | 1.23 GB ONNX (311 MB int8) | Weights Apache-2.0; `renikud-plus` package MIT | [VERIFIED-official] |
| **Dicta** (`dicta-il/dictabert-large-char-menaked`) | Niqqud restoration only; stress must be added separately | — | CC BY 4.0 | [VERIFIED-official] |
| **Dicta Nakdan hosted API** | Niqqud as a service | — | Commercial terms not checked | [UNVERIFIED] |
| **Nakdimon** | Niqqud restoration; used by Piper's built-in Hebrew phonemizer since Piper 1.6.0 | — | Not checked [UNVERIFIED] | [VERIFIED-official] for the Piper usage |
| **heb-tts-normalizer**, **hebrew-num2words** | Numbers, dates, currency, acronyms, URLs to Hebrew words | — | MIT; Apache-2.0 | [VERIFIED-official] |

Front-end licensing is not the blocker: every front-end above is commercially usable. **The blocker has always been the training speech.**

### 4.3 The data-license trap

Almost all older Hebrew voices descend from two corpora that forbid commercial use:

- **SASPEECH** (OpenSLR 134, the "Robo-Shaul" recordings): owned by the Israeli Public Broadcasting Corporation, free for non-commercial use only; commercial and broadcast use are barred. [PUBLISHED-thirdparty — OpenSLR page via search; consistent with the Phonikud repo and the Kokoro fine-tune card, both [VERIFIED-official]]
- **ILSpeech** (Phonikud project): non-commercial. [VERIFIED-official]

Consequences, all [VERIFIED-official] from the model cards:

- Phonikud-TTS checkpoints, the official Piper Hebrew voice, both Hebrew Kokoro fine-tunes, Robo-Shaul, MamreTTS and Zonos-Hebrew are non-commercial.
- The `kokoro-hebrew-saspeech` card states explicitly that a permissive wrapper license does not relax the dataset terms.
- **Watch for mislabeled repos.** `Phoonnx/vits-he_il-shaul-phonikud` is tagged MIT although the voice name indicates SASPEECH speech; `Yzamari/f5tts-hebrew-v2` is tagged Apache-2.0 although F5-TTS weights are CC BY-NC; `voxtream2-he` is GPL-3.0 on a CC BY-NC base. A license tag on Hugging Face is not a license chain. [ESTIMATE on the conclusion; tags [VERIFIED-official]]

### 4.4 Viable self-hosted paths

#### Path A — ZONOS3-Mini (end-to-end, no front-end)

- Apache-2.0 weights, MIT code. [VERIFIED-official]
- Takes Hebrew as written; no niqqud step. [VERIFIED-official]
- Hebrew results in Zyphra's own benchmark (FLEURS-R read speech, zero-shot, word error rate measured by a speech recognizer; lower is better): [PUBLISHED-thirdparty — vendor's own technical report, arXiv 2611.16525, Table 11; not independently reproduced]

| System | Hebrew WER % | Speaker similarity ×100 |
|---|---|---|
| Real human recordings (ground truth) | 28.97 | — |
| ZONOS2 8B | 11.75 | 69.7 |
| **ZONOS3-Mini** (raw-audio prompt / embedding prompt) | **13.25 / 15.09** | 72.8 / 80.6 |
| VoxCPM2 | 13.98–14.55 | 79.2–85.4 |
| VibeVoice 7B | 15.44 | 79.0 |
| Fish Audio Drama 3 | 17.27 | 79.6 |
| Higgs Audio v3 | 21.46 | 75.7 |
| MOSS-TTS v1.5 | 31.99 | 80.1 |
| OmniVoice | 33.41 | 85.9 |
| Fish S2 Pro | 55.66 | 78.5 |
| Qwen3-TTS 1.7B (no Hebrew support) | 88–92 | ~71 |

- How to read this: the recognizer scores real Hebrew speech at 29 % error, so absolute numbers are unreliable and only the ranking means anything. A low error rate shows the words are intelligible; it says nothing about stress, natural prosody or homograph choice — the things Hebrew listeners notice. [ESTIMATE]
- Risks: released around 2026-11-09 to 2026-11-17, so two weeks old with no independent reproduction; behavior on mixed Hebrew-English sentences is not documented; Hebrew gets no text normalization, so numbers and dates must be spelled out by our own normalizer. [VERIFIED-official for dates and normalization; [UNVERIFIED] for code-switching]

#### Path B — BlueV3 (Hebrew-first, phoneme front-end included)

- MIT, Hebrew-first, seven languages including English in one model with shared voices. [VERIFIED-official]
- Author-reported scores on unseen voices: Hebrew phone error rate 1.80 %, Hebrew speaker similarity 0.670, Hebrew DNSMOS 3.43; English word error rate 1.95 %. [VERIFIED-official — author's own numbers]
- Predicted naturalness (UTMOS) is 3.56 for Hebrew against 4.43 for English, so by the author's own measure Hebrew sounds less natural than English. [VERIFIED-official]
- Mixed sentences are explicitly supported with inline `<en>…</en>` tags in the same voice. [VERIFIED-official]
- Runs faster than real time on CPU, with an OpenAI-compatible streaming server included. [VERIFIED-official]
- Risks:
  - **Training-data provenance is not documented** on the model cards or README. Given the SASPEECH/ILSpeech history above, ask the author for the data list before commercial use. [UNVERIFIED]
  - The vocoder is an OpenRAIL-M derivative of Supertonic-3: commercial use is allowed but use-based restrictions travel with it. [VERIFIED-official]
  - Streaming is per sentence, not per frame; the first sentence must be fully generated before audio starts. At 5–22× real time on CPU a 3-second sentence takes roughly 0.15–0.6 s, so a GPU or short first clauses are needed to stay under 200–300 ms. [ESTIMATE]
  - The bundled server serves "one synthesis at a time"; a batched engine exists but needs integration work. [VERIFIED-official]
  - Single-author project; versions are incompatible with each other's voice files. [VERIFIED-official]

#### Path C — piper-he-noa (CPU floor)

- CC BY 4.0 weights; trained on 24 hours of synthetic Hebrew speech generated with Chatterbox (MIT) from Knesset sentences, plus public-domain LJSpeech — a license chain with no non-commercial link. [VERIFIED-official]
- 77 MB, runs on CPU, standard Piper ONNX. [VERIFIED-official]
- Risks:
  - It is a student of Chatterbox's Hebrew, which a third party rated poor; expect flat, read-speech prosody, not ChatGPT-Voice quality. [PUBLISHED-thirdparty for Chatterbox; [ESTIMATE] for the inference]
  - Hebrew and English are two different speakers in the model, so a mixed sentence switches voice. [VERIFIED-official]
  - The Piper engine is GPL-3.0-or-later. Running it server-side is not distribution, but shipping it inside an app would be; alternatively run the ONNX file directly with ONNX Runtime and a CC BY front-end. Not legal advice. [ESTIMATE]
  - The model card says phonemes follow ReNikud, while Piper's upstream Hebrew phonemizer source describes Nakdimon plus rules. Confirm which front-end matches the voice before judging quality. [VERIFIED-official for both statements]

#### Path D — VoxCPM2 (quality reference, expensive)

- Apache-2.0, "free for commercial use", native Hebrew. [VERIFIED-official]
- Hebrew error rate on par with ZONOS3-Mini and the best speaker similarity in the table above. [PUBLISHED-thirdparty]
- 2B parameters, ~8 GB VRAM, real-time factor 0.13–0.30 on an RTX 4090: roughly 3–8 concurrent streams per GPU, which is one to two orders of magnitude more expensive per minute than Paths A–C. Use it to calibrate "how good can open Hebrew sound", not as the production engine. [VERIFIED-official for the figures; [ESTIMATE] for the conclusion]

#### Not recommended

- **Chatterbox Multilingual V3** — MIT and Hebrew-capable on paper, but retired, watermarked, non-streaming and with a poor third-party Hebrew report.
- **Any SASPEECH/ILSpeech descendant** — non-commercial.
- **voxtream2-he** — best streaming design of the Hebrew community models, but an unresolved license conflict and self-declared instability.

### 4.5 Honest statement on self-hosted Hebrew

As of 2026-11-24 there is **no self-hostable Hebrew TTS that is both commercially licensed and demonstrated to be production-grade for natural conversational speech.** There are, for the first time, several that are commercially licensed and plausibly good enough, and the POC should test them rather than assume either outcome. Until a native-listener test passes, plan on a commercial API for Hebrew and self-hosted TTS for English. [ESTIMATE]

### 4.6 Mixed Hebrew-English sentences

| Engine | Handling | Evidence |
|---|---|---|
| BlueV3 | Inline `<en>…</en>` tags, same voice | [VERIFIED-official] |
| ZONOS3-Mini | One multilingual model; mid-sentence switching not documented | [UNVERIFIED] |
| piper-he-noa | Separate speaker per language — voice changes | [VERIFIED-official] |
| ReNikud / Phonikud front-ends | Pass non-Hebrew through, or call an English phonemizer fallback | [VERIFIED-official] |
| Inworld TTS-2 | Inline language tags | [VERIFIED-official] |
| Cartesia Sonic 3.6 | Multilingual voices; documented code-switching is for Hindi-English only | [VERIFIED-official] |

---

## 5. Commercial streaming TTS APIs

### 5.1 Hebrew support and latency

| Provider / model | Hebrew | Streaming latency claim | Notes | Evidence |
|---|---|---|---|---|
| **Inworld Realtime TTS-2 Flash** (`inworld-tts-2-flash`) | **Yes — Tier 1** (one of the 15 most extensively evaluated languages) | 20 ms P90 time-to-first-byte, server-side | Inline language tags; OpenAI-compatible endpoint | [VERIFIED-official] |
| **Inworld Realtime TTS-2** (`inworld-tts-2`) | Yes — Tier 1 | 100 ms P90 time-to-first-byte | Natural-language steering | [VERIFIED-official] |
| **Cartesia Sonic 3.6** (`sonic-3.6`, GA 2026-08-27) | **Yes** (`he`, one of 44) | First audio in under 90 ms | Commercial use needs a paid plan | [VERIFIED-official] |
| **ElevenLabs v4 Turbo** (`eleven_v4_turbo`) | **Yes** (90+ languages) | ~100 ms median | Served through the Text to Dialogue websocket | [VERIFIED-official] |
| **ElevenLabs v3 Conversational** | Yes (70+ languages) | ~165 ms in the docs, ~280 ms on the pricing page | The two official pages disagree | [VERIFIED-official] |
| **ElevenLabs Flash v2.5 / Turbo v2.5** | **No** — 32 languages, Hebrew absent | ~75–100 ms | Turbo is superseded by Flash | [VERIFIED-official] |
| **ElevenLabs Multilingual v2** | No | — | A third party reports unintelligible Hebrew [PUBLISHED-thirdparty] | [VERIFIED-official] |
| **Google Chirp 3 HD** | **Yes** (`he-IL`, generally available) | Bidirectional streaming supported; no latency figure found | No SSML in streaming mode | [VERIFIED-official] |
| **Google Gemini-TTS** (2.5 Flash / 3.1 Flash, Cloud TTS API) | Yes, **Preview** (`he-IL`) | "Low latency"; no figure | Streaming supported | [VERIFIED-official] |
| **Google Gemini 3.8 Flash / Flash-Lite TTS** | Not confirmed | — | GA only through the Agent Platform API, not the Cloud TTS API | [VERIFIED-official]; Hebrew [UNVERIFIED] |
| **Azure Neural** | **Yes** — `he-IL-HilaNeural`, `he-IL-AvriNeural` | No figure found | Older-generation prosody [ESTIMATE] | [VERIFIED-official] |
| **Azure HD (DragonHD) voices** | `he-IL` is listed with "HD voice" capability; which HD voices speak Hebrew was not determined | — | — | [UNVERIFIED] |
| **MiniMax Speech 2.8** (`speech-2.8-turbo`, `-hd`) | **Yes** (`language_boost: Hebrew`) | Not found | A third party rated MiniMax the best Hebrew of six providers in March 2025, on an older model [PUBLISHED-thirdparty] | [VERIFIED-official] |
| **OpenAI `gpt-4o-mini-tts`** | Yes (in the supported-language list) | Chunked streaming; no figure | **Deprecated; shuts down 2027-01-06.** Replacement is `gpt-realtime-2.1-mini` on the Realtime API, a different workflow. | [VERIFIED-official] |
| **Deepgram Flux TTS** | **No** — English plus 41 languages, Hebrew absent | As little as 80 ms [PUBLISHED-thirdparty] | Recommended over Aura-2 for new builds | [VERIFIED-official] |
| **Deepgram Aura-2** | **No** — 7 languages | — | Previous generation | [VERIFIED-official] |
| **Rime Coda v2 / Mist v3** | **No** — Coda 10 languages, Mist v3 four | Coda sub-100 ms; Mist v3 ~37 ms P50 | Arcana is retired | [VERIFIED-official] |
| **Amazon Polly** | **No** Hebrew voice in the voice list | — | — | [VERIFIED-official] |
| **Hume Octave** | Not in the published language list [PUBLISHED-thirdparty] | — | **TTS API sunset 2026-11-13**; Hume's site and docs now show a different product | [PUBLISHED-thirdparty]; current pages [VERIFIED-official] |

### 5.2 Prices

List prices, pay-as-you-go unless stated. Per-minute = price per 1M characters × characters per minute ÷ 1,000,000, at 900 (English) and 750 (Hebrew). All per-minute figures are [ESTIMATE]; all list prices are [VERIFIED-official].

| Provider / model | Price per 1M characters | $ / generated min, English | $ / generated min, Hebrew | Hebrew? |
|---|---|---|---|---|
| Inworld TTS-2 Flash — pay as you go | $15 | 0.0135 | 0.0113 | Yes |
| Inworld TTS-2 Flash — $1,500/month plan | $7 | 0.0063 | 0.0053 | Yes |
| Inworld TTS-2 Flash — enterprise | "sub-$5" | < 0.0045 | < 0.0038 | Yes |
| Inworld TTS-2 — pay as you go | $25 | 0.0225 | 0.0188 | Yes |
| Inworld TTS-2 — $1,500/month plan | $12.50 | 0.0113 | 0.0094 | Yes |
| Azure Neural — pay as you go | $15 | 0.0135 | 0.0113 | Yes |
| Azure Neural — commitment tiers (80M → 4,000M characters/month) | $12 → $6 | 0.0108 → 0.0054 | 0.0090 → 0.0045 | Yes |
| Azure Neural HD | $22 | 0.0198 | 0.0165 | Unclear |
| Google Chirp 3 HD | $30 | 0.0270 | 0.0225 | Yes |
| Cartesia Sonic 3.6 — Scale plan ($299 for 8M credits) | $37.38 | 0.0336 | 0.0280 | Yes |
| Cartesia Sonic 3.6 — Startup plan ($49 for 1.25M credits) | $39.20 | 0.0353 | 0.0294 | Yes |
| ElevenLabs v4 Turbo / v3 Conversational | $40 | 0.0360 | 0.0300 | Yes |
| ElevenLabs Flash / Turbo v2.5 | $40 | 0.0360 | — | No |
| ElevenLabs v4 / v3 / Multilingual v2 | $80 | 0.0720 | 0.0600 | v3, v4 only |
| MiniMax speech-2.8-turbo | $60 | 0.0540 | 0.0450 | Yes |
| MiniMax speech-2.8-hd | $100 | 0.0900 | 0.0750 | Yes |
| Deepgram Aura-2 | $30 | 0.0270 | — | No |
| Deepgram Flux TTS | $45 | 0.0405 | — | No |
| Amazon Polly Generative / Neural | $30 / $16 | 0.0270 / 0.0144 | — | No |

Providers that bill by time or by audio token (no character conversion needed):

| Provider / model | Billing | $ / generated min | Hebrew? | Evidence |
|---|---|---|---|---|
| Gemini 3.8 Flash-Lite TTS (Preview) | $6 per 1M audio tokens through 2026-12-31, then $12; 25 tokens per second of audio | 0.0090, then 0.0180 | Not confirmed | Price [VERIFIED-official]; per-minute [ESTIMATE] |
| Gemini 3.8 Flash TTS (Preview) | $9 per 1M audio tokens through 2026-12-31, then $18 | 0.0135, then 0.0270 | Not confirmed | same |
| Gemini 2.5 Flash TTS | $10 per 1M audio tokens | 0.0150 | Preview | same |
| Gemini 2.5 Pro TTS / 3.1 Flash TTS | $20 per 1M audio tokens | 0.0300 | Preview | same |
| OpenAI `gpt-4o-mini-tts` (deprecated) | $0.60 per 1M text tokens in, $12 per 1M audio tokens out | ~0.015 | Yes | Price [VERIFIED-official]; per-minute [UNVERIFIED — OpenAI's historical estimate, tokens-per-second rate not re-checked] |
| Rime Mist v3 | per minute | 0.030 (0.024 on the $100/month plan) | No | [VERIFIED-official] |
| Rime Coda v2 | per minute | 0.050 (0.040 on the $100/month plan) | No | [VERIFIED-official] |

Gemini text-input tokens add well under $0.001 per minute and are ignored. [ESTIMATE]

### 5.3 What the commercial numbers mean for the budget

- At ~50 % agent talk time, the cheapest Hebrew option at list price (Inworld TTS-2 Flash, Azure Neural) costs about **$0.0056 per conversational minute** for TTS alone — already over the $0.005 all-in target before speech recognition, the language model and transport. [ESTIMATE]
- With volume commitments (Inworld at $7/1M, Azure at $6–7.5/1M) it falls to about **$0.0023–0.0027 per conversational minute**, roughly half the whole budget. [ESTIMATE]
- Premium-quality options (Cartesia, ElevenLabs v4 Turbo, Chirp 3 HD) cost **$0.011–0.015 per conversational minute**, two to three times the whole budget. [ESTIMATE]
- Conclusion: a commercial API can be the Hebrew fallback and the quality benchmark, but not the steady-state Hebrew engine at the stated price target unless an enterprise discount well below list is negotiated. [ESTIMATE]

---

## 6. Self-hosted cost and capacity

All figures in this section are [ESTIMATE] built on the vendor numbers cited.

| Engine | Vendor throughput | Assumed hardware cost | Cost per generated minute | Streams per unit |
|---|---|---|---|---|
| ZONOS3-Mini | 457 s of audio per second per H100 at peak [VERIFIED-official] | $2–3 per H100-hour [UNVERIFIED] | ~$0.0001 at peak; ~$0.0005 if derated 5× to protect time-to-first-audio | ~90 concurrent streams per H100 after the 5× derate |
| BlueV3 on CPU | 5× real time on a 2-CPU cloud server [VERIFIED-official] | ~$0.05–0.08 per hour for 2 vCPUs [UNVERIFIED] | ~$0.0002–0.0003 | ~2–3 streams per 2-vCPU box after headroom |
| VoxCPM2 | Real-time factor 0.13–0.30 on an RTX 4090 [VERIFIED-official] | ~$0.4–0.7 per 4090-hour [UNVERIFIED] | ~$0.002–0.004 | 3–8 streams per GPU |
| Kokoro-82M, piper-he-noa | Not verified in this session | — | Expected to be in the same range as BlueV3 or lower | — |

- Even with pessimistic derating, self-hosted TTS costs 10–50× less per minute than the cheapest commercial API.
- The 80 ms time-to-first-audio published for ZONOS3-Mini was measured at 8 concurrent requests on an H100; latency at 90+ streams is not published and must be measured. [VERIFIED-official for the measurement condition]
- Barge-in is an orchestration concern, not a model feature: stop pulling frames and flush the playback buffer. Frame-level streaming engines (ZONOS3-Mini, Pocket TTS, voxtream2) stop within one ~80 ms frame; sentence-level engines (BlueV3, Piper, Kokoro) waste at most one sentence of compute.

---

## 7. Surprises and things that changed since earlier assumptions

1. **Chatterbox is retired.** The repo README states: "As of August 2026, Chatterbox is retired research and is no longer maintained", and that the code "stays public as an archive under the MIT license, with no support, updates, or paid tier." [VERIFIED-official]
2. **OpenAI is shutting down its TTS models.** `tts-1`, `tts-1-hd` and `gpt-4o-mini-tts` are deprecated with shutdown on 2027-01-06; the replacement is `gpt-realtime-2.1-mini` on the Realtime API, which is not available on the speech endpoint. [VERIFIED-official]
3. **Hume's TTS API is gone.** Sunset 2026-11-13 [PUBLISHED-thirdparty]; Hume's site and developer docs now present an audio-evaluation product instead [VERIFIED-official].
4. **ElevenLabs Flash v2.5 does not speak Hebrew.** Hebrew is only in the v3 and v4 families; the real-time Hebrew option is `eleven_v4_turbo`. [VERIFIED-official]
5. **Deepgram, Rime and Amazon Polly have no Hebrew TTS.** [VERIFIED-official]
6. **Inworld lists Hebrew as a Tier 1 language** at the lowest price and lowest published latency of any Hebrew-capable provider. [VERIFIED-official]
7. **The original `rhasspy/piper` repo now contains only "Development has moved"**, pointing to `OHF-Voice/piper1-gpl`, whose engine is GPL-3.0-or-later. [VERIFIED-official] Archived on 2025-10-06. [PUBLISHED-thirdparty] Piper now publishes a per-voice commercial-use list based on the full training chain, and several voices were retrained in late 2026 under the same file name — an old download may not qualify. [VERIFIED-official]
8. **A Hebrew Piper voice with a clean commercial chain exists** (`thewh1teagle/piper-he-noa`), made by training on synthetic speech to escape the SASPEECH license. [VERIFIED-official]
9. **Kokoro has no Hebrew** and the only Hebrew fine-tunes are non-commercial. [VERIFIED-official]
10. **Qwen3-TTS is open-weight under Apache-2.0** with 10 languages and a 97 ms first packet, but no Hebrew; it scores ~90 % error on Hebrew in Zyphra's table. [VERIFIED-official for license and latency; [PUBLISHED-thirdparty] for the Hebrew score]
11. **Google's Gemini TTS prices double on 2027-01-01** for the 3.8 Flash and Flash-Lite TTS previews. [VERIFIED-official]

---

## 8. Recommendations in detail

### (a) Self-hosted English

**Primary: `Zyphra/ZONOS3-Mini`** — Apache-2.0 weights, MIT code. [VERIFIED-official]

- The same model and voice speak Hebrew, which is what a mixed-language companion needs.
- Frame-level streaming with published 80 ms time-to-first-audio and the highest published throughput per GPU of the candidates reviewed.
- Caveat: two weeks old; keep a fallback wired in.

**Fallback / baseline: Kokoro-82M** — `hexgrad/Kokoro-82M` (PyTorch) or `onnx-community/Kokoro-82M-v1.0-ONNX`, Apache-2.0. [VERIFIED-official]

- Mature (13.6M downloads on the main repo), tiny, and the lowest-risk English engine.
- English only for our purposes; prosody is read-speech rather than conversational. [ESTIMATE]

### (b) Self-hosted Hebrew

Run a blind native-listener bake-off on the same 100–200 conversational sentences, including numbers, names, homographs and mixed Hebrew-English, across:

1. `Zyphra/ZONOS3-Mini` — raw Hebrew text in.
2. `notmax123/BlueV3-onnx` — with its bundled RenikudPlus front-end.
3. `openbmb/VoxCPM2` — quality ceiling for open weights.
4. `thewh1teagle/piper-he-noa` — CPU cost floor.
5. Inworld TTS-2 Flash and Cartesia Sonic 3.6 — commercial reference.

Decision rule: if the best open model is within a small margin of the commercial reference on naturalness and pronunciation errors, self-host Hebrew; otherwise route Hebrew to the commercial fallback and revisit quarterly. Before any commercial launch on BlueV3, obtain the training-data list from the author. [ESTIMATE]

### (c) Commercial fallback for Hebrew

**Primary: Inworld Realtime TTS-2 Flash** (`inworld-tts-2-flash`) — Hebrew Tier 1, 20 ms P90 time-to-first-byte, $15 per 1M characters at list (~$0.011 per generated Hebrew minute), $7 on the $1,500/month plan, lower at enterprise scale. [VERIFIED-official for price, tier and latency]

**Second source: Cartesia Sonic 3.6** (`sonic-3.6`) — Hebrew supported, under 90 ms, ~$0.028 per generated Hebrew minute. [VERIFIED-official for support, latency and plan prices]

**Lowest-cost legacy option: Azure Neural** (`he-IL-HilaNeural`, `he-IL-AvriNeural`) — $15 per 1M characters, down to $6 with a 4,000M-character monthly commitment. [VERIFIED-official]

Hebrew quality at Inworld and Cartesia was not listened to; "Tier 1" and "native speaker quality" are vendor statements. [VERIFIED-official that they are stated; quality itself [UNVERIFIED]]

---

## 9. Download locations for the POC

All repo IDs and file names below were read from the Hugging Face API on 2026-11-24. [VERIFIED-official]

| Component | Hugging Face repo | Key files | Code |
|---|---|---|---|
| **ZONOS3-Mini** | `Zyphra/ZONOS3-Mini` | `lm/`, `autoencoder/`, `speaker_encoders/` (PyTorch); `gguf/backbone-ptq.gguf` (663 MB), `gguf/zac.gguf` (2.2 GB) or `gguf/zac-keep2.gguf` (452 MB, faster decoder), `gguf/spk-encoder.gguf` (45 MB), `gguf/voices/` (27 default voices); `web/` (WebGPU) | `github.com/Zyphra/ZONOS3-Mini` (CUDA, MLX, C++/ggml, WebGPU servers); also served by SGLang-Omni: `sgl-omni serve --model-path Zyphra/ZONOS3-Mini` |
| **BlueV3** | `notmax123/BlueV3-onnx` (PyTorch: `notmax123/BlueV3`) | `onnx/text_encoder.onnx` (28 MB), `onnx/vector_estimator.onnx` (257 MB; int8 66 MB), `onnx/vocoder.onnx` (101 MB), `onnx/duration_predictor_style.onnx`, `onnx/reference_encoder.onnx` (136 MB), `voices/*.json`, `frontend/renikud/model.onnx` (1.23 GB), `LICENSES.md`, `LICENSE.OpenRAIL-M` | `github.com/maxmelichov/BlueTTS`; PyPI `blue-onnx`, `renikud-plus==0.5.0`, `heb-tts-normalizer==0.2.0`, `hebrew-num2words==0.1.0` |
| **piper-he-noa** | `thewh1teagle/piper-he-noa` | `he_IL-noa-medium.onnx` (77 MB), `he_IL-noa-medium.onnx.json` | `github.com/OHF-Voice/piper1-gpl` (`pip install piper-tts`) |
| **VoxCPM2** | `openbmb/VoxCPM2` | whole repo | `pip install voxcpm`; faster serving via `github.com/a710128/nanovllm-voxcpm` |
| **Kokoro-82M (ONNX)** | `onnx-community/Kokoro-82M-v1.0-ONNX` | `onnx/model.onnx` (326 MB), `onnx/model_fp16.onnx` (163 MB), `onnx/model_quantized.onnx` (92 MB), `voices/` | — |
| **Kokoro-82M (PyTorch)** | `hexgrad/Kokoro-82M` | `kokoro-v1_0.pth`, `voices/*.pt` | `github.com/hexgrad/kokoro` (`pip install kokoro`, needs espeak-ng) |
| **Kokoro single-file ONNX** | GitHub release `github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/` | `kokoro-v1.0.onnx`, `kokoro-v1.0.int8.onnx`, `voices-v1.0.bin` (URLs respond with HTTP 200) | `kokoro-onnx` package [UNVERIFIED package details] |
| **ReNikud** (Hebrew → IPA) | `renikud/renikud` | `model.onnx` (20.6 MB) | `github.com/renikud/renikud`; `pip install renikud-onnx` |
| **RenikudPlus** | `notmax123/RenikudPlus` | `model.onnx` (1.23 GB), `model_int8.onnx` (312 MB) | `pip install renikud-plus` |
| **Phonikud** | `Phonikud/phonikud-onnx` | `phonikud-1.0.onnx`, `phonikud-1.0.int8.onnx` | `github.com/thewh1teagle/phonikud` |
| **Pocket TTS with Hebrew adapter** (optional) | `thewh1teagle/pocket-tts-onnx` | `pocket-tts-english-ipa.onnx` (231 MB), `renikud.onnx` (21 MB) | `github.com/thewh1teagle/pocket-tts-onnx` |

`huggingface.co` and `raw.githubusercontent.com` were reachable with `curl` from this environment; the GitHub API was not.

---

## 10. Open questions for the POC

1. Does ZONOS3-Mini pronounce unvocalized conversational Hebrew — homographs, names, slang, numbers — acceptably to native listeners? What does it do with an English word inside a Hebrew sentence?
2. What is ZONOS3-Mini's time-to-first-audio and stability at 50–100 concurrent streams on the GPU we will actually rent?
3. What speech data were BlueV3 and RenikudPlus trained on, and under what licenses?
4. Does the OpenRAIL-M vocoder license in BlueV3 pass legal review for this product?
5. Which front-end do the piper-he-noa labels really follow — ReNikud or Piper's built-in Nakdimon path?
6. What enterprise price will Inworld and Cartesia quote for Hebrew at our projected volume?
7. Is Hebrew available on Gemini 3.8 Flash-Lite TTS, and what is its real streaming latency?

---

## Sources

All accessed 2026-11-24.

### Open-weight models — model cards, repos, licenses

- ZONOS3-Mini model card — https://huggingface.co/Zyphra/ZONOS3-Mini
- ZONOS3-Mini repo (license, runtimes) — https://github.com/Zyphra/ZONOS3-Mini
- ZONOS3-Mini announcement — https://www.zyphra.com/our-work/zonos3-mini
- ZONOS3-Mini Technical Report (per-language tables) — https://arxiv.org/abs/2611.16525
- BlueV3 ONNX bundle, `LICENSES.md`, release notes — https://huggingface.co/notmax123/BlueV3-onnx
- BlueV3 PyTorch weights — https://huggingface.co/notmax123/BlueV3
- BlueTTS repo — https://github.com/maxmelichov/BlueTTS
- BlueTTS 2.5 ONNX — https://huggingface.co/notmax123/BlueTTS2.5-onnx
- piper-he-noa — https://huggingface.co/thewh1teagle/piper-he-noa
- Piper (current) README, `docs/LICENSING.md`, `docs/COMMERCIAL_USE.md`, `docs/VOICES.md`, `CHANGELOG.md`, `src/piper/phonemize_hebrew.py` — https://github.com/OHF-Voice/piper1-gpl
- Piper (original, now a pointer) — https://github.com/rhasspy/piper
- Official Piper voices (Hebrew: `he/he_IL/saspeech`) — https://huggingface.co/rhasspy/piper-voices
- VoxCPM2 — https://huggingface.co/openbmb/VoxCPM2
- MOSS-TTS-Realtime — https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Realtime ; https://github.com/OpenMOSS/MOSS-TTS
- MOSS-TTS-Nano — https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M
- Chatterbox repo (retirement notice) — https://github.com/resemble-ai/chatterbox
- Chatterbox model cards — https://huggingface.co/ResembleAI/chatterbox ; https://huggingface.co/ResembleAI/chatterbox-turbo ; https://huggingface.co/ResembleAI/chatterbox-nano
- Kokoro-82M (card, `VOICES.md`) — https://huggingface.co/hexgrad/Kokoro-82M ; https://github.com/hexgrad/kokoro
- Kokoro ONNX — https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX
- Kokoro Hebrew fine-tunes — https://huggingface.co/avris/kokoro-hebrew-saspeech ; https://huggingface.co/thewh1teagle/kokoro-hebrew-nc
- Phonikud repo — https://github.com/thewh1teagle/phonikud
- Phonikud ONNX — https://huggingface.co/Phonikud/phonikud-onnx
- Phonikud-TTS checkpoints and library — https://huggingface.co/Phonikud/phonikud-tts-checkpoints ; https://github.com/thewh1teagle/phonikud-tts
- Phonikud paper — https://arxiv.org/abs/2506.12311
- ILSpeech dataset — https://huggingface.co/datasets/Phonikud/ILSpeech
- ReNikud — https://github.com/renikud/renikud ; https://huggingface.co/renikud/renikud ; https://arxiv.org/abs/2606.20179
- RenikudPlus — https://huggingface.co/notmax123/RenikudPlus
- Dicta diacritizer — https://huggingface.co/dicta-il/dictabert-large-char-menaked
- voxtream2-he and its base — https://huggingface.co/flowty1/voxtream2-he ; https://huggingface.co/herimor/voxtream2
- QwenTTS-he-1.7B — https://huggingface.co/notmax123/QwenTTS-he-1.7B
- Qwen3-TTS — https://github.com/QwenLM/Qwen3-TTS ; https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base
- neutts-air-he — https://huggingface.co/flowty1/neutts-air-he
- Pocket TTS — https://github.com/kyutai-labs/pocket-tts ; https://huggingface.co/kyutai/pocket-tts
- Pocket TTS ONNX with Hebrew adapter — https://github.com/thewh1teagle/pocket-tts-onnx ; https://huggingface.co/thewh1teagle/pocket-tts-onnx
- OmniVoice — https://huggingface.co/k2-fsa/OmniVoice
- Fish Audio S2 Pro, Drama 3, S1-mini — https://huggingface.co/fishaudio/s2-pro ; https://huggingface.co/fishaudio/drama-3 ; https://huggingface.co/fishaudio/s1-mini
- Higgs TTS 3 — https://huggingface.co/bosonai/higgs-tts-3-4b
- Supertonic 3 — https://huggingface.co/Supertone/supertonic-3
- Coqui XTTS-v2 — https://huggingface.co/coqui/XTTS-v2
- MMS-TTS Hebrew — https://huggingface.co/facebook/mms-tts-heb
- Zonos-Hebrew, MamreTTS, Robo-Shaul — https://huggingface.co/notmax123/Zonos-Hebrew ; https://huggingface.co/notmax123/MamreTTS ; https://huggingface.co/notmax123/robo_shaul
- SASPEECH — https://www.openslr.org/134/
- HebTTS — https://github.com/slp-rl/HebTTS
- F5-TTS — https://github.com/SWivid/F5-TTS ; https://huggingface.co/SWivid/F5-TTS
- Sesame CSM — https://github.com/SesameAILabs/csm ; https://huggingface.co/sesame/csm-1b
- Gradium phonon — https://huggingface.co/gradium/phonon-31m-en
- License and language metadata via the Hugging Face API (`https://huggingface.co/api/models/<repo>`) for: `canopylabs/orpheus-3b-0.1-ft`, `kyutai/tts-1.6b-en_fr`, `neuphonic/neutts-air`, `neuphonic/neutts-nano`, `microsoft/VibeVoice-1.5B`, `microsoft/VibeVoice-Realtime-0.5B`, `IndexTeam/IndexTTS-2`, `nari-labs/Dia-1.6B`, `nari-labs/Dia2-2B`, `myshell-ai/MeloTTS-English`, `FunAudioLLM/Fun-CosyVoice3-0.5B-2512`, `FunAudioLLM/CosyVoice2-0.5B`, `mistralai/Voxtral-4B-TTS-2603`, `Phoonnx/vits-he_il-shaul-phonikud`, `Yzamari/f5tts-hebrew-v2`, and the `ivrit-ai` organization listing
- Third-party Hebrew provider comparison (snapshot of 2025-03-22) — https://github.com/danielrosehill/Hebrew-TTS-Providers
- Third-party explainer on the XTTS license and Coqui shutdown — https://localaimaster.com/blog/xtts-coqui-commercial-license

### Commercial APIs — docs and pricing

- ElevenLabs models — https://elevenlabs.io/docs/overview/models
- ElevenLabs API pricing — https://elevenlabs.io/pricing/api
- Cartesia Sonic 3.6 — https://docs.cartesia.ai/build-with-cartesia/tts-models/latest
- Cartesia pricing — https://cartesia.ai/pricing
- Cartesia Sonic product page — https://cartesia.ai/sonic
- Google Chirp 3 HD — https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd
- Google Gemini-TTS — https://docs.cloud.google.com/text-to-speech/docs/gemini-tts
- Google Cloud Text-to-Speech pricing — https://cloud.google.com/text-to-speech/pricing
- Azure Speech language support — https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts
- Azure Retail Prices API (product "Azure Speech", region eastus) — https://prices.azure.com/api/retail/prices
- Azure Speech pricing page (prices render client-side; not readable here) — https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/
- OpenAI `gpt-4o-mini-tts` model page — https://developers.openai.com/api/docs/models/gpt-4o-mini-tts
- OpenAI text-to-speech guide (deprecation notice, languages) — https://developers.openai.com/api/docs/guides/text-to-speech
- OpenAI deprecations — https://developers.openai.com/api/docs/deprecations
- OpenAI pricing — https://developers.openai.com/api/docs/pricing
- Deepgram pricing — https://deepgram.com/pricing
- Deepgram TTS models and languages — https://developers.deepgram.com/docs/tts-models-languages-overview ; https://developers.deepgram.com/docs/flux-tts/voices ; https://developers.deepgram.com/docs/tts-models
- Deepgram Flux TTS latency (third party) — https://audioxpress.com/news/deepgram-launches-flux-tts-conversation-aware-text-to-speech-model-for-voice-agents
- Rime pricing and models — https://rime.ai/pricing ; https://docs.rime.ai/docs/models
- Inworld pricing — https://inworld.ai/pricing
- Inworld TTS models and language tiers — https://docs.inworld.ai/tts/tts-models ; https://docs.inworld.ai/tts/capabilities/multilingual
- MiniMax pricing — https://platform.minimax.io/docs/pricing/overview
- MiniMax text-to-speech API reference (language list) — https://platform.minimax.io/docs/api-reference/speech-t2a-http
- Amazon Polly pricing and voices — https://aws.amazon.com/polly/pricing/ ; https://docs.aws.amazon.com/polly/latest/dg/available-voices.html
- Hume — https://www.hume.ai/pricing ; https://dev.hume.ai/docs/text-to-speech-tts/overview ; shutdown reporting: https://www.stork.ai/blog/hume-ai-alternatives-2026

### Not reachable or not readable in this session

- Zyphra Cloud pricing for hosted ZONOS3-Mini (`cloud.zyphra.com`) — page rendered no prices. [UNVERIFIED]
- Gemini API speech-generation and pricing pages (`ai.google.dev`) — rendered no content; Hebrew on Gemini 3.8 TTS not confirmed. [UNVERIFIED]
- GitHub API — blocked for this session; repo star counts, archive flags and last-push dates were not read.
- `bosonai/higgs-audio-v2-generation-3B-base`, `fishaudio/openaudio-s1-mini` — Hugging Face API returned no data.
