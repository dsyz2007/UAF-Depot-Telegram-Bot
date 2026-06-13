-- Round 19 — rename department STG → DSP and combine the two DSP sub-sections.
-- Apply with:
--   npx wrangler d1 execute depot_db --remote --file worker/src/db/migrations/019_rename_stg_to_dsp.sql
--
-- STG used to be split into sub-sections C1+C2 (shown "DSP 1+2") and C3+C4
-- ("DSP 3+4"). They are now merged into a single department called "DSP" with
-- no sub-section. The department column is plain TEXT (no CHECK constraint), so
-- a simple UPDATE suffices. Idempotent: no-op if there are no STG rows.

UPDATE users SET department = 'DSP', sub_department = NULL WHERE department = 'STG';
