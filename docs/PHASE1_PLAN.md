# ROLLY Phase 1 — plan

Status: in progress (2026-11-25). Brief: `docs/PHASE1_IMPLEMENTATION_PROMPT.md`. Decisions are numbered in `docs/PHASE1_DECISIONS.md`,
progress in `docs/PHASE1_PROGRESS.md`, open items in `docs/PHASE1_BLOCKERS.md`.

## 1. Architecture (brief §3, confirmed)

```
iPhone: Expo app (apps/mobile)                Render: rolly-api (apps/api, Node/TS)                 RunPod pod (unchanged)
  modules/rolly-audio (Swift)   ──WSS──►     auth (pairing code → device token → access token     ──WSS /v1/session──►  VAD → Whisper → Gemma-4 →
  AVAudioSession playAndRecord   ticket      → single-use voice ticket)                            bearer ROLLY_GPU_API_KEY  BlueV3 / Piper, barge-in,
  voiceChat (AEC), HFP, 16k up,              PostgreSQL memory + memory policy                                               echo handling, compaction
  24k down, background audio                 prompt + opener builder (persona ported)
                                             relay: seq per agent turn, resample 44.1/22.05k → 24k
                                             summariser + live corrections (OpenAI gpt-6-luna)
                                             Render PostgreSQL rolly-api-db
```

- **Credentials never reach the phone.** The phone stores only its own device refresh token (Keychain). `rolly-api` holds
  `ROLLY_GPU_API_KEY` and `OPENAI_API_KEY` and opens the pod connection itself (P1-D3).
- **Relay** (`apps/api/src/voice/`): TypeScript port of `providers/remote.py`. Same start context, raw PCM16 16 kHz up, events
  back, agent audio resampled to 24 kHz with a streaming windowed-sinc resampler (P1-D10), one sequence number per agent
  turn, `agent.interrupted` forwarded so the phone flushes. The phone protocol is the tester's protocol plus
  `audio_end_ms` (phone-side latency), `client.audio` (audio-session events) and `resume_of` (reconnect).
- **Prompt building** moved to `rolly-api` (`apps/api/src/persona/`). `VOICE_STYLE`, `LANG`, `END_MARKER` copied verbatim;
  a test fails if they drift from `memory/context.py`. Phase 1 additions are separate sections (P1-D4).
- **Transport**: WebSocket + raw PCM16, as proven by the research. WebRTC/LiveKit only if mobile-network tests show the need
  (measurement pending, needs the phone). A dropped connection resumes as a new session that waits for the cut-off session's
  summary and receives its last turns (P1-D11).
- **Render**: new web service `rolly-api` (Starter, Frankfurt, auto-deploy from the Phase 1 branch) and Render PostgreSQL
  `rolly-api-db` (Basic-256MB, 1 GB, Frankfurt, no external access), both in project Rolly. Approved by the owner on
  2026-11-25 (~$13-14/month). `rolly-voice` and `render.yaml` are untouched.
- **Pod**: no change.

## 2. One primary user, other voices (brief §5)

ROLLY cannot tell who is speaking and never claims to. The design:

| Layer | Behaviour |
|---|---|
| Conversation | Persona section "Other people may be in the car": answer others when it makes sense, ask "רגע, זה אליי?" when unclear, never stop the session, never guess identity/gender/name from a voice |
| Turn attribution | Every user turn is `primary` (= nothing suggests another speaker; **not** identification) or `uncertain` when the pod's weak hints say so: `level_db` more than 10 dB below or above the session's `ref_level_db`. Hints can only make attribution *more* uncertain (P1-D7) |
| Summariser | Told the transcript may contain other people; `USER?` marks uncertain turns; every item has confidence, first-person flag, verbatim quote and turn number; reports `other_speakers_suspected` |
| Memory policy | **Active** only if confirmed, a correction, or first person + confidence ≥ 0.75 + quote found in a `primary` user turn + no sign of other speakers in the session (one-to-one context). Otherwise **candidate**: not presented as fact, listed as "Not confirmed", expires after 14 days, ROLLY may ask once "רק לוודא — לשמור את זה בזיכרון?" (P1-D6) |
| User actions on memory | Confirmations, corrections and deletions count only from `primary` turns; uncertain ones are ignored (a corrected value becomes a candidate) |
| Addressing | Evidence from `uncertain` turns is counted separately and never changes the stored preference |
| Passengers | Nothing about other people is stored beyond what the session summary needs |
| Provenance | Every memory row stores source, session, quote, turn, attribution, reason, confirmed flag |

## 3. Data model (PostgreSQL, `apps/api/src/db/migrations/001_init.sql`)

`users`, `profiles` (preferred name, languages, addressing value + status + evidence JSON), `memories` (kind, content, status
`candidate|active|deleted`, confidence, provenance JSON, source session, expires_at, supersedes), `sessions` (times, language,
onboarding, pipeline description, summary JSON incl. policy decisions, stats), `turns` (role, text, language, attribution
`primary|uncertain`, meta), `progress_items`, `memory_events` (audit, no content), `pairing_codes`, `devices`, `voice_tickets`,
`app_secrets`. No raw audio. Transcripts deleted after 30 days (hourly job). Deleted memories keep no content. Export
(`GET /v1/export`) and account deletion (`DELETE /v1/me`, cascades) exist.

## 4. Hebrew addressing (brief §4.3)

States `unknown → inferred ↔ unknown`, `* → confirmed` (P1-D8):
- evidence: gendered present-tense verbs/adjectives right after "אני" (a lexicon of ~70 pairs, a few fillers allowed),
  "הייתי + adjective", self-describing nouns (weight 2). Past-tense first person is not gendered and is not counted.
- inferred when weighted evidence ≥ 3 and the majority form has ≥ 80 %; contradictory evidence returns to `unknown`.
- confirmed by an explicit request ("תדבר אליי בלשון נקבה/זכר/רבים") by voice — stored immediately during the session — or in
  the app. Never inferred from pitch or name, never asked.
- prompt: `unknown` → neutral phrasing rules, including words that look neutral in writing but are gendered when the
  unvocalised text is read aloud by the voice (לך, שלך, אותך, עליך, איתך...). `inferred`/`confirmed` → that form, switch at once
  on correction.

## 5. Build order and status

| Step | What | Status |
|---|---|---|
| 1 | relay + test client, Hebrew turn + interruption | relay done and tested against a protocol-identical fake pod; real-pod run via server-side self-test once Render has its settings |
| 2 | Postgres, memory, prompt builder, summariser, continuity | done, tested on local PostgreSQL; real run pending (same) |
| 3 | Expo dev build on iPhone | code done, typechecks, prebuild OK; **build needs Apple Developer + Expo accounts (owner)** |
| 4 | deploy rolly-api + Postgres | created; waiting for the owner to set four secrets |
| 5 | onboarding, addressing, memory policy, voice/app corrections | implemented and unit/integration tested |
| 6 | Progress and Personalisation screens | implemented (untested on device) |
| 7 | Bluetooth and vehicle | needs the phone and the owner |

## 6. Tests

`npm test -w @rolly/api` (resampler, persona drift, addressing state machine, relay against the fake pod, memory policy /
continuity / corrections / auth on PostgreSQL), `npm test -w @rolly/mobile` (voice controller with mock native module),
`.venv/bin/python -m pytest -q tests` (research suite, unchanged). Real-pipeline checks: `POST /v1/admin/selftest`
(`relay`, `memory`) run by rolly-api next to the pod.
