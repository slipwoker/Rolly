# Prompt Debt review

Prompt debt = instruction text whose cost (conflicts, rigidity, dilution of other rules, maintenance) exceeds what
it still buys. It accumulates when fixes are appended instead of integrated.

## When

- Step B of every behavioural change (quick: the checklist below for the theme you touch).
- Full review: after every third prompt change, before a model switch, or monthly while the persona is changing.

## Measure (no arbitrary token limit)

`npm run prompt:stats -w @rolly/api` (add `--save` to append to `apps/api/eval/prompt-debt/history.jsonl`):

- system prompt size per fixture (onboarding / returning Hebrew / English), per-section size
- instruction and prohibition counts per section
- themes governed in several sections (consolidation candidates)
- near-duplicate instructions across sections

Size matters only together with behaviour: a larger prompt that scores better on the suite is fine; a growing
prompt with flat or worse scores is debt. Record both in the change report.

## Checklist

- [ ] **Duplicates**: the same rule in several places (look at the `themes` output; e.g. questions).
- [ ] **Conflicts**: two rules that cannot both be followed in a plausible turn (brevity vs "bring content";
      "take corrections in two words" vs "hold your position").
- [ ] **Unnecessary prohibitions**: "never/do not" lines that could become one positive principle, or that address
      a problem the model no longer has (check the eval).
- [ ] **Quotas the model cannot track** ("at most once per conversation", "two or three questions").
- [ ] **Example leakage**: example phrases that show up verbatim in transcripts.
- [ ] **Obsolete text**: rules for removed capabilities, unused outputs (e.g. `suggested_next_opener`), workarounds
      for a previous model.
- [ ] **Repeated patches**: `git log -p -- apps/api/src/persona providers/modular/text.py` shows the same symptom
      patched more than once -> stop patching, find the root cause.
- [ ] **Out-of-prompt rules**: per-turn notes or code that restate prompt rules (two sources of truth).
- [ ] **Wording-lock tests**: tests asserting prompt strings; replace with eval scenarios when you touch them.
- [ ] **Regressions linked to prompt changes**: compare eval results across the commits in question.

## Output

A short list: item, evidence (file/function, eval result), proposed action (delete / merge / rewrite / move layer),
expected effect, risk. Prefer one consolidation change evaluated end-to-end over many small edits.
