-- Round 22 — capture a reason / remarks on a sick (RSI/RSO) report, shown to the
-- approver in the Pending inbox and Recent approvals.
-- Apply with:
--   npx wrangler d1 execute depot_db --remote --file worker/src/db/migrations/022_sick_reason.sql
--
-- Additive column, idempotent-ish (errors "duplicate column name: reason" if re-run).

ALTER TABLE sick_cases ADD COLUMN reason TEXT;
