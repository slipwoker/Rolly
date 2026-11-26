# ROLLY Phase 1 — progress log

## 2026-11-25 (session 1)

**Baseline** (branch `claude/great-franklin-c07no6` = `origin/rolly-phase1` = `de63f33`):
- Research tests: `.venv/bin/python -m pytest -q tests` → **18 passed, 3 skipped** (the 3 VAD tests need downloaded models).
- `https://rolly-voice.onrender.com/healthz` → `{"ok":true,"ready":true}`.
- GPU pod `gn48mxl9lsf1nv` serving: Whisper he/en, BlueV3 `daniel` speed 1.2 (Hebrew), Piper lessac (English), `modular-selfhosted`.
- RunPod balance $36.17, $1.11/h.

**Built**
- npm workspaces: `packages/contracts` (voice protocol types), `apps/api`, `apps/mobile`. Python tree untouched.
- `apps/api`: relay (port of `providers/remote.py`), TS resampler, auth (pairing codes, device tokens, tickets), PostgreSQL
  schema + migrations, memory store, memory policy, addressing state machine, summariser (extended research prompt), live
  voice corrections, prompt builder with the persona copied verbatim, resume after a drop, HTTP API for the app, admin API,
  server-side self-test (`relay`, `memory` scenarios).
- `apps/mobile`: Expo SDK 58 + Router, pairing screen, Conversation / Progress / Personalisation, Hebrew RTL, Swift
  `rolly-audio` module, `VoiceController` (phone-side latency and flush measurement, audio-session events, reconnect).
- Render: `rolly-api` (Starter) and `rolly-api-db` (Basic-256MB) created after owner approval, moved by the owner into
  project Rolly. Deploys from this branch (~1 min). Waiting for four secrets (B1).

**Tested**
- `npm test -w @rolly/api`: 21 tests — resampler (amplitude, length, seams, aliasing), persona identical to Python,
  addressing (inference, contradiction, uncertain ignored, explicit confirm), relay against a protocol-identical fake pod
  (opener, reply, barge-in flush, 44.1 → 24 kHz, uncertain attribution of a −25 dB utterance, 401 without ticket), memory on
  PostgreSQL (candidate vs active, continuity in the next prompt, voice confirmation, uncertain confirmation rejected, live
  correction, uncertain correction rejected, voice addressing request, app deletion, export, account deletion, candidate
  expiry, auth chain).
- `npm test -w @rolly/mobile`: 5 tests — controller (mic gating, playback, reply time measured from capture time,
  flush + late-chunk drop, interruption pause/resume, route-change reporting, reconnect with `resume_of`, no reconnect after
  server close).
- `npx expo prebuild --platform ios`: OK, module autolinked, `UIBackgroundModes=audio`.

- Criterion 13 check: `POST rolly-voice.onrender.com/api/selftest` (selfhosted-gpu, default scenarios, job `b7911013ec`,
  ~16:01 UTC) → **7/7 checks, 0 scenarios failed**, 8 turns, reply latency median 811 ms (max 1,056), interruption
  detected 273 ms after onset, 0 playback underruns. The existing tester still works.

**Not yet run (and why)**
- Real pod end to end through rolly-api: waiting for B1 (the sandbox cannot open WebSockets to the pod, B6).
- Anything on the iPhone: B2. Swift not compiled: B3.
- Measurements of brief §8: all on-phone numbers are **untested**.

## 2026-11-26 (session 1, continued): memory, agenda and tasks without tools

Owner's request after the capability map: build everything missing in "memory and goals", "agenda and leading" and "tasks and ideas",
leaving tool connections (web search, Gmail, Calendar, Spotify/YouTube) and learning content for later. Decisions P1-D17..D22.

**Built** (branch restarted from `main` at `fe4d69a`, after PRs #1-#7):
- Goals with state and next step, look-ahead call after each conversation, plan for the next ride, pacing notes, spoken "time left".
- Pod note channel (separate commit, to be applied to the pod's branch after the owner merges).
- Tasks and ideas saved during the ride, done/reopen, Progress screen (goal cards, tick rows, ideas, share), home card shows the plan's first item.
- Forgetting in derived text; slimmer session rows; selection by score; digests; prompt budget.

**Tested here**
- `npm test -w @rolly/api`: 74 tests (was 28). `npm test -w @rolly/mobile`: 5. `pytest tests`: 23 passed, 3 skipped (was 20).
- Real utility model (`gpt-6-luna`), local PostgreSQL, no pod (`scripts/llm-check.ts`, three scripted Hebrew rides):
  one-to-one rides: goal state and next step advance on each ride, progress items linked to the goal, the accountant task saved
  live and ticked off on the next ride, plan carried over and marked done/touched/skipped, "forget what I said about the bank" →
  no mention left anywhere in the export; digests written. Durations: summary 2.1-4.6 s, look-ahead 1.8-3.8 s, live capture
  0.7-2.3 s, live forget ~1 s, scrub 1.7-2.4 s (all after or beside the conversation, none in the reply path).
  Found and fixed with the real model: duplicate task (full stop), note-taking counted as progress, the forgotten subject named
  in the new summary and in a stored topic label, second-person wording in plan topics. Seen once: the digest came back malformed
  (skipped, retried after the next ride).
  With a passenger line in the ride: everything stayed unconfirmed (see the open question in PHASE1_DECISIONS.md).

**Not yet run**
- Anything through the real pod: the note channel, pacing in a real conversation, the three new self-test scenarios
  (`goals`, `tasks`, `agenda` on `POST /v1/admin/selftest`). `rolly-api` deploys from `main`, so these run after the merge.
- Whether the conversation model actually follows the plan and the pacing notes: unknown until then.
- Opener latency with the longer prompt. The new Progress screen on a device.
