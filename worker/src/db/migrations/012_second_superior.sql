-- 012_second_superior.sql
-- A user can have up to TWO superiors; either one can approve their requests.
-- Additive column — no rebuild needed.
ALTER TABLE users ADD COLUMN superior_telegram_id_2 TEXT;
