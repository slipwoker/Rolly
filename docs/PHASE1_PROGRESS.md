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

**Not yet run (and why)**
- Real pod end to end through rolly-api: waiting for B1 (the sandbox cannot open WebSockets to the pod, B6).
- Anything on the iPhone: B2. Swift not compiled: B3.
- Measurements of brief §8: all on-phone numbers are **untested**.
