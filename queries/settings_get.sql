-- Cash register settings of the hub (one row per hub, unique index uq_cashreg_settings_hub).
-- The runtime injects :hub_id. If no row exists yet, the UI uses the schema defaults
-- (schemas/settings_update.json).
SELECT id,
       enable_cash_register, require_opening_balance, require_closing_balance,
       allow_negative_balance, require_blind_count,
       auto_open_session_on_login, auto_close_session_on_logout,
       protected_pos_url
FROM cash_register_settings
WHERE hub_id = :hub_id AND is_deleted = 0
LIMIT 1;
