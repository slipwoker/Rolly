# Prompt architecture: target separation and how the current code maps to it

Logical layers, not services. One model call per turn stays the design; do not add agents or services to get
separation.

| # | Layer | Should contain | Changes | Current location | Gap |
|---|---|---|---|---|---|
| 1 | Core identity and personality | Who ROLLY is, how it talks, a handful of principles | Rarely; versioned and evaluated | `VOICE_STYLE` + `LANG` (`research.ts`) | Frozen by research parity, so Phase 1 corrections pile up in later sections instead of editing it |
| 2 | Conversation orchestration | Initiative, when to ask vs tell, pacing, openers, turn shape | With product strategy | `LEAD`, `ONBOARDING`, gaps line, 4 opener variants, pod question-guard note | Spread over 6+ places in two languages (TS and Python); strongest rule is a per-turn note outside the prompt |
| 3 | Session context | Time, journey, resume turns | Per session | `## Current journey`, resume block | Fine; sits before `LEAD`, so `LEAD` is outside the cross-session cache prefix |
| 4 | Long-term memory | Selected, relevant user knowledge | Per session | `## About the user`, `## Memory of previous conversations` | Everything in `memoryView` is injected; no relevance selection; summaries, open topics and progress overlap |
| 5 | Task-specific instructions | Only when the situation exists | Per session/turn | Addressing (conditional, good), `OTHER_VOICES`, `MEMORY_CONTROL` (always on) | "Not confirmed" handling is included even when there are no candidates |
| 6 | Safety and operational constraints | Driving safety, capability honesty, end marker, privacy | Rarely | Mixed into `VOICE_STYLE` and `LEAD` | No explicit honesty rule for a sincere "are you a person?"; "never mention being an AI" can be read as "deny it" |

## Recommendations (incremental, no big-bang refactor)

1. Decide whether research parity is still a requirement. If not, retire `memory/context.py`'s role as the source
   of truth for `VOICE_STYLE` (keep the research tree runnable) so layer 1 can be edited instead of patched around.
2. Give layer 2 a single home: one short "how you run the conversation" section that replaces the question/lead
   rules now split across `VOICE_STYLE`, `LEAD`, `ONBOARDING`, gaps, openers and the guard note. Openers stay
   variants of one instruction.
3. Keep per-turn notes for state the model cannot see (e.g. "the user just interrupted you"), not for rules that
   the system prompt already states; if a rule only works as a per-turn note, the system prompt is too long or
   self-contradictory.
4. Memory: select by relevance (open topics and the latest summary first; facts only when they connect), cap by
   size, and avoid duplicating the same item as summary + open topic + progress.
5. Include conditional sections only when their condition holds (candidates present, other speakers suspected).
6. Put layers in cache-friendly order: static (1, 2, 6) first, then memory and session data; keep the recency
   placement only if evaluation on the production model shows it is needed.
