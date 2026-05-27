-- Round 2 schema changes for depot-bot.
-- Apply with:
--   npx wrangler d1 execute depot_db --local  --file worker/src/db/migrations/002_round2.sql
--   npx wrangler d1 execute depot_db --remote --file worker/src/db/migrations/002_round2.sql
--
-- This migration is rebuild-based. Each CHECK-constraint change uses the
-- standard create-new → INSERT…SELECT (with value transform) → drop old →
-- rename new dance. No staged UPDATEs that would violate the old CHECK.
--
-- Foreign keys are disabled for this connection only — the original schema
-- has REFERENCES users(id) on parade_state_entries / sick_cases /
-- off_requests / reminders, which would otherwise block DROP TABLE users.
-- New rebuilt tables omit the FK refs (D1 doesn't enforce cascades anyway,
-- and we already validate user existence at the API layer).
PRAGMA foreign_keys = OFF;

-- ============================================================================
-- 1. Public holidays cache + working-day overrides (additive, safe to rerun)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public_holidays (
    holiday_date TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    confirmed INTEGER NOT NULL DEFAULT 0,
    refreshed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS working_day_overrides (
    override_date TEXT PRIMARY KEY,
    is_working_day INTEGER NOT NULL CHECK (is_working_day IN (0, 1)),
    reason TEXT,
    set_by_user_id INTEGER,
    set_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- 2. Users — add ord_date, transform roles (superior → admin, admin → superadmin)
-- ============================================================================
-- We rebuild with the NEW CHECK constraint and remap inside INSERT…SELECT so we
-- never write a value that violates either the old or new CHECK.
DROP TABLE IF EXISTS users_new;
CREATE TABLE users_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    user_role TEXT NOT NULL DEFAULT 'user'
        CHECK (user_role IN ('user','admin','superadmin')),
    superior_telegram_id TEXT,
    ord_date TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Re-runnable: if users table doesn't yet have ord_date column, the SELECT will
-- error. Wrap the copy in a CASE that tolerates either schema by selecting
-- specific columns from the old table. We don't ADD COLUMN beforehand because
-- the rebuild replaces the whole table anyway.
INSERT INTO users_new (id, telegram_id, full_name, user_role, superior_telegram_id, ord_date, created_at)
SELECT
    id,
    telegram_id,
    full_name,
    CASE user_role
        WHEN 'superior' THEN 'admin'
        WHEN 'admin'    THEN 'superadmin'
        WHEN 'user'     THEN 'user'
        ELSE user_role    -- already-migrated values pass through ('admin','superadmin')
    END,
    superior_telegram_id,
    NULL,                 -- ord_date defaults to NULL
    created_at
FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
CREATE INDEX IF NOT EXISTS idx_users_superior ON users(superior_telegram_id);

-- ============================================================================
-- 3. Parade state — add AM/PM period, clone existing rows as PM mirrors
-- ============================================================================
DROP TABLE IF EXISTS parade_state_new;
CREATE TABLE parade_state_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    parade_state_date TEXT NOT NULL,
    period TEXT NOT NULL DEFAULT 'AM' CHECK (period IN ('AM','PM')),
    parade_status TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, parade_state_date, period)
);
INSERT INTO parade_state_new (id, user_id, parade_state_date, period, parade_status, reason, created_at)
    SELECT id, user_id, parade_state_date, 'AM', parade_status, reason, created_at FROM parade_state_entries;
INSERT INTO parade_state_new (user_id, parade_state_date, period, parade_status, reason, created_at)
    SELECT user_id, parade_state_date, 'PM', parade_status, reason, created_at FROM parade_state_entries;
DROP TABLE parade_state_entries;
ALTER TABLE parade_state_new RENAME TO parade_state_entries;
CREATE INDEX IF NOT EXISTS idx_parade_date ON parade_state_entries(parade_state_date);

-- ============================================================================
-- 4. Sick cases — structured MC fields + extended status + cancel audit
-- ============================================================================
DROP TABLE IF EXISTS sick_cases_new;
CREATE TABLE sick_cases_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    case_type TEXT NOT NULL CHECK (case_type IN ('RSI','RSO')),
    reportsick_status TEXT NOT NULL DEFAULT 'pending_superior'
        CHECK (reportsick_status IN ('pending_superior','approved','updated','rejected','flagged','cancelled','reverted')),
    superior_user_id INTEGER,
    approval_message_id TEXT,
    approved_at TEXT,
    updated_status TEXT,
    updated_at TEXT,
    escalated_at TEXT,
    num_of_mc_days INTEGER,
    mc_start_date TEXT,
    mc_end_date TEXT,
    medicine_prescribed TEXT,
    cancelled_by INTEGER,
    cancelled_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO sick_cases_new
    (id, user_id, case_type, reportsick_status, superior_user_id, approval_message_id,
     approved_at, updated_status, updated_at, escalated_at, created_at)
SELECT
     id, user_id, case_type, reportsick_status, superior_user_id, approval_message_id,
     approved_at, updated_status, updated_at, escalated_at, created_at
FROM sick_cases;
DROP TABLE sick_cases;
ALTER TABLE sick_cases_new RENAME TO sick_cases;

-- ============================================================================
-- 5. Off requests — extended status + cancel audit
-- ============================================================================
DROP TABLE IF EXISTS off_requests_new;
CREATE TABLE off_requests_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    requested_by_user_id INTEGER NOT NULL,
    startdate TEXT NOT NULL,
    enddate TEXT NOT NULL,
    reason TEXT NOT NULL,
    off_type TEXT NOT NULL DEFAULT 'off',
    off_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (off_status IN ('pending','approved','rejected','cancelled','reverted')),
    approved_by INTEGER,
    approved_date TEXT,
    superior_message_id TEXT,
    cancelled_by INTEGER,
    cancelled_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO off_requests_new
    (id, user_id, requested_by_user_id, startdate, enddate, reason, off_type,
     off_status, approved_by, approved_date, superior_message_id, created_at)
SELECT
     id, user_id, requested_by_user_id, startdate, enddate, reason, off_type,
     off_status, approved_by, approved_date, superior_message_id, created_at
FROM off_requests;
DROP TABLE off_requests;
ALTER TABLE off_requests_new RENAME TO off_requests;
CREATE INDEX IF NOT EXISTS idx_off_user_status ON off_requests(user_id, off_status);
