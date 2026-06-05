-- Arqueo de caja (total ya calculado por el handler desde denominaciones).
-- Runtime inyecta :hub_id, :current_user_id, :now.
INSERT INTO cash_register_count
  (id, hub_id, session_id, count_type, denominations, total, notes, counted_at,
   is_deleted, created_by, updated_by, created_at, updated_at)
VALUES
  (:count_id, :hub_id, :session_id, :count_type, :denominations, :total, :notes, :now,
   0, :current_user_id, :current_user_id, :now, :now);
