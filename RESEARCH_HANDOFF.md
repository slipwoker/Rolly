# ROLLY — Research handoff (state on 2026-11-25)

> **Snapshot.** Written on 2026-11-25 and not updated since. Closeout and later changes: `docs/RESEARCH_CLOSEOUT.md`.
> Known differences today: `render.yaml` and the pod follow `main`, not the research branch; the persona and memory now live in
> `apps/api` (this document's "no accounts / no PostgreSQL" is no longer true); the browser tester is retired.

This document is the factual starting point for product implementation. It describes what exists, what runs where,
what was measured and what is known to be weak. No credentials are recorded here; where a secret exists, only its
**name** and **where it lives** are given.

Companion documents in this repository (read in this order): `FINAL_REPORT.md` (conclusions), `BENCHMARKS.md`
(all measurements, sections 0.1-0.11 are the latest), `DECISIONS.md` (D1-D23), `BLOCKERS.md`, `COSTS.md`,
`LICENSES.md`, `PROGRESS.md`, `docs/ARCHITECTURE.md`, `infrastructure/GPU_RUNBOOK.md`.

---

## 1. Git baseline

| Item | Value |
|---|---|
| Repository | `slipwoker/Rolly` (GitHub, **public**) |
| Research branch | `claude/adoring-goodall-es5zzm` — **production follows this branch** (Render auto-deploys from it; the GPU pod `git pull`s it) |
| Baseline | the commit where `rolly-phase1` starts (`git merge-base origin/rolly-phase1 origin/claude/adoring-goodall-es5zzm`). A tag `research-baseline-2026-11-25` could not be pushed from the research session (the session's git proxy refuses tag pushes); the owner can create it on GitHub |
| Product branch | `rolly-phase1`, created at the baseline. All Phase 1 work happens there or on branches cut from it |

Consequence: anything pushed to the research branch can restart the live voice tester (Render) or change the GPU pod
(`infrastructure/pod_job.sh` is re-run by the pod whenever its content changes on that branch). Product work must not be
pushed to the research branch without the owner's approval.

## 2. What runs where

```
 Browser voice tester ──WSS──► Render: rolly-voice (Python, FastAPI)  ──WSS /v1/session──► RunPod pod (L40S)
                               sessions, memory (SQLite), telemetry       bearer token         whole voice pipeline
                               OpenAI-based agents (B, D)                                      + vLLM language model
```

### 2.1 Render — `rolly-voice` (the existing voice tester)

| Item | Value |
|---|---|
| URL | https://rolly-voice.onrender.com (all pages and APIs need the access token: `?token=` or `Authorization: Bearer`) |
| Render workspace / project | "Zappy's workspace" → project **Rolly** → environment **Production** (the workspace has many unrelated services: do not touch them) |
| Service | web service `rolly-voice`, id `srv-dc37phe8bjmc73esf23g`, plan Standard, region Frankfurt, Docker (`Dockerfile.render`) |
| Blueprint | `render.yaml` (Blueprint id `exs-dc37oos0916s7380lhf0`, auto-sync on) |
| Deploys | automatic on push to the research branch; Markdown, `docs/`, `tests/`, `infrastructure/`, `benchmarks/results/`, `reports/` are ignored by the build filter |
| Storage | 1 GB disk at `/var/data` → SQLite `rolly.sqlite3` (users, memories, sessions, turns, events, ratings) |
| Provider file | `config/providers.render.yaml` |
| Environment variable **names** | `OPENAI_API_KEY`, `ROLLY_ACCESS_TOKEN`, `ROLLY_ADMIN_TOKEN`, `ROLLY_BLIND_SALT`, `ROLLY_GPU_WORKER_URL`, `ROLLY_GPU_HEALTH_URL`, `ROLLY_GPU_LLM_URL` (no longer used), `ROLLY_GPU_API_KEY`, `ROLLY_UTILITY_LLM_BASE_URL`, `ROLLY_UTILITY_LLM_MODEL` (=`gpt-6-luna`), `ROLLY_UTILITY_LLM_KEY_ENV`, `ROLLY_UTILITY_LLM_TOKEN_PARAM`, `ROLLY_UTILITY_LLM_REASONING`, `ROLLY_TRANSCRIPT_RETENTION_DAYS` |
| Cost | about $25/month + disk |

Agents in the tester (blind labels are stable for the current salt):

| Label | Provider id | What it is |
|---|---|---|
| A | `selfhosted-gpu` | type `remote`: relays the session to the GPU pod's `/v1/session`; the whole pipeline runs on the pod |
| B | `hybrid-api` | OpenAI transcription (`gpt-transcribe`) + `gpt-6-luna` (reasoning off) + open voices on Render's CPU |
| C | `mock` | test tone, plumbing only |
| D | `openai-realtime` | OpenAI Realtime `gpt-realtime-2.1`, server VAD 500 ms |

HTTP API of the tester (`backend/app/main.py`): `GET /healthz` (public), `/api/providers`, `/api/users[/{id}]` (GET/PUT/DELETE),
`/api/users/{id}/context`, `POST /api/journey/start`, `/api/sessions`, `/api/sessions/{id}?events=1` (admin: raw timing
events), `/api/telemetry/summary`, `/api/eval/plan`, `POST /api/ratings`, `/api/ratings/export` (admin),
`POST /api/selftest` + `GET /api/selftest/{id}` (admin: scripted conversations run by the server against itself),
`WS /ws` (voice session).

Browser ↔ tester WebSocket protocol (`backend/app/session.py`, header comment):
- client → server: text `{"type":"session.start", provider, user_id, language, journey{duration_min,...}, proactive, options, tag}`;
  binary PCM16 mono 16 kHz, 20 ms frames; text `interrupt`, `text`, `event`, `ping`, `client.playback`, `session.end`.
- server → client: `session.created` (input 16 kHz, output 24 kHz), binary `[4-byte seq][PCM16 24 kHz]`, JSON events
  `user.speech_started/stopped`, `user.transcript`, `agent.turn_started`, `agent.text`, `agent.turn_done`,
  `agent.interrupted`, `turn.latency`, `pong`, `error`, `session.summary`, `session.closed`.

### 2.2 RunPod — GPU pod `rolly-gpu-backend`

| Item | Value |
|---|---|
| Pod id | `gn48mxl9lsf1nv`, 1 × NVIDIA L40S (46 GB usable), data centre EUR-IS-2 (Iceland), secure cloud, **$1.09/h** |
| Image | `nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04`; container disk 60 GB; volume 80 GB at `/workspace` (models, venvs, builds persist) |
| Ports | 8000/http worker (bearer token), 8081/http vLLM (bearer token), 8001/http public status and logs (no secrets), 22/tcp |
| Start command | clones the research branch into `/workspace/Rolly` and runs `infrastructure/pod_autorun.sh` (no SSH is used) |
| Pod environment variable **names** | `ROLLY_WORKSPACE`, `ROLLY_POD_MODE=worker`, `ROLLY_GPU_API_KEY` (same value as on Render) |
| Follow-up changes without restart | `pod_autorun.sh` pulls the branch every 30 s and re-runs `infrastructure/pod_job.sh` when that file changes |
| Status | `https://gn48mxl9lsf1nv-8001.proxy.runpod.net/status.json`, `blue.json`, `job.log`, `worker.tail.log`, `gpu.txt` |
| **Night schedule** | two scheduled Claude Code tasks in the owner's account: stop at 21:04 and start at 06:13 Israel time (`GPU_RUNBOOK.md` §8). The self-hosted agent is unavailable at night |
| Account balance | **about $36 on 2026-11-25** — RunPod removes pods when the balance runs out; must be topped up before longer work |
| Control | RunPod GraphQL API `https://api.runpod.io/graphql` (key saved as a network secret of the Claude Code environment; `rest.runpod.io` is not reachable through the session proxy) |

Services on the pod:

| Service | Address | What |
|---|---|---|
| vLLM | :8081 | `RedHatAI/gemma-4-26B-A4B-it-FP8-dynamic`, OpenAI-compatible, prefix caching |
| GPU worker | :8000 (`backend/gpu_worker.py`) | runs the `modular-selfhosted` pipeline of `config/providers.yaml` per session; started by `infrastructure/start_worker.sh` |
| BlueV3 voice server | 127.0.0.1:1920 | BlueTTS OpenAI-compatible server via `infrastructure/blue_serve.py` (all ONNX graphs on GPU); set up by `infrastructure/blue_setup.sh` |
| ZONOS3 server | stopped | built at `/workspace/zonos`; withdrawn (see §4) |

GPU worker API (all but `/healthz` need `Authorization: Bearer <ROLLY_GPU_API_KEY>`):
- `GET /healthz` — `{"ready": true, ...}`.
- `WS /v1/session` — one conversation (`providers/remote.py` documents the protocol):
  - caller → worker: text `{"type":"start","ctx":{session_id,user_id,language,system_prompt,opener_instruction,proactive,journey,profile,options}}`,
    then binary PCM16 mono 16 kHz, text `{"type":"text",...}` / `{"type":"interrupt"}` / `{"type":"close"}`;
  - worker → caller: `{"type":"ready","describe":{...}}`, then `{"type":"event","event":<name>,"data":{...}}` and binary audio
    frames `[4-byte big-endian header length][JSON {"event","data","sample_rate"}][PCM16]`. **Audio arrives at the voice's own
    rate** (BlueV3 44.1 kHz, Piper 22.05 kHz) and must be resampled by the caller.
  - Event names: `user.speech_started`, `user.speech_stopped`, `user.transcript` (with `language`, `level_db`, `ref_level_db`,
    `barge_in`, `near_agent`, `discarded`), `agent.turn_started`, `agent.text`, `agent.audio`, `agent.turn_done`,
    `agent.interrupted`, `metric`, `usage`, `session.end_requested`, `error`.
  - The caller provides the **system prompt and opener**; the worker holds no user data and no memory. This is the seam
    a new backend can use without changing the pod.
- `GET /v1/session/describe`, `POST /v1/audio/transcriptions`, `POST /v1/audio/speech`, `PUT|GET /v1/voices`.

## 3. The voice pipeline (self-hosted agent A)

| Stage | Model / setting | Where | Notes |
|---|---|---|---|
| Endpointing | Silero VAD, 32 ms windows; endpoint 544 ms of silence, speculative start at 256 ms | worker CPU | `providers/modular/vad.py` |
| Interruption | needs 192 ms of speech, probability ≥ 0.65, **and** loudness within 10 dB of the user's own level (floor −38 dBFS) while the agent is audible, for 500 ms after it stops; fragments that echo the agent's own words or are short and unclear are discarded and the agent says the rest of its sentence again; "רגע/stop/wait" always interrupt | worker | D21, `BENCHMARKS.md` §0.9 |
| Speech-to-text | Hebrew `ivrit-ai/whisper-large-v3-turbo-ct2`, English `deepdml/faster-whisper-large-v3-turbo-ct2`, float16, routed per session language; "mixed" detects he/en then routes | GPU | noise transcripts (repeated characters, impossible length) discarded |
| Language model | Gemma-4 26B A4B FP8 on vLLM, max 120 tokens, temperature 0.6; history compacted in blocks with a running synopsis | GPU | D15 |
| Chunking | first chunk at a clause boundary (≥ 24 chars), then sentences | worker | `providers/modular/text.py` |
| Hebrew voice | **BlueV3 v3.0.1, built-in voice `daniel`, speed 1.2**, float32, 44.1 kHz; fallback Piper `he_IL-noa-medium` + ReNikud | GPU | chosen by the owner from listening reels, D23 |
| English voice | Piper `en_US-lessac-medium` (CPU) | worker CPU | not yet reviewed by listeners |
| Persona | "close friend in the car", spoken colloquial Hebrew, one short sentence per turn, no menus | `memory/context.py` (`VOICE_STYLE`, `LANG`) | rewritten after team feedback |

Memory today (`memory/store.py`, `memory/context.py`, `memory/summarizer.py`): per user a JSON profile and typed memories
(`summary`, `open_topic`, `action_item`, `fact`, `goal`, `preference`); after a session the utility LLM (`gpt-6-luna`)
returns JSON (`summary`, `topics`, `decisions`, `action_items`, `unresolved_topics`, `resolved_topics`, `new_user_facts`,
`suggested_next_opener`) which is stored; the next session's system prompt includes the profile, the last three summaries,
open topics and action items, and a proactive opener instruction. Two synthetic profiles (`noa`, `daniel`) are seeded from
`memory/seed_profiles.json`. There are **no accounts, no authentication per user, no addressing (grammatical gender) model,
no speaker attribution, and no PostgreSQL** today.

## 4. Speech synthesis: what was tried

| Voice | Result | Status |
|---|---|---|
| Piper `he_IL-noa` + ReNikud | intelligible, judged robotic, flat, heavily accented | fallback only |
| OpenAI `gpt-4o-mini-tts` | Hebrew at 8-12 characters/s ("word by word"), speed setting ignored, 0.65-1.3 s to start | withdrawn |
| **ZONOS3-Mini** (cloned voice) | in live use it cut sentence endings (5 of 12 test utterances ended mid-sound), ran sentences together, pace 7.7-20.4 chars/s | **withdrawn on 2026-11-25** (BENCHMARKS §0.10). Code remains (`providers/modular/tts_zonos.py`, `infrastructure/zonos_setup.sh`) |
| **BlueV3** (`daniel`, speed 1.2) | deployed path: 24/24 clean endings, last word recognised 24/24, < 0.1 s per sentence on the L40S | **live** |
| Inworld TTS-2 / TTS-2 Flash (commercial) | 12/12 clean endings, 0-1 word errors, 88-151 ms to first audio; five native Hebrew voices | tested only; commercial fallback (key saved as a network secret for `api.inworld.ai`) |

Rule adopted: a voice goes live only after the 12-sentence ending test on the deployed path, and the pod setup refuses a
voice slower than 0.45 s per sentence.

## 5. Measured performance (latest)

| Measurement | Value | Source |
|---|---|---|
| Self-hosted, everything on one L40S (Piper voice), 56 turns | 681 ms median, 1,072 ms P95 | §0.1 |
| Hosted: Render relays to the pod, BlueV3, Hebrew | 828 ms median, 1,168 ms max (10 replies); English 846 ms | §0.11 |
| Concurrency on one L40S (Piper on CPU) | up to 35 conversations within 1.5 s P95, 0 failed turns at 50 | §0.3 |
| Interruption detected (server) | about 230 ms | self-tests |
| OpenAI Realtime 2.1 baseline | 1.6-2.0 s median; about $0.07 per connected minute | §0.1, §0.6 |
| Cost, fully self-hosted, 10,000 daily users × 30 min | about $37.7k-$42.9k/month all-in, half of it assumed staff | `COSTS.md` |

All latency figures are from scripted synthetic users next to the server; a phone on a mobile network and Bluetooth add
delay that has not been measured.

## 6. Known limitations and open risks

1. **No real users yet beyond three team members**, no scored human evaluation; Hebrew naturalness of BlueV3 in
   conversation has not been judged after deployment.
2. **BlueV3 server synthesises one request at a time**: concurrency was not measured with it; several sessions will queue.
3. **BlueV3 training-data provenance is undocumented** (single-author release); ask before commercial use. Decoder is
   OpenRAIL-M.
4. **No speaker identification**: the pipeline cannot tell who is speaking. It logs per-utterance loudness and a learned
   reference level (`level_db`, `ref_level_db`), a weak hint only. A second person as loud as the user is treated as the user.
5. **Echo**: handled server-side for laptops; on a phone with Bluetooth in a car it is untested. Echo cancellation on the
   device is required.
6. **Transport**: raw PCM over WebSocket (≈ 256 kbit/s up) works on Wi-Fi; mobile networks, tunnels and reconnects untested.
7. **Night schedule and balance**: the GPU is off 21:04-06:13 Israel time; the RunPod balance was about $36.
8. **Single pod, single region** (Iceland; app tier in Frankfurt). No redundancy.
9. **Hebrew numbers, dates and mixed Hebrew-English sentences** were not tested with BlueV3.
10. The language model occasionally misreads Hebrew number words (FP8 Gemma, §0.5).
11. The tester's access model (one shared token) is for testing only.

## 7. Reusable pieces for the product

| Piece | Reuse |
|---|---|
| GPU worker `/v1/session` | the product's backend can relay a phone's audio to it unchanged, supplying the system prompt from its own database |
| `providers/remote.py` | reference implementation of that relay (Python) |
| `memory/context.py` | persona (`VOICE_STYLE`), language rules (`LANG`), opener instruction — port or share, do not fork silently |
| `memory/summarizer.py` | summary JSON schema and prompt |
| `benchmarks/client.py`, `/api/selftest` | scripted conversations, including simulated loudspeaker echo (`--echo-gain`) |
| `frontend/voice.js`, `worklets.js` | reference client: 16 kHz capture, 20 ms frames, instant flush on interruption, playback telemetry |
| `tests/` | 21 tests (`.venv/bin/python -m pytest -q tests`) |

## 8. Secrets: names and locations only

| Secret | Where it lives |
|---|---|
| `OPENAI_API_KEY` | Render `rolly-voice` environment; network secret of the Claude Code environment for `api.openai.com` |
| `ROLLY_GPU_API_KEY` | Render `rolly-voice` environment and RunPod pod environment (same value) |
| `ROLLY_ACCESS_TOKEN`, `ROLLY_ADMIN_TOKEN`, `ROLLY_BLIND_SALT` | Render `rolly-voice` environment (generated) |
| RunPod API key | network secret of the Claude Code environment for `api.runpod.io` / `rest.runpod.io` |
| Inworld API key | network secret of the Claude Code environment for `api.inworld.ai` |
| Tester admin token | network secret of the Claude Code environment for `rolly-voice.onrender.com` |
| Cloned-voice files | `/workspace/voices` on the pod only; never in the repository |

The repository is public: never commit any of these values.
