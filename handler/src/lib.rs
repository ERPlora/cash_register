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
//!  - `record_refund`: listener de `sale.refunded`. Un movimiento de SALIDA por pata devuelta,
//!    tipado por el DESTINO al que vuelve el dinero (no por el cobro del que sale), e idempotente
//!    por documento (`refund_ref`).
//!  - `reverse_sale`: listener for `sale.voided`. ONE compensating movement for whatever the sale
//!    left alive in cash, booked in the OPEN drawer (cash_register#77) — never in a shift that has
//!    already been counted. Refuses out loud when no session is open, so the event dead-letters
//!    instead of writing nothing; the amount, the netting and the idempotence stay in SQL
//!    (`_reverse_movement_for_open_session`).
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
pub fn record_refund(input: Json<erplora_guest_sdk::Input>) -> FnResult<Json<Output>> {
    Ok(Json(record_refund_pure(input.into_inner().into_value())))
}

#[cfg(feature = "guest")]
#[plugin_fn]
pub fn reverse_sale(input: Json<erplora_guest_sdk::Input>) -> FnResult<Json<Output>> {
    Ok(Json(reverse_sale_pure(input.into_inner().into_value())))
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

/// One leg of a payment, as the drawer needs it: how much it covered, and with what.
///
/// `amount` is what the leg COVERED, never what was handed over: the change went back to the
/// customer out of the cash leg (ADR-0386 decision 2), so `amount_tendered` is money that did not
/// stay in the till. `kind` is the CANONICAL type of the method (`cash`|`card`|`transfer`|`other`,
/// hub#778) and it is the only thing the count keys on; `name` is the localized label the cashier
/// reads on the movements list.
struct Leg {
    amount: i64,
    name: String,
    kind: String,
}

/// The legs of a `sale.completed`, in the order the cashier took them (ADR-0386).
///
/// `payments[]` is the mixed-payment form, present in every event `sales` ≥ 2.16.0 emits — a
/// one-tender sale is a list of one. Its absence is NOT an error: a hub still running an older
/// `sales`, and every sale recorded before it upgraded, emits only the scalars, and that event is a
/// one-tender sale that has to keep booking exactly the movement it booked yesterday. An empty
/// list degrades the same way, so no emitter can make a sale disappear from the drawer.
fn legs_of(payload: &Value, total: i64) -> Vec<Leg> {
    let declared = payload.get("payments").and_then(|v| v.as_array());
    match declared {
        Some(legs) if !legs.is_empty() => legs
            .iter()
            .map(|leg| Leg {
                amount: money::from_json(leg.get("amount").unwrap_or(&Value::Null), 0),
                name: sor(leg, "payment_method_name", "cash"),
                kind: sor(leg, "payment_method_type", "cash"),
            })
            .collect(),
        _ => vec![Leg {
            amount: total,
            name: sor(payload, "payment_method_name", "cash"),
            kind: sor(payload, "payment_method_type", "cash"),
        }],
    }
}

/// record_sale: listener de sale.completed → un movimiento de caja (tipo 'sale') POR PATA de cobro,
/// en la sesión abierta del empleado. El payload del evento trae total, las patas y (opcional)
/// sale_id.
///
/// 🔴 **Por qué una pata, un movimiento** (cash_register#59, ADR-0386). Hasta aquí se escribía UN
/// movimiento por el total entero, tipado con el ESCALAR del evento — que con pago mixto es el
/// tender PRINCIPAL (la pata mayor). Una venta de 121,00 € cobrada con 50,00 € en tarjeta y
/// 71,00 € en efectivo dejaba un movimiento de 121,00 € tipo `cash`: el cajón esperaba 121,00 €
/// cuando solo entraron 71,00 €, y el arqueo salía corto en 50,00 € **en silencio**, todos los
/// días. Con el principal en tarjeta pasaba lo contrario y salía largo.
///
/// Las LECTURAS ya aguantaban N movimientos por venta (`session_summary.sql` suma solo los `cash`,
/// `_reverse_sale.sql` revierte su `SUM`), así que lo único que faltaba era escribir la verdad.
pub fn record_sale_pure(input: Value) -> Output {
    let payload = input.get("payload").cloned().unwrap_or(Value::Null);
    let total = money::from_json(payload.get("total").unwrap_or(&Value::Null), 0); // céntimos (de sale.completed)
    // Invitaciones (comp): coste de las líneas regalo de la venta (de sale.completed) → se acumula en
    // el movimiento para el arqueo. Una venta TODA-invitación (total 0) igual registra el movimiento.
    let gift_total = money::from_json(payload.get("gift_total").unwrap_or(&Value::Null), 0);
    if total <= 0 && gift_total <= 0 {
        return Output { operations: vec![], events: vec![], ..Default::default() };
    }

    let legs = legs_of(&payload, total);
    let sale_id = payload.get("sale_id").cloned().unwrap_or(json!(""));
    let description = json!(format!("Sale {}", s(payload.get("sale_id").unwrap_or(&Value::Null))));

    let mut operations = Vec::with_capacity(legs.len());
    for (i, leg) in legs.iter().enumerate() {
        // Cada movimiento necesita SU id, y el guest no puede generarlos (sandbox sin
        // aleatoriedad): salen del lote de `context.new_ids`. El host entrega 256, así que quedarse
        // corto es inalcanzable en la práctica — razón de más para RECHAZAR en voz alta en vez de
        // insertar una fila con la clave primaria vacía, que nadie podría anular después.
        let movement_id = new_id(&input, i);
        if movement_id.is_null() {
            return refuse(
                "cash_register.not_enough_ids",
                "the host did not hand out one id per payment leg",
            );
        }
        let mut p = Map::new();
        p.insert("movement_id".into(), movement_id);
        p.insert("movement_type".into(), json!("sale"));
        // Lo que la pata CUBRIÓ. El cambio ya salió del cajón (ADR-0386), así que `amount_tendered`
        // no es dinero que se quedara dentro y no se mira aquí.
        p.insert("amount".into(), json!(leg.amount));
        // Las invitaciones son de la VENTA, no de una pata: `session_summary.sql` hace
        // `SUM(m.gift_total)`, así que repetirlas en cada pata las multiplicaría por el número de
        // formas de pagar. Viajan en la primera y solo en la primera.
        p.insert("gift_total".into(), json!(if i == 0 { gift_total } else { 0 }));
        p.insert("payment_method".into(), json!(leg.name));
        // Tipo CANÓNICO del método (`cash`|`card`|`transfer`|`other`), de sale.completed (hub#778):
        // el cajón compara contra este, no contra el `name` localizado. Default `cash` para ventas de
        // eventos antiguos o emisores que aún no lo envíen (degradación: igual que antes del fix).
        p.insert("payment_method_type".into(), json!(leg.kind));
        // La MISMA referencia de venta en todas las patas: es lo que `_reverse_sale.sql` agrupa
        // para anular (`SUM` de las patas en efectivo), y lo que ata las N filas a un tique.
        p.insert("sale_reference".into(), sale_id.clone());
        p.insert("description".into(), description.clone());
        // La sesión abierta del usuario activo la resuelve el SQL (subquery por current_user_id).
        operations.push(Operation::sql("cash_register._movement_for_open_session", p));
    }
    Output { operations, events: vec![], ..Default::default() }
}


/// record_refund: listener de `sale.refunded` → un movimiento de SALIDA por pata devuelta, en la
/// sesión de caja abierta.
///
/// 🔴 **El tipo lo pone el DESTINO, no el origen** (cash_register#62, sales#160, ADR-0386 dec. 3).
/// Cada entrada de `payments[]` trae dos cosas que NO son la misma:
///
///   - `payment_id` — la pata de cobro de la que sale el dinero. Manda sobre el TOPE (`sales` ya
///     lo aplicó: no se devuelve por una tarjeta más de lo que esa tarjeta cobró). Aquí solo sirve
///     para distinguir las patas de un mismo documento en el índice de idempotencia.
///   - `payment_method_type` — por dónde VUELVE el dinero. Manda sobre el CAJÓN, y es lo único que
///     decide si esta pata mueve efectivo.
///
/// Una venta cobrada con TARJETA puede devolverse en EFECTIVO cuando esa tarjeta ya no existe (el
/// caso de Square): sale dinero de un cajón en el que esa venta nunca entró. Y al revés, una venta
/// en efectivo devuelta a una tarjeta NO saca nada del cajón. Tipar por el origen se equivoca en
/// los dos, en direcciones opuestas.
///
/// Por eso `_reverse_sale` no vale: agrupa la venta ENTERA (`SUM` por sesión) y se tipa por el
/// movimiento original. Una devolución es parcial y repetible —15,00 € hoy, 35,00 € la semana que
/// viene— y cada documento es su propio movimiento.
///
/// El importe viaja POSITIVO (como en el evento) y lo niega el SQL: el signo de un movimiento lo
/// decide su tipo, no quien lo manda (cash_register#48).
pub fn record_refund_pure(input: Value) -> Output {
    let payload = input.get("payload").cloned().unwrap_or(Value::Null);

    // El documento. Sin él no hay idempotencia posible: una reentrega del evento sacaría el dinero
    // del cajón otra vez y el descuadre sería exactamente del tamaño de la devolución. Se RECHAZA
    // en voz alta en vez de anotar una fila que nadie podría reconocer como ya vista.
    let refund_ref = sor(&payload, "refund_ref", "");
    if refund_ref.is_empty() {
        return refuse(
            "cash_register.refund_ref_required",
            "a refund with no stable document reference cannot be booked idempotently",
        );
    }

    let legs = refund_legs(&payload);
    if legs.is_empty() {
        // Una devolución sin patas no es un error: es un documento que no movió dinero por ninguna
        // puerta que el cajón conozca. No se inventa un movimiento por el `total`, que tiparía a
        // ciegas lo que el emisor no dijo.
        return Output { operations: vec![], events: vec![], ..Default::default() };
    }

    // 🔴 La sesión abierta sale de `context.reads`, NUNCA del payload (ADR-0069). Y se lee de
    // verdad, no solo se declara en el manifest: si no hay caja abierta, el INSERT…SELECT de
    // `_refund_movement_for_open_session` no produciría fila y el dinero saldría del cajón sin
    // dejar rastro — el fallo mudo que esta issue existe para cerrar. El evento se rechaza para que
    // caiga al dead-letter del outbox, donde SÍ se ve.
    //
    // cash_register#80: SOLO exige caja abierta si hay de verdad una pata en EFECTIVO. Una
    // devolución solo con tarjeta/transferencia no toca el cajón — con la caja abierta se anota
    // igual (queda "en el histórico"), pero sin caja abierta no hay dinero que anotar ni sesión a
    // la que colgar la fila: rechazarla igualmente convertía cada devolución de tarjeta fuera de
    // turno en una falsa alarma en el dead-letter.
    if read_rows(&input, "cash_register.current_session").is_empty() {
        if legs.iter().any(|leg| leg.kind == "cash") {
            return refuse(
                "cash_register.refund_no_open_session",
                "the refund was issued with no cash session open: the drawer has nowhere to book it",
            );
        }
        return Output { operations: vec![], events: vec![], ..Default::default() };
    }

    let sale_id = payload.get("sale_id").cloned().unwrap_or(json!(""));
    let description = json!(format!("Refund {} · sale {}", refund_ref, s(&sale_id)));

    let mut operations = Vec::with_capacity(legs.len());
    for (i, leg) in legs.iter().enumerate() {
        // Un id por pata, del lote de `context.new_ids`. Quedarse corto se rechaza en voz alta:
        // anotar media devolución descuadra la caja igual que no anotar ninguna, pero encima
        // parece cuadrada.
        let movement_id = new_id(&input, i);
        if movement_id.is_null() {
            return refuse(
                "cash_register.refund_not_enough_ids",
                "the host did not hand out one id per refunded leg",
            );
        }
        let mut p = Map::new();
        p.insert("movement_id".into(), movement_id);
        p.insert("amount".into(), json!(leg.amount));
        p.insert("payment_method".into(), json!(leg.name));
        // El tipo del DESTINO. Es la línea de la que depende todo lo de arriba.
        p.insert("payment_method_type".into(), json!(leg.kind));
        p.insert("sale_reference".into(), sale_id.clone());
        p.insert("refund_reference".into(), json!(refund_ref));
        // La pata de ORIGEN: lo que hace única cada fila de un documento repartido entre varios
        // destinos. El índice único de la migración 009 se apoya en ella.
        p.insert("source_payment_id".into(), json!(leg.source));
        p.insert("description".into(), description.clone());
        operations.push(Operation::sql("cash_register._refund_movement_for_open_session", p));
    }
    Output { operations, events: vec![], ..Default::default() }
}

/// Una pata DEVUELTA: cuánto vuelve, por dónde vuelve (destino) y de qué cobro sale (origen).
struct RefundLeg {
    amount: i64,
    name: String,
    kind: String,
    source: String,
}

/// Las patas de un `sale.refunded`. Solo las que mueven dinero de verdad: un importe <= 0 no es una
/// devolución (un negativo aquí sería un COBRO disfrazado), y `sales` ya lo rechaza en su puerta
/// (`sales.refund_amount_invalid`) — esto es la segunda cerradura, no la primera.
///
/// Sin `payments[]` no se anota nada: a diferencia del cobro, aquí NO se puede degradar al escalar
/// del evento, porque el escalar que decide el cajón —el destino— no existe fuera de las patas.
/// Inventarlo sería tipar a ciegas justo el dato que esta issue vino a arreglar.
fn refund_legs(payload: &Value) -> Vec<RefundLeg> {
    payload
        .get("payments")
        .and_then(|v| v.as_array())
        .map(|legs| {
            legs.iter()
                .filter_map(|leg| {
                    let amount = money::from_json(leg.get("amount").unwrap_or(&Value::Null), 0);
                    if amount <= 0 {
                        return None;
                    }
                    Some(RefundLeg {
                        amount,
                        name: sor(leg, "payment_method_name", "cash"),
                        kind: sor(leg, "payment_method_type", "cash"),
                        source: sor(leg, "payment_id", ""),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
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
/// reverse_sale: listener for `sale.voided` → ONE compensating movement for whatever the voided
/// sale had left ALIVE in cash, booked in the OPEN cash session (cash_register#77).
///
/// 🔴 **The compensation is booked where the money is TODAY, not where it came in.** Until #77 the
/// `refund` was written into the session that took the original `sale` movement (`GROUP BY
/// orig.session_id`), and nothing required that session to still be open: a sale voided the next
/// day put a movement into a shift that had already been CLOSED AND COUNTED, moved its expected
/// cash after the count, and left untouched the drawer the money actually comes out of. The market
/// has decided this one, and in a single direction: a closed shift is not reopened (Shopify POS
/// computes `expectedClosingBalance` "after the session was closed"; Business Central refuses to
/// post into a closed period), voiding an already-settled sale does not exist — you refund it
/// (Square, Lightspeed), and the refund is booked on the date it is made (Fresha). Toast says it
/// from the other side, and that is the same statement: "voiding payments on already-closed
/// drawers can complicate the cash record".
///
/// It is also the asymmetry that was left over: a REFUND has gone to the open shift since #62
/// (`_refund_movement_for_open_session`) while a VOID went to the original one, for the same
/// movement of money. When the void happens during the very shift that took the sale — the
/// ordinary case — the open session IS the original one, so nothing changes there.
///
/// What the handler adds and SQL cannot: **with no open drawer, it REFUSES OUT LOUD.** The
/// `INSERT … SELECT` would produce no row, the reversal would be lost and the drawer would keep
/// counting a sale that no longer exists — the mute failure #62 closed for refunds. Refusing sends
/// the event to the outbox dead-letter, where it can actually be seen.
///
/// The live amount, the netting of what was already refunded and the idempotence stay in SQL: they
/// depend on rows the guest cannot read.
pub fn reverse_sale_pure(input: Value) -> Output {
    let payload = input.get("payload").cloned().unwrap_or(Value::Null);

    // `:sale_id` is the whole `WHERE` of the reversal. Empty, the statement would look at every
    // movement with `sale_reference = ''` — the manual ones — and reverse a sum nobody sold.
    let sale_id = sor(&payload, "sale_id", "");
    if sale_id.trim().is_empty() {
        return refuse(
            "cash_register.void_sale_id_required",
            "the voided sale carries no reference: there is nothing to reverse in the drawer",
        );
    }

    // cash_register#80: what actually needs an open drawer is LIVE CASH, not the void itself. A
    // sale paid entirely by card — or already refunded in full, in cash — leaves nothing for
    // `_reverse_movement_for_open_session.sql` to write (its own `live.amount > 0` floor would
    // silently produce zero rows); refusing it anyway turned every card void issued before the
    // till opened for the day into a false alarm parked in the outbox dead-letter.
    let live_amount = read_rows(&input, "cash_register.live_cash_for_sale")
        .first()
        .map(|row| money::from_json(row.get("amount").unwrap_or(&Value::Null), 0))
        .unwrap_or(0);
    if live_amount <= 0 {
        return Output::default();
    }

    // 🔴 The open session comes from `context.reads`, NEVER from the payload (ADR-0069), and it
    // is really read: declaring it in the manifest is not enough, because `required` aborts when
    // the read fails to RESOLVE, not when it comes back empty.
    if read_rows(&input, "cash_register.current_session").is_empty() {
        return refuse(
            "cash_register.void_no_open_session",
            "the sale was voided with no cash session open: the drawer has nowhere to book the reversal",
        );
    }

    // The host's id (§5.3). Without it there is no row: refuse instead of writing a reversal
    // nobody can name.
    let movement_id = new_id(&input, 0);
    if movement_id.is_null() {
        return refuse(
            "cash_register.void_not_enough_ids",
            "the host handed out no id for the compensating movement",
        );
    }

    let mut p = Map::new();
    p.insert("movement_id".into(), movement_id);
    p.insert("sale_id".into(), json!(sale_id));
    Output::new()
        .with_operation(Operation::sql("cash_register._reverse_movement_for_open_session", p))
}

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
    // cash_register#78: `session.summary` resolves for a CLOSED session too (it has answered with
    // the audited figure since #77), so its mere presence does not mean the session takes writes.
    // Without this the manual door was the only one of the three ("as `open_session` and
    // `_record_refund` already do") with no guard of its own: a movement landed in a shift already
    // counted and signed, undoing its own `allow_negative_balance` guard in the process (that guard
    // reads `expected_cash` from THIS SAME row, which for a closed session is the frozen figure,
    // not what the new row would make it).
    if session.get("status").and_then(|v| v.as_str()) != Some("open") {
        return refuse(
            "cash_register.session_not_open",
            "That cash session is closed: a closed session does not accept new movements.",
        );
    }
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

    #[test]
    fn add_movement_refuses_a_closed_session() {
        // cash_register#78: `session.summary` resolves for a CLOSED session too (it answers with
        // the audited figure since #77) — the WASM door has no guard of its own to stop a manual
        // movement from landing in a shift that was already counted and signed.
        let out = add_movement_pure(inp_reads(
            json!({ "session_id": "s1", "movement_type": "in", "amount": 100 }),
            json!({ "cash_register.settings.get": settings(0, 0, 1),
                    "cash_register.session.summary": [{ "id": "s1", "status": "closed", "opening_balance": 10000, "expected_cash": 10000 }] }),
        ));
        assert_eq!(out.error.as_ref().map(|e| e.code.as_str()), Some("cash_register.session_not_open"));
        assert!(out.operations.is_empty(), "nothing is booked into a closed session");
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

    // ── cash_register#62 · sales#160 · ADR-0386 dec. 3 ────────────────────────────────────────
    //
    // A refund handed back IN CASH takes money out of the till. The drawer did not listen, so it
    // left no movement: the count came out short by exactly the refund and nothing explained it.
    //
    // The event carries the origin tender (`payment_id`, which caps the refund) and the
    // destination (`payment_method_type`, which decides the drawer) SEPARATELY. Every test below
    // exists to keep those two from being collapsed into one.

    /// A `sale.refunded` with an open drawer behind it. `reads` is what the host preloads for the
    /// listener's declared `reads` block — the session comes from THERE, never from the payload.
    fn refund_inp(payload: Value, ids: usize) -> Value {
        let new_ids: Vec<Value> = (0..ids).map(|i| json!(format!("id-{i}"))).collect();
        json!({
            "payload": payload,
            "context": {
                "new_ids": new_ids,
                "now": "2026-08-24T12:00:00+00:00",
                "reads": { "cash_register.current_session": [{ "id": "sess-open" }] },
            }
        })
    }

    /// Every operation this handler emitted against the refund door, in order.
    fn refund_ops(out: &Output) -> Vec<&Operation> {
        out.operations
            .iter()
            .filter(|op| op.command == "cash_register._refund_movement_for_open_session")
            .collect()
    }

    /// What the DRAWER will actually move, in cents out: only the legs whose DESTINATION is cash.
    /// The SQL negates the amount, so this counts the positive magnitudes the handler emitted.
    fn out_of_drawer(out: &Output) -> i64 {
        refund_ops(out)
            .iter()
            .filter(|op| op.params["payment_method_type"] == json!("cash"))
            .map(|op| op.params["amount"].as_i64().unwrap_or(0))
            .sum()
    }

    /// The issue's own case: 70,00 € charged on a CARD, 50,00 € of it handed back IN CASH because
    /// the card is gone. `payment_id` still names the card leg — that is what capped it.
    fn card_sale_refunded_in_cash() -> Value {
        json!({
            "sender": "sales", "sale_id": "sale-paid-by-card", "sale_number": "20260824-0007",
            "refund_id": "refund-doc-0001", "refund_ref": "refund-doc-0001",
            "total": 5000, "reason": "returned", "fully_refunded": false,
            "payments": [
                { "payment_id": "pay-card", "payment_method_id": "pm-cash",
                  "payment_method_name": "Efectivo", "payment_method_type": "cash", "amount": 5000 }
            ]
        })
    }

    #[test]
    fn a_cash_refund_leaves_its_entry_in_the_drawer() {
        let out = record_refund_pure(refund_inp(card_sale_refunded_in_cash(), 2));
        assert!(out.error.is_none(), "{:?}", out.error);
        let ops = refund_ops(&out);
        assert_eq!(ops.len(), 1, "one movement per refunded leg");
        assert_eq!(ops[0].params["amount"], json!(5000));
        assert_eq!(ops[0].params["sale_reference"], json!("sale-paid-by-card"));
        assert_eq!(ops[0].params["refund_reference"], json!("refund-doc-0001"));
        assert_eq!(out_of_drawer(&out), 5000, "50,00 € leaves the till");
    }

    #[test]
    fn the_movement_is_typed_after_the_destination_not_the_tender_it_came_from() {
        // 🔴 THE issue. The money came out of a CARD payment and went back as CASH. Typing after
        // the origin would book `card` and the till would never move — the silent shortfall.
        let out = record_refund_pure(refund_inp(card_sale_refunded_in_cash(), 2));
        let ops = refund_ops(&out);
        assert_eq!(ops[0].params["payment_method_type"], json!("cash"), "the DESTINATION");
        assert_eq!(ops[0].params["payment_method"], json!("Efectivo"));
        // …and the origin tender is still carried, because idempotency keys on it.
        assert_eq!(ops[0].params["source_payment_id"], json!("pay-card"));
    }

    #[test]
    fn a_cash_sale_refunded_onto_a_card_never_touches_the_drawer() {
        // The mirror image, and the half that makes the two rules distinguishable: typing after
        // the ORIGIN here would take 30,00 € out of a till that keeps every cent of it.
        let payload = json!({
            "sale_id": "sale-paid-in-cash", "refund_ref": "refund-doc-0002", "total": 3000,
            "payments": [
                { "payment_id": "pay-cash", "payment_method_id": "pm-card",
                  "payment_method_name": "Tarjeta", "payment_method_type": "card", "amount": 3000 }
            ]
        });
        let out = record_refund_pure(refund_inp(payload, 2));
        let ops = refund_ops(&out);
        assert_eq!(ops.len(), 1, "it is still on the record as a refund");
        assert_eq!(ops[0].params["payment_method_type"], json!("card"));
        assert_eq!(out_of_drawer(&out), 0, "no cash leaves the till");
    }

    #[test]
    fn a_refund_split_across_destinations_books_one_movement_per_leg() {
        // One document, two destinations. Both legs share `refund_ref`, so the ORIGIN tender is
        // what keeps them apart in the unique index — assert it is actually carried per leg.
        let payload = json!({
            "sale_id": "sale-mixed", "refund_ref": "refund-doc-0004", "total": 4000,
            "payments": [
                { "payment_id": "pay-a", "payment_method_name": "Efectivo",
                  "payment_method_type": "cash", "amount": 1500 },
                { "payment_id": "pay-b", "payment_method_name": "Tarjeta",
                  "payment_method_type": "card", "amount": 2500 }
            ]
        });
        let out = record_refund_pure(refund_inp(payload, 4));
        let ops = refund_ops(&out);
        assert_eq!(ops.len(), 2);
        let sources: Vec<&Value> = ops.iter().map(|op| &op.params["source_payment_id"]).collect();
        assert_eq!(sources, vec![&json!("pay-a"), &json!("pay-b")], "each leg keeps its own origin");
        assert_eq!(out_of_drawer(&out), 1500, "only the cash leg moves the till");
        for op in &ops {
            assert_eq!(op.params["refund_reference"], json!("refund-doc-0004"), "one document");
        }
    }

    #[test]
    fn every_leg_carries_the_document_reference_that_makes_it_idempotent() {
        // The reference is what the unique index keys on. A movement without it would be booked
        // again on every redelivery of the event, and the till would pay the refund twice.
        let out = record_refund_pure(refund_inp(card_sale_refunded_in_cash(), 2));
        for op in refund_ops(&out) {
            assert_eq!(op.params["refund_reference"], json!("refund-doc-0001"));
            assert_ne!(op.params["refund_reference"], json!(""));
        }
    }

    #[test]
    fn a_refund_without_a_document_reference_is_refused_out_loud() {
        let mut payload = card_sale_refunded_in_cash();
        payload["refund_ref"] = json!("");
        let out = record_refund_pure(refund_inp(payload, 2));
        assert!(out.operations.is_empty(), "nothing is booked without a reference");
        assert_eq!(
            out.error.as_ref().map(|e| e.code.as_str()),
            Some("cash_register.refund_ref_required")
        );
    }

    #[test]
    fn a_refund_with_no_open_session_is_refused_instead_of_vanishing() {
        // 🔴 The silent-failure guard. The INSERT…SELECT resolves the OPEN session: with none, it
        // produces no row and the cash would leave the drawer with nothing to show for it. The
        // session comes from `context.reads`, never from the payload — a caller could otherwise
        // claim a session that is not open.
        let no_session = json!({
            "payload": card_sale_refunded_in_cash(),
            "context": {
                "new_ids": ["id-0", "id-1"], "now": "2026-08-24T12:00:00+00:00",
                "reads": { "cash_register.current_session": [] },
            }
        });
        let out = record_refund_pure(no_session);
        assert!(out.operations.is_empty(), "nothing is booked with the drawer closed");
        assert_eq!(
            out.error.as_ref().map(|e| e.code.as_str()),
            Some("cash_register.refund_no_open_session")
        );
    }

    #[test]
    fn a_card_only_refund_with_no_open_session_is_a_silent_no_op() {
        // cash_register#80: a sale refunded entirely onto a card never touches the drawer, so
        // there is nothing for a closed till to refuse. Rejecting it anyway dead-lettered every
        // card refund/void issued before the register opened for the day.
        let payload = json!({
            "sale_id": "sale-paid-in-cash", "refund_ref": "refund-doc-0080", "total": 3000,
            "payments": [
                { "payment_id": "pay-cash", "payment_method_id": "pm-card",
                  "payment_method_name": "Tarjeta", "payment_method_type": "card", "amount": 3000 }
            ]
        });
        let no_session = json!({
            "payload": payload,
            "context": {
                "new_ids": ["id-0", "id-1"], "now": "2026-08-24T12:00:00+00:00",
                "reads": { "cash_register.current_session": [] },
            }
        });
        let out = record_refund_pure(no_session);
        assert!(out.error.is_none(), "{:?}", out.error);
        assert!(out.operations.is_empty(), "no cash leg, nowhere it needed to be booked");
    }

    #[test]
    fn a_mixed_refund_with_no_open_session_is_still_refused_for_its_cash_leg() {
        // The control: as soon as ONE leg is cash, the till has real money to account for and the
        // guard must still fire — #80 only spares the legs that never touch the drawer.
        let payload = json!({
            "sale_id": "sale-mixed", "refund_ref": "refund-doc-0081", "total": 4000,
            "payments": [
                { "payment_id": "pay-a", "payment_method_name": "Efectivo",
                  "payment_method_type": "cash", "amount": 1500 },
                { "payment_id": "pay-b", "payment_method_name": "Tarjeta",
                  "payment_method_type": "card", "amount": 2500 }
            ]
        });
        let no_session = json!({
            "payload": payload,
            "context": {
                "new_ids": ["id-0", "id-1"], "now": "2026-08-24T12:00:00+00:00",
                "reads": { "cash_register.current_session": [] },
            }
        });
        let out = record_refund_pure(no_session);
        assert!(out.operations.is_empty());
        assert_eq!(
            out.error.as_ref().map(|e| e.code.as_str()),
            Some("cash_register.refund_no_open_session")
        );
    }

    #[test]
    fn the_open_session_is_read_from_the_host_not_from_the_payload() {
        // kitchen#54: declaring the read in the manifest does NOT prove the handler uses it. A
        // payload that claims a session while the host says there is none must still be refused.
        let mut payload = card_sale_refunded_in_cash();
        payload["session_id"] = json!("sess-i-made-up");
        payload["current_session"] = json!([{ "id": "sess-i-made-up" }]);
        let forged = json!({
            "payload": payload,
            "context": {
                "new_ids": ["id-0", "id-1"], "now": "2026-08-24T12:00:00+00:00",
                "reads": { "cash_register.current_session": [] },
            }
        });
        let out = record_refund_pure(forged);
        assert_eq!(
            out.error.as_ref().map(|e| e.code.as_str()),
            Some("cash_register.refund_no_open_session"),
            "the payload does not get a vote on whether the drawer is open"
        );
    }

    #[test]
    fn running_out_of_ids_refuses_instead_of_booking_half_a_refund() {
        let payload = json!({
            "sale_id": "s", "refund_ref": "r-1", "total": 4000,
            "payments": [
                { "payment_id": "a", "payment_method_type": "cash", "amount": 1500 },
                { "payment_id": "b", "payment_method_type": "cash", "amount": 2500 }
            ]
        });
        let out = record_refund_pure(refund_inp(payload, 1));
        assert!(out.operations.is_empty(), "half a refund is worse than none: it looks square");
        assert_eq!(
            out.error.as_ref().map(|e| e.code.as_str()),
            Some("cash_register.refund_not_enough_ids")
        );
    }

    #[test]
    fn a_refund_event_with_no_legs_books_nothing_rather_than_guessing_the_destination() {
        // 🔴 No degrading to the scalar `total`, unlike the sale path. The datum that decides the
        // drawer — where the money went BACK to — does not exist outside `payments[]`. Inventing
        // it would type blind exactly the field this issue came to fix.
        for payload in [
            json!({ "sale_id": "s", "refund_ref": "r-2", "total": 5000 }),
            json!({ "sale_id": "s", "refund_ref": "r-3", "total": 5000, "payments": [] }),
        ] {
            let out = record_refund_pure(refund_inp(payload, 2));
            assert!(out.operations.is_empty());
            assert!(out.error.is_none(), "not an error: a document that moved no money we know of");
        }
    }

    #[test]
    fn a_leg_that_moves_no_money_is_not_booked() {
        // A zero or negative leg is not a refund — a negative one would be a CHARGE in disguise,
        // and booking it would ADD money to the drawer through the refund door.
        let payload = json!({
            "sale_id": "s", "refund_ref": "r-4", "total": 1000,
            "payments": [
                { "payment_id": "a", "payment_method_type": "cash", "amount": 0 },
                { "payment_id": "b", "payment_method_type": "cash", "amount": -5000 },
                { "payment_id": "c", "payment_method_type": "cash", "amount": 1000 }
            ]
        });
        let out = record_refund_pure(refund_inp(payload, 4));
        let ops = refund_ops(&out);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].params["amount"], json!(1000));
        assert_eq!(out_of_drawer(&out), 1000, "never more than what came back");
    }

    #[test]
    fn the_amount_travels_positive_and_the_sql_is_what_negates_it() {
        // cash_register#48: the sense of a movement is its TYPE, not the sign it arrives with.
        // The handler passes the event's positive cents; `-ABS(...)` in the SQL is what makes it
        // an outgoing amount, so an emitter cannot flip a refund into a deposit.
        let out = record_refund_pure(refund_inp(card_sale_refunded_in_cash(), 2));
        assert_eq!(refund_ops(&out)[0].params["amount"], json!(5000));
    }

    #[test]
    fn a_refund_never_carries_a_gift_total() {
        // `session_summary.sql` does `SUM(m.gift_total)` across the session. The invitations belong
        // to the SALE and already rode in on its first leg (#59); repeating them here would count
        // them twice. The SQL hard-codes 0 — this pins that the handler does not send one either.
        let mut payload = card_sale_refunded_in_cash();
        payload["gift_total"] = json!(800);
        let out = record_refund_pure(refund_inp(payload, 2));
        for op in refund_ops(&out) {
            assert!(op.params.get("gift_total").is_none(), "the refund door fixes it at 0");
        }
    }
}

#[cfg(test)]
mod void_tests {
    use super::*;
    use serde_json::json;
    // ── cash_register#77 · the void books where the money physically is ────────────────────────
    //
    // The reversal of a void is a cash refund like any other, so it lands where a refund lands: the
    // OPEN drawer. `_reverse_movement_for_open_session.sql` resolves that session itself; what the
    // handler owes the chain is the half SQL cannot express — refusing IN VOICE when there is no
    // drawer open at all, so the event falls to the outbox dead-letter instead of writing nothing.
    // It is the same guard `record_refund` got in #62, for the same reason.

    /// A `sale.voided` with an open drawer behind it, and a live cash amount to reverse (cash_register#80
    /// added this read: without it the handler cannot tell a card-only void — nothing to reverse —
    /// from a cash one with no drawer open for it). Defaults to a positive amount so every test
    /// written before #80 keeps exercising the session guard exactly as it did.
    fn void_inp(payload: Value, session: Value) -> Value {
        void_inp_live(payload, session, 10000)
    }

    fn void_inp_live(payload: Value, session: Value, live_amount: i64) -> Value {
        json!({
            "payload": payload,
            "context": {
                "new_ids": [json!("id-0"), json!("id-1")],
                "now": "2026-08-24T20:00:00+00:00",
                "reads": {
                    "cash_register.current_session": session,
                    "cash_register.live_cash_for_sale": [{ "amount": live_amount }],
                },
            }
        })
    }

    fn void_ops(out: &Output) -> Vec<&Operation> {
        out.operations
            .iter()
            .filter(|op| op.command == "cash_register._reverse_movement_for_open_session")
            .collect()
    }

    #[test]
    fn a_void_books_one_reversal_against_the_open_drawer() {
        let out = reverse_sale_pure(void_inp(json!({ "sale_id": "sale-1" }), json!([{ "id": "sess-open" }])));
        assert!(out.error.is_none(), "an ordinary void is not refused");
        let ops = void_ops(&out);
        assert_eq!(ops.len(), 1, "one sale, one compensating movement");
        assert_eq!(ops[0].params["sale_id"], json!("sale-1"));
        assert_eq!(ops[0].params["movement_id"], json!("id-0"), "the row the caller gets back");
    }

    #[test]
    fn a_void_with_no_open_session_is_refused_instead_of_vanishing() {
        // Without the guard the INSERT…SELECT finds no open session, writes no row and answers
        // ok: the drawer would silently keep counting a sale that no longer exists. Refusing sends
        // the event to the dead-letter, where somebody can see it.
        let out = reverse_sale_pure(void_inp(json!({ "sale_id": "sale-1" }), json!([])));
        assert_eq!(
            out.error.as_ref().map(|e| e.code.as_str()),
            Some("cash_register.void_no_open_session")
        );
        assert!(out.operations.is_empty(), "and nothing is written");
    }

    #[test]
    fn a_payload_cannot_forge_the_open_session() {
        // Same lock as the refund door: the trusted session is the host's read. A payload that
        // claims one while `context.reads` is empty is still refused.
        let forged = json!({
            "payload": { "sale_id": "sale-1", "current_session": [{ "id": "sess-i-made-up" }] },
            "context": {
                "new_ids": [json!("id-0")],
                "now": "2026-08-24T20:00:00+00:00",
                "reads": {
                    "cash_register.current_session": [],
                    "cash_register.live_cash_for_sale": [{ "amount": 10000 }],
                },
            }
        });
        assert_eq!(
            reverse_sale_pure(forged).error.as_ref().map(|e| e.code.as_str()),
            Some("cash_register.void_no_open_session")
        );
    }

    #[test]
    fn a_void_with_nothing_alive_in_cash_is_a_no_op_with_no_session_open() {
        // cash_register#80: a sale paid entirely by card (or already refunded in full in cash)
        // leaves nothing for the drawer to reverse. Refusing it anyway sent it to the outbox
        // dead-letter with an "open the till" message for a till the void never needed.
        let out = reverse_sale_pure(void_inp_live(json!({ "sale_id": "sale-card-only" }), json!([]), 0));
        assert!(out.error.is_none(), "{:?}", out.error);
        assert!(out.operations.is_empty(), "nothing to reverse, nothing written");
    }

    #[test]
    fn a_void_with_nothing_alive_in_cash_is_still_a_no_op_with_a_session_open() {
        // The open-drawer path is unaffected either way: with nothing live, the SQL itself would
        // have written nothing (`live.amount > 0` in `_reverse_movement_for_open_session.sql`).
        let out = reverse_sale_pure(void_inp_live(json!({ "sale_id": "sale-card-only" }), json!([{ "id": "sess-open" }]), 0));
        assert!(out.error.is_none());
        assert!(out.operations.is_empty());
    }

    #[test]
    fn a_void_without_a_sale_reference_is_refused() {
        // `:sale_id` is the whole `WHERE` of the reversal. Empty, the statement would look at every
        // movement with `sale_reference = ''` — the manual ones — and reverse a sum nobody sold.
        let out = reverse_sale_pure(void_inp(json!({ "sale_id": "" }), json!([{ "id": "sess-open" }])));
        assert_eq!(
            out.error.as_ref().map(|e| e.code.as_str()),
            Some("cash_register.void_sale_id_required")
        );
        assert!(out.operations.is_empty());
    }

    #[test]
    fn a_void_with_no_id_to_write_with_is_refused() {
        let starved = json!({
            "payload": { "sale_id": "sale-1" },
            "context": {
                "new_ids": [],
                "now": "2026-08-24T20:00:00+00:00",
                "reads": {
                    "cash_register.current_session": [{ "id": "sess-open" }],
                    "cash_register.live_cash_for_sale": [{ "amount": 10000 }],
                },
            }
        });
        assert_eq!(
            reverse_sale_pure(starved).error.as_ref().map(|e| e.code.as_str()),
            Some("cash_register.void_not_enough_ids")
        );
    }
}
