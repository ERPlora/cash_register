-- PG-compat (auditoría pm#16, 07-17): los binds BOOLEANOS del schema van envueltos en
-- CASE WHEN :x THEN 1 WHEN NOT :x THEN 0 END — las columnas son INTEGER 0/1 por contrato
-- (§2.5) y Postgres NO castea boolean→bigint (SQLite sí lo toleraba). El tri-estado
-- preserva NULL para los COALESCE de opcionales.
-- Upsert de la configuración de caja (singleton por hub). Runtime inyecta :new_id,
-- :hub_id, :current_user_id, :now. La UI envía el snapshot completo; aquí persistimos
-- el estado entero. ON CONFLICT(hub_id) actualiza la fila existente (y la revive si
-- estaba soft-borrada).
INSERT INTO cash_register_settings
  (id, hub_id, enable_cash_register, require_opening_balance, require_closing_balance,
   allow_negative_balance, auto_open_session_on_login, auto_close_session_on_logout,
   protected_pos_url,
   is_deleted, created_by, updated_by, created_at, updated_at)
VALUES
  (:new_id, :hub_id, CASE WHEN :enable_cash_register THEN 1 WHEN NOT :enable_cash_register THEN 0 END, CASE WHEN :require_opening_balance THEN 1 WHEN NOT :require_opening_balance THEN 0 END, CASE WHEN :require_closing_balance THEN 1 WHEN NOT :require_closing_balance THEN 0 END,
   CASE WHEN :allow_negative_balance THEN 1 WHEN NOT :allow_negative_balance THEN 0 END, CASE WHEN :auto_open_session_on_login THEN 1 WHEN NOT :auto_open_session_on_login THEN 0 END, CASE WHEN :auto_close_session_on_logout THEN 1 WHEN NOT :auto_close_session_on_logout THEN 0 END,
   :protected_pos_url,
   0, :current_user_id, :current_user_id, :now, :now)
ON CONFLICT(hub_id) DO UPDATE SET
  enable_cash_register         = excluded.enable_cash_register,
  require_opening_balance      = excluded.require_opening_balance,
  require_closing_balance      = excluded.require_closing_balance,
  allow_negative_balance       = excluded.allow_negative_balance,
  auto_open_session_on_login   = excluded.auto_open_session_on_login,
  auto_close_session_on_logout = excluded.auto_close_session_on_logout,
  protected_pos_url            = excluded.protected_pos_url,
  is_deleted                   = 0,
  deleted_at                   = NULL,
  updated_by                   = :current_user_id,
  updated_at                   = :now;
