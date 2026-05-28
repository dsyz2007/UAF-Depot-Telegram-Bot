-- Round 4 — additive columns + parade status remap.
-- Apply with:
--   npx wrangler d1 execute depot_db --remote --file worker/src/db/migrations/004_personnel_type_subdept_status_remap.sql
--
-- All changes are additive. Safe to run once; subsequent runs will hit
-- "duplicate column name" on the ALTERs (harmless — means it's already applied).

PRAGMA foreign_keys = OFF;

-- ============================================================================
-- 1. NSF / Regular labelling on each user
-- ============================================================================
ALTER TABLE users ADD COLUMN personnel_type TEXT;

-- ============================================================================
-- 2. DSP sub-departments (only meaningful when department = 'DSP')
-- ============================================================================
ALTER TABLE users ADD COLUMN sub_department TEXT;

-- ============================================================================
-- 3. Remap legacy parade statuses to the new short codes
--    Off            → OFF
--    Leave          → LL
--    Overseas Leave → OL
--    Attached-Out   → AO
--    (Present, Course, MC, Others stay as-is)
--    New statuses (MA, RSO, RSI) didn't exist before, no remap needed.
-- ============================================================================
UPDATE parade_state_entries SET parade_status = 'OFF' WHERE parade_status = 'Off';
UPDATE parade_state_entries SET parade_status = 'LL'  WHERE parade_status = 'Leave';
UPDATE parade_state_entries SET parade_status = 'OL'  WHERE parade_status = 'Overseas Leave';
UPDATE parade_state_entries SET parade_status = 'AO'  WHERE parade_status = 'Attached-Out';
