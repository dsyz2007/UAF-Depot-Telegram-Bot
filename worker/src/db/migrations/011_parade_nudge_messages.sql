-- 011_parade_nudge_messages.sql
-- Tracks the most-recent parade-state reminder DM per (user, target date) so a
-- later in-app status update can EDIT that message in place (to show the new
-- AM/PM) instead of sending an additional notification.
--
-- Only today/tomorrow are ever nudged, so this table stays tiny; the daily
-- prune (12:00 SGT cron) deletes rows whose target_date is in the past.
CREATE TABLE IF NOT EXISTS parade_nudge_messages (
  user_id     INTEGER NOT NULL,
  target_date TEXT NOT NULL,            -- YYYY-MM-DD (SGT) the reminder is about
  chat_id     TEXT NOT NULL,            -- recipient telegram_id
  message_id  TEXT NOT NULL,            -- Telegram message_id to edit
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, target_date)
);
