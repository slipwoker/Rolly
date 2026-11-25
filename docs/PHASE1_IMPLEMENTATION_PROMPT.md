# ROLLY — Phase 1 implementation (instructions for a new Claude Code session)

You are the lead engineer building the first usable ROLLY application: a voice-first companion that holds personalised,
continuous, hands-free conversations in Hebrew and English with one primary user, on a physical iPhone, through the car's
Bluetooth, with the phone locked. A research phase has already built and measured the voice pipeline. Your job is to turn
it into a product slice, reusing what works. **Phase 1 only. Stop when Phase 1 is done and ask for approval.**

## 0. Before you write code

1. Work in the existing repository `slipwoker/Rolly` and the existing Claude Code environment. Do not create another
   repository or environment.
2. Read, in this order: `RESEARCH_HANDOFF.md` (what runs where, protocols, secrets by name, limitations), `FINAL_REPORT.md`,
   `BENCHMARKS.md` sections 0.1-0.11, `DECISIONS.md` (especially D15, D21-D23), `infrastructure/GPU_RUNBOOK.md` §7-8,
   `providers/remote.py`, `backend/gpu_worker.py`, `memory/context.py`, `memory/summarizer.py`, `backend/app/session.py`.
3. Branches:
   - The research branch `claude/adoring-goodall-es5zzm` is **production**: Render's `rolly-voice` auto-deploys from it and
     the GPU pod pulls it every 30 s (and re-runs `infrastructure/pod_job.sh` when that file changes). **Never push to it**
     unless the owner explicitly approves a specific change.
   - Work on `rolly-phase1` (cut from tag `research-baseline-2026-11-25`), or on a branch cut from it. If your environment
     assigns you a different branch name, create it from `rolly-phase1` and say so.
4. Run the existing tests (`.venv/bin/python -m pytest -q tests`; create the venv from `requirements.txt` if missing) and
   confirm `https://rolly-voice.onrender.com/healthz` answers. Record the baseline in your first report.
5. Write a short plan (`docs/PHASE1_PLAN.md`) covering the decisions in §3 and §5 below, then start building the vertical
   slice in §7. Do not wait for approval of the plan unless a decision needs the owner (§9).

## 1. Ground truth you must not get wrong

- **Hebrew speech synthesis is BlueV3** (built-in voice `daniel`, speed 1.2), served on the GPU pod. The project brief
  mentions "the existing working ZonOS V3 configuration": ZONOS3-Mini was tested and **withdrawn on 2026-11-25** because it
  cut sentence endings in live conversation. Its code remains in the repository; do not switch back to it without the
  owner's approval. English uses Piper `en_US-lessac-medium` (not yet reviewed by listeners).
- **The whole voice pipeline runs on the GPU pod** behind `WS /v1/session` (Silero VAD endpointing 544 ms with speculative
  start, Whisper per language, Gemma-4 26B on vLLM, BlueV3/Piper voices, barge-in, echo and false-interruption handling,
  history compaction). The worker keeps **no user data**: the caller supplies the system prompt and the opener. This is the
  seam your backend uses. Do not rebuild or retune the pipeline, and do not restart model selection, unless you hit a
  critical blocker; if you do, stop and report it.
- Latest measured reply time on the hosted path: **828 ms median** in Hebrew (synthetic user next to the server). Phone,
  mobile network and Bluetooth add delay that nobody has measured yet. Measure it.
- Known weak points you will meet: the BlueV3 server synthesises one request at a time (fine for a few testers, not for
  load); no speaker identification exists; echo on a phone in a car is untested; the GPU pod is **off from 21:04 to 06:13
  Israel time** (scheduled tasks) and the RunPod balance was about $36 — check both before any vehicle test.
- The existing Python voice tester (`backend/app`, `frontend/`, Render service `rolly-voice`) must keep working
  throughout. It is Phase 1 acceptance criterion 13.

## 2. Mandatory technology

- Mobile: Expo, React Native, TypeScript, Expo Router, EAS **development builds** (native audio requires them; Expo Go is
  not enough).
- Backend: Node.js + TypeScript, deployed on Render (a new service; the Python tester stays as it is).
- Database: PostgreSQL on Render.
- Voice inference: the existing RunPod pipeline (`WS /v1/session` on the pod).
- Speech synthesis: the existing working configuration (BlueV3 for Hebrew, see §1).
- Advanced reasoning (summaries, memory extraction, addressing inference): external AI APIs where needed. The research used
  OpenAI `gpt-6-luna` with `max_completion_tokens` and `reasoning_effort: "none"` for summaries; the key exists on Render
  (`OPENAI_API_KEY`) and as a network secret of this environment.
- Architecture: modular monolith (`apps/api`) plus the separately deployed inference service (the pod).

Target layout, to grow into gradually; **do not move existing research code** in Phase 1:

```
apps/mobile/        Expo app (new)
apps/api/           Node/TS backend (new)
packages/contracts/ shared TypeScript types for the voice protocol, API payloads, memory schema (new)
(existing)          backend/ providers/ memory/ frontend/ benchmarks/ infrastructure/ config/ tests/  -- the research
                    implementation and voice tester; treat as apps/voice-tester + services/inference for now
docs/               plans, protocol notes, test reports
```

Use npm or pnpm workspaces for the TypeScript parts only. Keep the Python tree untouched except for deliberate,
owner-approved changes.

## 3. Architecture to build (recommendation; confirm in your plan)

```
iPhone (Expo app) ──WSS (short-lived session ticket)──► Render: rolly-api (Node/TS) ──WSS /v1/session (bearer)──► RunPod worker
   native audio module:                                  auth, users, Postgres memory,          VAD/STT/LLM/TTS pipeline
   AVAudioSession, voice                                 prompt + opener builder, relay,
   processing (AEC), 16 kHz up,                          summaries via external LLM,
   24 kHz down, background audio                         memory policy
```

- **Credentials never reach the phone.** The app authenticates to `rolly-api`; `rolly-api` holds `ROLLY_GPU_API_KEY` and
  the OpenAI key and opens the pod connection server-side. Session tickets are short-lived and single-use.
- **Relay**: implement in TypeScript what `providers/remote.py` does: open `/v1/session`, send
  `{"type":"start","ctx":{session_id,user_id,language,system_prompt,opener_instruction,proactive,journey,profile,options}}`,
  forward 16 kHz PCM16 from the phone, forward events back, and **resample agent audio to one client rate** (pod audio
  arrives at the voice's own rate: 44.1 kHz BlueV3, 22.05 kHz Piper; binary frame = 4-byte big-endian header length + JSON
  header `{event,data,sample_rate}` + PCM16). Keep a sequence number per agent turn and tell the phone to flush playback
  on `agent.interrupted`, as the tester does.
- **Prompt building moves to `rolly-api`**: port `VOICE_STYLE`, `LANG` and the opener logic from `memory/context.py`, and
  the summary prompt and JSON schema from `memory/summarizer.py`. Keep the persona text identical in substance; put the
  shared text in one file both implementations can read, or note clearly where they diverge.
- **Transport choice**: start with WebSocket + raw PCM16 (proven end to end in this project). Evaluate WebRTC/LiveKit only
  if mobile-network tests show it is needed; record the evidence either way. Measure reconnect behaviour (tunnel, network
  switch) and decide how a dropped connection resumes the session.
- Render: create the new web service and the PostgreSQL instance as **separate resources in the existing project "Rolly"**
  in "Zappy's workspace" (the workspace has many unrelated services; touch nothing else). Do not edit the existing
  `render.yaml` Blueprint in a way that affects `rolly-voice`. Both new resources cost money: get the owner's approval of
  plan and price first (§9).
- The pod needs no change for the first slice. If you find you need one (for example a different output sample rate),
  propose it to the owner: the pod follows the research branch, so a pod change means either an approved commit there or
  repointing the pod, which restarts it.

## 4. Product requirements for Phase 1

Core loop: open ROLLY → start a session → ROLLY opens with a personalised remark or question → natural voice conversation
with interruptions → progress saved → next session continues where it left off.

1. **Voice-first onboarding**, not a questionnaire. ROLLY leads the first conversation. Main question it explores: what
   would make the user's travel time genuinely valuable. It learns the preferred name naturally, explores goals and
   interests adaptively, asks about biography or profession only when relevant, and lets the user skip or redirect at any
   moment. The profile is enriched progressively in later sessions.
2. **Persistent memory in PostgreSQL**: profile, preferences, goals, ongoing topics, action items, session summaries,
   meaningful outcomes. Users can **correct or delete** remembered information by voice ("that's wrong, I work at…",
   "forget that") and in the app.
3. **Hebrew grammatical addressing**:
   - Learn how to address the user from linguistic evidence in the user's own speech, especially self-references
     ("אני חושב" / "אני חושבת", "אני עייף" / "אני עייפה", past-tense first person forms are not gendered — do not
     count them).
   - **Never** infer from voice pitch or from the name. **Never** ask a demographic gender question unprompted.
   - Until the evidence is reliable, use natural neutral phrasing (plural or impersonal forms, infinitives, rephrasing),
     not alternating forms.
   - Store the addressing preference with its status: `unknown`, `inferred` (with evidence count and examples) or
     `confirmed` (the user said so or corrected ROLLY). Corrections apply immediately in the running session and persist.
   - Pass the current preference into the system prompt each session, with instructions on how to speak in each state.
4. **Personalised, proactive opening** from memory (the research opener logic is the starting point), in the user's
   language; Hebrew and English conversations, including mid-conversation switching.
5. **Interruption and natural turn-taking**: reuse the pod's behaviour; on the phone, playback must stop within the same
   order of time as the tester (the server detects interruptions in about 230 ms; the client must flush immediately).
6. **Summaries and progress**: after each session, summary and extracted items as today, plus a short "what we moved
   forward" record. A lightweight **Progress** screen and a **Personalisation** screen (what ROLLY remembers, editable;
   addressing preference; language; placeholders for future connected services).
7. **Bluetooth car audio and locked phone**: Bluetooth hands-free microphone input where the car supports it, playback
   through the car speakers, full-duplex audio with barge-in, conversation continues with the phone locked, sensible
   behaviour on Bluetooth disconnect/reconnect, incoming calls and other audio-session interruptions (pause, then
   recover cleanly). Investigate the iOS requirements yourself and document them: `AVAudioSession` category
   `playAndRecord`, mode `voiceChat` (hardware echo cancellation via voice processing), options `allowBluetooth`
   (hands-free profile) and related, `UIBackgroundModes: audio`, interruption and route-change notifications. Expect to
   write a small native module (Swift, Expo Modules API, config plugin) or adopt a maintained library; justify the choice.
   Hands-free Bluetooth limits the microphone to 16 kHz wideband at best, which matches the pipeline's 16 kHz input.
8. **Additional voices, one primary user** (see §5).

UI: voice-first and almost headless. Three areas only: **Conversation** (a large start/stop control and state, optional
captions for debugging), **Progress**, **Personalisation** (incl. connected services placeholder). No chat-style
interface, no dashboards, minimal navigation. Hebrew right-to-left layout must be correct.

Accounts: the primary user is the authenticated account owner. Choose the simplest secure method that works on a physical
iPhone for a handful of testers (for example email magic link or Sign in with Apple) and justify it; no multi-user
sessions.

Out of scope for Phase 1: travel detection, notifications that start sessions, CarPlay and Android Auto interfaces,
Gmail/calendar/Spotify/YouTube integrations, learning journeys, background agents, external task execution, speaker
diarization, voice biometrics. Keep the design open to them; do not build them.

## 5. Single primary user, other voices present: policy

Without diarization or voice identification ROLLY **cannot** reliably tell who is speaking. Do not claim otherwise
anywhere (code comments, UI, reports).

Conversation behaviour:
- Do not assume every utterance comes from the primary user. If someone else speaks, ROLLY may answer conversationally
  when it makes sense. If it is unclear whether a remark was meant for ROLLY, it may ask a short, natural clarification.
- Do not end or interrupt a session because another voice may be present. Do not try to identify passengers by gender,
  name or voice. No participant-management UI.

Memory protection (the important part):
- Treat speaker attribution as **uncertain** by default. Persist to the primary user's long-term profile only what is
  reliably theirs: statements made in clear first person in a one-to-one context, information the user confirmed, and
  corrections the user made.
- Statements that would change identity, preferences, goals or personal facts and whose speaker is uncertain are stored,
  if at all, as **unconfirmed candidates** (not used as facts in prompts), and ROLLY asks the user to confirm when it is
  natural to do so, in neutral phrasing until the addressing preference is known ("רק לוודא — לשמור את זה בזיכרון?"). Unconfirmed candidates expire.
- The summariser must be told that the transcript may contain other people, must attribute cautiously, and must output
  per-item confidence and provenance. Store provenance with every memory (session, quote, confidence, confirmed or not).
- Do not keep information about passengers beyond what the session summary needs.
- Signals available today, usable only as weak hints for asking a clarification, never as identification: per-utterance
  `level_db` and the session's `ref_level_db` in `user.transcript` events (a much quieter voice is less likely to be the
  phone's owner), `barge_in`, and the language of the utterance.
- Grammatical-addressing evidence from uncertain utterances must not change the stored addressing preference.

## 6. Data model (starting point; refine in your plan)

`users` (account), `profiles` (preferred name, languages, addressing preference + status + evidence, interests, travel-time
goals), `memories` (type, content, status `candidate|active|deleted`, confidence, provenance, source session, created/updated,
expires_at for candidates), `sessions` (start/end, language, provider/pipeline description, summary JSON, stats),
`turns` (role, text, language, timestamps, speaker attribution flag `primary|uncertain`), `progress_items` (goal links,
what moved forward). Raw audio is **not** stored. Transcript retention: keep the research default of 30 days unless the
owner decides otherwise. Provide account deletion and memory export.

## 7. Build order (smallest vertical slice first)

1. **Backend relay with a fixed test user**: `rolly-api` locally → pod `/v1/session` → a Node test client streaming a WAV
   file and saving the agent audio; prove a full Hebrew turn and an interruption. Reuse the research's synthetic speech
   (`benchmarks/synth.py`) or recordings.
2. **Postgres + memory + prompt builder + summariser**, with the persona ported. Two sessions in a row show continuity.
3. **Expo dev build on a physical iPhone**: capture/playback with the native audio session, WebSocket to the local or
   deployed `rolly-api`, start/stop, interruption flush. Then locked-screen continuation.
4. **Deploy `rolly-api` and Postgres on Render** (after cost approval); the phone talks to the deployed backend.
5. **Onboarding conversation, addressing model, memory policy, correction/deletion by voice and in the app.**
6. **Progress and Personalisation screens.**
7. **Bluetooth and vehicle**: parked car first (connect, locked phone, disconnect/reconnect, incoming call), then a short
   supervised drive only if the owner agrees.

Test real integrations, not only mocks: every step ends with an end-to-end run against the real pod. Add automated tests
for the relay protocol, the memory policy (uncertain speaker → candidate, confirmation → active, correction, deletion) and
the addressing state machine. Keep the research test suite green.

## 8. Measurements to report

Per build: reply latency on the phone (end of user speech → first audible agent audio) over Wi-Fi and over mobile data,
interruption stop time on the phone, session stability over 30 minutes with the screen locked, reconnect behaviour, and
Bluetooth route changes. Use the tester's telemetry ideas (`client.playback` events) and store measurements in the
repository (`docs/` or `benchmarks/results/`). State clearly what is measured, estimated or untested.

## 9. Things that need the owner (ask early, keep working on the rest)

For each request give: what, why, setup steps, cost, time, alternatives, security implications, and whether work can
continue meanwhile.
- Apple Developer Program membership and the team ID for EAS development builds on a physical iPhone; the iPhone's UDID
  registration; an Expo account for EAS.
- Approval and plan choice for the new Render web service and Render PostgreSQL (both paid).
- RunPod balance top-up (about $36 left on 2026-11-25), and pausing the night schedule before any evening or night test.
- Any change to the research branch or the GPU pod.
- The authentication method if it needs a paid service or an Apple capability.
- Any cost beyond the approved budget. The project's rule: no financial commitment without explicit authorisation.

## 10. Phase 1 acceptance criteria

Phase 1 is complete only when all of these are demonstrated and reported with evidence:

1. ROLLY runs on a physical iPhone (EAS development build).
2. The app connects to the Render backend and, through it, to the RunPod inference service.
3. PostgreSQL persists sessions, memories, goals and progress.
4. ROLLY opens the first conversation naturally (voice-first onboarding).
5. ROLLY learns the user's name and travel-time goals.
6. Hebrew grammatical addressing adapts to reliable conversational evidence; neutral phrasing before that; corrections
   apply immediately.
7. The user can interrupt and redirect the conversation.
8. Active voice sessions work through vehicle Bluetooth while the phone is locked.
9. A following session shows meaningful continuity.
10. The user can review progress and correct or delete remembered information.
11. Additional voices do not automatically contaminate the primary user's persistent profile.
12. Uncertain speaker attribution is handled conservatively (candidates, confirmation).
13. The existing voice tester at `rolly-voice.onrender.com` still works (its `/api/selftest` passes).

Do not claim speaker identification. Do not claim a criterion is met without having run it; say what was tested, how, and
what failed.

## 11. Working rules

- Never commit or print secrets; the repository is public. Secrets live in Render environment variables and in this
  environment's network secrets (`RESEARCH_HANDOFF.md` §8 lists names and places). Mobile builds contain no inference or
  API keys.
- No raw user audio stored by default.
- Reuse working components; avoid refactors and file moves of the research code; no premature optimisation.
- Keep `PROGRESS.md`-style notes for Phase 1 in `docs/PHASE1_PROGRESS.md`, decisions in `docs/PHASE1_DECISIONS.md`
  (numbered), blockers in `docs/PHASE1_BLOCKERS.md`.
- Commit in small steps with clear messages; push only to your Phase 1 branch.
- Report blockers and limitations plainly. When Phase 1 meets the criteria, write `docs/PHASE1_REPORT.md` (what works,
  measurements, limitations, costs incurred, what Phase 2 needs) and **stop for explicit approval**. Phase 2 (travel
  detection, proactive invitations that never open the microphone or speak without the user's acceptance) and Phase 3
  (integrations, content, learning journeys, background agents) are not to be started.
