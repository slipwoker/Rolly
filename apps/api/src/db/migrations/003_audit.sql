-- Agent audit (backoffice /admin): what each conversation was given, what every model call cost, how the conversation
-- went, and the owner's review. Personal text is kept apart from metadata so that retention and "forget that" can remove
-- it without losing the measurements (src/audit/recorder.ts).

-- The fixed persona part of the system prompt, one row per distinct text. It holds no personal data and is kept forever,
-- so sessions can be compared across prompt changes.
CREATE TABLE IF NOT EXISTS prompt_versions (
  hash        text PRIMARY KEY,                -- first 12 hex chars of sha256(text)
  language    text,
  text        text NOT NULL,
  chars       int NOT NULL,
  build       text,                            -- deploy commit that first sent it (RENDER_GIT_COMMIT), when known
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  label       text                             -- the owner's name for this version (optional)
);

-- One row per conversation.
CREATE TABLE IF NOT EXISTS session_audit (
  session_id      uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  build           text,
  prompt_hash     text REFERENCES prompt_versions(hash) ON DELETE SET NULL,
  prompt_chars    int,                         -- whole system prompt
  memory_chars    int,                         -- the personal part of it
  prompt_tokens_est int,
  language        text,
  onboarding      boolean,
  sampling        jsonb NOT NULL DEFAULT '{}'::jsonb,
  memory_ids      uuid[] NOT NULL DEFAULT '{}',  -- memories put into the prompt
  plan_kinds      text[] NOT NULL DEFAULT '{}',  -- kinds of the plan items (topics are personal: see plan below)
  -- personal text: removed after the transcript retention period and when the user deletes or corrects a memory
  memory_block    text,                        -- the part of the system prompt after the persona
  opener          text,
  plan            jsonb,                       -- [{topic, take, kind}]
  notes           jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{kind, text, turns, at_s}]
  redacted        text,                        -- null | 'retention' | 'forget'
  -- measurements (no personal text)
  quality         jsonb,                       -- src/audit/quality.ts
  flags           text[] NOT NULL DEFAULT '{}',
  cost            jsonb,                       -- {api_usd, gpu_usd, total_usd, by_purpose, prices}
  judge           jsonb,                       -- LLM judge: {scores, overall, issues, model, at}
  -- the owner's review
  review_rating   smallint CHECK (review_rating BETWEEN 1 AND 5),
  review_tags     text[] NOT NULL DEFAULT '{}',
  review_note     text,
  reviewed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS session_audit_user ON session_audit (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS session_audit_created ON session_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS session_audit_prompt ON session_audit (prompt_hash);

-- Every utility-model call (summaries, live memory commands, plan, scrub, consolidation, judge). No prompt or answer text.
CREATE TABLE IF NOT EXISTS llm_calls (
  id                bigserial PRIMARY KEY,
  at                timestamptz NOT NULL DEFAULT now(),
  user_id           uuid REFERENCES users(id) ON DELETE CASCADE,
  session_id        uuid,                      -- not a foreign key: calls made before the session row exists stay countable
  purpose           text NOT NULL,             -- summary | live_command | capture | plan | scrub | consolidate | judge | other
  model             text NOT NULL,
  ok                boolean NOT NULL,
  error             text,
  ms                int,
  prompt_chars      int,
  prompt_tokens     int,
  cached_tokens     int,
  completion_tokens int,
  reasoning_tokens  int,
  cost_usd          double precision           -- at the prices in force when the call was made
);
CREATE INDEX IF NOT EXISTS llm_calls_at ON llm_calls (at DESC);
CREATE INDEX IF NOT EXISTS llm_calls_session ON llm_calls (session_id);
CREATE INDEX IF NOT EXISTS llm_calls_user ON llm_calls (user_id, at DESC);
