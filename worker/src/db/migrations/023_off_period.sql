-- Round 23 — off requests can be a HALF day (AM or PM), not just full-day.
-- Apply with:
--   npx wrangler d1 execute depot_db --remote --file worker/src/db/migrations/023_off_period.sql
--
-- 'FD' = full day, 'AM'/'PM' = that half only. A half-day costs 0.5 credits per
-- day in the range (full day costs 1). Additive column.

ALTER TABLE off_requests ADD COLUMN period TEXT NOT NULL DEFAULT 'FD';
