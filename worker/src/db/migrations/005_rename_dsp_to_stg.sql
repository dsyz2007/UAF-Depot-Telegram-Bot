-- Round 5 — rename department DSP → STG.
-- Apply with:
--   npx wrangler d1 execute depot_db --remote --file worker/src/db/migrations/005_rename_dsp_to_stg.sql
--
-- The department column is plain TEXT (no CHECK constraint), so a simple
-- UPDATE is enough — no table rebuild. Idempotent: if there are no rows with
-- DSP, the UPDATE is a no-op.

UPDATE users SET department = 'STG' WHERE department = 'DSP';
