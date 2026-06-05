SELECT id, name, is_active FROM cash_register_register
WHERE hub_id = :hub_id AND is_deleted = 0 AND is_active = 1
ORDER BY name ASC;
