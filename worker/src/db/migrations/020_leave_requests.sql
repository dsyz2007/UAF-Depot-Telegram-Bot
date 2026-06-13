-- Round 20 — dedicated Leave requests (LL / OL / Leave (Others)).
-- Apply with:
--   npx wrangler d1 execute depot_db --remote --file worker/src/db/migrations/020_leave_requests.sql
--
-- Leave is NOT credit-tracked (the actual application still happens in OneNS).
-- This table only drives the in-app approval + the optimistic parade display.

CREATE TABLE IF NOT EXISTS leave_requests (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER NOT NULL,
    leave_type          TEXT NOT NULL,                       -- 'LL' | 'OL' | 'Leave (Others)'
    startdate           TEXT NOT NULL,                       -- YYYY-MM-DD
    enddate             TEXT NOT NULL,
    reason              TEXT,
    status              TEXT NOT NULL DEFAULT 'pending',     -- pending|approved|rejected|cancelled|reverted
    approved_by         INTEGER,
    approved_at         TEXT,
    superior_message_id TEXT,
    cancelled_by        INTEGER,
    cancelled_at        TEXT,
    created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_leave_user ON leave_requests(user_id, status);
CREATE INDEX IF NOT EXISTS idx_leave_status ON leave_requests(status);
