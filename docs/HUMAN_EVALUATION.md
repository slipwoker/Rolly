# Blind human evaluation protocol

**Status: not performed. There are no human scores in this repository.** The interface and data pipeline are built and
tested (`frontend/eval.html`, `/api/eval/plan`, `/api/ratings`, `/api/ratings/export`); the evaluation needs people.

## Design

- Each evaluator talks to every available architecture for about three minutes.
- Agents are shown only as "Agent A", "Agent B", … The label ↔ provider mapping is derived from a secret salt
  (`ROLLY_BLIND_SALT`) and is visible only with the admin token.
- The order is randomised per evaluator (seeded by the evaluator code, so a page reload does not reshuffle it).
- All agents receive the same synthetic traveller profile and memory; evaluation sessions do not write to long-term memory.
- Scores 1–5 (or n/a) on nine criteria: naturalness, Hebrew quality, English quality, responsiveness, conversational
  intelligence, emotional appropriateness, interruption handling, overall experience, willingness to use during a daily commute.

## Script given to evaluators (per agent)

1. Press start and let the agent open the conversation.
2. Answer it, in the session language.
3. Change the subject once without warning.
4. Interrupt the agent once in the middle of a sentence.
5. Correct something it said or assumed.
6. Hebrew sessions: use a few English terms inside a Hebrew sentence.
7. End by saying you have arrived.

## Who and how many

- Minimum useful panel: 8 evaluators, at least 5 native Hebrew speakers. With fewer than 5 ratings per architecture, report medians only and call the result indicative.
- At least half of the sessions in a moving car or with road noise played from a speaker, since that is the product's environment.
- Headset or phone speaker with echo cancellation; Chrome or Safari.

## Analysis

`/api/ratings/export?fmt=csv` (admin token). Per architecture and criterion: median, mean, number of ratings, and the share of
ratings ≥ 4. Success criterion from the brief: Hebrew conversational quality ≥ 4/5. Report the free-text comments verbatim;
do not average across languages.

## Biases to state in the report

Order effects are reduced, not removed; a three-minute session cannot show 30-minute behaviour; latency differences can reveal
which agent is commercial; the self-hosted LLM and the commercial models differ in intelligence as well as voice, so
"naturalness" and "intelligence" must be read as separate columns.
