-- Round 8 — MC file attachment (Telegram file_id) + sick report location/time.
-- Apply with:
--   npx wrangler d1 execute depot_db --remote --file worker/src/db/migrations/008_mc_file_and_location.sql
--
-- Additive columns only. Re-running hits "duplicate column name" (harmless).

PRAGMA foreign_keys = OFF;

-- MC document stored on Telegram's servers; we keep only the reference.
ALTER TABLE sick_cases ADD COLUMN mc_file_id TEXT;
ALTER TABLE sick_cases ADD COLUMN mc_file_type TEXT;   -- 'photo' | 'document'

-- Replaces the old medicine_prescribed field in the update form.
ALTER TABLE sick_cases ADD COLUMN location TEXT;
ALTER TABLE sick_cases ADD COLUMN approx_time TEXT;
-- (medicine_prescribed column is left in place but no longer written/read.)
