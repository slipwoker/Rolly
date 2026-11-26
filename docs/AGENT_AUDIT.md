# Agent audit backoffice

The owner's page for following what Rolly does: conversation quality, the prompts it was given, how the agent behaves across
conversations, and what it costs. Decision P1-D26 in `PHASE1_DECISIONS.md`. Code: `apps/api/src/audit/`.

**Open:** `https://<rolly-api>/admin` and enter `ROLLY_ADMIN_TOKEN`. The token stays in that browser tab (sessionStorage) and is
sent as a bearer token; the page itself is static and holds no secret.

## Pages

| Page | What it answers |
|---|---|
| **Overview** | Conversations, minutes, reply latency p50/p95, health score, judge and review averages, spend and cost per minute; per-day charts; the flags to look at; agent insights: bot-speak habits, turn-taking, plan uptake, memory outcomes, language mismatches, judge scores per criterion |
| **Conversations** | Every conversation with length, latency, bot-speak rate, score, judge, review, cost and flags. Filter by flag, user, prompt version, reviewed or not |
| **Conversation** | Timeline of turns and the notes sent to the model, in time order, with per-turn latency, model first token, voice first audio and tokens; the exact prompt (persona version, memory part, opener, plan); every utility-model call; what was learned and what was injected; the LLM judge (run or re-run) and the owner's review (1-5, tags, note) |
| **Prompts** | Each distinct persona text with the metrics of the conversations that used it (latency, bot-speak, agreeing openers, general wisdom, words per reply, score, judge, review). Name a version; compare two versions line by line |
| **Costs** | Fixed cost (the GPU pod per day, the monthly services) and variable cost (utility-model tokens at list price); how busy the pod was; cost per minute talked, all-in and marginal; monthly run-rate; variable spend per day and purpose, per model, per user; the prices in use |
| **Model calls** | Every utility-model call: purpose, user, session, latency, tokens, cost, error. Filter by purpose and failures |
| **Users** | Testers with their use, health score, memory state (active / unconfirmed), goals, how often they corrected Rolly's memory, cost |

Self-test users (`selftest …`) are hidden unless "Include self-tests" is ticked.

## What is recorded

| Table | Contents | Personal? | Kept |
|---|---|---|---|
| `prompt_versions` | The fixed persona part of the system prompt (`core(language)`), one row per distinct text, with the build that first sent it | No | Always |
| `session_audit` | Per conversation: persona hash, prompt sizes, memory ids injected, plan kinds, sampling; **personal text**: memory part of the prompt, opener, plan, note texts; quality metrics, flags, conversation length, judge, the owner's review | Partly | Personal text: see below. The rest: until the conversation is deleted |
| `llm_calls` | Every utility-model call: purpose, model, ok/error, latency, prompt size, tokens (prompt, cached, completion, reasoning), cost | No text | Until the account is deleted |
| `turns.meta` | Per agent turn: `reply_ms`, `llm_ttft_ms`, `tts_ttfa_ms`, `stt_ms`, `prompt_tokens`, `completion_tokens` | With the transcript | Transcript retention (30 days) |
| `sessions.stats.usage` | The pod's raw usage: conversation-model tokens, characters spoken, audio transcribed | No | With the session |

**Privacy.** Personal audit text follows the rules for transcripts and derived text:

- removed after the transcript retention period (`ROLLY_TRANSCRIPT_RETENTION_DAYS`, hourly job);
- removed for a user at once when they delete or correct a memory (the same path that queues the scrub, P1-D21); notes whose
  text is fixed by the code (style guard, pacing) are kept;
- deleted with the conversation (`DELETE /v1/sessions/:id`) or the account.

The measurements stay. The owner can read testers' transcripts here (within the retention period): tell the testers.

## Quality: metrics, flags, score

`quality.ts` computes from the stored transcript and stats, with no model: reply latency (p50, p95, slow replies over 2 s),
interruptions per reply, words per reply and talk ratio, bot-speak habits (`persona/style.ts`: agreeing openers, general wisdom,
apologies, promises, naming feelings), turns that may be another voice, utterances the recogniser discarded, the user turns'
detected language against the session's, plan items taken up or skipped, memories saved and the user's corrections, summary and
plan-step failures.

Flags (thresholds in `THRESHOLDS`): high `pipeline_failed`, `language_mismatch`, `judge_low`; medium `errors`, `slow`,
`bot_speak`, `interruptions`, `memory_corrected`, `summary_failed`; low `long_replies`, `lookahead_failed`, `utility_llm_errors`,
`abandoned`, `superseded`, `other_voices`, `stt_discards`. The health score is 100 minus 25 / 12 / 4 per high / medium / low flag:
a sort key, not a grade. After a threshold changes, `POST /v1/admin/audit/reassess?days=90` recomputes recent sessions.

**LLM judge** (`judge.ts`): the utility model rates Rolly 1-5 on naturalness, relevance, initiative, memory use, brevity and
language, with up to five issues pointing at turn numbers. It runs after the plan step of every conversation with at least two
user turns (about $0.0003 each at gpt-6-luna prices); `ROLLY_AUDIT_JUDGE=off` disables it, the button on a conversation runs it
on demand. It is a second opinion; the owner's review is the reference.

## Costs

`pricing.ts`: gpt-6-luna $0.10 / $0.01 cached / $0.50 per million tokens (input / cached input / output), the L40S pod at
$1.09/h, Render rolly-api $7 and PostgreSQL $6 per month. Override with `ROLLY_PRICING` (JSON merged over the defaults), e.g.

```
ROLLY_PRICING={"gpu_usd_per_hour":0.79,"gpu_hours_per_day":24,"models":{"gpt-6-luna":{"input":0.1,"cached":0.01,"output":0.5}}}
```

**The GPU pod is a fixed cost.** It is billed by the hour while it exists, for one conversation, ten or none, so it is never
charged to a conversation or a user. It counts as hourly rate × `gpu_hours_per_day` (24: always on) for every day of the range
from the day of the first recorded conversation. Against it the backoffice shows:

- **GPU busy**: minutes talked ÷ minutes the pod was up (with a handful of testers, well under 1 %);
- **cost per minute talked, all-in**: everything spent ÷ minutes talked. It falls as use grows, since the pod costs the same;
- **one more minute adds**: the marginal cost, utility-model API only;
- **monthly run-rate**: pod per day × 30 + monthly services + API at the current pace.

A conversation's own cost is its utility-model calls ("API cost"). Each call's cost is stored with the prices of its time. Calls
of a model with no price are counted as "unpriced", never as free.

## API (admin token)

`GET /v1/admin/audit/overview|sessions|sessions/:id|prompts|prompts/:hash|costs|llm-calls|users` (`?days=`, `&selftest=1`),
`POST /v1/admin/audit/sessions/:id/review|judge|reassess`, `POST /v1/admin/audit/reassess`, `PATCH /v1/admin/audit/prompts/:hash`.

## Not done

- Conversations before this deploy have no prompt snapshot or utility-call records; "Reassess" gives them metrics and flags.
- The pod's real uptime is not read (RunPod API): the fixed cost assumes it is up `gpu_hours_per_day` hours on every day since
  the first conversation. A day it was stopped is still counted.
- No alerting (e.g. a message when a conversation is flagged high): the data is there, the channel is not.
- The judge has not been calibrated against the owner's reviews; compare the two on the Prompts and Overview pages once there
  are some reviews.
