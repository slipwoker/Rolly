# Privacy, data retention and security

This describes what the POC does today and what must be decided before real users are involved.
It is an engineering description, not legal advice; Israeli Privacy Protection Law and GDPR applicability
must be reviewed by counsel before any pilot with real people.

## What the system processes

| Data | Where it exists | Stored? | Default retention | Control |
|---|---|---|---|---|
| Raw microphone audio | Browser → server memory → STT (and the commercial API if that provider is selected) | **No** | Not written to disk | `ROLLY_RETAIN_AUDIO=true` writes `data/audio/<session>_user.wav` (off by default; verified by an automated test) |
| Agent audio | Generated, streamed, discarded | No | — | — |
| Transcripts (user and agent turns) | SQLite `turns` | Yes | 30 days | `ROLLY_TRANSCRIPT_RETENTION_DAYS`; `ROLLY_STORE_TRANSCRIPTS=false` keeps only the summary |
| Telemetry events (timings, token counts; also the transcript text of each turn) | SQLite `events`, `data/telemetry/*.jsonl` | Yes | 30 days (database); JSONL files are **not** purged automatically yet | Delete `data/telemetry/` or disable JSONL in production |
| Session summaries, open topics, action items, learned facts | SQLite `memories` | Yes | Until the user deletes them | `DELETE /api/users/{id}` |
| User profile | SQLite `users` | Yes | Until deleted | `DELETE /api/users/{id}` |
| Evaluator ratings | SQLite `ratings` | Yes | Until deleted | Evaluator names are free text — use codes, not names |

The purge job runs at start-up and every 24 hours. `DELETE /api/users/{id}` removes the profile, memory,
transcripts, telemetry and ratings linked to that user (covered by an automated test).

## Where data leaves our infrastructure

| Architecture | Third parties that receive user content |
|---|---|
| B self-hosted modular | None (all models run on our GPUs) |
| D hybrid with commercial LLM | Transcript text and the memory context go to the LLM vendor; audio stays with us |
| D hybrid with commercial STT or TTS | User audio (STT) or agent text (TTS) goes to that vendor |
| A commercial realtime | User audio, the full memory context and all agent output go to OpenAI or Google |

For each vendor the data-retention, training-use and regional-processing terms must be confirmed in the contract
actually signed; the research could only partly verify them (`LICENSES.md`).
Session resumption on Google's Live API stores session state server-side, which conflicts with zero-retention settings (published by Google, noted in `docs/research/01-commercial-realtime.md`).

## Consent the product will need

1. Explicit opt-in to voice processing and to long-term memory, with a plain-language explanation of what is remembered.
2. A spoken or in-app way to say "forget that" / "delete everything" — the erasure endpoint exists; the voice command does not yet.
3. Passengers: a car is a shared space. Other people's voices will be captured and transcribed. The product needs a policy
   (for example a voice notice, a passenger mode that disables memory, or speaker-gated capture).
4. Separate consent if audio is ever retained for quality improvement; the default must stay off.
5. Children and sensitive categories (health, finances) discussed in conversation end up in summaries; define what the summariser must not store.

## Security measures in the POC

- Credentials are read only from environment variables; `.env` is git-ignored; `config/providers.yaml` contains variable names, never values.
- Optional shared access token for testers (`ROLLY_ACCESS_TOKEN`) and a separate admin token (`ROLLY_ADMIN_TOKEN`) that is required
  to see which provider is behind a blind label, to export ratings and to read resource statistics.
- Docker Compose binds to localhost by default.
- The agent cannot end a session, call tools or take actions on model output alone (the end-of-session marker is confirmed by a rule).

## Known gaps (not acceptable for a public pilot)

- No per-user authentication: a user is a `user_id` string chosen by the client.
- No TLS termination in the repository; it must sit behind HTTPS/WSS (browsers require it for microphone access off localhost).
- SQLite file is not encrypted at rest.
- JSONL telemetry duplicates transcript text and is not covered by the purge job.
- No rate limiting or abuse protection on the WebSocket.
- Prompt-injection through user speech can alter the agent's behaviour within a session; memory writes go through the summariser,
  which reduces but does not remove the risk of poisoned long-term memory.

## Connected services (calendar, mail, music)

- **Google (calendar + mail)** is read only (`calendar.readonly`, `gmail.readonly`). The refresh token is stored encrypted (AES-256-GCM) in `integrations`, deleted on disconnect or account deletion, and revoked at Google at that moment. Rolly never sends, replies, accepts or changes anything.
- When the user asks about their calendar or mail, only the events (title, time, place) or at most five messages (sender, subject, Google's snippet, never full bodies) needed for that one question are fetched and sent to the utility model to be put into a spoken answer. Nothing from mail or calendar is written to memory or the transcript store beyond what the user hears Rolly say.
- **Spotify search** uses the app's own credentials to search the public catalogue; no user data is sent except the search words.
- **Spotify playback** (optional, per user): the user connects their own account (scopes `user-modify-playback-state`, `user-read-playback-state`, `user-read-private`: start a song on their device, see their devices and whether the plan is Premium; no listening history, no playlists, no email). The refresh token is stored encrypted like Google's and deleted on disconnect or account deletion (Spotify has no revoke call: the user can also remove Rolly at spotify.com/account/apps). Music is started only when the user asks for it, and listening is switched off on the phone while it plays.
