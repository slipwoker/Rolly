# ROLLY Phase 1 — blockers and requests to the owner

Each item: what, why, setup, cost, time, alternatives, security, whether work continues.

## B1. Four secrets on `rolly-api` (owner, open since 2026-11-25 16:00 UTC)
- **What**: in Render → rolly-api → Environment set `DATABASE_URL` (Internal Database URL of `rolly-api-db`),
  `ROLLY_GPU_API_KEY` and `OPENAI_API_KEY` (copy from `rolly-voice`), `ROLLY_ADMIN_TOKEN` (new random value; the same value
  was entered in this environment's network-secret form for `rolly-api.onrender.com`).
- **Why**: without them the service only answers `/healthz` (`configured: false`). Real-pod end-to-end tests run on the server.
- **Cost/time**: none / 3 minutes. **Security**: values never pass through the Claude session or the repository.
- **Work continues**: yes (everything else is tested against a fake pod and local PostgreSQL).

## B2. Apple Developer Program, iPhone registration, Expo account (owner) — needed for acceptance criterion 1
- **What**: (1) Apple Developer Program membership (individual or organisation) and its **Team ID**; (2) the iPhone's UDID
  registered for ad-hoc/internal distribution (EAS does this: `eas device:create` gives a link to open on the phone);
  (3) an Expo account (free) with EAS; (4) confirm or choose the bundle identifier (placeholder `com.zappy.rolly`).
- **Why**: native audio needs an EAS **development build**; Expo Go cannot load the Swift module.
- **Setup**: `cd apps/mobile && npx eas login && npx eas build:configure && npx eas device:create && npm run build:dev`;
  install from the EAS link; `npx expo start --dev-client`. iPhone: Settings → Privacy & Security → Developer Mode on.
- **Cost**: Apple $99/year; EAS free tier includes a monthly quota of builds (paid plans if more are needed).
- **Time**: Apple enrolment from minutes (individual) to days (organisation, D-U-N-S); first build ~20 min.
- **Alternatives**: a Mac with Xcode and a free Apple ID can sideload a 7-day development build (`npx expo run:ios --device`).
- **Security**: Apple credentials stay with EAS/the owner; the app contains no API keys.
- **Work continues**: yes, but criteria 1, 2 (from the phone), 7 and 8 cannot be demonstrated without it.

## B1b. Enrollment key (owner, once)
- Generate one random value and set it on Render (`ROLLY_ENROLLMENT_KEY`) and on the build machine / EAS
  (`EXPO_PUBLIC_ROLLY_ENROLLMENT_KEY`), see `docs/PHASE1_IPHONE_SETUP.md` §2b. Without it the app cannot register itself.

## B3. Swift module not compiled yet (engineering)
- No macOS/Xcode in this environment. `expo prebuild` succeeds and autolinks `rolly-audio`; the first EAS build is the first
  compile. Expect a fix-up round.

## B4. RunPod balance (owner)
- $36.17 on 2026-11-25 17:30 IST, spending $1.11/h ⇒ ~32 pod-hours ≈ 2 days with the night schedule. RunPod removes pods
  when the balance runs out. **Top-up needed before phone/vehicle testing.**

## B5. Night schedule (owner)
- Pod off 21:04-06:13 Israel time. Evening phone or car tests need the "stop for the night" task paused for that evening.

## B6. Sandbox network (engineering, worked around)
- The Claude environment's egress proxy does not pass WebSocket upgrades (pod `/v1/session` answered HTTP 404 through it).
  Worked around with the server-side self-test (P1-D12). The phone is unaffected.

## B7. Vehicle tests (owner)
- Parked-car Bluetooth tests (connect, locked phone, disconnect/reconnect, incoming call) and any supervised drive need the
  owner with the phone and car. A drive only with the owner's explicit agreement.
