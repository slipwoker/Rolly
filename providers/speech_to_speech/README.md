# Architecture C — self-hosted speech-to-speech: not implemented (no-go)

No adapter is provided on purpose. The research (`docs/research/04-speech-to-speech.md`) found no open-weight,
commercially usable, full-duplex speech-to-speech model that supports Hebrew, and the available English models keep
only 2–4 minutes of context against a 30-minute requirement. See decision D1 in `DECISIONS.md`.

If an English-only latency/naturalness reference is wanted later, the research suggests NVIDIA PersonaPlex-7B-v1
(Moshi server protocol: WebSocket `/api/chat`, Opus frames, one conversation per process, 24–48 GB GPU). An adapter would
implement `providers.base.VoiceProvider` like the commercial bridges in `providers/commercial/`.
