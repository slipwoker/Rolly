-- Goals that develop over time, the plan for the next ride, tasks and ideas, long-term digests, and the queue that makes
-- "forget that" also remove the fact from derived text (summaries, digests, plans).

-- one row per tracked goal (a memory of kind goal / travel_goal)
CREATE TABLE IF NOT EXISTS goal_tracks (
  memory_id          uuid PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'achieved', 'dropped')),
  state_note         text,          -- where things stand, one or two sentences, rewritten after each conversation that touched it
  next_step          text,
  last_discussed_at  timestamptz,
  sessions_count     int NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS goal_tracks_user ON goal_tracks (user_id, status);

ALTER TABLE memories ADD COLUMN IF NOT EXISTS importance smallint;       -- 1 (minor) .. 3 (central to this person)
ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_used_at timestamptz;  -- last time it was put into a prompt

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS digest text;               -- who this person is and what matters to them now
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS history_digest text;       -- older conversations folded into one paragraph
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS digest_at timestamptz;
-- {"created_at", "session_id", "items": [{"topic", "why", "kind", "ref_id"}]}
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS next_agenda jsonb;

-- Facts the user deleted or corrected that may still appear in derived text. A row lives only until the scrub pass has
-- rewritten that text (then it is deleted, content included). While a row is pending, derived text older than it is not
-- put into prompts.
CREATE TABLE IF NOT EXISTS scrub_queue (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content      text NOT NULL,
  replacement  text,
  attempts     int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scrub_queue_user ON scrub_queue (user_id);

-- The per-session JSON kept every extracted item verbatim (a second copy of personal facts that "forget" could not
-- reach), and topic labels. Keep only the summary text; the items themselves live in memories.
UPDATE sessions SET summary = jsonb_strip_nulls(jsonb_build_object(
  'summary', summary->'summary', 'method', summary->'method', 'language', summary->'language'))
WHERE summary IS NOT NULL AND (summary ? 'facts' OR summary ? 'policy' OR summary ? 'travel_goals' OR summary ? 'topics');
