# ROLLY

Voice-first travel companion. Phase 1 product: `apps/api` (rolly-api: memory, prompts, relay), `apps/mobile` (Expo app),
`packages/contracts`; the voice pipeline runs on a GPU pod (`backend/gpu_worker.py`, `providers/modular/`). The Python
research platform (`backend/app`, `benchmarks/`, `memory/`) is kept for comparison. Start with `RESEARCH_HANDOFF.md`
and `docs/PHASE1_DECISIONS.md`.

Tests: `npm run api:test` and `.venv/bin/python -m pytest -q`.

## Changing ROLLY's conversational behaviour

Before any change that can affect what the conversation model sees or how ROLLY converses (persona and prompt
sections, openers, per-turn notes, message/history assembly, memory selection or injection, summariser, model or
sampling settings), invoke the `rolly-agent-engineering` skill and follow its workflow: diagnose the real source,
replace before adding, evaluate with `apps/api/eval` against a baseline, and report. Not needed for UI,
infrastructure or backend work that does not change what reaches the model.
