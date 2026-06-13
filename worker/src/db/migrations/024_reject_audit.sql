-- Round 24 — record WHO rejected a request and WHEN, on every approvable type.
-- Apply with:
--   npx wrangler d1 execute depot_db --remote --file worker/src/db/migrations/024_reject_audit.sql
--
-- Lets the Pending page show a "Past Rejections" list (mirroring "Past
-- Approvals") and undo a rejection (reopen it to pending). Before this, sick
-- rejections recorded neither a rejecter nor a timestamp, and off/leave/grant
-- rejections were inconsistent — so there was no reliable way to list or
-- time-window recent rejections. All columns are additive and nullable.

ALTER TABLE off_requests      ADD COLUMN rejected_by INTEGER;
ALTER TABLE off_requests      ADD COLUMN rejected_at TEXT;
ALTER TABLE sick_cases        ADD COLUMN rejected_by INTEGER;
ALTER TABLE sick_cases        ADD COLUMN rejected_at TEXT;
ALTER TABLE leave_requests    ADD COLUMN rejected_by INTEGER;
ALTER TABLE leave_requests    ADD COLUMN rejected_at TEXT;
ALTER TABLE off_credit_grants ADD COLUMN rejected_by INTEGER;
ALTER TABLE off_credit_grants ADD COLUMN rejected_at TEXT;
