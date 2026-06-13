-- 017_forecast_views.sql
-- Per-viewer daily counter for "view a person's month forecast". Enforces the
-- daily caps (users: not allowed; admins: 15/day; superadmins: 50/day). Rows
-- are pruned by the daily cron once the date is past.
CREATE TABLE IF NOT EXISTS forecast_views (
  viewer_id INTEGER NOT NULL,
  view_date TEXT NOT NULL,          -- YYYY-MM-DD (SGT)
  count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (viewer_id, view_date)
);
