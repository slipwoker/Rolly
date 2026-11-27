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

## WhatsApp link (Phase 1, `apps/wa-gateway`; not deployed yet)

Engineering description, not legal advice; the legal review is still open (docs/WHATSAPP_GATEWAY.md, decision W6).

**What it is.** The user links Rolly as an additional device ("linked device", like WhatsApp Web). This is an **unofficial**
connection: it is not allowed by WhatsApp's terms, WhatsApp can restrict or ban the user's number, and it can stop working
without notice. The user must be told this in the app and accept it before linking; the gateway refuses to start a link
without `consent: true` and records when it was given.

| Data | Where | Retention | Notes |
|---|---|---|---|
| Message text, captions, file names, sender names in groups | gateway database (`wa_messages`) | **30 days** from when it reached the gateway (`WA_RETENTION_DAYS`), then deleted by an hourly purge | text and transcripts are sealed with AES-256-GCM, a key per user derived from `WA_DATA_KEY`; chat names are not sealed (they are searched) |
| Voice notes | not stored | audio is fetched from WhatsApp only when the user asks to hear that note, sent to the speech-to-text endpoint (our GPU worker), and dropped | only the transcript is kept (sealed, 30 days) |
| Images, video, documents, stickers | not downloaded | - | only their kind and caption are stored |
| Chat list and names | `wa_chats` | until the last message of the chat expires | the phone number of a chat never leaves the gateway: other services see an opaque 16-character reference |
| WhatsApp session keys | `whatsmeow_*` tables, same database | until the user disconnects or WhatsApp logs the device out | **not** sealed by us (owned by the library); protect the database and its backups; they give full access to the account's chats |
| What was sent through Rolly | `wa_sends` | 48 hours | counts and timestamps for the send limits; no content (the sent message itself is a normal stored message) |

**Who receives what.**
- WhatsApp/Meta: sees a new linked device and Rolly's messages, like any linked device.
- The speech-to-text worker: the audio of a voice note, only on request.
- The utility language model (OpenAI today): the user's spoken request and the last few turns of the conversation, to decide what was
  asked. **It never receives message content.** The conversation model on our GPU pod does receive the messages that are read aloud
  and the drafts, because it has to say them.
- No analytics or third party gets message content. Message text is not written to logs.

**Rules in the product.** Rolly never sends on its own; a send is a draft read back and confirmed by the user in a later turn; nothing is
read, drafted or confirmed when the turn may be another person's voice; other people's message text is treated as data, never as an
instruction; sends are capped (40 per 24 h, 4 s apart by default).

**Deletion.** "Disconnect WhatsApp" by voice (confirmed by a later yes) or `DELETE /v1/whatsapp` logs the device out on WhatsApp's side and
deletes the session, chats, messages, transcripts and send log of that user at once. Deleting the Rolly account does the same.

**Open points.** Passengers hear messages that are read aloud in the car (no mitigation yet except the attribution check for requests);
the session keys are not sealed; a database backup older than a deletion still contains what was deleted, until it ages out of Render's backup window (3 days on a Hobby workspace, 7 days on Pro or higher; logical exports 7 days; `docs/SECURITY.md`);
the gateway has no in-app consent screen yet (the API requires the flag; the screen is not built).

## Connected services (calendar, mail, music)

- **Google (calendar + mail)** is read only (`calendar.readonly`, `gmail.readonly`). The refresh token is stored encrypted (AES-256-GCM) in `integrations`, under a key that only the service's environment holds (`ROLLY_INTEGRATIONS_KEY`, never in the database; P1-D40, `docs/SECURITY.md`), deleted on disconnect or account deletion, and revoked at Google at that moment. Rolly never sends, replies, accepts or changes anything.
- **Writing to Google (email, calendar events)** uses two more scopes, `gmail.send` and `calendar.events`, and works only after the user has approved them (connections made earlier stay read-only until the user taps "update permissions"). Rolly sends one email or adds one event only after reading the draft back and hearing a yes in a later turn of the user's own voice; it cannot delete or change anything that exists and cannot reply inside a thread. Recipients are taken from what the user said or from names in the headers of their own mail (never message text). Invited guests receive Google's normal invitation. At most 10 emails and 15 events per hour per user.
- When the user asks about their calendar or mail, only the events (title, time, place) or at most five messages (sender, subject, Google's snippet, never full bodies) needed for that one question are fetched and sent to the utility model to be put into a spoken answer. Nothing from mail or calendar is written to memory or the transcript store beyond what the user hears Rolly say.
- **Spotify search** uses the app's own credentials to search the public catalogue; no user data is sent except the search words.
- **"Play it"** opens the song's Spotify link in the Spotify app on the user's phone. No Spotify account is connected, nothing about the user is sent to Spotify by Rolly's server, and Rolly stops listening (the microphone is released) until the user taps the screen to talk again.

**Link by email (WhatsApp).** When the user asks for the QR link by email, the address they type is sent to Elastic Email (our email provider) together with a message containing a
10-minute one-time link. We do not store or log the address; Elastic Email keeps its own delivery records under its own terms (to be checked in the contract). The link is the only
content of the message.
