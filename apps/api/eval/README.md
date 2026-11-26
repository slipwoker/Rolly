# Behavioural evaluation for ROLLY's conversation model

Text-level regression suite that uses the real prompt assembly. Process and interpretation:
`.claude/skills/rolly-agent-engineering/references/evaluation.md`.

| File | Role |
|---|---|
| `scenarios.ts` | 20 scenarios (Hebrew-first) with memory fixtures, scripted user lines, checks, judge criteria |
| `assemble.ts` | mirror of the pod's per-turn message assembly (question-guard note, history, barge-in truncation) |
| `checks.ts` | deterministic checks (`hard` = boundary violations, `signal` = heuristics) and metrics |
| `judge.ts` | LLM-as-judge rubric (second opinion, not proof) |
| `run.ts` | runner: `npm run eval -w @rolly/api -- --target pod|hybrid|custom --repeats 3 --label x` |
| `compare.ts` | `npm run eval:compare -w @rolly/api -- <baseline.json> <candidate.json>` |
| `promptStats.ts` | prompt-debt metrics: `npm run prompt:stats -w @rolly/api [-- --save]` |
| `results/` | saved runs; `results/BASELINE.md` names the current reference |
| `prompt-debt/history.jsonl` | prompt size / instruction-count history |

Not covered: speech recognition errors, turn-taking timing, echo handling, TTS, long sessions (history compaction).
