-- Round 9 — rename parade status value 'Others' → 'Leave (Others)'.
-- Apply with:
--   npx wrangler d1 execute depot_db --remote --file worker/src/db/migrations/009_rename_others_status.sql
--
-- parade_status / new_status are plain TEXT (no CHECK), so simple UPDATEs.
-- Idempotent: no-op once values are already renamed.

PRAGMA foreign_keys = OFF;

UPDATE parade_state_entries   SET parade_status = 'Leave (Others)' WHERE parade_status = 'Others';
UPDATE parade_change_requests SET new_status    = 'Leave (Others)' WHERE new_status    = 'Others';
