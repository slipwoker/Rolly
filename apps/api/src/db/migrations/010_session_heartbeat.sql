-- A running conversation reports that it is alive (every 30 s). A session that never ended and has been silent for minutes
-- was cut off (a deploy, a crash): its turns, written as they happened, are then summarised by whoever notices
-- (memory/recover.ts). Without this, everything said in a cut-off conversation was lost.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
CREATE INDEX IF NOT EXISTS sessions_open ON sessions (started_at) WHERE ended_at IS NULL;
