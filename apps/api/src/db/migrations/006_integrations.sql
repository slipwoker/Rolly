-- Connected services per user (Google: calendar + mail, read only). The refresh token is stored sealed (AES-256-GCM, src/integrations/crypto.ts).
CREATE TABLE IF NOT EXISTS integrations (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      text NOT NULL,              -- google
  refresh_enc   text NOT NULL,              -- iv.tag.ciphertext, base64url
  scopes        text NOT NULL DEFAULT '',
  account_label text,                       -- the connected account's email, shown in the app
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);
