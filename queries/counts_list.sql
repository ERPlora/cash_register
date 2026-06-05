SELECT id, count_type, total, denominations, notes, counted_at
FROM cash_register_count
WHERE session_id = :session_id AND hub_id = :hub_id AND is_deleted = 0
ORDER BY counted_at ASC;
