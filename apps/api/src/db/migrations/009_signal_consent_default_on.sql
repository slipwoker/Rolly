-- The default is now ON (no row = on, src/signals/consent.ts). Accounts that exist at this moment connected their
-- services for "read when I ask", so they start OFF until they switch it on; every account created after this is on.
INSERT INTO signal_consent(user_id, source, enabled)
SELECT u.id, s.source, false FROM users u CROSS JOIN (VALUES ('calendar'), ('mail'), ('whatsapp')) AS s(source)
ON CONFLICT (user_id, source) DO NOTHING;
