-- Mail and WhatsApp get their own standing consent, separate from the calendar's and from connecting the service (P1-D43).
ALTER TABLE signal_consent DROP CONSTRAINT IF EXISTS signal_consent_source_check;
ALTER TABLE signal_consent ADD CONSTRAINT signal_consent_source_check CHECK (source IN ('calendar', 'mail', 'whatsapp'));
