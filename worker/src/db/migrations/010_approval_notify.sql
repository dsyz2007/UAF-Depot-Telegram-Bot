-- Round 10 — throttle column for the consolidated approval digest.
-- Apply with:
--   npx wrangler d1 execute depot_db --remote --file worker/src/db/migrations/010_approval_notify.sql
--
-- Additive. Re-running hits "duplicate column name" (harmless).

PRAGMA foreign_keys = OFF;

-- Last time this user (as a superior) was sent a "pending approvals" digest DM.
-- Used to throttle the digest so a superior with many staff isn't spammed.
ALTER TABLE users ADD COLUMN last_approval_notify_at TEXT;
