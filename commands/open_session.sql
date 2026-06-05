-- Abre una sesión de caja para el usuario activo. Runtime inyecta :new_id, :hub_id,
-- :current_user_id, :now. session_number = INICIALES-YYMMDD-HHMM lo arma la UI/SDK (:session_number).
INSERT INTO cash_register_session
  (id, hub_id, user_id, register_id, session_number, status, opened_at, opening_balance, opening_notes,
   is_deleted, created_by, updated_by, created_at, updated_at)
VALUES
  (:new_id, :hub_id, :current_user_id, :register_id, :session_number, 'open', :now, :opening_balance, :opening_notes,
   0, :current_user_id, :current_user_id, :now, :now);
