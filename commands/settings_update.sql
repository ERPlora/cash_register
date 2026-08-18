-- Upsert of the cash register settings (one row per hub). The runtime injects :new_id, :hub_id,
-- :current_user_id, :now. The UI sends the full snapshot; the whole state is persisted here.
-- ON CONFLICT(hub_id) updates the existing row (and revives it if it was soft-deleted).
INSERT INTO cash_register_settings
  (id, hub_id, enable_cash_register, require_opening_balance, require_closing_balance,
   allow_negative_balance, require_blind_count, auto_open_session_on_login, auto_close_session_on_logout,
   protected_pos_url,
   is_deleted, created_by, updated_by, created_at, updated_at)
VALUES
  (:new_id, :hub_id, :enable_cash_register, :require_opening_balance, :require_closing_balance,
   :allow_negative_balance, COALESCE(:require_blind_count, 0), :auto_open_session_on_login, :auto_close_session_on_logout,
   :protected_pos_url,
   0, :current_user_id, :current_user_id, :now, :now)
ON CONFLICT(hub_id) DO UPDATE SET
  enable_cash_register         = excluded.enable_cash_register,
  require_opening_balance      = excluded.require_opening_balance,
  require_closing_balance      = excluded.require_closing_balance,
  allow_negative_balance       = excluded.allow_negative_balance,
  require_blind_count          = excluded.require_blind_count,
  auto_open_session_on_login   = excluded.auto_open_session_on_login,
  auto_close_session_on_logout = excluded.auto_close_session_on_logout,
  protected_pos_url            = excluded.protected_pos_url,
  is_deleted                   = 0,
  deleted_at                   = NULL,
  updated_by                   = :current_user_id,
  updated_at                   = :now;
