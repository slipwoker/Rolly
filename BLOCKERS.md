# Blockers and requests for human intervention

Status on 2026-11-24 (end of session). The GPU and OpenAI baselines have been run. What still needs a person: evaluators (B3),
the Hebrew voice decision (B4), a Google key (B1) and a price re-check (B5).

## B1 — Commercial realtime baselines  ·  RESOLVED for OpenAI; OPEN for Google

2026-11-24: the OpenAI Realtime baseline was run from the rented GPU pod (this session's own network cannot open WebSockets), with
the owner's key set as an environment variable on the pod. Results are in `BENCHMARKS.md` section 0. The pod has been terminated,
which removed that variable; the key saved on the session environment (`api.openai.com`) remains until the owner removes it.

Still open: a Google Gemini API key for the Gemini Live baseline (bridge implemented, tested only against an emulator), and
30-minute sessions on the commercial APIs to measure how their cost grows with context. Estimated cost: $5–$20.

## B2 — GPU for latency and concurrency measurement  ·  RESOLVED

2026-11-24: the owner funded a RunPod account ($50), saved an API key, and made the repository public so a pod could clone it.
One L40S ran for 3 h 17 min ($3.58) and was terminated. Results: `BENCHMARKS.md` section 0. Scripts used:
`infrastructure/pod_setup.sh`, `pod_autorun.sh`, `pod_bench.sh`, `pod_bench2.sh`, `pod_bench5.sh`.

Housekeeping for the owner:
- The repository `slipwoker/Rolly` is still **public**; switch it back to private if that was only for the run.
- RunPod API keys are saved on the session environment for `api.runpod.io` and `rest.runpod.io` (the second host never worked through
  the proxy and can be deleted). Remove both in the environment settings if no further GPU runs are planned.
- The environment's network access was changed to unrestricted during the session.
- RunPod balance remaining: $46.42. No pods or volumes are left.

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
