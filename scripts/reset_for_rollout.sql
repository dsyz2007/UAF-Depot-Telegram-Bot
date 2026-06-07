-- reset_for_rollout.sql
-- ONE-OFF test-data wipe before the official rollout. NOT a migration — run it
-- manually, once. It is IRREVERSIBLE: export a backup first (see README/command).
--
-- KEEPS: all users (names, roles, superiors, departments, ORD dates),
--        public_holidays, working_day_overrides.
-- CLEARS: off requests + off-credit grants + everyone's credit balance,
--         all RSI/RSO cases, and their pending reminders.

-- 1. Off requests (off counts / offs taken)
DELETE FROM off_requests;

-- 2. Off-credit grant records (history + any pending grants)
DELETE FROM off_credit_grants;

-- 3. Zero every user's off-credit balance
UPDATE users SET off_credits = 0;

-- 4. RSI / RSO cases
DELETE FROM sick_cases;

-- 5. Pending sick-case reminders (now orphaned)
DELETE FROM reminders WHERE related_type = 'sick_case';

-- ── OPTIONAL: also wipe parade-state test data ───────────────────────────────
-- You did NOT ask for this, so it's left commented out. Uncomment if you also
-- want a clean parade calendar at rollout.
-- DELETE FROM parade_state_entries;
-- DELETE FROM parade_change_requests;
-- DELETE FROM parade_nudge_messages;
