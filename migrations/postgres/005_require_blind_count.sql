-- Blind cash count (cash_register#24). Off by default: hubs that never turn it on keep today's
-- behaviour. When on, `cash_register.current_session` (the query every till user can run) stops
-- carrying `expected_total`; only `cash_register.current_session.expected` (permission
-- `cash_register.view_expected_totals`) reveals it before the count is declared.
ALTER TABLE cash_register_settings ADD COLUMN IF NOT EXISTS require_blind_count INTEGER NOT NULL DEFAULT 0;
