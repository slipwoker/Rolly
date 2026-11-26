-- Landing-page waiting list (apps/site). Only what is needed to tell someone the app is ready: the email, the page
-- language, where they came from (utm/referrer, optional) and when. No IP address is stored.
CREATE TABLE IF NOT EXISTS waitlist (
  id          bigserial PRIMARY KEY,
  email       text NOT NULL,
  lang        text,
  source      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_email_key ON waitlist (lower(email));
