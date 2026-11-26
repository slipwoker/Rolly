# Where ROLLY's behaviour comes from

Verified against the code on 2026-11-26. Re-check function names if files have moved.

## Request path

```
phone (apps/mobile)  --session.start {language, journey, resume_of}-->  rolly-api (apps/api, Render, deploys from main)
  app.ts prepare():  store.memoryView(user)  ->  buildContext(view, ...)   [promptBuilder.ts]
                     -> PodSessionContext {system_prompt, opener_instruction, language, profile{name, preferred_language}}
rolly-api  --WS start{ctx}-->  GPU worker (backend/gpu_worker.py, RunPod)  ->  ModularPipeline (providers/modular/pipeline.py)
  per turn:  VAD -> Whisper (per language) -> _messages() -> vLLM Gemma-4 26B-A4B -> SentenceChunker -> TTS
rolly-api  <-- events/audio --  pod;   session end: summarizer.ts -> policy.ts -> store (PostgreSQL) -> next session's memoryView
```

The system prompt is fixed for the whole session: the pod cannot update it mid-session. In-session behaviour changes
come only from history and the per-turn note.

## What the conversation model receives

| Layer | Source | Scope |
|---|---|---|
| Identity + style (`VOICE_STYLE`, `LANG`, `END_MARKER`) | `apps/api/src/persona/research.ts` - verbatim copy of `memory/context.py`; `test/persona.test.ts` fails on drift | every session |
| Addressing (neutral / known gender) | `phase1Sections.ts addressingSection()`; state from `store.ts` addressing record (`addressing.ts` lexicon) | Hebrew / auto sessions |
| Other voices, memory control | `phase1Sections.ts OTHER_VOICES`, `MEMORY_CONTROL` | every session |
| Onboarding or "gaps" | `ONBOARDING` (sessionCount 0) or `onboardingGapsSection()` | first / later sessions |
| About the user, previous conversations, open topics, action items, progress, unconfirmed candidates | `buildContext()` from `memoryView()` (`store.ts`): up to 8 interests, 5 travel goals, 8 facts + 5 goals, 3 summaries, 6 open topics, 6 action items, 4 progress, 5 candidates, 6 preferences | every session, all of it (no relevance selection) |
| Current journey (local time, duration, route) | `buildContext()` | every session |
| Resume block (last 8 turns of a dropped session) | `app.ts prepare()` -> `buildContext({resume})` | after a drop |
| `LEAD` | `phase1Sections.ts`, deliberately **last** (recency for the small model, P1-D16) | every session |
| Opener instruction (4 variants: resume, onboarding, nothing known, returning) | `buildContext()`; sent as the first **user** message and kept in history | session start |
| Question-guard note | `providers/modular/text.py question_guard_note()`, appended in `pipeline.py _messages()` to the user message when ROLLY's previous reply ended with "?"; never stored | per turn, pod config `question_guard` (default on) |
| History | `pipeline.py _finalize_committed()`: user text + what was *heard* of the reply (cut replies end with " —"); compacted in blocks after `max_history_turns` (24) into a synopsis plus a canned assistant line "Understood, I remember that." | session |
| Sampling | `config/providers.yaml` `modular-selfhosted.llm`: `max_tokens: 120`, `temperature: 0.6`; model served by vLLM (`infrastructure/pod_setup.sh`, `--max-model-len 16384`, prefix caching) | pod |

Precedence in practice: the per-turn note (closest to generation) > `LEAD` (end of system prompt) > the rest of the
system prompt. Conflicts between these are resolved by position, not by intent.

## Outside the conversation model, but shaping what it sees

- `pipeline.py` end-marker gate: `<end_session/>` is honoured only if the user's words match `END_INTENT` (`text.py`).
- Echo / false-interruption handling (`text.py echo_like`, `vad.py`) decides which user turns exist at all.
- `session.ts attributionFor()`: turns much quieter/louder than the reference are `uncertain` (memory only; the
  model never sees attribution).
- `live.ts handleLiveTurn()`: "forget / that's wrong" and explicit addressing requests change stored memory during the
  session; the model follows them from history, not from an updated prompt.
- `summarizer.ts SUMMARY_PROMPT` (utility LLM `gpt-6-luna`) + `policy.ts decide()`: what becomes an active memory vs a
  candidate; this is the main input of the next session's prompt. `suggested_next_opener` is produced but unused.
- `he_pronounce()` in `text.py`: pronunciation fixes applied only to TTS input.

## Two prompt implementations

- Phase 1 (production): `apps/api/src/persona/*`.
- Research platform (`rolly-voice`, `backend/app/`, `benchmarks/`): `memory/context.py build_context()` - the same
  `VOICE_STYLE` but **none** of the Phase 1 sections. `benchmarks/llm_quality.py` and `benchmarks/run_scenarios.py`
  therefore evaluate a different prompt from production. Use `apps/api/eval/` for Phase 1 behaviour.

## How a change reaches production

- TypeScript in `apps/api` (prompt, memory): Render auto-deploys `rolly-api` from `main` (`render.api.yaml`).
- Python on the pod (`providers/modular/*`, `backend/gpu_worker.py`, `config/providers.yaml`): only after the pod's
  deployment branch has the change and the worker restarts (`infrastructure/pod_autorun.sh` pulls and re-runs
  `pod_job.sh` when it changes). P1-D16 records that this branch was `claude/adoring-goodall-es5zzm`. Pushing pod
  code to it is a production change: get the owner's explicit approval.
- Model or vLLM flags: `infrastructure/pod_setup.sh`; requires a vLLM restart.

## Tests that touch behaviour

- `apps/api/test/persona.test.ts`: research parity + string-presence assertions on `LEAD`/onboarding wording.
- `tests/test_text_and_memory.py`: question guard, pronunciation, end-intent.
- `apps/api/test/eval.test.ts`: eval checks and pod-mirror parity (no model calls).
- `apps/api/eval/`: the behavioural suite (model calls). `src/selftest/` measures latency/relay, not conversation quality.
