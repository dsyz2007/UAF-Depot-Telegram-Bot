-- Round 18 — working-day overrides gain AM/PM split + department scoping.
-- Apply with:
--   npx wrangler d1 execute depot_db --remote --file worker/src/db/migrations/018_overrides_period_dept.sql
--
-- A superadmin can now force a HALF day (AM or PM) non-working/working, and
-- scope it to ALL departments (departments = NULL) or a subset (CSV, e.g.
-- 'DHQ,DMSP'). Existing whole-day overrides become period = 'FD', all depts.
--
-- Rebuild needed: the PK changes from (override_date) to (override_date, period).

PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS working_day_overrides_new;
CREATE TABLE working_day_overrides_new (
    override_date  TEXT NOT NULL,
    period         TEXT NOT NULL DEFAULT 'FD' CHECK (period IN ('AM', 'PM', 'FD')),
    departments    TEXT,                       -- NULL = all departments; else CSV like 'DHQ,DMSP'
    is_working_day INTEGER NOT NULL CHECK (is_working_day IN (0, 1)),
    reason         TEXT,
    set_by_user_id INTEGER,
    set_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (override_date, period)
);

INSERT INTO working_day_overrides_new
    (override_date, period, departments, is_working_day, reason, set_by_user_id, set_at)
SELECT override_date, 'FD', NULL, is_working_day, reason, set_by_user_id, set_at
FROM working_day_overrides;

DROP TABLE working_day_overrides;
ALTER TABLE working_day_overrides_new RENAME TO working_day_overrides;
