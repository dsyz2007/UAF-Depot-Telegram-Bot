-- 013_grant_reverted_status.sql
-- Allow an APPROVED off-credit grant to be reverted (credits clawed back),
-- mirroring off_requests' 'reverted' state. SQLite can't alter a CHECK in place,
-- so rebuild the table (copy all columns) with the extended constraint.
PRAGMA foreign_keys = OFF;

CREATE TABLE off_credit_grants_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    granted_by INTEGER NOT NULL,
    num_days INTEGER NOT NULL CHECK (num_days > 0),
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_superior'
        CHECK (status IN ('pending_superior','approved','rejected','cancelled','reverted')),
    superior_user_id INTEGER,
    approval_message_id TEXT,
    approved_at TEXT,
    cancelled_by INTEGER,
    cancelled_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO off_credit_grants_new
    (id, user_id, granted_by, num_days, reason, status, superior_user_id,
     approval_message_id, approved_at, cancelled_by, cancelled_at, created_at)
SELECT
    id, user_id, granted_by, num_days, reason, status, superior_user_id,
    approval_message_id, approved_at, cancelled_by, cancelled_at, created_at
FROM off_credit_grants;
DROP TABLE off_credit_grants;
ALTER TABLE off_credit_grants_new RENAME TO off_credit_grants;
CREATE INDEX IF NOT EXISTS idx_credit_grants_user ON off_credit_grants(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_grants_status ON off_credit_grants(status);

PRAGMA foreign_keys = ON;
