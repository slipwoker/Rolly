# Behaviour change report

**Change**: <one line>   **Date**: <yyyy-mm-dd>   **Commit(s)**: <sha>   **Decision record**: <P1-Dxx or none>

## Problem
<Observed behaviour, with a transcript excerpt and where it came from (owner test, eval scenario, user report).>

## Root cause
<Source of the behaviour (instruction / conflict / restriction / per-turn note / orchestration / memory / model /
speech pipeline), with evidence. If unproven, say "best-supported hypothesis" and what would confirm it.>

## Change
- Files and instructions modified: <file: section/function>
- Instructions added: <n, quoted>   removed: <n>   consolidated: <which into which>
- Alternatives considered and why rejected: <delete a rule / orchestration / memory / model config / ...>

## Evaluation
- Unit tests: <command, result>
- Behavioural suite: target <pod|hybrid>, judge <model>, repeats <n>; baseline <file> -> candidate <file>
- Targeted scenarios: <before -> after, with one transcript excerpt each>
- Regressions flagged by `eval:compare` and what reading the transcripts showed: <...>
- Prompt stats: <chars / instructions before -> after>
- Not verified: <e.g. production model, audio path, real car>

## Remaining risks
<What could get worse, where to look first if it does.>
