-- 016_appointments.sql
-- Replace the manual superior_telegram_id model with department appointments.
-- Each user may hold an appointment (WOIC / 2IC / PC) within their department
-- "unit" (for STG, the unit is the sub-section DSP 1+2 / DSP 3+4). A person's
-- approvers = everyone in the SAME unit who holds an appointment; if their unit
-- has none (or they have no department) → all superadmins. self_managed bypasses
-- approval entirely (explicit checkbox).
ALTER TABLE users ADD COLUMN appointment TEXT;                       -- 'WOIC' | '2IC' | 'PC' | NULL
ALTER TABLE users ADD COLUMN self_managed INTEGER NOT NULL DEFAULT 0;

-- Preserve existing self-managed accounts (old model: superior == own telegram_id).
UPDATE users SET self_managed = 1 WHERE superior_telegram_id = telegram_id;

-- Index for the per-unit approver lookups.
CREATE INDEX IF NOT EXISTS idx_users_appointment
    ON users(department, sub_department) WHERE appointment IS NOT NULL;
