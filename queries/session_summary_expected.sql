-- UNGAGGED twin of `session_summary.sql` (cash_register#84) — identical row, but NOT subject to the
-- `require_blind_count` setting: an OPEN session always carries its live `expected_cash`. It exists
-- for the two readers that need the real figure while the count is blind:
--   · the `movement.add` handler (a `reads` entry, system context), which enforces
--     `allow_negative_balance` on `expected_cash + amount` (cash_register#38) — fed a NULL it would
--     have nothing to compare against;
--   · supervisors (`cash_register.view_expected_totals`), same rule as `current_session_expected.sql`.
-- Keep both files computing the same thing: the blind CASE branch is the only difference.
--
-- Resumen de una sesión: totales por tipo de movimiento. Portado de get_session_summary.
--
-- SIGNO SERVER-AUTHORITATIVE (cash_register#48): el sentido de un movimiento lo dice su
-- `movement_type`, NO el signo con el que quedó guardado el importe. Hasta #48 el signo era una
-- convención que tenía que respetar quien llamaba, así que una SALIDA enviada en positivo SUMABA al
-- cajón (sacar 99.999 € dejaba el esperado en 100.110,50 €). El handler ya normaliza lo que se
-- escribe de aquí en adelante, pero las filas mal firmadas que YA existen envenenarían el arqueo
-- para siempre —y el cierre usa esta misma fórmula, así que el descuadre saldría cuadrado contra un
-- esperado falso—. Por eso la LECTURA deriva el signo: `-ABS(amount)` para `out`/`refund` y
-- `ABS(amount)` para `in`/`sale`. Es idempotente sobre las filas bien firmadas.
--
-- El DESGLOSE se lee como MAGNITUDES POSITIVAS (un refund de 50 € = 50, una salida de 30 € = 30):
-- «Salidas: −99.959,00 €» era la otra cara del mismo bug. El `expected_cash` sí lleva el signo
-- (entradas suman, salidas restan), igual que el arqueo de cierre.
SELECT
  s.id, s.session_number, s.status, s.opening_balance,
  COALESCE(SUM(CASE WHEN m.movement_type='sale'   THEN ABS(m.amount) ELSE 0 END),0) AS total_sales,
  COALESCE(SUM(CASE WHEN m.movement_type='refund' THEN ABS(m.amount) ELSE 0 END),0) AS total_refunds,
  COALESCE(SUM(CASE WHEN m.movement_type='in'     THEN ABS(m.amount) ELSE 0 END),0) AS total_cash_in,
  COALESCE(SUM(CASE WHEN m.movement_type='out'    THEN ABS(m.amount) ELSE 0 END),0) AS total_cash_out,
  COALESCE(SUM(m.gift_total),0) AS total_gifts,
  -- Physical cash the drawer should hold now (opening + Σ cash movements, signed by their KIND) —
  -- same rule as `close_session.sql`/`current_session.expected` (hub#778: keyed on
  -- payment_method_TYPE). The `movement.add` handler reads it to enforce `allow_negative_balance`
  -- (cash_register#38), so a wrong number here also disarms that guard.
  --
  -- A CLOSED shift answers with the STORED figure, never with a recount (cash_register#77). That
  -- column is the AUDITED number: `close_session.sql` computed it at the count and derived the
  -- stored `difference` from it, so recomputing it later would leave the row stating a difference
  -- that no longer follows from its own expected — the exact split `sessions_list.sql` already
  -- closed for the grid in #65, arrived at here from the other side. It is what made a void landing
  -- in a closed session move a shift that had already been signed; #77 also stopped the void from
  -- landing there, but this is the half that holds for ANY later row (a backdated movement, a
  -- soft-delete, a module not written yet). COALESCE, not a bare column, because a row closed
  -- before that column existed has none, and answering NULL would disarm the negative-balance guard
  -- instead of tightening it.
  CASE WHEN s.status <> 'open'
       THEN COALESCE(s.expected_balance,
                     s.opening_balance + COALESCE(SUM(CASE WHEN COALESCE(m.payment_method_type,'cash') = 'cash'
                                                           THEN CASE WHEN m.movement_type IN ('out','refund') THEN -ABS(m.amount) ELSE ABS(m.amount) END
                                                           ELSE 0 END),0))
       ELSE s.opening_balance + COALESCE(SUM(CASE WHEN COALESCE(m.payment_method_type,'cash') = 'cash'
                                                  THEN CASE WHEN m.movement_type IN ('out','refund') THEN -ABS(m.amount) ELSE ABS(m.amount) END
                                                  ELSE 0 END),0)
  END AS expected_cash,
  COUNT(m.id) AS movement_count
FROM cash_register_session s
LEFT JOIN cash_register_movement m ON m.session_id = s.id AND m.is_deleted = 0 AND m.hub_id = :hub_id
WHERE s.id = :session_id AND s.hub_id = :hub_id
GROUP BY s.id;
