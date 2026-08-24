//! Handler WASM (Tier 2) del módulo `cash_register`.
//! Portado de old_modules/m_cash_register (CashCount.calculate_total_from_denominations,
//! events._on_sale_completed). Lógica pura, sin BD.
//!
//! Exporta:
//!  - `add_count`: registra un arqueo. Calcula el total sumando denominaciones
//!    (bills/coins → Σ denom×count) si no viene `total` explícito. Emite _insert_count.
//!  - `record_sale`: listener de `sale.completed`. Añade un movimiento de caja con el
//!    total de la venta a la sesión abierta del empleado. Como el guest no consulta la
//!    BD, emite _movement_for_open_session, que resuelve la sesión abierta en SQL.
//!  - `open_session` / `close_session` / `add_movement` (cash_register#38): the drawer settings
//!    (`require_opening_balance`, `require_closing_balance`, `allow_negative_balance`) enforced on
//!    the server. Each rule answers with its own domain code, read from the trusted settings row the
//!    host preloads (`context.reads`, ADR-0069) — never from the payload. The writes themselves stay
//!    in SQL (`_open_session_insert`, `_close_session_apply`, `_movement_insert`).

use erplora_guest_sdk::money;
use rust_decimal::Decimal;
use std::str::FromStr;
use erplora_guest_sdk::{DomainError, Operation, Output};
use serde_json::{json, Map, Value};

#[cfg(feature = "guest")]
use extism_pdk::*;

#[cfg(feature = "guest")]
#[plugin_fn]
pub fn add_count(input: Json<erplora_guest_sdk::Input>) -> FnResult<Json<Output>> {
    Ok(Json(add_count_pure(input.into_inner().into_value())))
}

#[cfg(feature = "guest")]
#[plugin_fn]
pub fn record_sale(input: Json<erplora_guest_sdk::Input>) -> FnResult<Json<Output>> {
    Ok(Json(record_sale_pure(input.into_inner().into_value())))
}

#[cfg(feature = "guest")]
#[plugin_fn]
pub fn open_session(input: Json<erplora_guest_sdk::Input>) -> FnResult<Json<Output>> {
    Ok(Json(open_session_pure(input.into_inner().into_value())))
}

#[cfg(feature = "guest")]
#[plugin_fn]
pub fn close_session(input: Json<erplora_guest_sdk::Input>) -> FnResult<Json<Output>> {
    Ok(Json(close_session_pure(input.into_inner().into_value())))
}

#[cfg(feature = "guest")]
#[plugin_fn]
pub fn add_movement(input: Json<erplora_guest_sdk::Input>) -> FnResult<Json<Output>> {
    Ok(Json(add_movement_pure(input.into_inner().into_value())))
}

// El DINERO lo calcula `erplora_guest_sdk::money` (ADR-0123): una sola implementación para todo el
// hub, un solo modo de redondeo (HALF_UP). Este módulo tenía su propio `round_cents` (half-even
// simulado con un épsilon sobre `f64`), copiado byte a byte de otros cuatro handlers.
fn f(v: &Value, d: f64) -> f64 {
    match v { Value::Number(n) => n.as_f64().unwrap_or(d), Value::String(s) => s.trim().parse().unwrap_or(d), _ => d }
}
fn s(v: &Value) -> String {
    match v { Value::String(x) => x.clone(), Value::Number(n) => n.to_string(), _ => String::new() }
}
fn sor(p: &Value, k: &str, d: &str) -> String {
    let x = s(p.get(k).unwrap_or(&Value::Null));
    if x.is_empty() { d.to_string() } else { x }
}
fn new_id(input: &Value, i: usize) -> Value {
    input.get("context").and_then(|c| c.get("new_ids")).and_then(|v| v.as_array())
        .and_then(|a| a.get(i)).cloned().unwrap_or(Value::Null)
}

/// Σ denom×count sobre bills y coins, en **céntimos** (ADR-0007). Las claves de
/// denominación son etiquetas de EUROS de la moneda/billete físico ("50", "0.50"),
/// así que se escalan a céntimos (×100). Fiel a calculate_total_from_denominations.
fn total_from_denoms(denoms: &Value) -> i64 {
    let mut total: i64 = 0; // céntimos
    for section in ["bills", "coins"] {
        if let Some(Value::Object(m)) = denoms.get(section) {
            for (denom, count) in m {
                // La etiqueta del billete/moneda está en EUROS ("50", "0.50") → frontera CON NOMBRE.
                let euros = Decimal::from_str(denom.trim()).unwrap_or(Decimal::ZERO);
                let denom_cents = money::euros_to_cents(euros);
                total += denom_cents * f(count, 0.0) as i64;
            }
        }
    }
    total
}

/// add_count: payload { session_id, count_type, denominations?, total?, notes? }.
pub fn add_count_pure(input: Value) -> Output {
    let payload = input.get("payload").cloned().unwrap_or(Value::Null);
    let denoms = payload.get("denominations").cloned().unwrap_or(json!({}));
    let total = match payload.get("total") {
        Some(v) if !v.is_null() && f(v, -1.0) >= 0.0 => money::from_json(v, 0), // céntimos
        _ => total_from_denoms(&denoms),
    };
    let mut p = Map::new();
    p.insert("count_id".into(), new_id(&input, 0));
    p.insert("session_id".into(), payload.get("session_id").cloned().unwrap_or(Value::Null));
    p.insert("count_type".into(), json!(sor(&payload, "count_type", "opening")));
    p.insert("denominations".into(), json!(Value::Object(
        denoms.as_object().cloned().unwrap_or_default()).to_string()));
    p.insert("total".into(), json!(total));
    p.insert("notes".into(), json!(sor(&payload, "notes", "")));
    Output { operations: vec![Operation::sql("cash_register._insert_count", p)], events: vec![], ..Default::default() }
}

/// record_sale: listener de sale.completed → movimiento de caja (tipo 'sale') en la
/// sesión abierta del empleado. El payload del evento trae total y (opcional) sale_id.
pub fn record_sale_pure(input: Value) -> Output {
    let payload = input.get("payload").cloned().unwrap_or(Value::Null);
    let total = money::from_json(payload.get("total").unwrap_or(&Value::Null), 0); // céntimos (de sale.completed)
    // Invitaciones (comp): coste de las líneas regalo de la venta (de sale.completed) → se acumula en
    // el movimiento para el arqueo. Una venta TODA-invitación (total 0) igual registra el movimiento.
    let gift_total = money::from_json(payload.get("gift_total").unwrap_or(&Value::Null), 0);
    if total <= 0 && gift_total <= 0 {
        return Output { operations: vec![], events: vec![], ..Default::default() };
    }
    let mut p = Map::new();
    p.insert("movement_id".into(), new_id(&input, 0));
    p.insert("movement_type".into(), json!("sale"));
    p.insert("amount".into(), json!(total));
    p.insert("gift_total".into(), json!(gift_total));
    p.insert("payment_method".into(), json!(sor(&payload, "payment_method_name", "cash")));
    // Tipo CANÓNICO del método (`cash`|`card`|`transfer`|`other`), de sale.completed (hub#778):
    // el cajón compara contra este, no contra el `name` localizado. Default `cash` para ventas de
    // eventos antiguos o emisores que aún no lo envíen (degradación: igual que antes del fix).
    p.insert("payment_method_type".into(), json!(sor(&payload, "payment_method_type", "cash")));
    p.insert("sale_reference".into(), payload.get("sale_id").cloned().unwrap_or(json!("")));
    p.insert("description".into(), json!(format!("Sale {}", s(payload.get("sale_id").unwrap_or(&Value::Null)))));
    // La sesión abierta del usuario activo la resuelve el SQL (subquery por current_user_id).
    Output { operations: vec![Operation::sql("cash_register._movement_for_open_session", p)], events: vec![], ..Default::default() }
}


// ── cash_register#38: settings enforced on the server ────────────────────────────────────────

/// Rows the host preloaded for `query` (`context.reads[query]`, ADR-0069). Empty if absent.
fn read_rows<'a>(input: &'a Value, query: &str) -> &'a [Value] {
    input.get("context").and_then(|c| c.get("reads")).and_then(|r| r.get(query)).and_then(|v| v.as_array())
        .map(|a| a.as_slice()).unwrap_or(&[])
}

/// A 0/1 flag of the settings row (`cash_register.settings.get`). No row → `false`: a hub that
/// never saved the settings keeps today's behaviour (nothing enforced) — the migration defaults are
/// the UI's suggestion, not a rule the hub agreed to.
fn setting_flag(input: &Value, key: &str) -> bool {
    read_rows(input, "cash_register.settings.get").first()
        .and_then(|row| row.get(key)).map(|v| f(v, 0.0) != 0.0).unwrap_or(false)
}

fn refuse(code: &str, message: &str) -> Output {
    Output::new().with_error(DomainError::new(code, message))
}

/// Copies the caller's keys into the operation params (the SQL binds them by name; the host adds
/// the system params on top).
fn passthrough(payload: &Value, keys: &[&str]) -> Map<String, Value> {
    let mut p = Map::new();
    for k in keys {
        p.insert((*k).to_string(), payload.get(*k).cloned().unwrap_or(Value::Null));
    }
    p
}

/// `YYYYMMDD` of the HOST clock (`context.now`). The counter is keyed by (hub, day), so the day
/// can never come from the payload: two terminals with different local settings would otherwise
/// open two series for the same shift. Same idiom as `payments`.
fn day_from_now(now: &str) -> String {
    let date = now.split('T').next().unwrap_or("");
    let digits: String = date.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() >= 8 { digits[..8].to_string() } else { "00000000".to_string() }
}

/// open_session: payload { register_id?, opening_balance?, opening_notes? }.
/// reads: `cash_register.settings.get`, `cash_register.current_session`.
///
/// The SHIFT NUMBER is the server's (cash_register#49). It used to be whatever the caller sent,
/// with the SQL falling back to `'S-' || :session_id` — so opening by command (the assistant, the
/// installable app, an integration) left the turn as `S-898dbda8-39d7-4a13-b1c5-6d1a71b85b6a`: 38
/// characters, in the very column the manager talks about a shift by and searches the list with.
/// Now it is minted here like `sales` and `payments` mint theirs: an atomic per-(hub, day) counter
/// bumped in the SAME transaction as the insert, and `S-YYMMDD-NNNN` composed in SQL from it. That
/// also closes the collision the old `S-YYMMDD-HHMMSS` had between two terminals opening in the
/// same second.
pub fn open_session_pure(input: Value) -> Output {
    let payload = input.get("payload").cloned().unwrap_or(Value::Null);
    // cash_register#11 on this path: the preloaded open session gives the translatable refusal;
    // the partial unique index + `ON CONFLICT DO NOTHING` in `_open_session_insert` still guard a
    // race between two devices.
    if !read_rows(&input, "cash_register.current_session").is_empty() {
        return refuse(
            "cash_register.session_already_open",
            "A cash session is already open for this business. Close it before opening a new one.",
        );
    }
    let opening = money::from_json(payload.get("opening_balance").unwrap_or(&Value::Null), 0);
    if setting_flag(&input, "require_opening_balance") && opening <= 0 {
        return refuse(
            "cash_register.opening_balance_required",
            "This business requires an opening float: enter the cash the drawer starts with.",
        );
    }
    // The day of the counter and the day the person reads. Both derived here so the SQL binds
    // literals and never has to do string surgery on a date.
    let now = s(input.get("context").and_then(|c| c.get("now")).unwrap_or(&Value::Null));
    let day = day_from_now(&now);
    let session_day = day[2..].to_string(); // YYMMDD — `S-260821-0001`, the shape the till already showed

    let mut bump = Map::new();
    bump.insert("day".into(), json!(day));

    // `session_number` is NOT read from the payload any more (cash_register#49): a caller that
    // still sends one is ignored, so the screen and the API cannot drift apart.
    let mut p = passthrough(&payload, &["register_id", "opening_notes"]);
    // The host is the id authority (§5.3): the session takes `new_ids[0]`, which is what the caller
    // gets back as the created entity (hub#776).
    p.insert("session_id".into(), new_id(&input, 0));
    p.insert("opening_balance".into(), json!(opening));
    p.insert("day".into(), json!(day));
    p.insert("session_day".into(), json!(session_day));
    // Order matters and the transaction is one: the counter is bumped, then the insert reads it
    // back with a subquery (the guest never does a read-back — pattern sales/payments/kitchen).
    Output::new()
        .with_operation(Operation::sql("cash_register._bump_counter", bump))
        .with_operation(Operation::sql("cash_register._open_session_insert", p))
}

/// close_session: payload { session_id, closing_balance?, closing_notes? }.
/// reads: `cash_register.settings.get`.
pub fn close_session_pure(input: Value) -> Output {
    let payload = input.get("payload").cloned().unwrap_or(Value::Null);
    let counted = payload.get("closing_balance").filter(|v| !v.is_null() && s(v).trim() != "");
    if setting_flag(&input, "require_closing_balance") && counted.is_none() {
        return refuse(
            "cash_register.closing_balance_required",
            "This business requires the drawer to be counted at closing: enter the counted cash.",
        );
    }
    let mut p = passthrough(&payload, &["session_id", "closing_notes"]);
    p.insert("closing_balance".into(), counted.map(|v| json!(money::from_json(v, 0))).unwrap_or(Value::Null));
    Output::new().with_operation(Operation::sql("cash_register._close_session_apply", p))
}

/// The SIGN of a cash movement belongs to the SERVER (cash_register#48). It used to be a convention
/// the CALLER had to honour — the module's own screen sent `-3000` for a cash-out, but nothing said
/// so: `movement.add` declared no `schema`, the handler stored the amount as it arrived and the
/// reading queries summed it blind. A cash-out sent with a positive amount therefore ADDED to the
/// drawer, and `allow_negative_balance` — evaluated on `expected_cash + amount` — became
/// unreachable through that door: the sum could never dip below zero. Taking 99.999 € out left the
/// expected cash at 100.110,50 € and `ok: true`, and the closing reconciliation used the same
/// formula, so the till "balanced" against a total that was already false.
///
/// Here the caller states WHAT the movement is (`movement_type`) and HOW MUCH (a magnitude); the
/// sign is derived. Outflows (`out`, `refund`) are stored negative, inflows (`in`, `sale`) positive
/// — the canonical convention `close_session.sql`, `session.summary` and `_reverse_sale.sql`
/// already assume. An unknown type has no sign, so it has no place in the drawer.
fn signed_amount(movement_type: &str, amount: i64) -> Option<i64> {
    match movement_type {
        "out" | "refund" => Some(-amount.abs()),
        "in" | "sale" => Some(amount.abs()),
        _ => None,
    }
}

/// The CANONICAL type of a payment method (`cash`|`card`|`transfer`|`other`, hub#778) — the only
/// thing the drawer can key on, and the only vocabulary this door speaks (cash_register#54).
///
/// The guard used to ask `payment_method == "cash"` about the value the caller sent, while the five
/// readings (`session.summary`, `current_session`, `current_session.expected`, `close_session`,
/// `_auto_close_sessions`) all key on `payment_method_type`. The two halves of the same operation
/// therefore disagreed in BOTH directions: a movement sent as `card` was excluded from the guard
/// and included in the expected cash (the write never persisted the type, so the column kept its
/// `DEFAULT 'cash'`), and a movement sent as «Efectivo» —the LOCALIZED name of cash, which never
/// equals `'cash'` in a case-sensitive comparison— was excluded from the guard while being real
/// money leaving the till. A hub in Spanish emptied the drawer below zero just by naming the method
/// in its own language. A guard you dodge by changing language is not a guard.
///
/// So the type is derived HERE, once, and it feeds both the guard and the INSERT — they cannot
/// drift apart again. A method outside the vocabulary is `None`: refusing it is the only safe
/// answer, because filing it as "not cash" hides real money leaving the till and filing it as
/// "cash" is the bug above. The localized CATALOGUE of methods belongs to `sales` and reaches the
/// drawer through `record_sale`, which carries the type the catalogue already knows.
fn payment_method_type(method: &str) -> Option<&'static str> {
    match method.trim().to_ascii_lowercase().as_str() {
        "" | "cash" => Some("cash"),
        "card" => Some("card"),
        "transfer" => Some("transfer"),
        "other" => Some("other"),
        _ => None,
    }
}

/// add_movement: payload { session_id, movement_type, amount (magnitude, minor units — the SERVER
/// signs it, cash_register#48), payment_method?, sale_reference?, description? }.
/// reads: `cash_register.settings.get`, `cash_register.session.summary` (params session_id) — the
/// summary carries `expected_cash`.
pub fn add_movement_pure(input: Value) -> Output {
    let payload = input.get("payload").cloned().unwrap_or(Value::Null);
    // pm#146 on this path: a session that is not this hub's (or is deleted) is not preloaded → refuse
    // before writing, so no `movement_added` is ever emitted for a row that does not exist.
    let Some(session) = read_rows(&input, "cash_register.session.summary").first() else {
        return refuse(
            "cash_register.session_unavailable",
            "That cash session is not available: it does not exist in this business or it has been deleted.",
        );
    };
    // cash_register#48. `schemas/add_movement.json` is the manifest's half of this contract (it
    // rejects an unknown type and a non-positive amount before the handler runs); these two
    // refusals are the code's half, so the rule holds even for a caller the schema never saw.
    let movement_type = sor(&payload, "movement_type", "");
    let Some(amount) = signed_amount(&movement_type, money::from_json(payload.get("amount").unwrap_or(&Value::Null), 0))
    else {
        return refuse(
            "cash_register.movement_type_unknown",
            "That is not a kind of cash movement: use in, out, sale or refund.",
        );
    };
    if amount == 0 {
        return refuse(
            "cash_register.amount_required",
            "A cash movement needs an amount: enter how much money goes in or out of the drawer.",
        );
    }
    // cash_register#54: the canonical type decides, not the name the caller wrote. Same rule the
    // readings apply, derived once and used twice — for the guard just below and for the row.
    let method = sor(&payload, "payment_method", "cash");
    let Some(method_type) = payment_method_type(&method) else {
        return refuse(
            "cash_register.payment_method_unknown",
            "That is not a way of paying the drawer knows: use cash, card, transfer or other.",
        );
    };
    if amount < 0 && method_type == "cash" && !setting_flag(&input, "allow_negative_balance") {
        let expected_cash = money::from_json(session.get("expected_cash").unwrap_or(&Value::Null), 0);
        if expected_cash + amount < 0 {
            return refuse(
                "cash_register.negative_balance_not_allowed",
                "This cash-out would leave the drawer below zero, and this business does not allow a negative balance.",
            );
        }
    }
    let mut p = passthrough(&payload, &["session_id", "sale_reference", "description"]);
    p.insert("movement_id".into(), new_id(&input, 0));
    p.insert("movement_type".into(), json!(movement_type));
    p.insert("amount".into(), json!(amount));
    // Both columns, as `_movement_for_open_session.sql` has written them since #33. Through THIS
    // door the name IS the canonical token —there are no localized names here— so it is stored
    // normalized: `movements.list` filters `payment_method` with `eq`, and `Card` and `card` must
    // not be two different things in that filter.
    p.insert("payment_method".into(), json!(method_type));
    p.insert("payment_method_type".into(), json!(method_type));
    Output::new().with_operation(Operation::sql("cash_register._movement_insert", p))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn inp(payload: Value, ids: usize) -> Value {
        let new_ids: Vec<Value> = (0..ids).map(|i| json!(format!("id-{i}"))).collect();
        json!({ "payload": payload, "context": { "new_ids": new_ids, "now": "2026-05-31T10:00:00+00:00" } })
    }

    #[test]
    fn count_total_from_denominations() {
        // 2×50€ + 5×20€ + 10×1€ = 100€ + 100€ + 10€ = 210€ = 21000 céntimos.
        let payload = json!({ "session_id": "sess1", "count_type": "opening",
            "denominations": { "bills": { "50": 2, "20": 5 }, "coins": { "1": 10 } } });
        let out = add_count_pure(inp(payload, 2));
        assert_eq!(out.operations.len(), 1);
        assert_eq!(out.operations[0].command, "cash_register._insert_count");
        assert_eq!(out.operations[0].params["total"], json!(21000));
        assert_eq!(out.operations[0].params["count_id"], json!("id-0"));
    }

    #[test]
    fn count_explicit_total_overrides() {
        // total explícito en céntimos: 333€ = 33300.
        let payload = json!({ "session_id": "s", "count_type": "closing", "total": 33300 });
        let out = add_count_pure(inp(payload, 2));
        assert_eq!(out.operations[0].params["total"], json!(33300));
    }

    #[test]
    fn record_sale_creates_movement() {
        // total del evento sale.completed en céntimos: 45.50€ = 4550.
        let payload = json!({ "sale_id": "sale1", "total": 4550, "payment_method_name": "card" });
        let out = record_sale_pure(inp(payload, 2));
        assert_eq!(out.operations.len(), 1);
        assert_eq!(out.operations[0].command, "cash_register._movement_for_open_session");
        assert_eq!(out.operations[0].params["amount"], json!(4550));
        assert_eq!(out.operations[0].params["movement_type"], json!("sale"));
        assert_eq!(out.operations[0].params["sale_reference"], json!("sale1"));
    }

    #[test]
    fn record_sale_persists_the_payment_method_type_from_the_event() {
        // hub#778: the movement carries the canonical TYPE so the drawer keys on it, not on the
        // localized NAME. A Spanish "Efectivo" sale must reach the drawer as type "cash".
        let payload = json!({ "sale_id": "s1", "total": 2000, "payment_method_name": "Efectivo", "payment_method_type": "cash" });
        let out = record_sale_pure(inp(payload, 1));
        assert_eq!(out.operations[0].params["payment_method"], json!("Efectivo"));
        assert_eq!(out.operations[0].params["payment_method_type"], json!("cash"));
    }

    #[test]
    fn record_sale_a_card_sale_carries_its_type() {
        // The regression: a card sale must NOT inflate the expected drawer cash. Its type travels
        // so the drawer excludes it from the expected total.
        let payload = json!({ "sale_id": "s2", "total": 5000, "payment_method_name": "Tarjeta", "payment_method_type": "card" });
        let out = record_sale_pure(inp(payload, 1));
        assert_eq!(out.operations[0].params["payment_method_type"], json!("card"));
    }

    #[test]
    fn record_sale_without_type_defaults_to_cash() {
        // Backward compat: an event from an older emitter (pre-#778) without payment_method_type
        // defaults to "cash" — same behavior as before the fix.
        let payload = json!({ "sale_id": "s3", "total": 1500, "payment_method_name": "Cash" });
        let out = record_sale_pure(inp(payload, 1));
        assert_eq!(out.operations[0].params["payment_method_type"], json!("cash"));
    }

    #[test]
    fn record_sale_zero_is_noop() {
        let out = record_sale_pure(inp(json!({ "total": 0 }), 2));
        assert_eq!(out.operations.len(), 0);
    }

    // ── cash_register#59 · ADR-0386: one movement per TENDER, not one per sale ────────────────
    //
    // The drawer's READS already survive N movements per sale (`session_summary.sql` sums the
    // `cash` ones, `_reverse_sale.sql` reverses their SUM). What did not was the WRITE: a mixed
    // sale landed as ONE movement for the whole total, typed after the principal leg.

    /// Every operation this handler emitted against the drawer's insert door, in order.
    fn movements(out: &Output) -> Vec<&Operation> {
        out.operations
            .iter()
            .filter(|op| op.command == "cash_register._movement_for_open_session")
            .collect()
    }

    /// The cents this output puts into the physical drawer: the `cash` legs, and only those.
    fn into_drawer(out: &Output) -> i64 {
        movements(out)
            .iter()
            .filter(|op| op.params["payment_method_type"] == json!("cash"))
            .map(|op| op.params["amount"].as_i64().unwrap_or(0))
            .sum()
    }

    /// The event `sales` v2.16.1 emits for the issue's sale: 121,00 € charged as 50,00 € on a card
    /// and 71,00 € in cash, of which 90,00 € was handed over (19,00 € of change). The scalars are
    /// the PRINCIPAL leg — the cash one, because 71 > 50 — exactly as `decide_checkout` derives
    /// them, which is what made the descuadre silent.
    fn mixed_sale_event() -> Value {
        json!({
            "sale_id": "sale-mixed",
            "total": 12100,
            "payment_method_id": "pm-cash",
            "payment_method_name": "Efectivo",
            "payment_method_type": "cash",
            "payments": [
                { "payment_method_id": "pm-card", "payment_method_name": "Tarjeta",
                  "payment_method_type": "card", "amount": 5000, "amount_tendered": 5000,
                  "change_due": 0, "sort_order": 0, "reference": "" },
                { "payment_method_id": "pm-cash", "payment_method_name": "Efectivo",
                  "payment_method_type": "cash", "amount": 7100, "amount_tendered": 9000,
                  "change_due": 1900, "sort_order": 1, "reference": "" }
            ]
        })
    }

    #[test]
    fn a_mixed_sale_puts_only_its_cash_leg_in_the_drawer() {
        // 🔴 THE issue (cash_register#59). Before the fix this was ONE movement of 121,00 € typed
        // `cash`: the drawer expected 121,00 € when 71,00 € had entered it, and the cashier
        // counted 50,00 € short every single mixed sale — silently, because nothing anywhere says
        // the number is wrong.
        let out = record_sale_pure(inp(mixed_sale_event(), 4));
        assert_eq!(into_drawer(&out), 7100, "only the cash leg is drawer money");
    }

    #[test]
    fn a_mixed_sale_books_one_movement_per_leg_with_its_own_type() {
        let out = record_sale_pure(inp(mixed_sale_event(), 4));
        let ops = movements(&out);
        assert_eq!(ops.len(), 2, "one movement per leg of the payment");

        assert_eq!(ops[0].params["payment_method_type"], json!("card"));
        assert_eq!(ops[0].params["payment_method"], json!("Tarjeta"));
        assert_eq!(ops[0].params["amount"], json!(5000));
        assert_eq!(ops[0].params["movement_type"], json!("sale"));
        assert_eq!(ops[0].params["sale_reference"], json!("sale-mixed"));

        assert_eq!(ops[1].params["payment_method_type"], json!("cash"));
        assert_eq!(ops[1].params["payment_method"], json!("Efectivo"));
        // The CHANGE came out of the drawer (ADR-0386 decision 2), so what stayed in it is the
        // 71,00 € the leg covered — never the 90,00 € handed over.
        assert_eq!(ops[1].params["amount"], json!(7100));

        // And the legs still add up to the sale, to the cent: nothing is dropped or double booked.
        let booked: i64 = ops.iter().map(|op| op.params["amount"].as_i64().unwrap()).sum();
        assert_eq!(booked, 12100);
    }

    #[test]
    fn every_movement_of_a_mixed_sale_gets_its_own_id() {
        let out = record_sale_pure(inp(mixed_sale_event(), 4));
        let ids: Vec<&Value> = movements(&out).iter().map(|op| &op.params["movement_id"]).collect();
        assert_eq!(ids, vec![&json!("id-0"), &json!("id-1")]);
    }

    #[test]
    fn running_out_of_ids_is_refused_out_loud() {
        // A movement inserted with a NULL primary key is either a crash or, worse, a row nobody
        // can reverse. The host hands 256 ids, so this is unreachable in practice — which is
        // exactly why it has to fail loudly instead of degrading into a half-booked sale.
        let out = record_sale_pure(inp(mixed_sale_event(), 1));
        assert!(out.operations.is_empty(), "nothing is booked when the ids run short");
        let err = out.error.expect("a domain error, not a silent half-sale");
        assert_eq!(err.code, "cash_register.not_enough_ids");
    }

    #[test]
    fn the_gift_total_of_a_mixed_sale_is_booked_once() {
        // `session_summary.sql` does `SUM(m.gift_total)`: repeating it on every leg would multiply
        // the invitations by the number of ways the sale was paid.
        let mut payload = mixed_sale_event();
        payload["gift_total"] = json!(800);
        let out = record_sale_pure(inp(payload, 4));
        let gifts: Vec<i64> = movements(&out)
            .iter()
            .map(|op| op.params["gift_total"].as_i64().unwrap_or(0))
            .collect();
        assert_eq!(gifts.iter().sum::<i64>(), 800);
        assert_eq!(gifts, vec![800, 0], "the invitations ride on the first leg only");
    }

    #[test]
    fn a_one_tender_sale_still_books_exactly_one_movement() {
        // `sales` v2.16.1 always sends `payments[]`, a single-tender sale included. That sale must
        // land exactly as it did before this change.
        let payload = json!({
            "sale_id": "s-card", "total": 5000,
            "payment_method_name": "Tarjeta", "payment_method_type": "card",
            "payments": [
                { "payment_method_id": "pm-card", "payment_method_name": "Tarjeta",
                  "payment_method_type": "card", "amount": 5000, "amount_tendered": 5000,
                  "change_due": 0, "sort_order": 0, "reference": "" }
            ]
        });
        let out = record_sale_pure(inp(payload, 2));
        let ops = movements(&out);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].params["amount"], json!(5000));
        assert_eq!(ops[0].params["payment_method_type"], json!("card"));
        assert_eq!(into_drawer(&out), 0, "a card sale never reaches the drawer");
    }

    #[test]
    fn an_event_without_payments_keeps_todays_behaviour_exactly() {
        // 🔴 BACK-COMPAT, and it is not hypothetical: a hub running `sales` < 2.16.0 emits no
        // `payments[]` at all, and so does every sale recorded before it upgraded. That event is a
        // one-tender sale and has to keep booking ONE movement from the scalars.
        let payload = json!({
            "sale_id": "s-old", "total": 4550,
            "payment_method_name": "Efectivo", "payment_method_type": "cash",
        });
        let out = record_sale_pure(inp(payload, 2));
        let ops = movements(&out);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].params["amount"], json!(4550));
        assert_eq!(ops[0].params["payment_method"], json!("Efectivo"));
        assert_eq!(ops[0].params["payment_method_type"], json!("cash"));
        assert_eq!(ops[0].params["movement_id"], json!("id-0"));
        assert_eq!(into_drawer(&out), 4550);
    }

    #[test]
    fn an_empty_payments_list_falls_back_to_the_scalars() {
        // Defence in depth: `sales` never emits an empty list, but an emitter that did must not
        // make the sale vanish from the drawer.
        let payload = json!({
            "sale_id": "s-empty", "total": 4550, "payment_method_type": "cash",
            "payment_method_name": "Efectivo", "payments": []
        });
        let out = record_sale_pure(inp(payload, 2));
        assert_eq!(movements(&out).len(), 1);
        assert_eq!(into_drawer(&out), 4550);
    }

    #[test]
    fn a_leg_without_a_type_is_drawer_money_like_the_scalars_are() {
        // Same degradation as the scalar path (hub#778): unknown type → `cash`. Guessing anything
        // else would quietly take money OUT of the expected count.
        let payload = json!({
            "sale_id": "s-untyped", "total": 3000,
            "payments": [ { "amount": 3000 } ]
        });
        let out = record_sale_pure(inp(payload, 2));
        let ops = movements(&out);
        assert_eq!(ops[0].params["payment_method_type"], json!("cash"));
        assert_eq!(ops[0].params["payment_method"], json!("cash"));
        assert_eq!(into_drawer(&out), 3000);
    }

    #[test]
    fn an_all_gift_sale_still_books_its_invitations() {
        // Total 0 with invitations: `sales` sends one leg of 0. The movement still has to exist —
        // the count reports the comps even though no money moved.
        let payload = json!({
            "sale_id": "s-gift", "total": 0, "gift_total": 1200,
            "payments": [ { "payment_method_type": "cash", "amount": 0 } ]
        });
        let out = record_sale_pure(inp(payload, 2));
        let ops = movements(&out);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].params["amount"], json!(0));
        assert_eq!(ops[0].params["gift_total"], json!(1200));
    }

    #[test]
    fn three_tenders_book_three_movements() {
        // ADR-0386 puts no ceiling on the legs, and neither does the drawer.
        let payload = json!({
            "sale_id": "s3", "total": 12100,
            "payments": [
                { "payment_method_type": "card", "payment_method_name": "Tarjeta", "amount": 5000 },
                { "payment_method_type": "cash", "payment_method_name": "Efectivo", "amount": 5000,
                  "amount_tendered": 5000, "change_due": 0 },
                { "payment_method_type": "transfer", "payment_method_name": "Bizum", "amount": 2100 }
            ]
        });
        let out = record_sale_pure(inp(payload, 4));
        assert_eq!(movements(&out).len(), 3);
        assert_eq!(into_drawer(&out), 5000);
    }

    // ── cash_register#38: the drawer settings are enforced on the SERVER ─────────────────────
    // `require_opening_balance` / `require_closing_balance` / `allow_negative_balance` used to be
    // looked at by the UI only. Each rule gets its own domain code (one `expect_rows` gate per SQL
    // command could not tell "already open" from "float missing"), read from the trusted settings
    // row the host preloads (ADR-0069 `reads`), never from the payload.

    fn inp_reads(payload: Value, reads: Value) -> Value {
        json!({ "payload": payload, "context": { "new_ids": ["id-0", "id-1"], "now": "2026-08-18T10:00:00+00:00", "reads": reads } })
    }
    fn settings(opening: i64, closing: i64, negative: i64) -> Value {
        json!([{ "id": "cfg", "require_opening_balance": opening, "require_closing_balance": closing, "allow_negative_balance": negative }])
    }

    #[test]
    fn open_session_refuses_without_float_when_the_setting_requires_it() {
        let out = open_session_pure(inp_reads(
            json!({ "opening_balance": 0, "session_number": "S-1" }),
            json!({ "cash_register.settings.get": settings(1, 1, 0), "cash_register.current_session": [] }),
        ));
        assert_eq!(out.error.as_ref().map(|e| e.code.as_str()), Some("cash_register.opening_balance_required"));
        assert!(out.operations.is_empty());
    }

    #[test]
    fn open_session_with_float_or_without_the_setting_inserts() {
        for (opening, setting) in [(1500, 1), (0, 0)] {
            let out = open_session_pure(inp_reads(
                json!({ "opening_balance": opening, "session_number": "S-1", "register_id": null, "opening_notes": "" }),
                json!({ "cash_register.settings.get": settings(setting, 1, 0), "cash_register.current_session": [] }),
            ));
            assert!(out.error.is_none(), "opening={opening} setting={setting}: {:?}", out.error);
            // cash_register#49: the open is now TWO operations in one transaction — bump the daily
            // counter, then insert reading it back. The assertion on `session_number` moved out
            // with the number itself: the caller no longer supplies it (see `session_number_tests`).
            assert_eq!(out.operations.len(), 2);
            assert_eq!(out.operations[0].command, "cash_register._bump_counter");
            assert_eq!(out.operations[1].command, "cash_register._open_session_insert");
            assert_eq!(out.operations[1].params["opening_balance"], json!(opening));
            assert_eq!(out.operations[1].params["session_id"], json!("id-0"));
        }
    }

    #[test]
    fn open_session_without_a_settings_row_enforces_nothing() {
        // A hub that never saved the settings keeps today's behaviour (nothing enforced).
        let out = open_session_pure(inp_reads(
            json!({ "opening_balance": 0 }),
            json!({ "cash_register.settings.get": [], "cash_register.current_session": [] }),
        ));
        assert!(out.error.is_none());
        assert_eq!(out.operations.len(), 2); // counter + insert (cash_register#49)
    }

    #[test]
    fn open_session_refuses_when_one_is_already_open() {
        // cash_register#11 kept: the read of the open session gives the translatable refusal; the
        // partial unique index + ON CONFLICT DO NOTHING in `_open_session_insert` still guard a race.
        let out = open_session_pure(inp_reads(
            json!({ "opening_balance": 1000 }),
            json!({ "cash_register.settings.get": settings(0, 0, 1), "cash_register.current_session": [{ "id": "s-open" }] }),
        ));
        assert_eq!(out.error.as_ref().map(|e| e.code.as_str()), Some("cash_register.session_already_open"));
    }

    #[test]
    fn close_session_refuses_without_counted_cash_when_the_setting_requires_it() {
        for payload in [json!({ "session_id": "s1" }), json!({ "session_id": "s1", "closing_balance": null }), json!({ "session_id": "s1", "closing_balance": "" })] {
            let out = close_session_pure(inp_reads(payload.clone(), json!({ "cash_register.settings.get": settings(0, 1, 0) })));
            assert_eq!(out.error.as_ref().map(|e| e.code.as_str()), Some("cash_register.closing_balance_required"), "{payload}");
            assert!(out.operations.is_empty());
        }
    }

    #[test]
    fn close_session_applies_when_counted_or_not_required() {
        let out = close_session_pure(inp_reads(
            json!({ "session_id": "s1", "closing_balance": 12000, "closing_notes": "ok" }),
            json!({ "cash_register.settings.get": settings(0, 1, 0) }),
        ));
        assert!(out.error.is_none());
        assert_eq!(out.operations[0].command, "cash_register._close_session_apply");
        assert_eq!(out.operations[0].params["closing_balance"], json!(12000));
        assert_eq!(out.operations[0].params["session_id"], json!("s1"));
        // Not required: a close without a count (e.g. API) is still allowed, closing_balance NULL.
        let out = close_session_pure(inp_reads(json!({ "session_id": "s1" }), json!({ "cash_register.settings.get": settings(0, 0, 0) })));
        assert!(out.error.is_none());
        assert_eq!(out.operations[0].params["closing_balance"], Value::Null);
    }

    #[test]
    fn add_movement_refuses_a_cash_out_that_empties_the_drawer_when_negative_is_not_allowed() {
        // Drawer holds 10000 + 2500 = 12500 cash; a 13000 out would leave -500.
        let out = add_movement_pure(inp_reads(
            json!({ "session_id": "s1", "movement_type": "out", "amount": -13000, "payment_method": "cash" }),
            json!({ "cash_register.settings.get": settings(0, 0, 0),
                    "cash_register.session.summary": [{ "id": "s1", "status": "open", "opening_balance": 10000, "expected_cash": 12500 }] }),
        ));
        assert_eq!(out.error.as_ref().map(|e| e.code.as_str()), Some("cash_register.negative_balance_not_allowed"));
        assert!(out.operations.is_empty());
    }

    #[test]
    fn add_movement_allows_a_cash_out_that_fits_or_when_negative_is_allowed() {
        let summary = json!([{ "id": "s1", "status": "open", "opening_balance": 10000, "expected_cash": 12500 }]);
        for (amount, allow) in [(-12500, 0), (-13000, 1), (500, 0)] {
            let out = add_movement_pure(inp_reads(
                json!({ "session_id": "s1", "movement_type": if amount < 0 { "out" } else { "in" }, "amount": amount, "payment_method": "cash", "description": "x" }),
                json!({ "cash_register.settings.get": settings(0, 0, allow), "cash_register.session.summary": summary }),
            ));
            assert!(out.error.is_none(), "amount={amount} allow={allow}: {:?}", out.error);
            assert_eq!(out.operations[0].command, "cash_register._movement_insert");
            assert_eq!(out.operations[0].params["amount"], json!(amount));
            assert_eq!(out.operations[0].params["session_id"], json!("s1"));
            assert_eq!(out.operations[0].params["movement_id"], json!("id-0"));
        }
    }

    #[test]
    fn add_movement_refuses_an_unknown_session() {
        // pm#146 kept on the WASM path: a session that is not this hub's (or is deleted) is not
        // preloaded → the movement is refused, no event is emitted for a row that does not exist.
        let out = add_movement_pure(inp_reads(
            json!({ "session_id": "ghost", "movement_type": "in", "amount": 100 }),
            json!({ "cash_register.settings.get": settings(0, 0, 1), "cash_register.session.summary": [] }),
        ));
        assert_eq!(out.error.as_ref().map(|e| e.code.as_str()), Some("cash_register.session_unavailable"));
    }
}

#[cfg(test)]
mod sign_tests {
    use super::*;
    use serde_json::json;

    fn inp_reads(payload: Value, reads: Value) -> Value {
        json!({ "payload": payload, "context": { "new_ids": ["id-0", "id-1"], "now": "2026-08-21T10:00:00+00:00", "reads": reads } })
    }
    fn settings(negative: i64) -> Value {
        json!([{ "id": "cfg", "require_opening_balance": 0, "require_closing_balance": 0, "allow_negative_balance": negative }])
    }
    fn summary(expected_cash: i64) -> Value {
        json!([{ "id": "s1", "status": "open", "opening_balance": 10000, "expected_cash": expected_cash }])
    }

    /// cash_register#48 — the SERVER puts the sign on a movement, not the caller. The exact
    /// reproduction from the issue: the SAME cash-out sent with the two signs must land the SAME
    /// amount in the drawer, and it must be a SUBTRACTION.
    #[test]
    fn a_cash_out_is_always_stored_negative_whatever_sign_the_caller_sent() {
        for sent in [9999900_i64, -9999900] {
            let out = add_movement_pure(inp_reads(
                json!({ "session_id": "s1", "movement_type": "out", "amount": sent, "payment_method": "cash" }),
                json!({ "cash_register.settings.get": settings(1), "cash_register.session.summary": summary(10010) }),
            ));
            assert!(out.error.is_none(), "sent={sent}: {:?}", out.error);
            assert_eq!(out.operations[0].params["amount"], json!(-9999900), "sent={sent}");
        }
    }

    /// The guard was UNREACHABLE through the positive-sign door: `expected_cash + amount` could
    /// never dip below zero. With the sign normalized first, the refusal is inevitable.
    #[test]
    fn a_cash_out_bigger_than_the_drawer_is_refused_whatever_sign_the_caller_sent() {
        for sent in [20000_i64, -20000] {
            let out = add_movement_pure(inp_reads(
                json!({ "session_id": "s1", "movement_type": "out", "amount": sent, "payment_method": "cash" }),
                json!({ "cash_register.settings.get": settings(0), "cash_register.session.summary": summary(10000) }),
            ));
            assert_eq!(
                out.error.as_ref().map(|e| e.code.as_str()),
                Some("cash_register.negative_balance_not_allowed"),
                "sent={sent}"
            );
            assert!(out.operations.is_empty(), "sent={sent}");
        }
    }

    /// A refund is an OUTFLOW too (`_reverse_sale.sql` already persists it negative): the public
    /// door must agree with the internal one.
    #[test]
    fn a_refund_is_an_outflow_and_an_inflow_is_positive() {
        for (movement_type, sent, stored) in [
            ("refund", 5000_i64, -5000_i64),
            ("refund", -5000, -5000),
            ("in", 5000, 5000),
            ("in", -5000, 5000),
            ("sale", -2500, 2500),
        ] {
            let out = add_movement_pure(inp_reads(
                json!({ "session_id": "s1", "movement_type": movement_type, "amount": sent, "payment_method": "cash" }),
                json!({ "cash_register.settings.get": settings(1), "cash_register.session.summary": summary(100000) }),
            ));
            assert!(out.error.is_none(), "{movement_type}/{sent}: {:?}", out.error);
            assert_eq!(out.operations[0].params["amount"], json!(stored), "{movement_type}/{sent}");
        }
    }

    /// An unknown `movement_type` never reaches the drawer: the schema rejects it, and the handler
    /// refuses too (belt and braces — the schema is the manifest's contract, this is the code's).
    #[test]
    fn an_unknown_movement_type_is_refused() {
        let out = add_movement_pure(inp_reads(
            json!({ "session_id": "s1", "movement_type": "withdrawal", "amount": 1000 }),
            json!({ "cash_register.settings.get": settings(1), "cash_register.session.summary": summary(100000) }),
        ));
        assert_eq!(out.error.as_ref().map(|e| e.code.as_str()), Some("cash_register.movement_type_unknown"));
        assert!(out.operations.is_empty());
    }

    /// A zero movement is not a movement: it would add a row to the audit trail that moves no money.
    #[test]
    fn a_zero_amount_is_refused() {
        let out = add_movement_pure(inp_reads(
            json!({ "session_id": "s1", "movement_type": "out", "amount": 0 }),
            json!({ "cash_register.settings.get": settings(1), "cash_register.session.summary": summary(100000) }),
        ));
        assert_eq!(out.error.as_ref().map(|e| e.code.as_str()), Some("cash_register.amount_required"));
        assert!(out.operations.is_empty());
    }
}

#[cfg(test)]
mod session_number_tests {
    use super::*;
    use serde_json::json;

    fn inp(payload: Value) -> Value {
        json!({ "payload": payload, "context": {
            "new_ids": ["id-0", "id-1"], "now": "2026-08-21T19:45:46+00:00",
            "reads": { "cash_register.settings.get": [], "cash_register.current_session": [] } } })
    }

    /// cash_register#49 — the shift number is the SERVER's. Opening by command used to leave the
    /// turn as `S-<uuid>`, 38 characters, in the very column the manager talks about a shift by.
    #[test]
    fn opening_bumps_the_daily_counter_before_inserting() {
        let out = open_session_pure(inp(json!({ "opening_balance": 5000 })));
        assert!(out.error.is_none(), "{:?}", out.error);
        let commands: Vec<&str> = out.operations.iter().map(|o| o.command.as_str()).collect();
        assert_eq!(
            commands,
            vec!["cash_register._bump_counter", "cash_register._open_session_insert"],
            "the counter must be bumped FIRST, in the same transaction"
        );
    }

    /// The counter is keyed by (hub, day) — the day comes from the HOST clock, never from the
    /// payload, so two terminals with different local settings share one series.
    #[test]
    fn the_counter_day_and_the_readable_day_come_from_the_host_clock() {
        let out = open_session_pure(inp(json!({ "opening_balance": 5000 })));
        assert_eq!(out.operations[0].params["day"], json!("20260821"));
        assert_eq!(out.operations[1].params["day"], json!("20260821"));
        assert_eq!(out.operations[1].params["session_day"], json!("260821"));
    }

    /// The number is no longer negotiable: whatever the caller sends is ignored, so opening from
    /// the screen and opening by command cannot drift apart.
    #[test]
    fn a_caller_supplied_session_number_is_ignored() {
        let out = open_session_pure(inp(json!({ "opening_balance": 5000, "session_number": "S-MINE" })));
        let params = &out.operations[1].params;
        assert!(
            !params.values().any(|v| v == &json!("S-MINE")),
            "the caller's session_number reached the insert: {params:?}"
        );
    }

    /// A refusal must not burn a number: nothing is written at all.
    #[test]
    fn a_refused_open_bumps_nothing() {
        let out = open_session_pure(json!({ "payload": { "opening_balance": 5000 }, "context": {
            "new_ids": ["id-0"], "now": "2026-08-21T19:45:46+00:00",
            "reads": { "cash_register.settings.get": [], "cash_register.current_session": [{ "id": "s-open" }] } } }));
        assert_eq!(out.error.as_ref().map(|e| e.code.as_str()), Some("cash_register.session_already_open"));
        assert!(out.operations.is_empty());
    }
}

#[cfg(test)]
mod payment_method_tests {
    use super::*;
    use serde_json::json;

    fn inp_reads(payload: Value, reads: Value) -> Value {
        json!({ "payload": payload, "context": { "new_ids": ["id-0", "id-1"], "now": "2026-08-21T10:00:00+00:00", "reads": reads } })
    }
    fn settings(negative: i64) -> Value {
        json!([{ "id": "cfg", "require_opening_balance": 0, "require_closing_balance": 0, "allow_negative_balance": negative }])
    }
    fn summary(expected_cash: i64) -> Value {
        json!([{ "id": "s1", "status": "open", "opening_balance": 10000, "expected_cash": expected_cash }])
    }
    fn add(payload: Value, negative: i64, expected_cash: i64) -> Output {
        add_movement_pure(inp_reads(
            payload,
            json!({ "cash_register.settings.get": settings(negative),
                    "cash_register.session.summary": summary(expected_cash) }),
        ))
    }

    /// cash_register#54, first half — the same bug as #33 through the OTHER door. The manual
    /// movement carried no `payment_method_type`, so `add_movement.sql` left the column on its
    /// `DEFAULT 'cash'`: a 50,00 € movement paid by CARD raised the expected cash of a drawer that
    /// never saw that money (opening 100 € → `expected_cash` 150 €).
    #[test]
    fn a_manual_movement_is_written_with_the_canonical_type_of_its_method() {
        for (method, method_type) in [("cash", "cash"), ("card", "card"), ("transfer", "transfer"), ("other", "other")] {
            let out = add(json!({ "session_id": "s1", "movement_type": "in", "amount": 5000, "payment_method": method }), 1, 10000);
            assert!(out.error.is_none(), "{method}: {:?}", out.error);
            assert_eq!(out.operations[0].command, "cash_register._movement_insert");
            assert_eq!(out.operations[0].params["payment_method_type"], json!(method_type), "method={method}");
            // Both columns are written: the reversal and `movements.list` read the name, the
            // arqueo reads the type. Leaving one of them to a DDL default is the whole bug.
            assert_eq!(out.operations[0].params["payment_method"], json!(method), "method={method}");
        }
    }

    /// A caller that says nothing still means the drawer: same default the column has had since
    /// migration 003, now stated by the writer instead of inherited from the DDL. Blank counts as
    /// nothing said — refusing it would only differ from the absent key by an invisible character.
    #[test]
    fn a_movement_without_a_method_is_cash() {
        for payload in [
            json!({ "session_id": "s1", "movement_type": "in", "amount": 5000 }),
            json!({ "session_id": "s1", "movement_type": "in", "amount": 5000, "payment_method": "" }),
            json!({ "session_id": "s1", "movement_type": "in", "amount": 5000, "payment_method": "  " }),
        ] {
            let out = add(payload.clone(), 1, 10000);
            assert!(out.error.is_none(), "{payload}: {:?}", out.error);
            assert_eq!(out.operations[0].params["payment_method_type"], json!("cash"), "{payload}");
        }
    }

    /// cash_register#54, second half — the WORST one. The guard decided `is_cash` on the
    /// LOCALIZED NAME while the five readings key on the canonical TYPE, so a hub in Spanish
    /// emptied the drawer below zero just by calling the command with «Efectivo»: the name never
    /// equals `'cash'` in a case-sensitive comparison, the guard filed it as "not physical cash"
    /// and waved it through. A guard you dodge by changing language is not a guard.
    #[test]
    fn the_localized_name_of_cash_cannot_dodge_the_negative_balance_guard() {
        for name in ["Efectivo", "efectivo", "Contant", "Espèces", "Bargeld"] {
            let out = add(json!({ "session_id": "s1", "movement_type": "out", "amount": 20000, "payment_method": name }), 0, 10000);
            assert!(
                out.error.is_some(),
                "«{name}» went through: the drawer would be left at −100,00 € with allow_negative_balance off"
            );
            assert!(out.operations.is_empty(), "«{name}» wrote a row");
        }
    }

    /// The door of the manual movement speaks the CANONICAL vocabulary (`cash`|`card`|`transfer`|
    /// `other`), not the catalogue of localized names — that one belongs to `sales`, and it reaches
    /// the drawer through `record_sale`, which carries the type the catalogue already knows. So an
    /// unrecognised method is REFUSED, with its own translated domain code: filing it as "not cash"
    /// would silently take it out of the drawer, and filing it as "cash" is the bug above.
    #[test]
    fn an_unknown_payment_method_is_refused() {
        for method in ["Efectivo", "bizum", "crypto", "efectivo/cash"] {
            let out = add(json!({ "session_id": "s1", "movement_type": "in", "amount": 5000, "payment_method": method }), 1, 10000);
            assert_eq!(
                out.error.as_ref().map(|e| e.code.as_str()),
                Some("cash_register.payment_method_unknown"),
                "method={method:?}"
            );
            assert!(out.operations.is_empty(), "method={method:?}");
        }
    }

    /// Case is not part of the contract: `CASH` and `Card` are the same tokens.
    #[test]
    fn the_canonical_tokens_are_case_insensitive() {
        for (method, method_type) in [("CASH", "cash"), ("Card", "card"), (" transfer ", "transfer")] {
            let out = add(json!({ "session_id": "s1", "movement_type": "in", "amount": 5000, "payment_method": method }), 1, 10000);
            assert!(out.error.is_none(), "{method}: {:?}", out.error);
            assert_eq!(out.operations[0].params["payment_method_type"], json!(method_type), "method={method}");
            // …and the name is stored normalized, so the `eq` filter of `movements.list` does not
            // see `Card` and `card` as two different methods.
            assert_eq!(out.operations[0].params["payment_method"], json!(method_type), "method={method}");
        }
    }

    /// The mirror image: money that never enters the drawer is not held back by the drawer's
    /// guard. A card refund bigger than the cash in the till is legitimate — the till holds no
    /// card money to run out of — and the readings exclude it from `expected_cash` anyway.
    #[test]
    fn a_non_cash_movement_is_outside_the_drawer_and_outside_its_guard() {
        for method in ["card", "transfer", "other"] {
            let out = add(json!({ "session_id": "s1", "movement_type": "out", "amount": 20000, "payment_method": method }), 0, 10000);
            assert!(out.error.is_none(), "{method}: {:?}", out.error);
            assert_eq!(out.operations[0].params["amount"], json!(-20000), "method={method}");
        }
    }

    /// And the guard still fires for real cash — the fix must not disarm what #38 and #48 left
    /// working.
    #[test]
    fn a_cash_out_bigger_than_the_drawer_is_still_refused() {
        let out = add(json!({ "session_id": "s1", "movement_type": "out", "amount": 20000, "payment_method": "cash" }), 0, 10000);
        assert_eq!(out.error.as_ref().map(|e| e.code.as_str()), Some("cash_register.negative_balance_not_allowed"));
        assert!(out.operations.is_empty());
    }
}
