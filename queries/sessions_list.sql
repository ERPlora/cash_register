SELECT id, session_number, status, register_id, opened_at, opening_balance,
       closed_at, closing_balance, expected_balance, difference
FROM cash_register_session
WHERE hub_id = :hub_id AND is_deleted = 0
ORDER BY opened_at DESC
LIMIT 50;
