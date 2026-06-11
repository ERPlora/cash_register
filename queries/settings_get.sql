-- Configuración de caja del hub (singleton por hub, índice único uq_cashreg_settings_hub).
-- Runtime inyecta :hub_id. Si no existe fila aún, la UI usa los defaults del esquema
-- (migrations/sqlite/001_init.sql).
SELECT id,
       enable_cash_register, require_opening_balance, require_closing_balance,
       allow_negative_balance, auto_open_session_on_login, auto_close_session_on_logout,
       protected_pos_url
FROM cash_register_settings
WHERE hub_id = :hub_id AND is_deleted = 0
LIMIT 1;
