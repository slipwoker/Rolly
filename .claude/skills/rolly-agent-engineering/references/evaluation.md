# Behavioural evaluation

Code: `apps/api/eval/` (README there). Unit tests for the framework: `apps/api/test/eval.test.ts`.

## What it does

- Builds each scenario's system prompt and opener with the real `buildContext()`.
- Replays the pod's per-turn assembly (`PipelineMirror`, mirroring `pipeline.py _messages/_finalize_committed`,
  including the question-guard note and barge-in truncation); parity with the Python is unit-tested.
- Sends scripted user lines to an OpenAI-compatible model with the pod's sampling settings.
- Scores each conversation with deterministic checks (`checks.ts`: hard = boundary violations, signal = heuristics)
  and an LLM judge (`judge.ts`, per-scenario criteria and focus).
- Saves everything (transcripts, checks, judge evidence, prompt hash, git commit) to `eval/results/`.

## Targets

| `--target` | Model | Use |
|---|---|---|
| `pod` | production Gemma-4 26B-A4B on vLLM; needs `ROLLY_EVAL_POD_LLM_URL` (pod port 8081) and `ROLLY_GPU_API_KEY` | the authoritative run before shipping a prompt change |
| `hybrid` (default) | `gpt-6-luna`, reasoning off, as configured for `hybrid-api` | relative comparisons when the pod is off or unreachable; never the final word on Gemma's behaviour |
| `custom` | `--base-url --model --key-env --token-param --temperature --reasoning` | other candidates (model switch studies) |

The Claude Code cloud sandbox cannot reach the pod's vLLM port without the key and cannot open the pod WebSocket
(proxy refuses upgrades, P1-D12); run `--target pod` from a machine that has `ROLLY_GPU_API_KEY`.

## Procedure

```bash
npm run eval -w @rolly/api -- --offline                                   # fixtures build, no network
npm run eval -w @rolly/api -- --target pod --repeats 3 --label before-x   # baseline on the current code
# ... make the change ...
npm run eval -w @rolly/api -- --target pod --repeats 3 --label after-x
npm run eval:compare -w @rolly/api -- eval/results/<before>.json eval/results/<after>.json
```

Same target, same judge, same scenarios, at least 3 repeats (temperature 0.6). Commit the result files you cite in
a report; `eval/results/BASELINE.md` names the current reference run.

## Reading results

- Hard failures: inspect every one; most are real, some are lexicon false positives (the `detail` field names the word).
- Signals and judge means: compare deltas, not absolute values. A move under ~0.3 judge points or under ~15% on a
  signal with 3 repeats is noise.
- Always read the transcripts of the scenarios you targeted and of flagged regressions. The judge rewards
  politeness and fluency and can miss Hebrew grammar errors.
- Watch the metrics block: question-ending rate, consecutive question pairs, mean words, guard applications.

## Adding scenarios

Add to `eval/scenarios.ts`: a memory fixture, scripted lines that make sense after most replies, `covers`, the few
checks that are objective for this scenario, and judge criteria + a `focus` that describes good and bad behaviour.
Do not write checks that assert prompt wording. When a real-world transcript shows a failure, turn it into a
scenario before fixing it.

## Manual test plan (when automated evaluation cannot cover it)

Audio-path behaviour (speech recognition errors, barge-in timing, echo, TTS pronunciation, real car noise) is not
covered by the text suite. For those, on the phone, in Hebrew, record per run: date, build, pod commit, user state.

1. First ride with a fresh user: ROLLY opens; give one-word answers for three turns; mention one interest.
2. Returning user: ROLLY's opener names a real open topic; answer "no time yet".
3. Ask its opinion on something contested; push back twice without an argument, then give a real argument.
4. State a common myth as fact.
5. Interrupt mid-sentence and change the subject.
6. Ask it to play music; ask sincerely whether it is a person.
7. Have a passenger say a line; ask for feminine (or masculine) addressing mid-ride.
8. Say "we've arrived".

For each: expected behaviour (from `references/personality.md`), observed, pass/fail, and a transcript excerpt.
Report what was not verified.
