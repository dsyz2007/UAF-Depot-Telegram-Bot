-- Round 21 — leave can be a HALF day (AM or PM), not just full-day.
-- Apply with:
--   npx wrangler d1 execute depot_db --remote --file worker/src/db/migrations/021_leave_period.sql
--
-- Additive column. 'FD' = full day (AM + PM), 'AM' / 'PM' = that half only.

ALTER TABLE leave_requests ADD COLUMN period TEXT NOT NULL DEFAULT 'FD';
