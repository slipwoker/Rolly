-- How the user's name is pronounced, when the user corrected it by voice (P1-D39): {"name": "...", "ipa": "...", "source": "user"}.
-- Reset when the name changes. The pod pins a name that its Hebrew front end reads differently by position without this.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS name_pron jsonb;
