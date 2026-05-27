-- Round 3: off-credit system + department classification.
-- Apply with:
--   npx wrangler d1 execute depot_db --remote --file worker/src/db/migrations/003_off_credits_and_department.sql
--
-- All changes are additive (ALTER TABLE ADD COLUMN + new table). No table
-- rebuilds, so no FK issues. Safe to run once. If re-run, the ALTER TABLE
-- statements will fail with "duplicate column name" — that's expected and
-- means the column already exists.

PRAGMA foreign_keys = OFF;

-- ============================================================================
-- 1. Department classification (DHQ / DMSP / DCS / DSP / Others)
-- ============================================================================
ALTER TABLE users ADD COLUMN department TEXT;

-- ============================================================================
-- 2. Off-credit balance on each user
-- ============================================================================
ALTER TABLE users ADD COLUMN off_credits INTEGER NOT NULL DEFAULT 0;

-- ============================================================================
-- 3. Off-credit grants — audit trail + superior-approval workflow
-- ============================================================================
CREATE TABLE IF NOT EXISTS off_credit_grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,           -- recipient
    granted_by INTEGER NOT NULL,        -- admin who initiated
    num_days INTEGER NOT NULL CHECK (num_days > 0),
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_superior'
        CHECK (status IN ('pending_superior','approved','rejected','cancelled')),
    superior_user_id INTEGER,
    approval_message_id TEXT,
    approved_at TEXT,
    cancelled_by INTEGER,
    cancelled_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_credit_grants_user ON off_credit_grants(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_grants_status ON off_credit_grants(status);
