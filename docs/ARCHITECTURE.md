# Architecture of the test platform

> Research-phase architecture. Retired as a product surface on 2026-11-26 (see `docs/RESEARCH_CLOSEOUT.md`); the current
> architecture is the diagram in `docs/rolly-hld.html`. The provider interface and the pod pipeline below are still in use.

```
+----------------------------------------------------+
| BROWSER  (frontend/)                               |
|   microphone -> 16 kHz audio, 20 ms frames         |
|   player     <- 24 kHz audio, stops instantly      |
|   pages: drive, blind evaluation, dashboard        |
+----------------------------------------------------+
        |  ^
        |  |   one WebSocket: audio up, audio and
        v  |   JSON events down
+----------------------------------------------------+
| BACKEND  (backend/app) - VoiceSession              |
|   builds the context from memory (memory/)         |
|   records telemetry (telemetry/)                   |
|   writes the summary and new memories              |
|   blind labels and ratings API                     |
+----------------------------------------------------+
        |  ^
        v  |   the same events for every provider
+----------------------------------------------------+
| PROVIDERS  (providers/)                            |
|   modular    : VAD -> STT -> LLM -> TTS            |
|   hybrid     : same pipeline, stages through APIs  |
|   commercial : OpenAI Realtime, Gemini Live        |
|   mock       : plumbing tests only                 |
+----------------------------------------------------+
```

## One interface for every architecture

`providers/base.py` defines `VoiceProvider`: it receives 16 kHz PCM and emits provider-agnostic events
(`user.speech_started/stopped`, `user.transcript`, `agent.turn_started`, `agent.text`, `agent.audio`,
`agent.turn_done`, `agent.interrupted`, `metric`, `usage`, `session.end_requested`, `error`).
The session layer owns the socket, the memory and the telemetry, so every architecture is measured by the same code and
receives exactly the same user context. Switching provider is a field in `session.start`; the browser client has no
provider-specific code.

Provider configurations live in `config/providers.yaml`; self-hosted versus commercial stages are a configuration change.

## Modular pipeline (Architecture B and D)

`providers/modular/pipeline.py`

1. **Endpointing** (`vad.py`): Silero VAD on 32 ms windows. Three moments are exposed: speech start (barge-in),
   an *eager* point after 256 ms of silence, and the *endpoint* after 544 ms.
2. **Speculative turn**: at the eager point STT → LLM → first TTS chunk start immediately, but nothing is released to the
   user until the endpoint is confirmed. If the user resumes speaking the work is cancelled. This hides roughly 290 ms of
   processing inside the silence the system must wait for anyway.
3. **STT** (`stt.py`): one decode per utterance; language detection restricted to Hebrew/English.
4. **LLM** (`llm.py`): any OpenAI-compatible endpoint, streaming.
5. **Chunker** (`text.py`): the first chunk is cut at a clause boundary so audio starts early; later chunks are whole sentences.
6. **TTS** (`tts.py`, `tts_hebrew.py`): per-chunk synthesis, routed by script (Hebrew vs Latin).
7. **Barge-in**: user speech while the agent is audible cancels generation, flushes client playback, and the history keeps
   only the sentences that had started playing.

## Latency accounting

`response_latency_ms` = arrival time of the **last speech sample** (from the provider's `audio_end_ms`, mapped through the
audio clock) → first agent audio chunk handed to the socket. It therefore *includes* the endpointing wait, which is the
honest "user stopped talking → agent starts" number. The benchmark client measures the same interval on its own clock
(last sample sent → first audio byte received); the two agree within a few milliseconds on localhost. The browser adds its
playout buffer and output latency (`client.playback` events).

## Memory and proactive behaviour

`memory/context.py` assembles the system prompt from the profile, recent summaries, unresolved topics, open action items,
known facts and the current journey (duration, time of day). A `journey_start` event (`POST /api/journey/start`, or simply
opening the socket with `proactive: true`) makes the agent speak first using an opener instruction that points at the most
relevant unresolved topic. At session end `memory/summarizer.py` produces a JSON summary (decisions, action items, unresolved
and resolved topics, new facts) which is written back, so the next journey opens from it.

## What is deliberately missing

WebRTC/Opus transport, authentication, horizontal scaling (sessions are in-process), retrieval for large memories,
tool calling, multi-party conversations, mobile clients.
