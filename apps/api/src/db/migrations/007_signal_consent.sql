-- Standing consent to let Rolly understand what matters to the user from a connected source, in the background (P1-D42).
-- Separate from connecting the service: connecting lets Rolly read WHEN ASKED; this lets it look BEFORE a ride. A row records the user's choice;
-- with no row the source is ON (src/signals/consent.ts, P1-D44), and only an 'off' row switches it off.
CREATE TABLE IF NOT EXISTS signal_consent (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source     text NOT NULL CHECK (source IN ('calendar')),   -- mail and whatsapp are added with their own consent screens
  enabled    boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, source)
);
