-- Movimiento manual de caja (in/out/refund/sale). Runtime inyecta :new_id, :hub_id, :current_user_id, :now.
INSERT INTO cash_register_movement
  (id, hub_id, session_id, movement_type, amount, payment_method, sale_reference, description, employee_id,
   is_deleted, created_by, updated_by, created_at, updated_at)
VALUES
  (:new_id, :hub_id, :session_id, :movement_type, :amount, :payment_method, :sale_reference, :description, :current_user_id,
   0, :current_user_id, :current_user_id, :now, :now);
