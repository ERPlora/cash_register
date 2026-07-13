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

use erplora_guest_sdk::money;
use rust_decimal::Decimal;
use std::str::FromStr;
use erplora_guest_sdk::{Operation, Output};
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
    Output { operations: vec![Operation::sql("cash_register._insert_count", p)], events: vec![] }
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
        return Output { operations: vec![], events: vec![] };
    }
    let mut p = Map::new();
    p.insert("movement_id".into(), new_id(&input, 0));
    p.insert("movement_type".into(), json!("sale"));
    p.insert("amount".into(), json!(total));
    p.insert("gift_total".into(), json!(gift_total));
    p.insert("payment_method".into(), json!(sor(&payload, "payment_method_name", "cash")));
    p.insert("sale_reference".into(), payload.get("sale_id").cloned().unwrap_or(json!("")));
    p.insert("description".into(), json!(format!("Sale {}", s(payload.get("sale_id").unwrap_or(&Value::Null)))));
    // La sesión abierta del usuario activo la resuelve el SQL (subquery por current_user_id).
    Output { operations: vec![Operation::sql("cash_register._movement_for_open_session", p)], events: vec![] }
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
    fn record_sale_zero_is_noop() {
        let out = record_sale_pure(inp(json!({ "total": 0 }), 2));
        assert_eq!(out.operations.len(), 0);
    }
}
