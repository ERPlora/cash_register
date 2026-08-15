# Módulo `cash_register` — caja y arqueos

Capa de control de efectivo del TPV: **sesiones** (turnos), movimientos de efectivo y arqueos del
cajón. Reconcilia el efectivo **esperado** (fondo + Σ movimientos) contra el **contado** al cierre y
registra la diferencia. Captura sola las ventas en efectivo escuchando `sale.completed`.

> **Module id:** `cash_register`. **Depende de:** nada (`depends_on: []`).
> Módulo híbrido: SQL + handler WASM (`add_count`, `record_sale`).

## Documentación de usuario — [`docs/`](docs/)

Viaja **dentro** del módulo y se versiona con él: el asistente del hub (ADR-0282) la indexa por
versión instalada y cita la de TU versión, no la de la última publicada. En inglés (idioma fuente).

| Fichero | Para qué |
| ------- | -------- |
| [`docs/overview.md`](docs/overview.md) | Qué hace y qué NO hace; qué eventos emite y escucha |
| [`docs/screens.md`](docs/screens.md) | Abrir turno, movimiento, arqueo por denominaciones y cierre, paso a paso |
| [`docs/concepts.md`](docs/concepts.md) | Esperado vs contado vs diferencia, por qué `out`/`refund` van en NEGATIVO, sesión cerrada = historia, invitaciones aparte |
| [`docs/limits.md`](docs/limits.md) | La limitación conocida del KPI en vivo, permisos por acción y diagnóstico de descuadres |

## Qué expone hoy

| Tipo | Nombre | Permiso |
| ---- | ------ | ------- |
| query | `cash_register.sessions.list` / `.session.summary` / `.current_session` / `.registers.list` / `.settings.get` | `view_session` |
| query | `cash_register.movements.list` | `view_movement` |
| query | `cash_register.counts.list` | `view_count` |
| command | `cash_register.session.open` / `.close` | `add_session` / `close_session` |
| command | `cash_register.movement.add` | `add_movement` |
| command | `cash_register.count.add` (WASM) | `add_count` |
| command | `cash_register.registers.create` / `.settings.update` | `manage_settings` (solo admin) |
| escucha | `sale.completed` → `record_sale` (WASM) · `sale.voided` → `_reverse_sale` | — |
| emite | `cash_register.session_opened` / `.session_closed` / `.settings_updated` | — |

Navegación: `erp-cashregister-dashboard`; ajustes declarativos (ADR-0082).

## Layout

```text
module.json                   # manifest (contrato técnico)
migrations/postgres/          # esquema §2.5 (hub_id + soft-delete + auditoría)
queries/*.sql                 # lecturas declarativas (:hub_id inyectado)
commands/*.sql                # escrituras declarativas (las `_` son intenciones del WASM)
schemas/*.json                # JSON Schemas de input (draft 2020-12)
handler/                      # WASM Tier 2 → dist/handler.wasm
ui/                           # Web Components (Lit/Ionic/OutfitKit)
docs/                         # documentación de usuario + corpus del asistente
```

## Estado y trabajo abierto

El estado vive en las **Issues de este repo**, no aquí. Conocido y documentado en `docs/limits.md`:
`current_session.expected_total` invierte el signo de `refund`/`out` (el KPI en vivo descuadra; el
cierre NO).

Doc de arquitectura: `architecture/modules/cash_register.md` (cargarlo antes de tocar el módulo).
