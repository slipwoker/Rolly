# Benchmarks

Raw machine-readable results: `benchmarks/results/*.json`. Generated tables: `reports/benchmark_summary.md`
(`python -m benchmarks.analyze`). Nothing in this file is typed from memory; every number comes from those files.

## Read this first: what was and was not measured

All runs were made on **one 4-vCPU container with no GPU**. That hardware is two orders of magnitude too slow for real-time
voice, so:

| Category | Measured here? | Why it is or is not valid |
|---|---|---|
| Speech-recognition accuracy (WER), clean and in road noise | **Yes** | Accuracy does not depend on the hardware |
| Endpointing and barge-in detection timing | **Yes** | Determined by the VAD configuration and the audio, not by the hardware |
| Context retention, correction handling, hallucination probes, proactive opener, summaries | **Yes**, for the small CPU-sized LLM only | Behaviour of *that* model; a production model will differ |
| Browser playout buffer and playback-stop time | **Yes** (headless Chromium, localhost) | Client-side property |
| Session-layer CPU cost per user | **Yes** | CPU work, measured as CPU time |
| Response latency of a real-time deployment | **No** | CPU latencies (about 10 s) say nothing about a GPU deployment |
| Concurrency per GPU, GPU memory and utilisation | **No** | No GPU |
| Commercial realtime APIs (latency, Hebrew quality, cost) | **No** | No API keys |
| Human ratings | **No** | No evaluators |
| Bandwidth with a production codec | **No** | POC streams raw PCM; Opus figures are estimates |

## 1. Speech recognition accuracy

FLEURS test split (real human read speech, CC BY), faster-whisper, greedy decoding, language forced. Road noise is synthetic
(`benchmarks/synth.py`), mixed at a speech-to-noise ratio measured over active speech.

| Language | Model | Clean | 10 dB | 5 dB | 0 dB |
|---|---|---:|---:|---:|---:|
| Hebrew (40 utterances) | `ivrit-ai/whisper-large-v3-turbo-ct2` (Hebrew-tuned) | **18.9 %** | 20.0 % | 23.1 % | 27.5 % |
| Hebrew | `deepdml/faster-whisper-large-v3-turbo-ct2` (stock turbo) | 28.6 % | – | 34.1 % | – |
| Hebrew | `Systran/faster-whisper-small` | 46.5 % | – | – | – |
| English (30 utterances) | stock turbo | **5.6 %** | – | 7.2 % | – |
| English | Hebrew-tuned | 29.0 % | – | 49.4 % | – |

Character error rates and the per-utterance transcripts are in the result files.

Findings:

1. **The Hebrew-tuned model is clearly better on Hebrew** (18.9 % vs 28.6 % WER) **and clearly worse on English** (29.0 % vs 5.6 %).
   On English audio it *translated* 6 of 30 utterances into Hebrew instead of transcribing them. One model cannot serve both
   languages; the pipeline now routes by session language (decision D2).
2. **Road noise costs little**: Hebrew degrades from 18.9 % to 23.1 % at 5 dB and 27.5 % at 0 dB; English from 5.6 % to 7.2 % at 5 dB.
   Synthetic stationary noise is kinder than a real cabin (no speech from passengers, radio, or wind bursts).
3. **Absolute Hebrew numbers overstate conversational error.** FLEURS Hebrew contains digits, acronyms and foreign names
   (`m16`, `802.11n`, `25GHz`) and at least one truncated recording. On the 27 references without digits or Latin letters the
   Hebrew-tuned model scores 13.9 % WER / 3.9 % CER clean. The published ivrit.ai leaderboard figure for the same model on
   conversational Hebrew is 5.3–7.1 %. Our test is small (40 utterances, about 5.7 minutes); treat differences of a few points as noise.
4. `small` is unusable for Hebrew (46.5 %).

Not measured: Hebrew-English code-switching on real speech (no licensed test set was available; see section 4, scenario s09).

## 2. Endpointing and interruption detection

Silero VAD driven frame by frame on 30 FLEURS utterances; true speech onset and offset from the clean recording's energy envelope.

| Noise | Barge-in detected after true onset: median / p95 | Speculative ("eager") point after true end: median | End of turn declared after true end: median / p95 | Missed | Split by a pause |
|---|---:|---:|---:|---:|---:|
| clean | 284 / 1364 ms | 228 ms | 516 / 761 ms | 0 / 60 | 3 / 30 |
| 10 dB | 253 / 1398 ms | 196 ms | 484 / 675 ms | 0 / 60 | 3 / 30 |
| 5 dB | 269 / 1450 ms | 196 ms | 484 / 675 ms | 0 / 60 | 4 / 30 |
| 0 dB | 312 / 1468 ms | 188 ms | 476 / 733 ms | 0 / 60 | 4 / 30 |

False barge-ins on two minutes of road noise alone, at levels from −40 to −12 dBFS: 0 per minute.

Findings:

1. Typical barge-in detection is about 250–310 ms after the user starts speaking (160 ms of confirmed speech is required while the
   agent is audible, to resist echo). The p95 of about 1.4 s comes from utterances that begin quietly; the energy-based "true onset"
   also marks breaths, so the tail is partly a measurement artefact and partly real.
2. **A fixed 544 ms silence endpoint cuts the speaker off in 10–13 % of long read sentences** (3–4 of 30 were split at a mid-sentence
   pause). This is the main argument for a semantic turn detector; none of the available ones supports Hebrew (D3).
3. No missed utterances and no false triggers in noise, down to 0 dB.
4. In the full pipeline (section 4) the interrupt was signalled 162 ms after speech onset (one synthetic sample), and no agent audio
   arrived after the interrupt.
5. In Chromium, playback stopped 43 ms after the interrupt message arrived (output latency included) and the playout buffer added
   about 8 ms to first audio (`client.playback` telemetry, browser end-to-end test, localhost, one run).

Against the criterion "agent playback stops within 300 ms of a detected interruption": detection → silence is about 45 ms plus
network on the measured path, so the criterion is met with a wide margin. From *speech onset* to silence the typical total is about 300–350 ms.

## 3. LLM probes (small CPU model: Qwen3-4B-Instruct, Q4)

The exact agent context (profile, memory, journey) with one question per probe; keyword scoring; answers stored for review.

| Probe | English | Hebrew |
|---|---:|---:|
| Recall of facts present in memory | 6 / 6 | 5 / 6 |
| No invented answer when the fact is not in memory | 3 / 4 | 3 / 4 |
| General closed questions | 3 / 3 | 2 / 3 |
| Fact stated at the start recalled after 10 and after 20 filler turns | pass, pass | not tested |

Hallucination rate on the controlled unknown-fact probes: 2 of 8 (25 %), e.g. it invented a 58-minute time for a run that was never
mentioned. With 8 probes this is an indication, not a rate to quote.

Prompt caching, measured on the CPU server: the first turn of a session evaluates about 830 prompt tokens before the first token
(12–14 s on this CPU); later turns reuse the cached prefix (about 880–1,100 cached tokens) and reach the first token in about 1.0–1.2 s.
The same mechanism (prefix caching in vLLM, cached-input pricing in APIs) is what keeps the per-turn cost of a growing history bounded.

## 4. Scripted scenarios through the full pipeline (CPU)

`modular-selfhosted`: Silero VAD → Whisper (routed by language, int8) → Qwen3-4B Q4 on llama.cpp → Piper (English) / ReNikud + Piper (Hebrew).
Synthetic user speech, real-time microphone simulation, real WebSocket.

- 12 of 12 scenarios completed, 28 of 28 user turns answered, 0 errors.
- 26 of 28 scripted checks passed.
- Response latency on this CPU: median 10.5 s, p95 16.1 s. **Not representative of a GPU deployment.**
  Stage medians: STT 6.1 s, LLM first chunk 4.3 s, first TTS chunk 0.33 s.
- Playout underruns: 0.89 per agent turn — on this CPU the LLM generates more slowly than speech is played, so replies stutter.
- Transcription of the synthetic user speech: English 1.0 % WER, Hebrew 4.3 % clean / 6.1 % including the noisy scenario.
  Because the Hebrew "user" is our own Hebrew TTS voice, this also shows that voice is intelligible to a recogniser. It says nothing about how natural it sounds.

| Requirement from the brief | Scenario | Result |
|---|---|---|
| Hebrew entrepreneurial brainstorming | s01 | Ran; every turn answered. **The 4B model's Hebrew is poor**: wrong grammatical gender, invented words, drifting meaning. One check failed (the opener did not name the stored topic recognisably) |
| English entrepreneurial brainstorming | s02 | Passed; coherent, on-topic replies; summary extracted the action item "email three agencies by Friday" |
| Personal planning | s03 | Passed |
| Learning a new subject | s04 | Passed |
| Continuing a previous conversation | s05 | Passed: opener referenced yesterday's open question; recalled "four of ten interviews" |
| Switching topics unexpectedly | s06 | Passed: followed to the new topic |
| Interrupting mid-sentence | s07 | Passed: interrupt signalled 162 ms after speech onset; stored reply truncated to what was heard ("Direct sales to families: closer") |
| Correcting misunderstood information | s08 | Passed: accepted "seven, not four" and answered "three left" |
| Hebrew-English code-switching | s09 | **Inconclusive.** English terms were mis-transcribed ("Stripe" → "סטייפי", "roadmap" → "הוודמאפ"), but the synthetic Hebrew voice cannot pronounce English words properly, so the stimulus is not valid. Needs human recordings |
| Road noise (5 dB) | s10a / s10b | English passed with 0 % WER. Hebrew: correct recall, but the model wrote "GERMANY" in Latin letters and an Arabic word inside a Hebrew sentence, which the Hebrew voice cannot speak; one word mis-transcribed |
| Extended 30–60 minute conversation | long session | See section 6 |
| Proactive initiation | all | 12 of 12 sessions opened by the agent without user input; 3 of 4 keyword checks on the opener passed |
| Summary and action items | s02 | Passed |
| Natural ending | s12 | Passed: "זה מספיק להיום, להתראות" ended the session and produced a summary |

The central qualitative finding: **with a 4B model the English conversation is usable and the Hebrew conversation is not.** Speech
recognition and speech synthesis worked in Hebrew; the language model is the weak link, which is consistent with the research
finding that no model of 12B or below has a published Hebrew score.

## 5. Concurrency

| Run | Sessions | Latency median | Failed turns | Note |
|---|---:|---:|---:|---|
| Session layer only (mock provider: transport, resampling, telemetry) | 10 / 25 / 50 | unchanged across levels | 0 | 0.006 CPU-seconds per session-second; with VAD (0.0065) about 80 sessions per core at full load |
| Full pipeline on 4 vCPU, no GPU | 1 | 11.4 s | 0 / 2 | |
| | 2 | 19.9 s | 0 / 4 | |
| | 4 | 64.7 s | 0 / 8 | No sessions dropped, but unusable |

Maximum sustainable real-time concurrency of the full pipeline on this hardware: **0**. The run validates the harness
(`benchmarks/concurrency.py`) and shows graceful degradation (queues grow, nothing crashes). The planned 1 / 5 / 10 / 20 / 50 ramp on
a GPU has not been run.

## 6. Extended session

See `reports/benchmark_summary.md` ("Extended session") for the 30-minute run: completed turns, failures, latency drift between the
first and last third, and the end-of-session memory probe.

## 7. Projected latency on a GPU (estimate, not a measurement)

| Stage | Measured here (CPU) | Published for a GPU | Planning figure, one L40S |
|---|---:|---|---:|
| Wait before acting on end of speech (speculative start) | 190–230 ms after true end | — | 200–260 ms |
| Speech-to-text, utterance up to 5 s | 6,100 ms | 231 ms p50 on L40S, 405 ms on L4 (ivrit.ai model card) | 230 ms |
| LLM, first speakable chunk | 4,300 ms | not found for the planned model | 250–400 ms |
| TTS, first chunk | 330 ms | — | 60–150 ms |
| Network and playout | 50 ms (localhost Chromium) | — | 80–150 ms on mobile |
| **End of speech → audible reply** | 10,500 ms | | **about 0.85–1.2 s** |

The endpoint commit at 544 ms is not the bottleneck in this projection; the serial STT → LLM → TTS chain after the speculative start is.
Reading against the targets: P95 below 1.5 s looks reachable; a median below 800 ms does not, unless transcription runs
incrementally during speech (a streaming recogniser) so that almost no STT time remains after the user stops. This projection must be
replaced by the GPU measurement.

## 8. Not measured, and what is ready to measure it

| Metric from the brief | Status | Ready-made tool |
|---|---|---|
| Median / P95 response latency in real time | Not measured | `benchmarks/run_scenarios.py` on a GPU host |
| Maximum sustainable concurrency, GPU utilisation and memory | Not measured | `benchmarks/concurrency.py`, `/api/resources` |
| Commercial baseline quality, latency, token usage | Not measured | same scripts with `--provider openai-realtime` / `gemini-live` |
| Cost per connected / active minute from real usage | Not measured (modelled in `COSTS.md`) | `usage` telemetry events are recorded per session |
| Session failure rate | 0 failures in 12 scenario sessions, 7 concurrency sessions, the browser sessions and the long session on CPU | — |
| Human evaluation | Not performed | `frontend/eval.html`, `docs/HUMAN_EVALUATION.md` |
| Network bandwidth | Raw PCM as built: 256 kbit/s up, up to 384 kbit/s down while the agent speaks. Opus estimate 0.8 MB per minute both ways | — |
