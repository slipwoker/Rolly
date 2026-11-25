# Decision log

Each decision lists the evidence it rests on and how firm that evidence is.
Evidence levels: **measured** (run in this POC), **published** (vendor/model-card source fetched), **unverified**
(search excerpts or third-party trackers only), **estimate**, **assumption**.

| # | Date | Decision | Evidence | Level | Revisit when |
|---|---|---|---|---|---|
| D1 | 2026-11-24 | **Architecture C (self-hosted speech-to-speech) is a no-go for this POC**; not implemented. | No open-weight full-duplex model supports Hebrew (Moshi, PersonaPlex, NemotronLabs VoiceChat, Haru-4B, Sophon-Realtime, Qwen3-Omni-30B are English or other languages only). Context windows of 2–4 minutes also fail the 30-minute requirement. The only Hebrew-capable native speech-to-speech models found are hosted (Alibaba Qwen-Omni realtime). `docs/research/04-speech-to-speech.md` | published / unverified mix | A Hebrew-capable open model is released, or Hebrew is dropped for a market |
| D2 | 2026-11-24 | **Self-hosted STT is routed by language: `ivrit-ai/whisper-large-v3-turbo-ct2` for Hebrew sessions, stock `large-v3-turbo` (`deepdml/faster-whisper-large-v3-turbo-ct2`) for English sessions**; mixed sessions detect Hebrew vs English per utterance and route. One decode per VAD-endpointed utterance. | Measured on FLEURS (real speech, `BENCHMARKS.md`): Hebrew WER 18.9 % (Hebrew-tuned) vs 28.6 % (stock); English WER 29.0 % (Hebrew-tuned) vs 5.6 % (stock). On English audio the Hebrew-tuned model translated 6 of 30 utterances into Hebrew instead of transcribing them. Both models are Apache-2.0 / MIT. Published ivrit.ai leaderboard for Hebrew: 5.3 / 7.1 % vs 8.4 / 12.8 %. | measured + published | A streaming Hebrew+English model (e.g. `MaorB/embeddinggemma-2-asr-hebrew-english-streaming`) is validated; code-switching accuracy is measured on real speech |
| D3 | 2026-11-24 | **VAD/endpointing: Silero VAD + fixed silence endpoint (544 ms) + speculative start at 256 ms.** No learned turn detector. | Silero is MIT. LiveKit's turn detector is licence-restricted to LiveKit Agents and has no Hebrew; Pipecat Smart Turn v3 does not list Hebrew. Endpointing accuracy measured in `benchmarks/vad_bench.py`. | measured + published | Smart Turn is fine-tuned or validated for Hebrew |
| D4 | 2026-11-24 | **Hebrew TTS for the POC: `thewh1teagle/piper-he-noa` voice + `renikud/renikud` G2P, run directly on ONNX Runtime.** | Both CC BY 4.0; the GPL Piper engine is avoided by running the ONNX graph ourselves. Runs at ~12x real time on CPU (measured). Intelligible by ASR round-trip (measured). Naturalness is **not** established — needs native listeners. | measured (speed, intelligibility) / unknown (naturalness) | Human evaluation; BlueV3 and ZONOS3-Mini bake-off on a GPU |
| D5 | 2026-11-24 | **English TTS for the POC: Kokoro-82M v1.0 (GPU target) and Piper lessac (CPU runs)** through sherpa-onnx 1.13.8. | Apache-2.0 model; sherpa-onnx 2.x removed the espeak front-end and cannot phonemise these voices (observed). sherpa-onnx 1.13.8 bundles espeak-ng data (GPL-3) — flagged in `LICENSES.md`. | measured (it works) / licence flagged | Licence review of espeak-ng data; ZONOS3-Mini evaluation |
| D6 | 2026-11-24 | **Self-hosted language model: `google/gemma-4-26B-A4B-it` (FP8 build `RedHatAI/gemma-4-26B-A4B-it-FP8-dynamic`) on vLLM with prefix caching.** Qwen3-4B on llama.cpp is only the CPU development stand-in. | Measured on an L40S: first token 52 ms, 117 tokens/s, recall 12 of 12, no invented answers in 8 probes, fluent and grammatical Hebrew in the scenario transcripts, 56 of 56 scripted checks. Defect: Hebrew number words garbled in 2 of 3 closed questions. The 4B stand-in failed on Hebrew quality. Apache-2.0 (FP8 repack licence not researched). | measured (small samples) | Unquantised weights or another model fixes the number-word defect; a larger Hebrew evaluation says otherwise |
| D7 | 2026-11-24 | **Custom thin FastAPI + WebSocket transport for the POC instead of Pipecat or LiveKit.** This deviates from the research recommendation (Pipecat for the POC). | (a) The build environment only allows HTTPS egress, so no WebRTC media path could be tested; (b) one measurement layer had to wrap commercial speech-to-speech and the modular pipeline identically; (c) speculative-turn gating and "true end of speech" latency accounting needed full control. Cost: no Opus, no jitter buffer, no packet-loss concealment — raw PCM over TCP. | engineering judgement | Production: move to WebRTC (self-hosted LiveKit, or Pipecat on a WebRTC transport). The provider interface maps one-to-one onto Pipecat services |
| D8 | 2026-11-24 | **Commercial baselines: OpenAI `gpt-realtime-2.1` (+ `-mini`) and Google `gemini-3.8-live`.** Implemented from SDK-documented protocols; not run live. | Research pick; older realtime models are being retired (`gpt-realtime` shutdown 2027-01-20). Hebrew quality reports for both are mixed. | published / unverified | API keys available |
| D9 | 2026-11-24 | **The agent may propose ending a session, but a rule confirms it** (user stop phrase or arrival event). | The 4B model emitted the end marker unprompted and closed a session mid-conversation (measured, first English run). | measured | A stronger model is used — keep the guard anyway |
| D10 | 2026-11-24 | **Conversation history stores only what the user actually heard** after a barge-in. | Generation is faster than playback; without truncation the model "remembers" saying things the user never heard. Implemented for the modular pipeline (sentence granularity) and via `conversation.item.truncate` for OpenAI. | design | — |
| D11 | 2026-11-24 | **Memory = SQLite store with profile, summaries, open topics, action items, facts; summaries produced by a utility LLM shared by all providers.** | Keeps cross-session memory independent of the voice architecture under test. Verified end-to-end: a summary written by one session appears in the next session's context (automated test). | measured | Production: Postgres + retrieval when memory outgrows the prompt |
| D12 | 2026-11-24 | **Privacy defaults: no raw audio on disk; transcripts kept 30 days; per-user erasure endpoint.** | Brief requirement; verified by automated test that no audio directory is created by default. | measured | Legal review (`docs/PRIVACY.md`) |
| D13 | 2026-11-24 | **Fleet strategy in the cost model: autoscaled cloud GPUs, or owned base load + cloud burst. Not a fixed fleet sized for the peak.** | With 15 % of daily minutes in the busiest hour, a peak-sized fixed fleet runs at ~18–22 % utilisation and costs about twice as much per minute as an autoscaled one (cost model). | estimate (assumed demand curve) | Real usage data replaces the assumed commute curve |
| D15 | 2026-11-24 | **Conversation history is compacted in blocks into a cumulative synopsis, not trimmed by a sliding window.** | Measured in the 30-minute run: once the sliding window began dropping one old message per turn (turn 41), the LLM's cached prefix fell from about 3,280 tokens to 734 and time-to-first-token rose from about 2 s to about 50 s on CPU; the fact stated in the first minute was also gone. With block compaction the cache is rebuilt once per block (measured in the 10-minute verification runs). The same effect drives the cost of commercial realtime APIs, which bill uncached context on every turn. | measured | Production: write the synopsis with a separate model/slot so it never queues in front of a user turn; keep an append-only list of user-stated facts |
| D16 | 2026-11-24 | **Self-host the language model from the start; keep a commercial model (`gpt-6-luna`) as a fallback route.** (Revised the same day: before the GPU run the recommendation was to start on the API.) | Measured on the same GPU host and scenarios: self-hosted pipeline 681 ms median / 1,072 ms P95; hybrid with the API model 1,333 ms / 2,441 ms, because the API's first token takes 711 ms against 52 ms locally. Hebrew quality and recall were equal on our probes. The API model costs only about $0.0004 per minute, so the decision is about latency and independence, not cost. | measured | A faster hosted model is found, or operating the GPU stack proves too costly in staff time |
| D17 | 2026-11-24 | **Commercial realtime baseline = OpenAI Realtime, run from the GPU pod.** The build session's proxy does not carry WebSocket upgrades, so the baseline was run from the rented pod, with the owner's key set as a pod environment variable. Gemini Live remains un-run (no key). | Measured: `gpt-realtime-2.1` 1.62–2.05 s median depending on turn-detection mode, $0.070–0.075 per connected minute from reported token usage; mini 1.65–1.73 s, $0.020. | measured (prices unverified) | Google key available; 30-minute sessions on the API |
| D18 | 2026-11-24 | **Keep the default end-of-turn wait (544 ms with a speculative start at 256 ms).** | Measured: the speculative start saves about 300 ms (953 → 652 ms median). Shortening the wait to 416 / 320 ms gains a further 80 / 130 ms but raises mid-sentence cut-offs on real recordings from 10–13 % to 17 % / 27–33 %. | measured | A learned turn detector for Hebrew is available |
| D19 | 2026-11-24 | **Rent GPUs by the hour and autoscale on a schedule; plan capacity at 20–35 conversations per L40S.** | Measured on one L40S: 35 simultaneous conversations at P95 1.48 s, 50 with no failed turn at P95 1.70 s; cold start about 3 minutes with cached weights. Cost model: a peak-sized fixed fleet is idle about 80 % of the time. The L40S was reported out of stock shortly before we rented one. | measured (one GPU) + assumed demand curve | Fleet-level test; real demand data |
| D20 | 2026-11-24 | **Speech synthesis stays on CPU for now.** | Piper-class voices run at 12–14 times real time on CPU and produced first audio in about 120 ms on the pod; about 0.16 CPU-cores per conversation. The Hebrew voice decision (open or commercial, CPU or GPU) waits for a listening test. | measured | Voice chosen |
| D14 | 2026-11-24 | **Did not install `blue-onnx` (BlueV3 Hebrew TTS).** | A safety check declined installing a two-week-old single-author package named by web research. Left as a candidate pending explicit approval. | — | Owner approves (see `BLOCKERS.md`) |

## D21. Who may interrupt the agent is decided by loudness, and a false interruption is repaired (2026-11-25)

**Context.** First tests by people on laptops: both pipeline agents were cut off by their own voice and by other voices in the
room, on nearly every reply (BENCHMARKS.md section 0.9). The same will happen in a car with a hands-free loudspeaker and passengers.

**Decision.**
1. A sound can interrupt only if it is loud enough: within 10 dB of this user's own level once that is known, above -38 dBFS
   before, and above the echo level measured in the session. Rejected: stricter speech-detector thresholds and longer
   confirmation time (tested, no effect on echo).
2. The requirement stays in force for 500 ms after the last audio was sent, because the client is still playing it.
3. A sound that did interrupt is checked after recognition. Words of the agent's own sentence, or a short fragment recognised
   with low confidence, are discarded, and the agent says the rest of its reply again (at most twice per reply).
4. Words such as "רגע", "stop", "wait" always count as an interruption.
5. Interruption needs 192 ms of speech (was 160 ms).

**Cost.** A quiet real interruption is ignored. A false cut still costs about a second before the sentence is repeated.
**Not solved.** A second person speaking as loudly as the user. Thresholds are first values, to be tuned from logged levels.

## D22. Hebrew voice of the self-hosted agent: ZONOS3-Mini, cloned voice, on the same GPU (2026-11-25)

**Context.** The Piper Hebrew voice failed the first listening test (robotic, flat, accented). The research had listed
ZONOS3-Mini and BlueV3 as the open candidates; BlueV3 still waits for approval of its package (BLOCKERS B4).

**Decision.** Hebrew speech of the self-hosted agent comes from ZONOS3-Mini (Zyphra; Apache-2.0 weights), served by its
C++/ggml server on the pipeline's GPU, with raw-reference cloning of a recording made by a team member for this purpose.
English keeps the Piper voice for now. If the voice server or the voice file is missing, Hebrew falls back to Piper.

**Details that were not obvious.**
- The project's CUDA build targets the H100 only; on the L40S it must be configured with `-DCMAKE_CUDA_ARCHITECTURES=89`.
- CPU serving is too slow for conversation with a 23 s reference (first audio after about 1.3 s).
- The cloned voice is biometric-like data: the recording and the derived codes stay off the public repository; the codes are
  uploaded to the GPU host over the authenticated worker API.

**Open.** Consent and terms for using a real person's voice beyond this experiment; a voice-server concurrency test; a
listening comparison against BlueV3 and a commercial Hebrew voice.

**Update, same day: withdrawn from live use.** In conversation the voice cut sentence endings (ended mid-sound in 5 of 12
test utterances), ran sentences together and varied its pace from 7.7 to 20.4 characters per second between utterances
(BENCHMARKS.md section 0.10). No setting tried fixed the endings. Hebrew is back on Piper; the ZONOS3 server stays installed
for further tests. Lesson: a voice is not accepted on single samples and a latency test; it needs a scripted listening set of
short and long sentences and an automatic check of sentence endings before it goes live.
