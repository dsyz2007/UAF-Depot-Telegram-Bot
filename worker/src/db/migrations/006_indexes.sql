-- Round 6 — fill in missing indexes that the audit identified.
-- Apply with:
--   npx wrangler d1 execute depot_db --remote --file worker/src/db/migrations/006_indexes.sql
--
-- Pure CREATE INDEX IF NOT EXISTS — safe to run multiple times. No data
-- changes, no rebuilds, no FK issues.

PRAGMA foreign_keys = OFF;

-- sick_cases: the 002 rebuild dropped its indexes. /api/sick/my-open and the
-- per-user cancel/revert queries were doing full scans.
CREATE INDEX IF NOT EXISTS idx_sick_user_status
    ON sick_cases(user_id, reportsick_status);

-- /api/today fetches open + pending sick cases — filters by status only.
CREATE INDEX IF NOT EXISTS idx_sick_status
    ON sick_cases(reportsick_status);

-- /api/today's "approved offs covering today" filter starts with off_status,
-- which the existing idx_off_user_status (user_id, off_status) can't serve.
CREATE INDEX IF NOT EXISTS idx_off_status_enddate
    ON off_requests(off_status, enddate);

-- Sick update/revert deletes pending reminders by (related_type, related_id);
-- without this index every cancel was a SCAN of reminders.
CREATE INDEX IF NOT EXISTS idx_reminders_related
    ON reminders(related_type, related_id);

-- Daily ORD cron filters users by ord_date. Most users have NULL ord_date so
-- a partial index gives us index speed at minimal write/storage cost.
CREATE INDEX IF NOT EXISTS idx_users_ord_date
    ON users(ord_date) WHERE ord_date IS NOT NULL;
