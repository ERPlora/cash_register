SELECT id, movement_type, amount, payment_method, sale_reference, description, created_at
FROM cash_register_movement
WHERE session_id = :session_id AND hub_id = :hub_id AND is_deleted = 0
ORDER BY created_at DESC
LIMIT 100;
