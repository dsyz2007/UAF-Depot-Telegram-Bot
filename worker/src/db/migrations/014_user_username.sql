-- 014_user_username.sql
-- Store each user's Telegram @username (handle) so admins can map handle ↔
-- telegram_id ↔ assigned name. Captured on /start and on WebApp open; existing
-- users can be backfilled in one pass via the Admin "Backfill handles" button
-- (uses getChat by id). Stored WITHOUT the leading '@'. Additive column.
ALTER TABLE users ADD COLUMN username TEXT;
