-- The hub currency's scale for the till count (cash_register#111), preloaded into the WASM handler
-- of `cash_register.count.add` (ADR-0069 `reads`): the sandbox cannot read the database, and the
-- scale must not come from the payload. ALWAYS one row — a hub that never set its currency reads two
-- NULLs, which the handler resolves like the runtime does (no currency → EUR; `currency_decimals`
-- declared by hand wins over the ISO-4217 registry). The runtime injects :hub_id.
SELECT
  (SELECT h.value FROM hub_settings h WHERE h.hub_id = :hub_id AND h.key = 'currency') AS currency,
  (SELECT h.value FROM hub_settings h WHERE h.hub_id = :hub_id AND h.key = 'currency_decimals') AS currency_decimals;
