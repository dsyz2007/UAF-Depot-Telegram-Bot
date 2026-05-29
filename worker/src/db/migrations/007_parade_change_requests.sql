-- Round 7 — late-submission approval workflow for parade state.
-- Apply with:
--   npx wrangler d1 execute depot_db --remote --file worker/src/db/migrations/007_parade_change_requests.sql
--
-- New table only. Safe to rerun (CREATE…IF NOT EXISTS).

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS parade_change_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    parade_state_date TEXT NOT NULL,
    period TEXT NOT NULL CHECK (period IN ('AM','PM')),
    new_status TEXT NOT NULL,
    new_reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected','cancelled')),
    superior_user_id INTEGER,
    approval_message_id TEXT,
    approved_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Hot path: look up a user's own pending changes (e.g. "do I have any in flight?").
CREATE INDEX IF NOT EXISTS idx_parade_change_user
    ON parade_change_requests(user_id, status);

-- Hot path: superior callback looks up by request id (PK) — already covered.
