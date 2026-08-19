-- Automatic daily close of the cash session (cash_register#23).
--
-- `auto_close_enabled` (off by default) + `auto_close_time` (HH:MM in the BUSINESS time zone): the
-- scheduled task `auto_close_sessions` closes, once the cut-off has passed, every session still
-- open that was opened before it — Toast closes every open drawer at the business-day cut-off
-- (4:00 AM by default), Lightspeed Restaurant runs the Z report at closing time.
--
-- `auto_open_session_on_login` / `auto_close_session_on_logout` are DROPPED: nobody ever read them
-- (no consumer in the hub shell nor in this module) and no reference product opens a drawer on
-- login or closes it on logout — a setting nobody honours is a lie in the settings screen.
ALTER TABLE cash_register_settings ADD COLUMN IF NOT EXISTS auto_close_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cash_register_settings ADD COLUMN IF NOT EXISTS auto_close_time TEXT NOT NULL DEFAULT '04:00';
ALTER TABLE cash_register_settings DROP COLUMN IF EXISTS auto_open_session_on_login;
ALTER TABLE cash_register_settings DROP COLUMN IF EXISTS auto_close_session_on_logout;
