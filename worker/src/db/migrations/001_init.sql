-- Initial schema for depot-bot.
-- Apply with:
--   npx wrangler d1 execute depot_db --local  --file worker/src/db/migrations/001_init.sql
--   npx wrangler d1 execute depot_db --remote --file worker/src/db/migrations/001_init.sql

-- USERS ----------------------------------------------------------------------
-- One row per personnel. telegram_id is the canonical ID (we never trust the
-- client to send it; we extract it from the verified initData / webhook update).
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    user_role TEXT NOT NULL DEFAULT 'user'
        CHECK (user_role IN ('user','superior','admin')),
    superior_telegram_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- OFF REQUESTS ---------------------------------------------------------------
-- requested_by_user_id distinguishes "I asked for myself" vs "my superior
-- entered this on my behalf as already-approved".
CREATE TABLE IF NOT EXISTS off_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    requested_by_user_id INTEGER NOT NULL REFERENCES users(id),
    startdate TEXT NOT NULL,
    enddate TEXT NOT NULL,
    reason TEXT NOT NULL,
    off_type TEXT NOT NULL DEFAULT 'off',
    off_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (off_status IN ('pending','approved','rejected','cancelled')),
    approved_by INTEGER REFERENCES users(id),
    approved_date TEXT,
    superior_message_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- SICK CASES -----------------------------------------------------------------
-- State machine: pending_superior -> approved -> updated | flagged
CREATE TABLE IF NOT EXISTS sick_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    case_type TEXT NOT NULL CHECK (case_type IN ('RSI','RSO')),
    reportsick_status TEXT NOT NULL DEFAULT 'pending_superior'
        CHECK (reportsick_status IN ('pending_superior','approved','updated','rejected','flagged')),
    superior_user_id INTEGER REFERENCES users(id),
    approval_message_id TEXT,
    approved_at TEXT,
    updated_status TEXT,
    updated_at TEXT,
    escalated_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- PARADE STATE ENTRIES -------------------------------------------------------
-- One row per (user, date). Allowed parade_status values (free text but
-- the UI dropdown enforces these): Present, Off, Leave, MC, Course, Duty,
-- Detached, AWOL, Others.
CREATE TABLE IF NOT EXISTS parade_state_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    parade_state_date TEXT NOT NULL,
    parade_status TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, parade_state_date)
);

-- REMINDERS ------------------------------------------------------------------
-- Generic delayed-task table. The */5min cron drains it. related_type tells
-- the worker which handler to invoke (e.g. 'sick_case', 'parade_state').
CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    related_type TEXT NOT NULL,
    related_id INTEGER NOT NULL,
    due_at TEXT NOT NULL,
    reminder_type TEXT NOT NULL,
    sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- INDEXES --------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_reminders_due
    ON reminders(due_at) WHERE sent_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_parade_date
    ON parade_state_entries(parade_state_date);

CREATE INDEX IF NOT EXISTS idx_off_user_status
    ON off_requests(user_id, off_status);

CREATE INDEX IF NOT EXISTS idx_users_superior
    ON users(superior_telegram_id);
