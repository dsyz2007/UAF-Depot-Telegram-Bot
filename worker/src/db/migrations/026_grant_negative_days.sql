-- 026_grant_negative_days.sql
-- Allow NEGATIVE off-credit grants — a deduction by a unit appointment-holder or
-- DHQ. The old CHECK (num_days > 0) (from 003, kept by 013's rebuild) made every
-- deduction fail on INSERT (HTTP 500). SQLite can't alter a CHECK in place, so
-- rebuild the table (copy every column, incl. 024's rejected_by/rejected_at),
-- keeping only "non-zero" — the app already rejects a 0-day grant.
-- Safe to re-run: the leading DROP clears any half-built copy from a failed run.
PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS off_credit_grants_new;
CREATE TABLE off_credit_grants_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    granted_by INTEGER NOT NULL,
    num_days INTEGER NOT NULL CHECK (num_days <> 0),
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_superior'
        CHECK (status IN ('pending_superior','approved','rejected','cancelled','reverted')),
    superior_user_id INTEGER,
    approval_message_id TEXT,
    approved_at TEXT,
    cancelled_by INTEGER,
    cancelled_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    rejected_by INTEGER,
    rejected_at TEXT
);
INSERT INTO off_credit_grants_new
    (id, user_id, granted_by, num_days, reason, status, superior_user_id,
     approval_message_id, approved_at, cancelled_by, cancelled_at, created_at,
     rejected_by, rejected_at)
SELECT
    id, user_id, granted_by, num_days, reason, status, superior_user_id,
    approval_message_id, approved_at, cancelled_by, cancelled_at, created_at,
    rejected_by, rejected_at
FROM off_credit_grants;
-- Keep the AUTOINCREMENT high-water mark. A plain copy resets it to MAX(id), so
-- ids of deleted grants (user deletion / 2-year prune) could be handed out again
-- — and a stale Approve/Reject DM button would then act on the NEW grant. Bump the
-- counter by inserting, then deleting, a placeholder at the old sequence value.
INSERT INTO off_credit_grants_new (id, user_id, granted_by, num_days, reason, status)
SELECT MAX(seq), 0, 0, 1, '026 sequence placeholder', 'cancelled'
FROM sqlite_sequence
WHERE name = 'off_credit_grants'
HAVING MAX(seq) > (SELECT IFNULL(MAX(id), 0) FROM off_credit_grants_new);
DELETE FROM off_credit_grants_new WHERE reason = '026 sequence placeholder';
DROP TABLE off_credit_grants;
ALTER TABLE off_credit_grants_new RENAME TO off_credit_grants;
CREATE INDEX IF NOT EXISTS idx_credit_grants_user ON off_credit_grants(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_grants_status ON off_credit_grants(status);

PRAGMA foreign_keys = ON;
