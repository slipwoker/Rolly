# Blockers and requests for human intervention

Status on 2026-11-24. Nothing below blocks the code or the CPU-side measurements already in the repository; each item
blocks the specific measurement named in "What it unblocks".

## B1 — API keys for the commercial realtime baselines  ·  OPEN

| | |
|---|---|
| What is required | An OpenAI API key with Realtime access and a Google Gemini API key (AI Studio) |
| Why | Architecture A is the quality baseline. Both bridges are implemented and pass tests against local protocol emulators, but they have never talked to the real services, so there is no measured latency, Hebrew quality or cost for them |
| Setup | OpenAI: platform.openai.com → API keys → create a project key; add at least $20 credit. Google: aistudio.google.com → Get API key. In a Claude cloud session the keys are entered through the secure credential form (never pasted in chat) for hosts `api.openai.com` and `generativelanguage.googleapis.com`. Locally: put `OPENAI_API_KEY` / `GEMINI_API_KEY` in `.env` |
| Expected cost | Scenario suite ×3 plus one 30-minute session per provider is roughly 60–90 conversational minutes each: about $5–$20 for `gpt-realtime-2.1`, $2–$5 for the mini, $2–$10 for Gemini Live (estimates from unverified token prices). Suggested cap: $60 total |
| Setup time | 10 minutes |
| Alternatives | Run only one provider; or skip the baseline and compare self-hosted configurations only (loses the "comparable to ChatGPT Voice" answer) |
| Security / licensing | User audio and the synthetic memory context are sent to the vendor. Benchmarks use synthetic profiles and synthetic speech only. Check that the model IDs in `config/providers.yaml` are available to the account (the IDs come from SDK inspection and were not confirmed on the vendors' pages) |
| Can work continue without it | Yes |

## B2 — GPU for latency and concurrency measurement  ·  OPEN (needs budget approval)

| | |
|---|---|
| What is required | One rented 48 GB GPU (NVIDIA L40S) for roughly 20–40 hours, with Docker or SSH and one public TCP port |
| Why | Every latency number in this repository was measured on a 4-vCPU container without a GPU, where a turn takes 5–10 s. The targets (median < 800 ms, P95 < 1.5 s), the maximum sustainable concurrency per GPU and therefore the self-hosted cost per minute cannot be measured without a GPU. The cost model currently uses assumed capacity |
| Setup | See `infrastructure/GPU_RUNBOOK.md`. Short version: create a RunPod account, load $50 credit, create an API key or just start one L40S pod from the PyTorch template with ports 8000/TCP and 22/TCP exposed, then run three commands |
| Expected cost | About $50 for 40 hours at ~$1.09/h (price unverified); $100–$200 with comparison runs on an L4 and an H100. Well inside the $300–$700 budget |
| Setup time | 20–30 minutes for a human; the benchmark suite then runs unattended in about 2 hours |
| Alternatives | Any provider with an L40S/A6000/A100 and SSH (Lambda, Hyperstack, Nebius; Nebius has an Israeli data centre). A 24 GB card (L4, RTX 4090) works with a smaller LLM. Modal per-second billing is an option if you prefer no idle cost |
| Security / licensing | The pod runs open-weight models only; no user data. Expose the port with `ROLLY_ACCESS_TOKEN` set. RunPod's HTTP proxy is unauthenticated and has a 100 s limit, so use the direct TCP port for the WebSocket |
| Can work continue without it | Yes, but research questions 1, 5 and 6 stay unanswered by measurement |

## B3 — Human evaluators for the blind test  ·  OPEN

| | |
|---|---|
| What is required | 5–10 evaluators, at least 5 native Hebrew speakers, about 20 minutes each, with a headset |
| Why | Naturalness, Hebrew quality, emotional appropriateness and willingness to use cannot be measured automatically. **No human evaluation has been performed and no scores exist** |
| Setup | Deploy the app behind HTTPS (browsers need it for the microphone), set `ROLLY_ACCESS_TOKEN`, share `https://<host>/eval.html?token=…`. Protocol and scoring are in `docs/HUMAN_EVALUATION.md`. Export with `/api/ratings/export?token=<admin>&fmt=csv` |
| Expected cost | Evaluator time; plus GPU hours and API usage during the sessions (about $10–$30) |
| Setup time | 1 hour to deploy; evaluation spread over 1–2 days |
| Alternatives | Fewer evaluators (results then indicative only) |
| Security / licensing | Evaluators speak into third-party APIs when a commercial provider is in the rotation; tell them. Use evaluator codes, not names |
| Can work continue without it | Yes |

## B4 — Approval to evaluate additional Hebrew TTS engines  ·  OPEN

| | |
|---|---|
| What is required | A yes/no on installing and running `blue-onnx` (BlueV3) and `ZONOS3-Mini` for a Hebrew TTS bake-off |
| Why | The POC's Hebrew voice (`piper-he-noa`) is commercially licensed and fast but is expected to sound read-aloud rather than conversational. BlueV3 (Hebrew-first, MIT + OpenRAIL-M vocoder) and ZONOS3-Mini (Apache-2.0, needs a GPU) are the stronger candidates. Installing `blue-onnx` was declined by an automated safety check because it is a two-week-old single-author package; I did not work around it |
| Setup | Reply with approval, or install it yourself in an isolated environment: `pip install blue-onnx` |
| Expected cost | None (ZONOS3-Mini needs the GPU from B2) |
| Alternatives | Use a commercial Hebrew TTS (Inworld TTS-2 Flash, Azure he-IL) for Hebrew and keep self-hosted TTS for English |
| Security / licensing | Supply-chain risk of a new package; BlueV3's training data is undocumented and its vocoder carries OpenRAIL-M use restrictions (`LICENSES.md`) |
| Can work continue without it | Yes |

## B5 — Vendor pricing pages could not be fetched  ·  OPEN (affects confidence, not execution)

GPU rental prices and OpenAI token prices in `config/pricing.yaml` come from search excerpts and third-party trackers because
the vendor pages were blocked by this environment's network policy. They are marked `unverified` and should be re-checked
by a human (10 minutes) or by allowing those hosts. The cost model is one command to re-run after editing the file.

## Resolved

| | |
|---|---|
| Hugging Face downloads blocked | Resolved 2026-11-24: owner approved adding the Hugging Face hosts to the environment's allowed list |
