# Benchmarks

Raw machine-readable results: `benchmarks/results/*.json`. Generated tables: `reports/benchmark_summary.md`
(`python -m benchmarks.analyze`). Nothing in this file is typed from memory; every number comes from those files.

## Read this first: what was and was not measured

Two environments were used on 2026-11-24:

- **GPU pod**: one rented NVIDIA L40S (48 GB) on RunPod, Sweden. Real-time latency, concurrency, the 30-minute session, the
  hybrid pipeline and the OpenAI Realtime baseline were measured here (section 0).
- **CPU container**: 4 vCPU, no GPU. Accuracy, endpointing, memory behaviour and functional checks were measured here
  (sections 1–6). Latencies from this machine (about 10 s) are not real-time figures and are kept only as a functional record.

| Category | Measured? | Notes |
|---|---|---|
| Response latency, self-hosted pipeline on a GPU | **Yes** | Section 0. Client on the same host: network and client playout are not included |
| Concurrency per GPU | **Yes** | Section 0, one L40S, 1 to 50 simultaneous conversations |
| Stable 30-minute session on a GPU | **Yes** | Section 0 |
| OpenAI Realtime speech-to-speech baseline (latency, behaviour, token usage) | **Yes** | Section 0; first live use of the bridge, three turn-detection modes, two models |
| Hybrid pipeline with a commercial language model | **Yes** | Section 0 (GPU) and section 4 (CPU) |
| Speech-recognition accuracy, clean and in road noise | **Yes** | Section 1 |
| Endpointing and barge-in detection | **Yes** | Section 2 |
| Context retention, corrections, hallucination probes, proactive opener, summaries | **Yes** | Sections 0, 3, 4 |
| Session-layer CPU cost | **Yes** | Section 5 |
| Google Gemini Live baseline | **No** | No Google key |
| Human ratings (naturalness, Hebrew quality, willingness to use) | **No** | No evaluators. Nobody has listened to any output |
| Latency over a mobile network, real cars, real users | **No** | Synthetic users, client next to the server |
| Cost per minute from real traffic | **No** | Modelled from measured capacity and measured token usage (`COSTS.md`) |

## 0. GPU and commercial-baseline results (RunPod L40S)

Raw files: `benchmarks/results/*_20261124T18…` to `…T21…` with "GPU pod" or "RunPod" in their `hardware_note`.
Scripts: `infrastructure/pod_setup.sh`, `pod_bench.sh`, `pod_bench2.sh`, `pod_bench5.sh`. Total pod time about 3 h 20 min, $3.66.

**Setup.** Everything self-hosted ran on the one GPU: two Whisper large-v3-turbo models (Hebrew-tuned and stock, float16),
and `RedHatAI/gemma-4-26B-A4B-it-FP8-dynamic` under vLLM with prefix caching; 36 GB of the 46 GB of GPU memory were in use.
Speech synthesis ran on the pod's CPU (Piper English voice, ReNikud + Piper Hebrew voice). The benchmark client ran on the same
machine and spoke synthetic user speech in real time. Response latency is "last user speech sample sent → first agent audio byte
received", identical for every configuration.

Caveats that apply to every number in this section: no network path and no client playout buffer (about 50 ms in Chromium on
localhost; a mobile network adds its round trip); synthetic speech that is clean and has no hesitations; one run per
configuration on one machine; small samples (14 to 56 turns per row). The English voice used here (`en_US-lessac`) has an
unresolved dataset licence (`LICENSES.md`) and is a stand-in.

### 0.1 Response latency by architecture

| Configuration | Turns | Median | p90 | p95 | Max | Scripted checks |
|---|---:|---:|---:|---:|---:|---:|
| **Self-hosted pipeline**, default end-of-turn wait (544 ms, speculative start at 256 ms) | 56 | **681 ms** | 936 | 1,072 | 1,319 | 56 / 56 |
| Self-hosted, shorter wait (416 / 192 ms) | 16 | 576 ms | 831 | 898 | 906 | 17 / 17 |
| Self-hosted, shortest wait (320 / 160 ms) | 16 | 522 ms | 636 | 649 | 664 | 17 / 17 |
| Self-hosted, speculative start switched off (544 ms) | 16 | 953 ms | 1,168 | 1,224 | 1,298 | 17 / 17 |
| **Hybrid**: self-hosted speech + OpenAI `gpt-6-luna` (reasoning off) | 28 | 1,333 ms | 1,847 | 2,441 | 3,139 | 28 / 28 |
| **OpenAI Realtime** `gpt-realtime-2.1`, semantic turn detection, eagerness auto (default) | 27 | 2,049 ms | 5,198 | 5,468 | 5,628 | 28 / 28 |
| OpenAI Realtime `gpt-realtime-2.1`, semantic turn detection, eagerness high | 14 | 1,972 ms | 3,306 | 3,410 | 3,559 | 17 / 17 |
| OpenAI Realtime `gpt-realtime-2.1`, server VAD, 500 ms silence | 14 | 1,619 ms | 1,719 | 1,780 | 1,891 | 17 / 17 |
| OpenAI Realtime `gpt-realtime-2.1-mini`, eagerness auto (two runs) | 28 + 28 | 1,730 / 1,646 ms | 4,878 / 4,907 | 5,041 / 5,097 | 6,360 / 5,313 | 27 / 28, 28 / 28 |

Against the targets (median < 800 ms, P95 < 1.5 s): the self-hosted pipeline meets both in every configuration except with the
speculative start disabled. The hybrid and every OpenAI Realtime configuration miss the median target; server-VAD Realtime and
nothing else among them comes close on P95. The OpenAI figures include the round trip from Sweden to OpenAI.

Where the time goes in the self-hosted pipeline (median / p95 per stage, 56 turns): speech-to-text 63 / 101 ms; language model
first token 56 / 65 ms; first speakable chunk 140 / 266 ms; first speech audio 119 / 257 ms; whole chain from the speculative start
331 / 634 ms. The rest of the 681 ms is the deliberate wait to be sure the user has finished. In the hybrid the language model's
first token takes 711 ms, which is the entire difference. Hebrew turns are slower than English ones (median 781 vs 670 ms).

Other measurements from the same runs: interruption signalled 171 ms after the user's speech onset (self-hosted, 2 samples),
274 ms (OpenAI Realtime, 1 sample); proactive opener audible 193 ms after connecting (self-hosted) against about 1.9 s
(OpenAI Realtime); zero playout underruns in every GPU run.

### 0.2 The end-of-turn wait: latency against cutting people off

| End-of-turn wait / speculative start | Median latency (GPU, 16 turns) | P95 | Long sentences cut at a mid-sentence pause (FLEURS, 30 real recordings) |
|---|---:|---:|---:|
| 544 ms / 256 ms (default) | 652 ms | 904 ms | 3–4 of 30 (10–13 %) |
| 416 ms / 192 ms | 576 ms | 898 ms | 5 of 30 (17 %) |
| 320 ms / 160 ms | 522 ms | 649 ms | 8–10 of 30 (27–33 %) |
| 544 ms, no speculative start | 953 ms | 1,224 ms | 3–4 of 30 |

The speculative start is worth about 300 ms at no cost in cut-offs. Shortening the wait buys another 80–130 ms but roughly
doubles to triples the cut-off rate on read sentences; the default is the better trade until a learned turn detector exists for Hebrew.

### 0.3 Concurrency on one L40S

Hebrew and English users mixed, five turns each, every level run to completion.

| Simultaneous conversations | Turns | Median | P95 | Max | Failed turns | Playout underruns | GPU utilisation (mean) |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 5 | 871 ms | 908 | 911 | 0 | 0 | 7 % |
| 2 | 10 | 756 ms | 962 | 965 | 0 | 0 | – |
| 5 | 25 | 797 ms | 1,266 | 1,297 | 0 | 0 | 13 % |
| 10 | 50 | 790 ms | 1,238 | 1,659 | 0 | 1 | 17 % |
| 20 | 100 | 845 ms | 1,304 | 1,782 | 0 | 2 | 33 % |
| 35 | 175 | 945 ms | 1,482 | 1,944 | 0 | 1 | 56 % |
| 50 | 250 | 1,068 ms | 1,699 | 2,092 | 0 | 4 | 57 % |

- **35 simultaneous conversations stay inside the 1.5 s P95 target; 50 complete without a single failed turn** but with P95 at 1.7 s.
- The median creeps up from about 0.8 s to 0.95 s at 35. Read against the strict 800 ms median target the limit is between 10 and 20;
  the single-session median in this mixed-language test is itself 0.76–0.87 s.
- Server CPU: 0.15–0.18 CPU-seconds per session-second (speech synthesis and VAD run on CPU), i.e. about six conversations per core.
- Hybrid ramp (API language model): median 1.29–1.58 s and P95 1.5–2.9 s from 1 to 35 conversations, no failed turns, GPU nearly idle
  (speech recognition only). Its latency is set by the API, not by our hardware; 14 underruns appeared at 35.
- Simulated users take about 4.4 turns per minute (measured in the 30-minute session), close to the 4 assumed in the cost model.

### 0.4 Thirty-minute session on the GPU

30.3 minutes, 134 turns, 0 failed, 0 underruns. Latency median 740 ms, P95 944 ms, max 1,048 ms; first third 782 ms, last third
716 ms — no drift. The history was compacted ten times in the background (median 1.2 s each; the slowest turn of the session still took only 1,048 ms) and the fact
stated in the first minute was recalled at the end. The same test on CPU, before block compaction existed, is in section 6.

### 0.5 Self-hosted language model: `gemma-4-26B-A4B` (FP8) on the L40S

| Probe (English · Hebrew) | Result |
|---|---:|
| Recall of facts present in memory | 6/6 · 6/6 |
| No invented answer when the fact is not in memory | 4/4 · 4/4 |
| General closed questions | 3/3 · 1/3 |
| Fact recalled after 10 and 20 filler turns | pass, pass |
| Time to first token / output speed | 52 ms median / 117 tokens per second |

Hebrew conversation in the scenario transcripts is fluent, grammatical and uses the correct gender — comparable, on reading, to
the commercial model. Two defects were found: in two of three Hebrew closed questions the number words were garbled (stray Cyrillic
letters inside "חמישים ושש", a misspelt year). The prompt tells the model to spell numbers as words; this needs a fix (digits plus
a text normaliser before speech synthesis) and a check whether the FP8 quantisation is responsible.

### 0.6 OpenAI Realtime baseline: behaviour and measured cost

- First live use of the bridge. It worked on the first call; one bug surfaced and was fixed (the opener ignored the user's memory
  because per-response instructions replace the session instructions on this API).
- Quality: `gpt-realtime-2.1` passed 28 of 28 scripted checks, with fluent Hebrew and correct use of memory. `gpt-realtime-2.1-mini`
  passed 55 of 56 over two runs (the one miss is a correct answer worded differently from the keyword list) but its Hebrew had
  gender and phrasing errors in the transcripts.
- Hebrew-English mixed speech: `gpt-realtime-2.1` kept "payment module" in English and understood "Q2" where our pipeline
  garbled both, but it also mis-heard "Stripe"; the synthetic stimulus remains invalid for a firm conclusion.
- In the three `gpt-realtime-2.1` runs the farewell turn ended the session through the tool call without spoken audio
  (counted as one "no response" each); the session still ended correctly.
- **Cost from the token usage the API reported**, at list prices that could not be verified on OpenAI's own page:
  `gpt-realtime-2.1` $0.070–0.075 per connected minute across four runs; `gpt-realtime-2.1-mini` $0.020–0.021. These are
  one-to-two-minute sessions; the research estimate for 30-minute sessions is higher because the growing context is re-billed.
  About half of the input tokens were served from cache.

### 0.7 Operations notes from the pod

- From container start to ready, with weights cached on the volume: about 3 minutes on each of five restarts (vLLM loading the 26B model dominates).
- First start failed because the slim CUDA image has no C compiler, which vLLM needs at start-up; fixed in `pod_setup.sh`.
- 27 GB of model weights downloaded in under three minutes in that data centre.

### 0.8 Hosted deployment: app on Render (Frankfurt), models on a RunPod L40S (Iceland)

Measured on 2026-11-25 on the deployed service. Latency is the server-side figure used everywhere in this document (last
speech sample to first agent audio leaving the app).

| Layout of the self-hosted agent | Source | Replies | Median | P95 | Range |
|---|---|---:|---:|---:|---|
| Everything on one machine (section 0.1, for reference) | benchmark | 56 | 681 ms | 1,072 ms | |
| Turn-taking on Render; speech-to-text, language model and voice called separately on the pod | three real browser conversations | 3 | 1,410 ms | – | 1,289–1,459 ms |
| **Whole pipeline on the pod, Render relays audio over one WebSocket** | server self-test, 6 scripted conversations | 18 | **926 ms** | 1,221 ms | 598–1,304 ms |

- In the split layout each model call paid the network: speech-to-text took 289–695 ms (63 ms on one machine), first word from
  the language model 238–364 ms (56 ms), first audio from the voice 271–439 ms (about 119 ms).
- The relay removed two of the three hops. The remaining gap to the one-machine figure, about 250 ms, is attributed to the
  network path between the two data centres through RunPod's HTTP proxy; it was **not measured separately**.
- The self-test passed 14 of 14 checks (memory-based opener, replies, interruption). Interruption was detected in 209–216 ms
  server-side (2 samples) and no agent audio arrived after it.
- The two rows are not a controlled comparison: three replies from a person on a real microphone against 18 replies from
  synthetic speech. The split layout was not re-measured with the self-test before it was replaced.
- The self-test user runs next to the app, so a real user's mobile network and audio device are not included.
- Result file: `benchmarks/results/hosted_selftest_selfhosted-gpu_relay_20261125.json`.

In the first browser sessions a 1.7 s noise burst was transcribed as one Hebrew letter repeated more than a hundred times, and
a 1 s burst as "תודה."; the agent answered both. Transcripts of that kind are now discarded for every speech-to-text engine
(`discard_reason` in `providers/modular/stt.py`). The same sessions showed that speaking Hebrew to a traveller whose session
language is English produces nonsense text, because the language is fixed per session unless "mixed" is chosen.

### 0.9 False interruptions: the agent hearing itself and other voices

**What happened.** In the first team tests on the hosted service (2026-11-25, laptop microphones and loudspeakers, other people
talking in the room) the self-hosted and hybrid agents were cut off 0.3-0.9 s into almost every reply: 7 of 7 replies in one
25-second session. The "user" transcripts were fragments of the agent's own sentence or of background speech
("סליחה" while the agent was saying "סליחה", "שמות", "טוב"), and the agent answered them with apologies.

**Reproduction.** The benchmark client can now feed the agent's voice back into its microphone (`--echo-gain`). A user who only
listens, hybrid pipeline on the CPU container:

| Echo level in the microphone | Before: replies cut off per conversation | After |
|---|---:|---:|
| gain 0.05 (about -45 dBFS; imperfect echo cancellation) | 6 (English), 12 (Hebrew) | 1, 0 |
| gain 0.1 | not run | 1 (English) |
| gain 0.3 (about -28 dBFS; loudspeaker with no echo cancellation at all) | 6, 7 | 1 (English) |

Before the fix every simulated conversation looped (cut, apology, cut). After it the single cut is followed by the agent
saying the rest of its sentence, and the echo level is learned so that it does not happen again.

**What was learned from the simulation.** The speech detector cannot tell echo from the user: it reports probability 0.99 on
echo at -46 dBFS. Loudness can: the echo arrived 10-30 dB below the user's speech. Raising detector thresholds or requiring
longer speech did not help; a loudness requirement before the cut did.

**Hosted self-test after the fix** (`benchmarks/results/hosted_selftest_false_interruptions_20261125.json`):

| Agent | Echo | False cut-offs (8 replies) | Real interruption detected after | Audio after it | Checks | Median reply |
|---|---|---:|---:|---:|---:|---:|
| Self-hosted (relayed) | gain 0.05 | 0 | 154 ms | 0 ms | 7 / 7 | 1,083 ms |
| Self-hosted (relayed) | none | 0 | 275 ms | 0 ms | 7 / 7 | 1,110 ms |
| Hybrid | gain 0.05 | 0 | 82 ms | 0 ms | 7 / 7 | 2,290 ms |

Not shown by these numbers, and still open:
- This is simulated echo with a synthetic user at a constant level. No person has re-tested since the fix.
- A real interruption spoken more than 10 dB below the user's usual level is ignored while the agent talks.
- Another person speaking clearly and as loudly as the user is still treated as the user. Telling voices apart needs speaker
  verification or a directional microphone; neither was tried.
- Every utterance now records its level and the decision, so the thresholds can be set from real sessions.
- Median reply time in this run (1.08-1.11 s over 8 replies each) is higher than the 926 ms of section 0.8 (18 replies); the
  runs are too small to say whether that is a real change.

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
| Hebrew | OpenAI `gpt-transcribe` (commercial API) | 19.5 % | – | 23.1 % | – |
| English | OpenAI `gpt-transcribe` (commercial API) | 3.5 % | – | – | – |

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
5. **The open Hebrew-tuned model matches the commercial API on Hebrew**: 18.9 % vs 19.5 % clean, 23.1 % vs 23.1 % at 5 dB
   (same 40 utterances). On English the API is somewhat better than stock Whisper turbo (3.5 % vs 5.6 %, 30 utterances).
   On this evidence there is no accuracy reason to buy Hebrew transcription.

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

## 3. LLM probes

The exact agent context (profile, memory, journey) with one question per probe; keyword scoring; answers stored for review.

| Probe (English · Hebrew) | Qwen3-4B-Instruct Q4, local CPU | OpenAI `gpt-6-luna`, API, reasoning off |
|---|---:|---:|
| Recall of facts present in memory | 6/6 · 5/6 | 6/6 · 6/6 |
| No invented answer when the fact is not in memory | 3/4 · 3/4 | 4/4 · 4/4 |
| General closed questions | 3/3 · 2/3 | 3/3 · 3/3 |
| Fact stated at the start recalled after 10 and after 20 filler turns (English) | pass, pass | pass, pass |
| Time to first token, median | 1.2 s (CPU, cached prefix) | 0.67 s (through this session's proxy) |

Hallucination on the controlled unknown-fact probes: 2 of 8 for the small local model (it invented a 58-minute time for a run that was
never mentioned), 0 of 8 for the commercial model. With 8 probes these are indications, not rates to quote. Scoring is by keyword; the
abstention keyword list was extended twice after reading answers that were correct refusals in wording the first list missed, and all
stored answers were re-scored with the final list.

Prompt caching, measured on the CPU server: the first turn of a session evaluates about 830 prompt tokens before the first token
(12–14 s on this CPU); later turns reuse the cached prefix (about 880–1,100 cached tokens) and reach the first token in about 1.0–1.2 s.
The same mechanism (prefix caching in vLLM, cached-input pricing in APIs) is what keeps the per-turn cost of a growing history bounded.

## 4. Scripted scenarios through the full pipeline on the CPU container (functional record; GPU results are in section 0)

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
| Extended 30–60 minute conversation | long session | 31.6 minutes, 50 turns, no failures; exposed a latency cliff and forgetting, both fixed and re-verified in shorter runs (section 6) |
| Proactive initiation | all | 12 of 12 sessions opened by the agent without user input; 3 of 4 keyword checks on the opener passed |
| Summary and action items | s02 | Passed |
| Natural ending | s12 | Passed: "זה מספיק להיום, להתראות" ended the session and produced a summary |

The central qualitative finding: **with a 4B model the English conversation is usable and the Hebrew conversation is not.** Speech
recognition and speech synthesis worked in Hebrew; the language model is the weak link, which is consistent with the research
finding that no model of 12B or below has a published Hebrew score.

### Hybrid run: same pipeline, language model replaced by a commercial API

`hybrid-apillm`: identical speech recognition and synthesis on the same CPU; LLM = OpenAI `gpt-6-luna` over HTTPS with reasoning off.

- 12 of 12 scenarios completed, 28 of 28 turns answered, **28 of 28 scripted checks passed** (26 of 28 with the local 4B model).
  The first attempt at s01 and s02 failed with no opener because the benchmark connected while the server was still loading models after
  a container restart; both were re-run once the server was ready and those re-runs are what the result file holds (marked in the file).
- **Hebrew**: replies were fluent and grammatical in the transcripts, addressed the user in the correct gender, used the stored memory
  precisely (the CTO's name, the skipped long run, the third option "Germany"), and recovered from a garbled transcription by asking
  "did you mean Stripe?". This is the author's reading of the transcripts in the result file, **not** a rated human evaluation.
- LLM stage: first speakable chunk after a median of 1.24 s (through the session proxy), against 4.3 s for the local model on CPU.
  Playout underruns dropped from 0.89 to 0 per turn. End-to-end latency is still 6.9 s median because CPU speech recognition takes 5.1 s.
- Token usage, measured: 40 LLM calls, on average 948 prompt tokens and 44 completion tokens per call; only 8 % of prompt tokens were
  served from the provider's cache, because most prompts in these short sessions are below the provider's minimum cacheable size.
  At the unverified list price that is about $0.0001 per turn, or $0.0004 per conversational minute at four turns per minute.

## 5. Concurrency on the CPU container and session-layer cost

| Run | Sessions | Latency median | Failed turns | Note |
|---|---:|---:|---:|---|
| Session layer only (mock provider: transport, resampling, telemetry) | 10 / 25 / 50 | 424 / 462 / 462 ms | 0 / 340 | Flat across levels (the mock itself waits about 520 ms); 0.006 CPU-seconds per session-second at 25–50 sessions; about 0.45 MB of memory per session |
| Full pipeline on 4 vCPU, no GPU | 1 | 11.4 s | 0 / 2 | |
| | 2 | 19.9 s | 0 / 4 | |
| | 4 | 64.7 s | 0 / 8 | No sessions dropped, but unusable |

With the VAD cost measured separately (0.0065 CPU-seconds per second of audio), the session layer handles about 80 conversations per
core at full load, about 40 with headroom.

Maximum sustainable real-time concurrency of the full pipeline on the CPU container: **0**. That run validated the harness
and showed graceful degradation. The ramp on a GPU is in section 0.3.

## 6. Extended session on the CPU container (where the history problem was found)

One continuous English conversation, simulated user, CPU.

| Run | Minutes | Turns completed / failed | Session survived | Latency, first third → last third (median) | Early-fact probe at the end |
|---|---:|---:|---|---|---|
| 30-minute run, sliding-window history (as first built) | 31.6 | 50 / 0 | yes | 11.4 s → 59.9 s | **fail** |
| Verification, block compaction, forced every 3 turns | 12.7 | 19 / 0 | yes | 8.7 s → 15.3 s | fail |
| Verification, block compaction with cumulative synopsis | 12.7 | 18 / 0 | yes | 9.3 s → 17.5 s | **pass** ("Your locker code is 7429") |

What the 30-minute run showed:

1. **Stability**: no failed turn, no error, no dropped connection in 31.6 minutes.
2. **A latency cliff at turn 41**: turns 1–40 had a median of 11.9 s, turns 41–50 a median of 62.3 s. The telemetry shows why: the history
   window had filled and began dropping the oldest message on every turn, so the prompt prefix changed on every turn and the LLM's cached
   prefix fell from about 3,280 tokens to 734. Time to first token went from about 2 s to about 50 s on this CPU.
3. **Forgetting**: the fact stated in the first minute had been dropped by the same window.
4. The end-of-journey summary of that run is the marked non-LLM fallback, because the LLM server process was killed by the container's
   memory limit at the very end of the run. The fallback path worked as designed; the summary itself is not useful.

The fix (decision D15) compacts the older half of the conversation into a synopsis in one block. In the verification runs the cache is
rebuilt once after each compaction and then hits again (cached tokens per turn, second run: …1314, **734**, 1234, 1300, **858**, 1327, 1375,
**968**, …). The first verification run still lost the fact because the weak model re-summarised its own summary five times; carrying
the earlier synopsis over verbatim fixed that. Remaining cost on this CPU: the turn that coincides with writing a synopsis waits for
the single LLM slot (10–20 s), which a deployment avoids by using a separate slot or model for it. With the default setting (24
exchanges) a 30-minute conversation compacts two or three times; that configuration was not re-run for the full 30 minutes.

## 7. The earlier latency projection, for the record

Before the GPU run this file projected 0.85–1.2 s from end of speech to audible reply and judged the 800 ms median "at risk".
The measurement (section 0) is 681 ms median and 1,072 ms P95 without network and playout: the projection was pessimistic,
mainly because speech recognition took 63 ms instead of the 230 ms taken from the model card, and the language model produced its
first speakable chunk in 140 ms instead of the assumed 250–400 ms. With a realistic 80–150 ms for mobile network and playout the
median lands at about 0.76–0.83 s, i.e. on the target rather than comfortably under it.

## 8. Still not measured

| Item | Why | What is ready |
|---|---|---|
| Human evaluation | No evaluators | `frontend/eval.html`, `docs/HUMAN_EVALUATION.md` |
| Google Gemini Live baseline | No Google key | `--provider gemini-live` (bridge tested against an emulator only) |
| Latency over mobile networks and in real cars | Client ran next to the server | Browser client; needs a deployed HTTPS endpoint |
| Mixed Hebrew-English speech on real recordings | No licensed test set | Scenario s09 with human recordings |
| Other GPU types (L4, A40, RTX 6000 Ada), and each stage's capacity in isolation | Only one L40S run | `infrastructure/pod_*.sh` |
| GPU speech synthesis and stronger Hebrew voices | Speech synthesis ran on CPU with stand-in voices | `BLOCKERS.md` B4 |
| 30-minute sessions on the commercial APIs | Only short sessions were run | `benchmarks/long_session.py --provider openai-realtime` |
| Session failure rate under real conditions | 0 failed sessions in all GPU runs (24 + 24 scenario sessions, 123 concurrency sessions, one 30-minute session) and all CPU runs | — |
| Network bandwidth with a production codec | POC streams raw PCM: 256 kbit/s up, 265 kbit/s down measured in the 30-minute session. Opus estimate 0.8 MB per minute both ways | — |
