---
name: rolly-agent-engineering
description: Required workflow for any change that can alter how ROLLY converses - the persona and prompt sections (apps/api/src/persona/), opener instructions, the pod's per-turn notes and message assembly (providers/modular/text.py, pipeline.py), memory selection and injection (memoryView, summarizer, live corrections, addressing), the conversation model or its sampling settings, and turn-taking logic that changes what the model sees. Also use when diagnosing a behaviour complaint ("ROLLY asks too many questions", "sounds robotic", "agrees with everything"), auditing prompt debt, or adding evaluation scenarios. Enforces diagnose-first, replace-before-adding, behavioural evaluation against a baseline, and a change report. Not for UI, infrastructure, auth, audio plumbing or backend work that does not change what reaches the conversation model.
---

# ROLLY agent engineering

ROLLY's behaviour is production software. It must get more intelligent and natural as it evolves, not more
constrained, scripted or mechanically compliant. This skill is the guard on that.

## When it applies

Use it before editing anything in the runtime path of the conversation model:

- `apps/api/src/persona/*` (identity, Phase 1 sections, prompt builder, openers)
- `providers/modular/text.py`, `providers/modular/pipeline.py` (per-turn notes, history, end-marker handling)
- `apps/api/src/memory/*` where it changes what is injected (`store.ts memoryView`, `summarizer.ts`, `live.ts`, `addressing.ts`, `policy.ts`)
- `config/providers.yaml` `llm` blocks, the vLLM model, `max_history_turns`, `question_guard`
- `memory/context.py` (research copy of the persona; parity-tested against `research.ts`)

Skip it for UI, mobile layout, auth, deployment, audio DSP and routine backend work, unless the change alters the
text the model receives or the turns it sees (e.g. echo handling that changes what lands in history does qualify).

Where behaviour actually comes from, in order, with file references: [references/runtime-map.md](references/runtime-map.md).
Read it before diagnosing; do not assume a single system prompt controls behaviour.

## Principles (mandatory)

1. **Minimal instructions.** A few high-level principles beat many rigid rules. A small model (the pod runs a
   ~4B-active MoE) follows a short, coherent prompt better than a long one full of exceptions.
2. **Behaviour over compliance.** Optimise for natural, context-aware conversation, not for adherence to scripts,
   quotas ("at most once"), or phrase lists.
3. **Replace before adding.** Never append an instruction until you have searched for every instruction on the same
   theme and decided to modify, merge or delete them instead. Net instruction count should usually not grow.
4. **Separation of concerns.** Stable identity, conversation strategy, session context, memory, task-specific
   instructions and safety constraints are different layers ([references/prompt-architecture.md](references/prompt-architecture.md)).
   Do not put per-user data in identity text or identity rules in memory blocks.
5. **Evidence-driven.** Find the actual source of the observed behaviour (transcript, assembled prompt, per-turn
   note, model, history) before changing anything. A hunch is a hypothesis, label it so.
6. **Regression awareness.** Every behavioural fix is checked for side effects on unrelated capabilities and for
   new rigidity, repetition or over-agreement.

## Workflow for every behavioural change

### A. Diagnose
- Reproduce: get the transcript (owner's test, `GET /v1/admin/...`, or an eval run). Note model, language, memory state.
- Rebuild what the model actually saw: system prompt from `buildContext` (`npm run eval -w @rolly/api -- --offline`
  shows sizes; `buildScenarioContext` in `eval/run.ts` gives the text), plus history and any per-turn note.
- Classify the source (several can apply): instructions; conflicting instructions; over-restrictive rule; per-turn
  note; orchestration (opener, history, compaction, interruption); memory selection/injection; missing information;
  model limitation or sampling config; speech pipeline (STT errors, VAD/turn-taking, TTS pronunciation).
- If it is not an instruction problem, do not fix it with an instruction.

### B. Inspect existing instructions
- `npm run prompt:stats -w @rolly/api` lists every theme governed in several places and near-duplicates.
- `grep -n` the theme across `apps/api/src/persona/`, `providers/modular/text.py`, openers in `promptBuilder.ts`.
- Write down: duplicates, contradictions, precedence (position in the prompt, per-turn note vs system prompt),
  and whether the desired behaviour is already specified but not followed (then the fix is not more text).

### C. Design the smallest effective change
Consider, in this order: delete or loosen a restriction; rewrite an existing instruction; merge duplicates;
change orchestration (opener, per-turn context, history); change memory selection; change model/sampling;
only then add an instruction, and say why none of the above works. Avoid new agents, services or layers without a
demonstrated need. Prefer principles with one good example over lists of prohibitions and phrase bans.

### D. Evaluate
1. `npm run api:test` (unit tests incl. persona parity and eval mirror parity) and `.venv/bin/python -m pytest -q` for pod code.
2. Behavioural suite before and after, same target and judge:
   `npm run eval -w @rolly/api -- --target pod|hybrid --repeats 3 --label <change>` then
   `npm run eval:compare -w @rolly/api -- eval/results/<baseline>.json eval/results/<candidate>.json`.
   Use `--scenarios` to iterate quickly, but run the full suite before calling it done.
3. Read the transcripts of the scenarios the change targets and of any flagged regression. Look specifically for
   increased rigidity, repetition, excessive agreement, unnatural patterns, and capabilities that broke.
4. `npm run prompt:stats -w @rolly/api -- --save` and note the instruction/size delta.
5. If the production model was not reachable, say so; give the manual test plan from
   [references/evaluation.md](references/evaluation.md) and list what remains unverified.

### E. Report
Use [templates/change-report.md](templates/change-report.md): problem, root cause (or best-supported hypothesis),
files and instructions modified, why this option, instructions added/removed/consolidated, evaluation evidence,
remaining risks. Never claim an improvement without evaluation evidence; "the prompt now says X" is not evidence.
Record significant decisions in `docs/PHASE1_DECISIONS.md` as the repo already does.

## ROLLY's identity (protect it)

A proactive, intelligent, voice-first companion that makes travel time more valuable. It leads rather than reacts,
holds reasoned opinions, challenges assumptions constructively, avoids people-pleasing, formulaic empathy and
"I understand"-style filler, knows when to ask, suggest, challenge, explore or move on, stays curious and flexible,
lets the user redirect at any moment, and does not force productivity on someone who wants to relax.
These are principles, not phrases or templates. Detail and failure patterns: [references/personality.md](references/personality.md).

## Prompt debt

Review it on every behavioural change (step B) and as a periodic audit; process and checklist:
[references/prompt-debt.md](references/prompt-debt.md). Warning signs specific to this repo's history: several
patches for the same symptom in a row (the "too many questions" fix went through three rounds in one day),
tests that assert prompt wording instead of behaviour, frozen text that forces every fix into a new appended
section, and per-turn notes that override the system prompt.

## Anti-patterns

- Adding "never X" after one bad transcript without checking whether X is already forbidden elsewhere.
- Fixing a model-capability or sampling issue with more prompt text.
- Locking prompt wording with string-presence tests; test behaviour in `eval/` instead.
- Quotas the model cannot count ("at most once per conversation") as the main control mechanism.
- Hard-coding example phrases that the model then repeats verbatim.
- Reporting "fixed" from one manual conversation, or treating LLM-judge scores as proof.
- Touching unfinished work by others in the same files without coordinating: rebase onto it, keep its intent.
