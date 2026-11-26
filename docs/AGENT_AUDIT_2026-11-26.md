# ROLLY conversational intelligence: initial Prompt Debt audit (read-only)

Date: 2026-11-26. Code at `fe4d69a` (main). Method: the `rolly-agent-engineering` skill
(`.claude/skills/rolly-agent-engineering/`). **No prompt, pipeline or production behaviour was changed by this audit.**
No other branch with unfinished agent work was found (only `main`); nothing was touched outside the new skill,
the evaluation framework and this report.

## Evidence base

- Code reading of every layer that reaches the conversation model (map: `references/runtime-map.md` in the skill).
- `npm run prompt:stats -w @rolly/api` (snapshot in `apps/api/eval/prompt-debt/history.jsonl`).
- Behavioural suite `apps/api/eval`, 20 scenarios x 3 repeats, real prompt assembly and a mirror of the pod's per-turn
  assembly. Runs in `apps/api/eval/results/` (see `BASELINE.md`):
  - reference: question guard on (production configuration);
  - experiment: question guard off, everything else identical.
- **Limitation:** the target was a stand-in (`gpt-6-luna`, the `hybrid-api` conversation LLM). The production model
  (Gemma-4 26B-A4B on the pod) could not be reached from the sandbox. A larger model follows long prompts better than a
  ~4B-active MoE, so the stand-in probably *understates* instruction-following problems. Every behavioural number below
  is "stand-in" until re-run with `--target pod`.

## Measurements

| Item | Value |
|---|---|
| System prompt, first ride (Hebrew) | 9,089 chars, ~2,400 tokens |
| System prompt, returning user (Hebrew) | 7,345 chars, ~2,000 tokens |
| System prompt, returning user (English) | 6,034 chars, ~1,500 tokens |
| Instruction units the model can receive (all sections, openers, per-turn note) | 68, of which 42 are prohibitions (62%) |
| Instructions about asking questions | 28, spread over 11 sections/notes, in two languages' code (TypeScript and Python) |
| Prompt changes for the "too many questions" symptom | 3 in one day (`6835b20`, `229ac5e`, `cb6b8d7`) |
| Reference run: scenarios with a hard failure in >= 1 of 3 repeats | 2 / 20 (s01 addressing, s09 end marker) |
| Reference run: judge means (1-5) | attribution_care 3.0, transitions 3.67, substance 3.78, naturalness 3.97, initiative 4.0, empathy 4.0 ... autonomy 5.0 |
| Replies starting with the same word ("וואלה") | 25% (48 / 189 replies) |
| Conversations with a menu question ("X או Y?") | 11 / 60 |

Question guard on vs off (same stand-in, same scenarios, 3 repeats each):

| | guard on | guard off |
|---|---|---|
| consecutive question pairs per conversation | 0.00 | 0.60 |
| replies ending with a question | 32% | 46% |
| onboarding stays within 3 question turns (s01) | 3 / 3 | 0 / 3 |
| ROLLY decides when told "you decide" (s03) | 2 / 3 | 0 / 3 |
| scenarios with a hard failure | 2 | 3 |
| judge: transitions / initiative / substance | 3.67 / 4.00 / 3.78 | 2.00 / 3.73 / 3.61 |

The guard (one note next to the turn) is the mechanism that actually controls questions. Other judge differences are
within noise (re-judging identical transcripts moved a criterion by up to 0.33).

## Findings, by priority

### High

**H1. The production model has never been evaluated on the Phase 1 prompt.** P1-D15 and P1-D16 were validated by the
owner's phone tests only; `benchmarks/llm_quality.py` and `run_scenarios.py` use `memory/context.py`, which has none of
the Phase 1 sections. Every prompt decision so far is untested against regressions. *Action:* one `--target pod`
baseline before any prompt change (needs `ROLLY_GPU_API_KEY`, no code change).

**H2. Question control is fragmented and has been patched repeatedly.** 28 question-related instructions in
`VOICE_STYLE`, `LEAD` (twice), `ONBOARDING`, gaps line, `NEUTRAL_HEBREW`, `MEMORY_CONTROL`, `OTHER_VOICES`, openers and
the pod's `QUESTION_GUARD_NOTE`; three fixes in one day for one symptom. The measurement above shows the per-turn guard
does the work. Side effect seen in transcripts: after a question the guard forces a statement even when the user did
not answer it, producing filler ("נסיעת בוקר תמיד מרגישה לי כמו רגע קטן להתאפס..."). *Action:* one short orchestration
principle (lead with substance; ask only what a curious friend would) plus the guard; delete the duplicates; consider
letting the guard skip clarification turns. Evaluate on the pod.

**H3. The identity layer is frozen, so fixes accumulate around it.** `research.ts` must stay byte-identical to
`memory/context.py` (`persona.test.ts`), so every Phase 1 correction became a new appended section, and
`persona.test.ts` additionally locks wording ("Never ask two questions in a row", "at most two or three questions").
This is the structural cause of H2, M1 and M2. *Action (owner decision):* end research parity for Phase 1, then
replace wording assertions with eval scenarios as each section is touched.

**H4. "Topic closed" is read as "conversation over".** s09: after "טוב, מיצינו את הריצה" ROLLY said goodbye and emitted
`<end_session/>` in 1/3 runs with the guard and 2/3 without. In production the pod ignores the marker (the words do
not match `END_INTENT`) but the farewell is still spoken and the ride continues awkwardly; and `END_INTENT` itself
contains `מספיק` and `סיימנו`, which Israelis also use to close a topic ("מספיק עם הריצה"), so a real early end is
possible. *Action:* orchestration, not more prompt: require a ride-ending cue rather than any "enough"; word the ending
rule as ending the ride. The pod already emits an `end_marker_ignored` metric to measure this in real sessions.

**H5. No honesty carve-out for "are you a person?".** `VOICE_STYLE`: "Never mention being an AI, a model or an
assistant". The stand-in answered honestly 3/3 (s18) despite this, but a smaller, more literal model may deny it.
Trust/safety issue. *Action:* "don't talk about being an AI unprompted; if sincerely asked, say so in a few words and
move on."

### Medium

**M1. Mandatory turn shape produces formulaic replies.** "React like a person before you add anything" (with example
reactions) + `LEAD` "first give something of your own" + the guard's "React briefly, then..." + "two sentences, ~25
words". With `LANG.he` listing slang to use (`וואלה` first), 25% of replies open with "וואלה". Judge notes repeatedly say
ROLLY *describes* a story instead of telling it (s01, s03, s08, s17; substance is the weakest general criterion).
*Action:* drop "react first" as a rule, mark slang as occasional, allow a slightly longer turn when delivering content.

**M2. Example leakage and announcing.** `LEAD`'s "right" example ends in a teaser ("ויש לי אחד על הכביש הכי פקוק
בעולם") and it suggests openers like "יש לי משהו מעניין לנסיעה הזאת:..." - while the opener instruction says "do not
announce what you are going to talk about". Teasers appear in transcripts. *Action:* rewrite the example so it
delivers; remove the announcing openers.

**M3. ROLLY's own grammatical gender is undefined.** ROLLY mostly speaks of itself in masculine (21 self-references in
the reference run) but takes on the gender of whoever it talks to: "אני תמיד חושבת" to a feminine user (s04),
"הייתי הולכת" right after the user asked for feminine forms (s15), "אני אומרת" when answering a girl (s16, both runs).
The Hebrew voice is the male "daniel". Missing information, not a rule problem. *Action:* owner decides; one clause in
identity. The eval records `rolly_self_gender` (it uses the production addressing lexicon, so it undercounts: "אומרת"
is not in it).

**M4. The least-known user gets the most rules.** The first-ride prompt is the longest (9.1k chars: `ONBOARDING` 8
instructions / 6 prohibitions, plus 6-bullet neutral-addressing rules). s01 is among the weakest scenarios: ROLLY asks
the user to narrow down ("איזה תקופה הכי תופסת אותך?") instead of delivering, offered a menu in the opener, and broke
neutral addressing in 1/3 runs ("שמעת", "אותך"). *Action:* merge `ONBOARDING` into the orchestration principle; keep
the neutral-addressing rule but shorten it to the spoken-gender word list and one positive pattern.

**M5. Opinion pushback vs correction.** "If they correct you, take it in two words and move on" does not separate
factual corrections from disagreement. One early run caved ("אז אני כנראה מפספס משהו") but after fixing an ambiguous
scripted line, position_integrity was 4.67. Weak evidence; verify on the pod before acting.

**M6. Other voices.** `OTHER_VOICES` allows answering anyone "when it makes sense"; in s16 ROLLY answered a child's
question to her parent in 6/6 runs and the judge scored attribution_care 3.0 (the lowest criterion). Friendly
behaviour or overreach is a product decision. The section is otherwise sound (no gender inference from "אבא" was
observed). *Action:* decide, then simplify the section to one principle.

**M7. Memory is injected wholesale.** `memoryView()` sends everything (up to 8 interests, 13 facts/goals, 3 summaries,
6 open topics, 6 action items, 4 progress items, 5 candidates); the same thread appears as summary, open topic and
action item (the fixture's ride-sharing app appears three times), and the `Not confirmed` guidance is always present.
Fine at today's volume, grows with use. *Action:* relevance selection and de-duplication; include conditional
guidance only when its condition holds.

### Low

- **L1. Quotas the model cannot count** ("at most once per conversation" in three places, "two or three questions").
  Replace with principles, or track state in orchestration where it matters.
- **L2. Dead or obsolete text:** `suggested_next_opener` is generated by the summariser and never used; history
  compaction inserts a canned English "Understood, I remember that." into Hebrew conversations (after 24 turns).
- **L3. Recency placement:** `LEAD` after the dynamic memory/journey block keeps it out of the cross-session prefix
  cache; re-test whether the placement is still needed once the prompt is shorter.
- **L4. One behaviour, two deploy paths:** prompt in TypeScript (Render, `main`), per-turn note in Python (pod
  deployment branch). Keep any one behaviour's controls in one place.

## Evaluation coverage still missing

Production model (H1); the audio path (Hebrew recognition errors, barge-in timing, echo, pronunciation) - manual plan
in the skill's `references/evaluation.md`; sessions long enough to trigger compaction; resume after a dropped
connection; `auto` language and code-switching beyond one scenario; plural addressing; quality of what the summariser
remembers (policy logic is unit-tested, extraction quality is not); live voice corrections through `live.ts`; the
"stressed in traffic, offer quiet" rule; sycophancy drift over long conversations; any human evaluation
(`docs/HUMAN_EVALUATION.md`: none performed).

## Prioritised improvement plan

| # | Step | Kind | Depends on | Expected effect / how to verify |
|---|---|---|---|---|
| 1 | Production baseline: `npm run eval -w @rolly/api -- --target pod --repeats 3` | measurement | `ROLLY_GPU_API_KEY` | Real numbers for every finding; becomes the reference in `BASELINE.md` |
| 2 | Owner decisions: end research parity (H3); ROLLY's self-gender (M3); honesty wording (H5); answering other voices (M6) | decision | - | Unblocks 3-5; record as P1-D entries |
| 3 | Consolidate questions/lead/onboarding into one orchestration section, keep the guard, fix the examples (H2, M1, M2, M4) | prompt (net removal) | 1, 2 | Fewer instructions (roughly -15); question metrics no worse; substance/initiative up; compare against 1 |
| 4 | End detection: ride-ending cue required, `END_INTENT` without bare `מספיק`/`סיימנו` (H4) | orchestration | 1 | s09 hard failures to 0; watch `end_marker_ignored` in production |
| 5 | Identity edits after parity ends: honesty, self-gender, no mandatory reaction, sparing slang (H5, M3, M1) | prompt (edit) | 2 | s18, `rolly_self_gender`, opening-word share down |
| 6 | Memory selection and de-duplication; conditional sections (M7) | orchestration | 1 | Shorter returning-user prompt; memory_use not lower |
| 7 | Replace wording-lock assertions in `persona.test.ts` with eval scenarios as sections change (H3) | tests | 3 | Tests protect behaviour, not phrasing |
| 8 | Close coverage gaps: long-session and resume scenarios; summariser quality eval; manual audio plan per release | evaluation | - | Fewer blind spots |

Do 3 to 6 one at a time, each with a before/after eval and a change report (skill template), not as one rewrite.
