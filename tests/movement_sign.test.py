#!/usr/bin/env python3
"""The SIGN of a cash movement belongs to the SERVER (cash_register#48).

A cash-out sent with a POSITIVE amount used to ADD to the drawer. Sacar 99.999 € left the expected
cash at 100.110,50 € and `total_cash_out` at −99.959,00 €, and the command answered `ok: true`. Two
halves were missing:

  1. `cash_register.movement.add` declared NO `schema` and the handler stored `amount` as it
     arrived, so the sign was a convention the CALLER had to know — and `allow_negative_balance`,
     evaluated on `expected_cash + amount`, was UNREACHABLE through the positive door (the sum could
     never dip below zero). That half is decided in pure Rust and proven by `handler/src/lib.rs`
     (`cargo test`) plus the manifest checks below.
  2. The reading queries summed `m.amount` blind, so ONE badly signed row already in the table
     poisons the drawer for ever — including the closing reconciliation, which uses the same
     formula. The till then "balances" against a total that is already false and the cashier pays a
     discrepancy nobody made.

What this file proves, against a REAL Postgres built from the module's own migrations:

  a. The manifest states the contract: `movement.add` has a `schema`, `movement_type` is an enum
     and `amount` cannot be zero; the two new domain codes are translated in en and es.
  b. The reading queries are IMMUNE to a badly signed row: `session.summary`, `current_session`,
     `current_session.expected`, `movements.list` and both closes (`_close_session_apply`,
     `_auto_close_sessions`) read the sign from `movement_type`, not from the stored sign.
  c. `total_cash_out` / `total_refunds` are MAGNITUDES (never negative), and the session invariant
     `expected_cash = opening + sales + cash_in − cash_out − refunds` holds.

Usage: tests/movement_sign.test.py   (exit 0 = green)
"""

import json
import os
import pathlib
import re
import subprocess
import sys
import uuid

MODULE_DIR = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = json.loads((MODULE_DIR / "module.json").read_text())
CONTAINER = os.environ.get("CASH_REGISTER_TEST_PG_CONTAINER", "erplora-test-pg-5433")
DB = f"cash_register_movement_sign_test_{os.getpid()}"
HUB = "hub-a"
USER = "u-cashier"

# The codes the new contract answers with, and the UI key that translates each one.
CODES = {
    "cash_register.movement_type_unknown": "errMovementTypeUnknown",
    "cash_register.amount_required": "errAmountRequired",
}

failures: list[str] = []


def fail(m: str) -> None:
    failures.append(m)
    print(f"  FAIL: {m}")


def ok(m: str) -> None:
    print(f"  ok: {m}")


def psql(args: list[str], db: str | None = None, stdin: str | None = None) -> str:
    cmd = ["docker", "exec", "-i", CONTAINER, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres"]
    if db:
        cmd += ["-d", db]
    res = subprocess.run(cmd + args, input=stdin, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(res.stderr.strip() or res.stdout.strip())
    return res.stdout


def literal(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


# The runtime lowers the portable bridge functions to native Postgres (hub/crates/db/src/lib.rs).
# Only the one this module's SQL uses (`_auto_close_sessions`) is mirrored here.
def lower_bridge(sql: str) -> str:
    return re.sub(r"erp_dt\(([^()]*(?:\([^()]*\))?[^()]*)\)", r"((\1)::timestamptz)", sql)


def bind(sql: str, params: dict) -> str:
    sql = lower_bridge(sql)
    return re.sub(
        r"(?<!:):([a-z_][a-z0-9_]*)",
        lambda m: literal(params.get(m.group(1))),
        sql,
        flags=re.IGNORECASE,
    )


def sys_params(payload: dict) -> dict:
    p = dict(payload)
    p.setdefault("hub_id", HUB)
    p.setdefault("current_user_id", USER)
    p.setdefault("now", "2026-08-21T10:00:00+00:00")
    p.setdefault("new_id", str(uuid.uuid4()))
    return p


def run_sql_command(name: str, payload: dict) -> None:
    cmd = MANIFEST["commands"][name]
    p = sys_params(payload)
    # cash_register#49: the shift number is minted by an atomic per-(hub, day) counter that the
    # open bumps in the SAME transaction, so the insert has something to read back. Without it the
    # session would simply not be written.
    if name == "cash_register._open_session_insert":
        p.setdefault("day", "20260818")
        p.setdefault("session_day", "260818")
        cmd = {"sql": MANIFEST["commands"]["cash_register._bump_counter"]["sql"] + cmd["sql"]}
    psql([], db=DB, stdin="\n".join(
        ["BEGIN;"] + [bind((MODULE_DIR / r).read_text(), p) for r in cmd["sql"]] + ["COMMIT;"]))


def run_query(name: str, payload: dict | None = None) -> list[dict]:
    q = MANIFEST["queries"][name]
    sql = bind((MODULE_DIR / q["sql"]).read_text(), sys_params(payload or {})).rstrip().rstrip(";")
    out = psql(["-tA", "-c", f"SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM ({sql}) t"], db=DB)
    return json.loads(out.strip() or "[]")


# ── a. the manifest states the contract ────────────────────────────────────────────────────────
def check_manifest() -> None:
    cmd = MANIFEST["commands"]["cash_register.movement.add"]
    rel = cmd.get("schema")
    if not rel:
        fail("cash_register.movement.add declares no `schema`: nothing states what a movement is")
        return
    schema = json.loads((MODULE_DIR / rel).read_text())
    props = schema.get("properties", {})
    mt = props.get("movement_type", {})
    if sorted(mt.get("enum", [])) != ["in", "out", "refund", "sale"]:
        fail(f"movement_type must be an enum of the four kinds, got {mt.get('enum')}")
    else:
        ok("movement_type is an enum: an unknown kind never reaches the drawer")
    if "movement_type" not in schema.get("required", []) or "amount" not in schema.get("required", []):
        fail(f"movement_type and amount must be required, got {schema.get('required')}")
    else:
        ok("movement_type and amount are required")
    amount = props.get("amount", {})
    if amount.get("type") != "integer" or amount.get("not") != {"const": 0}:
        fail(f"amount must be a non-zero integer (minor units), got {amount}")
    else:
        ok("amount is a non-zero integer in minor units")

    for lang in ("en", "es"):
        ui = json.loads((MODULE_DIR / "locales" / f"{lang}.json").read_text()).get("ui", {})
        for code, key in CODES.items():
            if not ui.get(key):
                fail(f"locales/{lang}.json: ui.{key} missing (translation of {code})")
    en = json.loads((MODULE_DIR / "locales" / "en.json").read_text())["ui"]
    es = json.loads((MODULE_DIR / "locales" / "es.json").read_text())["ui"]
    same = [k for k in CODES.values() if en.get(k) and en.get(k) == es.get(k)]
    if same:
        fail(f"locales/es.json still English for {same}")
    else:
        ok("the new domain codes are translated in en and es")


# ── b/c. the readings are immune to a badly signed row ─────────────────────────────────────────
def check_against_postgres() -> None:
    if subprocess.run(["docker", "inspect", CONTAINER], capture_output=True).returncode != 0:
        fail(f"container `{CONTAINER}` is not running")
        return
    psql(["-c", f'CREATE DATABASE "{DB}"'])
    try:
        for rel in MANIFEST["migrations"]["postgres"]:
            psql([], db=DB, stdin=(MODULE_DIR / rel).read_text())
        # The core's settings table (hub/crates/runtime/src/settings.rs) — the hub creates it, and
        # `_auto_close_sessions` reads the business time zone from it.
        psql(["-c", "CREATE TABLE hub_settings (hub_id TEXT NOT NULL, key TEXT NOT NULL, "
                    "value TEXT NOT NULL DEFAULT '', updated_at TEXT, updated_by TEXT, "
                    "PRIMARY KEY (hub_id, key))"], db=DB)

        sid = str(uuid.uuid4())
        run_sql_command("cash_register._open_session_insert", {
            "session_id": sid, "opening_balance": 10000, "session_number": "S-SIGN",
            "register_id": None, "opening_notes": ""})

        def movement(movement_type: str, amount: int, method_type: str = "cash") -> None:
            """Writes a row DIRECTLY, bypassing the handler — that is the point: these are the rows
            already in the tables of hubs that ran the buggy version, plus anything a future caller
            gets wrong. The readings must survive them."""
            psql(["-c",
                  "INSERT INTO cash_register_movement (id, hub_id, session_id, movement_type, amount,"
                  " payment_method, payment_method_type, is_deleted, created_at, updated_at) VALUES"
                  f" ('{uuid.uuid4()}', '{HUB}', '{sid}', '{movement_type}', {amount}, 'cash',"
                  f" '{method_type}', 0, '2026-08-21T10:00:00+00:00', '2026-08-21T10:00:00+00:00')"],
                 db=DB)

        # The QA reproduction, row by row: the same kind of movement written with BOTH signs.
        movement("sale", 5000)      # a 50,00 € cash sale
        movement("in", 2000)        # 20,00 € put into the drawer
        movement("out", -3000)      # 30,00 € taken out, signed by the module's own screen
        movement("out", 1000)       # 10,00 € taken out, signed by the API caller — the P0 row
        movement("refund", -1500)   # 15,00 € refunded, as `_reverse_sale` writes it
        movement("refund", 500)     # 5,00 € refunded, written the wrong way round
        movement("sale", 9999, "card")  # card never touches the physical drawer

        # opening 10000 + 5000 + 2000 − 3000 − 1000 − 1500 − 500 = 11000
        EXPECTED_CASH = 11000
        s = run_query("cash_register.session.summary", {"session_id": sid})[0]
        if s["expected_cash"] != EXPECTED_CASH:
            fail(f"session.summary.expected_cash must be {EXPECTED_CASH} (every out/refund SUBTRACTS,"
                 f" card ignored), got {s['expected_cash']}")
        else:
            ok("session.summary: a badly signed row no longer inflates the expected cash")
        if s["total_cash_out"] != 4000 or s["total_refunds"] != 2000:
            fail(f"total_cash_out must be 4000 and total_refunds 2000, as MAGNITUDES, got "
                 f"cash_out={s['total_cash_out']} refunds={s['total_refunds']}")
        else:
            ok("total_cash_out / total_refunds are magnitudes, never negative")
        if s["total_sales"] != 14999 or s["total_cash_in"] != 2000:
            fail(f"total_sales must be 14999 (5000 cash + 9999 card) and total_cash_in 2000, got {s}")
        else:
            ok("total_sales / total_cash_in unchanged")

        # The invariant of the whole issue, on the CASH movements alone (the card sale is not in
        # the drawer, so it is discounted from the sales side).
        invariant = (s["opening_balance"] + (s["total_sales"] - 9999) + s["total_cash_in"]
                     - s["total_cash_out"] - s["total_refunds"])
        if invariant != s["expected_cash"]:
            fail(f"invariant broken: opening + sales + cash_in − cash_out − refunds = {invariant}, "
                 f"expected_cash = {s['expected_cash']}")
        else:
            ok("invariant holds: expected = opening + sales + cash_in − cash_out − refunds")

        for q in ("cash_register.current_session", "cash_register.current_session.expected"):
            row = run_query(q)[0]
            if row["expected_total"] != EXPECTED_CASH:
                fail(f"{q}.expected_total must be {EXPECTED_CASH}, got {row['expected_total']}")
            else:
                ok(f"{q} agrees with session.summary")

        rows = run_query("cash_register.movements.list", {"session_id": sid})
        wrong = [r for r in rows
                 if (r["movement_type"] in ("out", "refund")) != (r["amount"] < 0)]
        if wrong:
            fail(f"movements.list must show every out/refund negative and every in/sale positive, got {wrong}")
        else:
            ok("movements.list shows one sign per kind, whatever the row holds")

        # The close reconciles against the CORRECTED expected — otherwise the discrepancy is
        # measured against a lie and the cashier pays for it.
        run_sql_command("cash_register._close_session_apply",
                        {"session_id": sid, "closing_balance": 10500, "closing_notes": ""})
        closed = json.loads(psql(["-tA", "-c",
                                  f"SELECT row_to_json(s) FROM cash_register_session s WHERE id = '{sid}'"],
                                 db=DB).strip())
        if closed["expected_balance"] != EXPECTED_CASH or closed["difference"] != 10500 - EXPECTED_CASH:
            fail(f"the close must reconcile against {EXPECTED_CASH} (difference {10500 - EXPECTED_CASH}), got "
                 f"expected={closed['expected_balance']} difference={closed['difference']}")
        else:
            ok("_close_session_apply reconciles against the corrected expected cash")

        # The automatic close computes the very same expected — two formulas would mean the shift
        # you closed by hand and the shift the schedule closed do not compare.
        sid2 = str(uuid.uuid4())
        psql(["-c",
              "INSERT INTO cash_register_session (id, hub_id, user_id, session_number, status, opened_at,"
              " opening_balance, opening_notes, is_deleted, created_at, updated_at) VALUES"
              f" ('{sid2}', '{HUB}', '{USER}', 'S-AUTO', 'open', '2026-08-20T08:00:00+00:00', 10000, '', 0,"
              " '2026-08-20T08:00:00+00:00', '2026-08-20T08:00:00+00:00')"], db=DB)
        psql(["-c",
              "INSERT INTO cash_register_movement (id, hub_id, session_id, movement_type, amount,"
              " payment_method, payment_method_type, is_deleted, created_at, updated_at) VALUES"
              f" ('{uuid.uuid4()}', '{HUB}', '{sid2}', 'out', 1000, 'cash', 'cash', 0,"
              " '2026-08-20T09:00:00+00:00', '2026-08-20T09:00:00+00:00')"], db=DB)
        # Neither a card sale nor a soft-deleted cash sale is money in the drawer: the expected cash
        # the schedule freezes must leave both out, like the manual close does (rv cash_register#148).
        psql(["-c",
              "INSERT INTO cash_register_movement (id, hub_id, session_id, movement_type, amount,"
              " payment_method, payment_method_type, is_deleted, created_at, updated_at) VALUES"
              f" ('{uuid.uuid4()}', '{HUB}', '{sid2}', 'sale', 7000, 'card', 'card', 0,"
              " '2026-08-20T09:10:00+00:00', '2026-08-20T09:10:00+00:00'),"
              f" ('{uuid.uuid4()}', '{HUB}', '{sid2}', 'sale', 3000, 'cash', 'cash', 1,"
              " '2026-08-20T09:20:00+00:00', '2026-08-20T09:20:00+00:00')"], db=DB)
        run_sql_command("cash_register.settings.update", {
            "enable_cash_register": True, "require_opening_balance": False,
            "require_closing_balance": False, "allow_negative_balance": True,
            "require_blind_count": False, "auto_close_enabled": True,
            "auto_close_time": "04:00", "protected_pos_url": "/m/sales/pos/"})
        # cash_register#145: the pass is a handler — the read picks the due sessions and each one
        # is closed by `_auto_close_session_apply`, the statement that carries the formula.
        for row in run_query("cash_register.sessions.due_for_auto_close"):
            run_sql_command("cash_register._auto_close_session_apply", {"session_id": row["session_id"]})
        auto = json.loads(psql(["-tA", "-c",
                                f"SELECT row_to_json(s) FROM cash_register_session s WHERE id = '{sid2}'"],
                               db=DB).strip())
        if auto["expected_balance"] != 9000:
            fail(f"_auto_close_sessions must expect 10000 − 1000 = 9000 (card and deleted sales left out), got {auto['expected_balance']}")
        else:
            ok("_auto_close_sessions uses the same corrected formula as the manual close")
    finally:
        psql(["-c", f'DROP DATABASE IF EXISTS "{DB}" WITH (FORCE)'])


def main() -> int:
    print("[movement sign] manifest")
    check_manifest()
    print("[movement sign] real Postgres")
    check_against_postgres()
    if failures:
        print(f"\n{len(failures)} failure(s)")
        return 1
    print("\nOK — the server signs the movement, and one badly signed row cannot poison the drawer")
    return 0


if __name__ == "__main__":
    sys.exit(main())
