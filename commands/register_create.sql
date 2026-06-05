INSERT INTO cash_register_register (id, hub_id, name, is_active, is_deleted, created_by, updated_by, created_at, updated_at)
VALUES (:new_id, :hub_id, :name, 1, 0, :current_user_id, :current_user_id, :now, :now);
