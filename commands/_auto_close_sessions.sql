-- Automatic daily close (cash_register#23). Run by the scheduled task `auto_close_sessions` every
-- few minutes with the SYSTEM context (no user); it does nothing unless the hub turned
-- `auto_close_enabled` on.
--
-- Semantics (Toast "business-day cut-off", Lightspeed "closing time"): `auto_close_time` is an
-- HH:MM in the BUSINESS time zone. The most recent cut-off instant not after :now is computed
-- (today's if it already passed, otherwise yesterday's) and every session still `open` that was
-- opened BEFORE that instant is closed. That is also what makes catch-up correct: a hub that slept
-- through the cut-off closes the stale session on its first run next morning, and leaves alone the
-- session somebody opened after the cut-off (today's shift).
--
-- The close mirrors `close_session.sql`: `expected_balance` = opening + Σ cash movements, but
-- `closing_balance` stays NULL — nobody counted the drawer, and inventing a counted amount would
-- fake a reconciliation (`difference` stays NULL too, like the migration 004 auto-close). The row
-- is attributed to the system (`:current_user_id` is empty in the scheduler context) and marked in
-- `closing_notes`.
--
-- TIME ZONE. The runtime binds no `:timezone`; like `taxes` reads `hub_settings.country_code`
-- (ADR-0085), the business zone is read here: an explicit `hub_settings.timezone` (IANA name,
-- hub#731) wins, else the country/region decides (the same table `settings::zone_for_country`
-- uses for the countries this product ships to), else UTC. `:now` is ALWAYS wrapped in
-- `CAST(:now AS TEXT)`: Postgres deduces a bind's type from its first use and the runtime binds it
-- as a string, so a bare `(:now)::timestamptz` would deduce timestamptz and the statement would not
-- even PREPARE next to the TEXT columns (whatsapp_inbox#24).
-- SIGNO (cash_register#48): el sentido lo da `movement_type`, no el signo guardado — `-ABS()` para
-- `out`/`refund`, `ABS()` para `in`/`sale`. Una fila mal firmada (salida en positivo) hacía que el
-- cierre cuadrase contra un esperado falso y el cajero pagaba un descuadre que no cometió.
WITH clock AS (
  SELECT erp_dt(CAST(:now AS TEXT)) AS now_utc
), zone AS (
  SELECT COALESCE(
    NULLIF(TRIM((SELECT h.value FROM hub_settings h WHERE h.hub_id = :hub_id AND h.key = 'timezone')), ''),
    CASE UPPER(TRIM(COALESCE((SELECT h.value FROM hub_settings h WHERE h.hub_id = :hub_id AND h.key = 'region_code'), '')))
      WHEN 'ES-CN' THEN 'Atlantic/Canary'
      WHEN 'PT-20' THEN 'Atlantic/Azores'
      WHEN 'PT-30' THEN 'Atlantic/Madeira'
    END,
    CASE UPPER(TRIM(COALESCE((SELECT h.value FROM hub_settings h WHERE h.hub_id = :hub_id AND h.key = 'country_code'), 'ES')))
      WHEN 'ES' THEN 'Europe/Madrid'  WHEN 'PT' THEN 'Europe/Lisbon'  WHEN 'AD' THEN 'Europe/Andorra'
      WHEN 'FR' THEN 'Europe/Paris'   WHEN 'IT' THEN 'Europe/Rome'    WHEN 'DE' THEN 'Europe/Berlin'
      WHEN 'GB' THEN 'Europe/London'  WHEN 'IE' THEN 'Europe/Dublin'  WHEN 'NL' THEN 'Europe/Amsterdam'
      WHEN 'BE' THEN 'Europe/Brussels' WHEN 'AT' THEN 'Europe/Vienna' WHEN 'CH' THEN 'Europe/Zurich'
      WHEN 'GR' THEN 'Europe/Athens'  WHEN 'PL' THEN 'Europe/Warsaw'  WHEN 'RO' THEN 'Europe/Bucharest'
      WHEN 'MX' THEN 'America/Mexico_City' WHEN 'AR' THEN 'America/Argentina/Buenos_Aires'
      WHEN 'CL' THEN 'America/Santiago' WHEN 'CO' THEN 'America/Bogota' WHEN 'PE' THEN 'America/Lima'
      ELSE 'UTC'
    END
  ) AS name
), cfg AS (
  SELECT c.auto_close_enabled, c.auto_close_time
  FROM cash_register_settings c
  WHERE c.hub_id = :hub_id AND c.is_deleted = 0
  LIMIT 1
), cutoff AS (
  -- Local wall clock → today's cut-off; if it has not happened yet, yesterday's. Back to UTC.
  SELECT (CASE WHEN (l.local_now::date + cfg.auto_close_time::time) <= l.local_now
               THEN (l.local_now::date + cfg.auto_close_time::time)
               ELSE (l.local_now::date + cfg.auto_close_time::time) - INTERVAL '1 day'
          END) AT TIME ZONE zone.name AS last_cutoff_utc,
         clock.now_utc
  FROM cfg, zone, clock,
       LATERAL (SELECT clock.now_utc AT TIME ZONE zone.name AS local_now) l
  WHERE cfg.auto_close_enabled = 1
)
UPDATE cash_register_session s
SET status = 'closed',
    closed_at = CAST(:now AS TEXT),
    closing_balance = NULL,
    expected_balance = s.opening_balance + COALESCE((
        SELECT SUM(CASE WHEN COALESCE(m.payment_method_type,'cash') = 'cash' THEN CASE WHEN m.movement_type IN ('out','refund') THEN -ABS(m.amount) ELSE ABS(m.amount) END ELSE 0 END)
        FROM cash_register_movement m
        WHERE m.session_id = s.id AND m.is_deleted = 0
    ), 0),
    difference = NULL,
    closing_notes = CASE WHEN s.closing_notes = '' THEN 'auto-closed by schedule (cash_register#23)'
                         ELSE s.closing_notes || ' | auto-closed by schedule (cash_register#23)' END,
    updated_by = :current_user_id,
    updated_at = CAST(:now AS TEXT)
FROM cutoff
WHERE s.hub_id = :hub_id AND s.is_deleted = 0 AND s.status = 'open'
  AND erp_dt(s.opened_at) < cutoff.last_cutoff_utc;
