-- 015_sick_date.sql
-- The calendar date an RSI/RSO applies to (today or tomorrow, chosen at report
-- time). Used to optimistically set that day's parade state to RSI/RSO on
-- report, and to revert it if the case is rejected/cancelled. Additive column.
ALTER TABLE sick_cases ADD COLUMN sick_date TEXT;
