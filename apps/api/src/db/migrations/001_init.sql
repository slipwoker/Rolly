-- ROLLY Phase 1 schema. No raw audio is stored anywhere.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS app_secrets (
  name        text PRIMARY KEY,
  value       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_label text,                          -- owner's label for the tester (admin only), not shown to ROLLY
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

-- one-time pairing codes (stored hashed) that bind a phone to a user
CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash   text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- long-lived device credentials (refresh tokens, stored hashed), revocable
CREATE TABLE IF NOT EXISTS devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text,
  refresh_hash  text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz
);

-- single-use, short-lived voice tickets (the phone never holds a pipeline credential)
CREATE TABLE IF NOT EXISTS voice_tickets (
  ticket_hash text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id              uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferred_name       text,
  preferred_language   text CHECK (preferred_language IN ('he', 'en')),
  languages            text[] NOT NULL DEFAULT '{}',
  addressing_value     text CHECK (addressing_value IN ('masculine', 'feminine', 'plural')),
  addressing_status    text NOT NULL DEFAULT 'unknown' CHECK (addressing_status IN ('unknown', 'inferred', 'confirmed')),
  -- {"masculine": n, "feminine": n, "examples": [{"quote","form","session_id","at"}], "ignored_uncertain": n}
  addressing_evidence  jsonb NOT NULL DEFAULT '{}'::jsonb,
  professional_background text,
  preferences          jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- typed memories with status and provenance.
-- kind: fact | preference | goal | travel_goal | interest | open_topic | action_item | summary | outcome
-- status: candidate (unconfirmed, not used as fact, expires) | active | deleted (kept as tombstone without content)
CREATE TABLE IF NOT EXISTS memories (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              text NOT NULL,
  content           text NOT NULL,
  status            text NOT NULL CHECK (status IN ('candidate', 'active', 'deleted')),
  confidence        real,
  -- {"source": "summarizer"|"user_app"|"user_voice"|"correction"|"confirmation", "session_id", "quote", "attribution", "confirmed": bool, "reason"}
  provenance        jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_session_id uuid,
  supersedes        uuid REFERENCES memories(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz,
  resolved_at       timestamptz
);
CREATE INDEX IF NOT EXISTS memories_user_kind ON memories (user_id, kind, status, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz,
  language     text,
  onboarding   boolean NOT NULL DEFAULT false,
  pipeline     jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary      jsonb,
  stats        jsonb,
  end_reason   text,
  user_turns   int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS turns (
  session_id   uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  idx          int NOT NULL,
  role         text NOT NULL CHECK (role IN ('user', 'agent')),
  text         text NOT NULL,
  language     text,
  attribution  text NOT NULL DEFAULT 'uncertain' CHECK (attribution IN ('primary', 'uncertain')),
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL,
  PRIMARY KEY (session_id, idx)
);

CREATE TABLE IF NOT EXISTS progress_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id  uuid REFERENCES sessions(id) ON DELETE SET NULL,
  goal_id     uuid REFERENCES memories(id) ON DELETE SET NULL,
  text        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX IF NOT EXISTS progress_user ON progress_items (user_id, created_at DESC);

-- audit of memory changes made by the user (by voice or in the app); no content of deleted items is kept here
CREATE TABLE IF NOT EXISTS memory_events (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  memory_id   uuid,
  action      text NOT NULL,   -- create | confirm | correct | delete | expire | addressing
  via         text NOT NULL,   -- app | voice | summarizer | system
  session_id  uuid,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
