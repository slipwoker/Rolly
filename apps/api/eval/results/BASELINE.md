# Reference runs

| Run | Target | Judge | Repeats | Prompt version | Commit |
|---|---|---|---|---|---|
| `2026-11-26T0652_baseline-hybrid-stand-in.json` | gpt-6-luna (reasoning off, max 120 tokens, temperature 0.6) - **stand-in**, not the production Gemma-4 | gpt-6.2-sol (reasoning low) | 3 x 20 scenarios | `9bcef74723f7` | `fe4d69a` |
| `2026-11-26T0652_hybrid-stand-in-no-question-guard.json` | same, pod question guard **off** (experiment) | same | 3 x 20 | `9bcef74723f7` | `fe4d69a` |

Headline numbers of the reference run: 2 of 20 scenarios with a hard failure in at least one repeat
(s01 neutral addressing, s09 end marker on "מיצינו"); judge means 3.0 (attribution_care) to 5.0 (autonomy);
question-ending rate 0.32; no consecutive question pairs; 25% of replies start with the same word ("וואלה").

**Missing: a production-model baseline.** The cloud sandbox could not reach the pod's vLLM (needs `ROLLY_GPU_API_KEY`).
Run once from a machine with the key and add it here:

```bash
ROLLY_EVAL_POD_LLM_URL=https://<pod-id>-8081.proxy.runpod.net/v1 ROLLY_GPU_API_KEY=... \
  npm run eval -w @rolly/api -- --target pod --repeats 3 --label baseline-pod
```

Compare only runs with the same target, judge model and judge version (`meta.judge_version`); `eval:compare` warns otherwise.
Re-judging identical transcripts has moved a criterion mean by up to 0.33 with 3 repeats: treat smaller moves as noise.
