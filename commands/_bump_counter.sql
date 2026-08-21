-- Incrementa atómicamente el contador de turnos del día (cash_register#49). UPSERT en UNA
-- sentencia: sin ventana SELECT→UPDATE — en Postgres el `ON CONFLICT` toma el row-lock de la fila
-- en conflicto, así que dos aperturas simultáneas no pueden leer el mismo `last_number`. Es la
-- primera operación de `cash_register.session.open` y corre en la MISMA transacción que el INSERT
-- de la sesión, que lo lee de vuelta por subquery (el guest WASM nunca hace read-back — patrón
-- `payments`/`sales`).
--
-- RHS cualificado con el nombre de la tabla: en Postgres el identificador sin cualificar puede
-- chocar con `excluded`.
--
-- El runtime inyecta :new_id, :hub_id y :now; :day (YYYYMMDD) lo aporta el handler desde el reloj
-- del HOST, nunca desde el payload. Requiere el índice único uq_cash_register_session_counter_hub_day
-- (hub_id, day), que es el arbiter de este ON CONFLICT.
--
-- Si el INSERT de la sesión no llega a escribir (la carrera del índice parcial «una sesión abierta
-- por hub» → `ON CONFLICT DO NOTHING`), el número queda quemado y la serie salta uno. Es el
-- comportamiento de cualquier contador transaccional y es preferible al contrario: reutilizar un
-- número ya visto sí sería un problema de auditoría.
INSERT INTO cash_register_session_counter (id, hub_id, day, last_number, created_at, updated_at)
VALUES (:new_id, :hub_id, :day, 1, :now, :now)
ON CONFLICT (hub_id, day)
DO UPDATE SET last_number = cash_register_session_counter.last_number + 1, updated_at = :now;
