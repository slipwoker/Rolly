# Security and retention (production path)

Production path: phone app (`apps/mobile`) → `rolly-api` on Render (Fastify + PostgreSQL, `apps/api`, `render.api.yaml`) → GPU worker on
RunPod (`backend/gpu_worker.py`, `infrastructure/*.sh`). The research tester under `backend/app/` is not covered here.
Decisions: P1-D40 in `docs/PHASE1_DECISIONS.md`. The published policy is `apps/site/legal/privacy.{he,en}.html`; this file
documents what makes its security and retention statements true. Facts about Render were read from render.com/docs on
2026-11-26; recheck them if the plan changes.

## Secrets

| Secret | Where it lives | What it protects |
|---|---|---|
| `ROLLY_INTEGRATIONS_KEY` | rolly-api environment only (`sync: false`), never in the database | seals stored Google refresh tokens (AES-256-GCM, key via HKDF-SHA256). **Required in production**: the service refuses to start without it. |
| auth HMAC secret | `ROLLY_AUTH_SECRET` if set; otherwise generated once and stored in `app_secrets` | access tokens (15 min) and the OAuth `state` |
| `ROLLY_GPU_API_KEY` | rolly-api environment and the RunPod pod's environment | the GPU worker and vLLM. **Required**: without it the worker refuses every request except `/healthz`, and the pod scripts refuse to start the worker |
| `ROLLY_ADMIN_TOKEN` | rolly-api environment | backoffice and admin endpoints; failed attempts are rate-limited (10 per address and 100 overall per 15 minutes) |
| `OPENAI_API_KEY`, `GOOGLE_CLIENT_*`, `SPOTIFY_CLIENT_*`, `ROLLY_ENROLLMENT_KEY` | rolly-api environment | outside services and device enrollment |

### Setting `ROLLY_INTEGRATIONS_KEY` on Render (before deploying P1-D40)

1. Generate a key on your own machine (do not paste it in chat, a ticket or the repository):

   ```bash
   openssl rand -base64 32
   ```

2. Render dashboard → project **Rolly** → **rolly-api** → **Environment** → **Add environment variable**: key `ROLLY_INTEGRATIONS_KEY`, the
   value from step 1. Choose **Save only** (no deploy yet), or **Save and deploy** if this change is already on `main`.
3. Keep a copy in the team's password manager. **If the key is lost, the stored Google connections cannot be opened** and each user
   has to connect Google again (nothing else is affected).
4. Deploy. At start-up the service re-seals every token written before P1-D40 under the new key, and logs
   `stored tokens re-sealed under the integrations key: N, unreadable: M`. A token an older instance writes during the deploy
   is re-sealed the first time it is read.

If the variable is missing, the new deploy fails at start-up (`ROLLY_INTEGRATIONS_KEY must be set in production`) and Render keeps
the previous instance running. The key must be at least 32 characters and must differ from the auth secret.

**Rotating the key** is not automated yet. Today it means asking users to reconnect Google: set a new key, then delete the
`integrations` rows (a row the new key cannot open reads as "not connected" but stays until deleted). A two-key rotation (`ROLLY_INTEGRATIONS_KEY_OLD`) can be added when needed.

**Backups made before the re-sealing** still hold tokens sealed with the old key, next to the auth secret in `app_secrets`. They age
out with the backup window below (at most 7 days). For a clean cut, disconnect and reconnect Google after that window, or revoke the
app's access in the Google account.

## What is not written to logs

- **rolly-api request logs** keep the method, the path, the *names* of query parameters (values replaced by `~`), the host and the
  client address. The Google OAuth callback's `code` and `state` never reach the log. The 404 handler does not echo the full URL.
  No headers, no client port. (`apps/api/src/server.ts`, `redactUrl` / `loggerOptions`.)
- The voice WebSocket's single-use `ticket` is in its URL, but upgrades are not logged by Fastify.
- **Render's own HTTP request logs** (Pro plans and above) record the requested URL. Render's docs do not say whether the query string is
  kept. The exposure is small: the OAuth `code` is single-use, expires in minutes and needs the client secret, the `state` is signed and
  expires in 10 minutes, and a voice ticket expires in 60 s and is consumed on first use.
- **GPU worker**: the pinned name pronunciation is logged as a count, not the name. vLLM is started with `--disable-log-requests` and
  `VLLM_LOGGING_LEVEL=INFO`, so prompts (which carry the user's memory) are not logged. That is the default of recent vLLM versions,
  but older ones logged every prompt.
- **OpenAI**: both calls send `store: false`. That matters for the Responses API (web lookup), whose default is to store responses for 30
  days. The chat-completions default was already false. OpenAI still keeps API data in abuse-monitoring logs for up to 30 days unless the
  organisation has Zero Data Retention or Modified Abuse Monitoring (approval by OpenAI).

## Network exposure

- **rolly-api-db**: `render.api.yaml` declares `ipAllowList: []` (reachable only from Render's private network). **On 2026-11-26 the live
  database had `0.0.0.0/0` ("everyone") in its allow list**, so it is reachable from the internet (password and TLS are still required).
  This contradicts the blueprint and the policy's "the database is not exposed to the internet". Fix by hand: dashboard →
  `rolly-api-db` → **Networking/Access control** → remove the `0.0.0.0/0` entry (or sync the blueprint). `rolly-wa-db` already has an
  empty list.
- **GPU pod**: the worker on port 8000 always requires the bearer key. vLLM listens on `127.0.0.1:8081` by default, because the worker on
  the same pod is its only client. `ROLLY_VLLM_HOST=0.0.0.0` exposes it again through the pod's port 8081 (for
  `apps/api/scripts/style-eval.ts`), and the script then refuses to start it without the key.
- **Pod status port 8001** (`pod_autorun.sh`) is public and unauthenticated. It publishes tails of `worker.log`, `vllm.log`, `job.log` and
  setup output. With the changes above these carry no prompts or names, but treat anything added to those logs as public.

## Retention

| What | Where | Kept | Set by |
|---|---|---|---|
| Transcripts | rolly-api PostgreSQL | 30 days, then purged hourly | `ROLLY_TRANSCRIPT_RETENTION_DAYS` |
| Unconfirmed memory candidates | rolly-api PostgreSQL | 14 days | `ROLLY_CANDIDATE_TTL_DAYS` |
| Database backups: point-in-time recovery | Render (`rolly-api-db`, paid instance `basic-256mb`) | **3 days on a Hobby workspace, 7 days on Pro or higher** | Render workspace plan (not set in the repo) |
| Database backups: logical exports | Render | 7 days after creation, every plan | Render |
| Backups of a deleted database | Render | none: Render keeps no backup of a deleted instance | Render |
| rolly-api service logs | Render log explorer | **7 days (Hobby), 14 days (Pro), 30 days (Scale/Enterprise)** | Render workspace plan |
| GPU worker, vLLM and voice-server logs | RunPod volume, `/workspace/logs` | rotated daily, copies deleted after **7 days** (so at most 8 days of lines) | `infrastructure/log_retention.sh`, started by `start_worker.sh`; `ROLLY_LOG_KEEP_DAYS` |
| Name-reading cache | RunPod volume, `/workspace/pron_cache.json` | no expiry (the name word and how the voice reads it; no user id) | open point below |

Chosen retention: transcripts 30 days and candidates 14 days (as published). Backups and logs follow Render's plan, which the
policy covers ("for a limited period, per our hosting providers' policies"), and that is at most 7 days of backups and 30 days of logs
on any plan. The pod's own logs: 7 days.

**Check by hand** (not visible from the repository): the workspace plan in the Render dashboard (Settings → Plan). That plan sets the
backup window and log retention above. No log stream to a third party is configured; adding one would extend log retention and needs
an update to the policy's provider list.

**Proposed, not applied:** keep the workspace on a plan with 7-day point-in-time recovery, which is enough for this phase. Do not add
log streams. If deletions must reach backups faster, the only lever on Render is the plan's window.

## Open points

- `pron_cache.json` on the pod keeps names (no user link) with no expiry. Either key it by a hash of the name, or clear it with the log
  retention.
- `trustProxy: true` takes the client address from `X-Forwarded-For`, which a client can set, so per-address limits (enrollment, admin)
  can be sidestepped by varying it. The admin limit has an overall cap for this reason. Setting `trustProxy` to the exact number of
  Render proxy hops would fix it, but needs checking against Render first.
- The auth HMAC secret lives in the database unless `ROLLY_AUTH_SECRET` is set. With a copy of the database someone could mint access
  tokens. Setting `ROLLY_AUTH_SECRET` in the environment removes that, but it invalidates current access tokens (the apps refresh them
  on their own).
