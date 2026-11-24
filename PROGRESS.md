# Progress log

All work so far was done in one session on 2026-11-24, on a 4-vCPU / 15 GB container with no GPU and no commercial API keys.
"Done" means executed here with output in the repository. "Built, not run" means the code exists and is tested against
emulators or on CPU only.

## Status by phase

| Phase | Status | What exists | What is missing |
|---|---|---|---|
| 1 Research and selection | **Done**, with verification limits | Six source-tagged reports (`docs/research/`), comparison matrix, licence report, decision log | Many vendor pages were unreachable from the research environment; those claims are tagged unverified |
| 2 Unified test platform | **Done** | Browser client (drive, blind evaluation, dashboard), WebSocket backend, provider abstraction, telemetry, sessions, retention controls; 17 automated tests; browser end-to-end test in real Chromium | WebRTC/Opus transport (deliberately out of scope, decision D7); Docker images not built here |
| 3 Proactive behaviour and memory | **Done** | Journey-start trigger, shared memory, proactive opener that references stored topics, summaries with action items that feed the next session, arrival event, natural ending | Voice command for "forget that"; retrieval for large memories |
| 4 Quality benchmarks | **Partly done** | Executed on CPU: Hebrew/English WER on real speech with road noise, endpointing and barge-in detection, LLM context/hallucination probes, scripted scenarios through the full pipeline, 30-minute session, browser playback timings | Real-time latency (needs GPU); commercial baselines (need keys); human ratings (need people) |
| 5 Infrastructure and scalability | **Partly done** | GPU and provider research; concurrency harness; session-layer capacity measured (about 40 sessions per vCPU); CPU-only concurrency run | Concurrency per GPU: not measured. GPU runbook is written but not executed |
| 6 Financial feasibility | **Done as a model** | Parametric cost model, four DAU scenarios, utilisation grid, fleet strategies, break-even analysis | Its two largest inputs (conversations per GPU, GPU prices) are assumption / unverified |
| 7 Licensing, privacy, security | **Done for the POC** | Licence report with verification status, privacy and retention document, secure credential handling, erasure endpoint | Legal review; items listed in `LICENSES.md` section 1 |

## Architectures

| Architecture | State |
|---|---|
| A Commercial realtime (OpenAI Realtime, Gemini Live) | Built from SDK-documented protocols; tested against local protocol emulators; **never run against the live services** |
| B Self-hosted modular | Built and run end to end in Hebrew and English on CPU |
| C Self-hosted speech-to-speech | Evaluated, **no-go** (no Hebrew, short context); documented, not built |
| D Hybrid | Same code as B with stages swappable to APIs by configuration; API stages **not run** (no keys) |

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

## Next actions (in order of value)

1. Approve and rent a GPU; run `infrastructure/run_benchmarks.sh` (`BLOCKERS.md` B2). This turns the latency and capacity assumptions into measurements.
2. Provide API keys and run the same scenario suite against the commercial baselines (B1).
3. Recruit evaluators for the blind test, with native Hebrew speakers (B3).
4. Decide on the Hebrew TTS bake-off (B4).
5. Re-verify unverified prices and re-run the cost model (B5).
