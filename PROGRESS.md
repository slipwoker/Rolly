# Progress log

All work so far was done in one session on 2026-11-24, on a 4-vCPU / 15 GB container with no GPU. An OpenAI key was provided at the end of the session.
"Done" means executed here with output in the repository. "Built, not run" means the code exists and is tested against
emulators or on CPU only.

## Status by phase

| Phase | Status | What exists | What is missing |
|---|---|---|---|
| 1 Research and selection | **Done**, with verification limits | Six source-tagged reports (`docs/research/`), comparison matrix, licence report, decision log | Many vendor pages were unreachable from the research environment; those claims are tagged unverified |
| 2 Unified test platform | **Done** | Browser client (drive, blind evaluation, dashboard), WebSocket backend, provider abstraction, telemetry, sessions, retention controls; 17 automated tests; browser end-to-end test in real Chromium | WebRTC/Opus transport (deliberately out of scope, decision D7); Docker images not built here |
| 3 Proactive behaviour and memory | **Done** | Journey-start trigger, shared memory, proactive opener that references stored topics, summaries with action items that feed the next session, arrival event, natural ending | Voice command for "forget that"; retrieval for large memories |
| 4 Quality benchmarks | **Done except human evaluation** | WER on real speech with road noise, endpointing and barge-in detection, LLM probes, scripted scenarios, 30-minute sessions, browser playback timings; real-time latency on an L40S; OpenAI Realtime baseline in three turn-detection modes and two models; hybrid pipeline | Human ratings; Gemini Live; mixed-language speech on real recordings; real networks and cars |
| 5 Infrastructure and scalability | **Done on one GPU** | Concurrency ramp 1–50 on one L40S (35 within the P95 target), CPU cost per conversation, cold-start time, end-of-turn timing experiments, unattended pod scripts | Multi-GPU fleet behaviour; other GPU types; GPU speech synthesis |
| 6 Financial feasibility | **Done, on measured capacity** | Cost model with measured L40S price, measured conversations per GPU and measured API token usage; four DAU scenarios, utilisation grid, fleet strategies, break-even | Staffing and the demand curve are assumptions; other GPU prices unverified |
| 7 Licensing, privacy, security | **Done for the POC** | Licence report with verification status, privacy and retention document, secure credential handling, erasure endpoint | Legal review; items listed in `LICENSES.md` section 1 |

## Architectures

| Architecture | State |
|---|---|
| A Commercial realtime (OpenAI Realtime, Gemini Live) | OpenAI Realtime **run live** from the GPU pod (two models, three turn-detection modes); one bridge bug found and fixed. Gemini Live built, tested against an emulator only |
| B Self-hosted modular | Built; run end to end in Hebrew and English on CPU and on an L40S (681 ms median response, 35 simultaneous conversations within target) |
| C Self-hosted speech-to-speech | Evaluated, **no-go** (no Hebrew, short context); documented, not built |
| D Hybrid | Same code as B with stages swappable to APIs by configuration. **Run** with a commercial language model (OpenAI `gpt-6-luna`): 12 of 12 scenarios, 28 of 28 checks. Also run on the GPU host (1.33 s median). Commercial transcription measured separately. Commercial speech synthesis not run |

## Timeline of the session

1. Workspace inspection: empty repository; no GPU; outbound network limited to package registries. Hugging Face added to the allowed hosts after owner approval.
2. Six research agents ran in parallel (commercial realtime, STT, TTS, speech-to-speech, LLMs and frameworks, GPU pricing).
3. Platform core written: provider interface, session layer, memory, telemetry, mock provider. First end-to-end test with the mock.
4. Modular pipeline written (VAD/endpointing with speculative turns, STT, LLM client, chunker, TTS). First real conversation on CPU in English, then Hebrew.
5. Hebrew TTS built from model weights only (ReNikud G2P + Piper voice on ONNX Runtime) after a package install was declined by a safety check.
6. Bugs found by running it and fixed:
   - the small LLM ended a session by itself → rule-based confirmation of the end marker (D9);
   - session summary never reached the client when summarisation was slow → socket is drained during finalisation;
   - the simulated client assumed gapless playback → realistic playout-buffer model with underrun counting;
   - first session paid the model-loading time → optional warm-up at start;
   - client-side latency was biased low by trailing silence in synthetic speech → clips are trimmed;
   - the 30-minute run showed latency collapsing after turn 40 because sliding-window history trimming defeated the LLM prefix cache, and an early fact was lost → block compaction with a cumulative synopsis (D15), verified in shorter runs.
7. Browser client written and verified in headless Chromium with a fake microphone (proactive opener, barge-in, summary).
8. Commercial bridges written; emulator tests added.
9. Benchmarks: WER (FLEURS, three models, four noise levels), VAD/endpointing, LLM probes, session-layer capacity, scenarios, concurrency, long session.
10. Finding from the WER run: the Hebrew-tuned Whisper translates English speech into Hebrew → per-language STT routing added (D2) and the pipeline benchmarks re-run.
11. Cost model, licence report, comparison matrix, privacy document, runbooks, final report.
12. After the owner saved an OpenAI key: the realtime WebSocket turned out to be unreachable from this environment (HTTP 405 at the proxy). The key was used over HTTPS instead for LLM probes, a full hybrid scenario run with `gpt-6-luna`, and transcription accuracy with `gpt-transcribe`. A readiness flag was added to the health endpoint after a start-up race spoiled the first two scenario sessions.

13. GPU run. The owner funded RunPod and saved an API key. The REST host failed through the session proxy; the GraphQL host worked. One L40S pod was created through the API and driven without shell access: a start command clones the repository and runs setup and benchmarks, publishing logs and results on a read-only HTTP port. Problems met and fixed: vLLM needs a C compiler that the slim CUDA image lacks; progress output was buffered, which I twice misread as a stalled run and restarted unnecessarily (about 20 minutes of pod time); the first concurrency ramp stopped after one level because of an over-strict stop rule.
14. OpenAI Realtime from the pod. The owner set the key on the pod. The bridge worked on the first live call; the opener ignored memory (per-response instructions replace session instructions) and was fixed and re-run. Safety limits added: reply length cap, per-scenario timeout.
15. Four benchmark passes on the pod; pod terminated at 21:55 UTC; $3.66 spent.

## What changed in the conclusions during the session

| Before the GPU run | After |
|---|---|
| Latency projected at 0.85–1.2 s; 800 ms median "at risk" | Measured 681 ms median, 1,072 ms P95 next to the server |
| Hebrew quality needs a commercial language model | Self-hosted Gemma-4 26B is fluent in Hebrew and 13 times faster to first token than the API model |
| Start on component APIs, self-host later | Self-host speech recognition and the language model from the start |
| Capacity per GPU assumed at 10–39 | Measured 20–35 within the latency target on one L40S |
| Commercial realtime cost estimated at $0.03–0.08 | Measured $0.07 (`gpt-realtime-2.1`) and $0.02 (mini) on short sessions |

## Hosted deployment (2026-11-25)

Deployed to Render (project Rolly, service `rolly-voice`) with a RunPod L40S as the model backend; see README.
The owner ran the first browser conversations the same day. They showed that calling the three models separately from
Render made replies about twice as slow as on one machine, so the pipeline was moved to the pod and Render now relays audio:
926 ms median over 18 self-test replies (BENCHMARKS.md section 0.8). Noise transcripts are discarded, and the server can
test itself (`POST /api/selftest`). Still open: a longer real-user session on the hosted address, with headphones.

## First listening feedback from the team (2026-11-25, informal, not scored)

Three people tried the hosted agents. No ratings were entered on the blind-evaluation page; this is what they said.
- Conversation flow: the OpenAI Realtime agent was preferred; at that moment it was also the fastest.
- Hebrew: "very weak", mainly the pace; the open Hebrew voice is robotic, flat and heavily accented. English was acceptable.
- The pipeline agents were cut off by their own voice and by other voices in the room (fixed, BENCHMARKS.md 0.9, DECISIONS.md).
- The agents sound like an AI assistant, not like a person.

Done in response: relay of the pipeline to the GPU host, false-interruption handling, a friend-like persona with shorter
turns for all agents (opening line 5-7 s instead of 9-13 s), and an OpenAI voice for Hebrew on the hybrid agent as a
listening reference. After the persona change the hosted self-test measured 808 ms median over 8 replies for the self-hosted
agent, 7 of 7 checks (`benchmarks/results/hosted_selftest_friend_persona_20261125.json`).
Later the same day the self-hosted agent's Hebrew voice was replaced by ZONOS3-Mini with a cloned voice on the GPU
(BENCHMARKS.md 0.10, DECISIONS.md): Hebrew replies 929 ms median over 10 self-test replies, 18 of 18 checks.
ZONOS3-Mini was withdrawn the same day (it cut sentence endings in live conversation). BlueV3 was approved and tested, an
Inworld key was provided and its Hebrew voices tested; the product owner chose BlueV3, built-in voice "daniel", speed 1.2,
which is live on the self-hosted agent: 828 ms median over 10 Hebrew self-test replies, 24 of 24 clean sentence endings on
the deployed path (BENCHMARKS.md 0.11).
Still open: a listening verdict on BlueV3 in real conversation, the English voice, voice-server concurrency.

## Next actions (in order of value)

1. Blind human evaluation with native Hebrew speakers, including a Hebrew voice bake-off (B3, B4). This is now the main unknown.
2. A trial over a mobile network and in a car; a recorded mixed Hebrew-English test set.
3. Gemini Live baseline and 30-minute sessions on the commercial APIs (B1).
4. Repeat the concurrency ramp on a second GPU type and on two GPUs behind a load balancer.
5. Text normalisation before speech synthesis; investigate the number-word defect of the FP8 model.
